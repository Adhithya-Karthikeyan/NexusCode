/**
 * Command hooks (the Claude-Code-style extension point). A configured hook is a
 * shell command run on a lifecycle event: the JSON payload (plus the event
 * name) is written to the child's stdin, and its response decides the outcome —
 *
 *   - exit 0 + empty stdout        → observe/allow.
 *   - exit 0 + JSON `{block,reason,modify}` on stdout → that verdict (a pre-hook
 *                                    can thus veto or rewrite the operation).
 *   - non-zero exit                → BLOCK (reason taken from stderr/stdout),
 *                                    matching Claude Code's "exit code ≠ 0 =
 *                                    deny" convention. Only enforced on the
 *                                    vetoable events; elsewhere it's logged.
 *
 * The payload written to the child is REDACTED (secret-named fields + secret
 * shapes masked) so a command hook never receives a live credential on stdin.
 * A `matcher` glob scopes tool hooks to specific tool names. The child is
 * spawned with a wall-clock timeout and killed (SIGTERM→SIGKILL) if it overruns.
 */

import { spawn } from "node:child_process";
import { redactArgs } from "@nexuscode/tools";
import type { CommandHookConfig, HooksConfig } from "@nexuscode/config";
import type { HookBus } from "./bus.js";
import {
  HookExecutionError,
  type HookContext,
  type HookEvent,
  type HookHandler,
  type HookPayloads,
  type HookVerdict,
} from "./types.js";

/** Compile a `*`-glob (tool-name matcher) into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Extract a tool name from a payload, if the event carries one. */
function toolNameOf(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "toolName" in payload) {
    const v = (payload as { toolName?: unknown }).toolName;
    if (typeof v === "string") return v;
  }
  return undefined;
}

export interface CommandHookResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn one command hook, feed it the JSON envelope on stdin, and collect its
 * output under a timeout. Never throws for a non-zero exit — the caller maps the
 * result to a verdict.
 */
export function runCommandHook(
  cfg: Pick<CommandHookConfig, "command" | "args" | "timeoutMs" | "env">,
  envelope: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<CommandHookResult> {
  return new Promise<CommandHookResult>((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(cfg.env ?? {}) },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 200).unref?.();
      }
    };

    const onAbort = (): void => {
      timedOut = true;
      kill();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, cfg.timeoutMs ?? 5000);
    timer.unref?.();

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code, signal) => {
      finish(() => resolve({ exitCode: code, signal, stdout, stderr, timedOut }));
    });

    // Write the (redacted) envelope to stdin and close it.
    try {
      child.stdin.write(JSON.stringify(envelope));
      child.stdin.end();
    } catch {
      // If the child never opened stdin, the close/error handlers still fire.
    }
  });
}

/** Map a command-hook result to a hook verdict. */
export function resultToVerdict<E extends HookEvent>(
  result: CommandHookResult,
): HookVerdict<HookPayloads[E]> {
  if (result.timedOut) {
    return { block: true, reason: "command hook timed out" };
  }
  if (result.exitCode !== 0) {
    const reason =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `command hook exited with code ${result.exitCode ?? "null"}`;
    return { block: true, reason };
  }
  const text = result.stdout.trim();
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const verdict: HookVerdict<HookPayloads[E]> = {};
    if (parsed.block === true) verdict.block = true;
    if (typeof parsed.reason === "string") verdict.reason = parsed.reason;
    if (parsed.approve === true || parsed.approve === false) verdict.approve = parsed.approve;
    if (parsed.modify && typeof parsed.modify === "object") {
      verdict.modify = parsed.modify as Partial<HookPayloads[E]>;
    }
    return verdict;
  } catch {
    // Non-JSON stdout on a clean exit is treated as an observation, not a block.
    return {};
  }
}

/**
 * Build an in-process {@link HookHandler} that runs a configured command hook.
 * Applies the `matcher` glob (tool events only) and redacts the payload before
 * it is handed to the child.
 */
export function commandHookHandler<E extends HookEvent>(
  cfg: CommandHookConfig,
): HookHandler<E> {
  const matcher = cfg.matcher ? globToRegExp(cfg.matcher) : undefined;
  return async (payload: HookPayloads[E], ctx: HookContext) => {
    if (matcher) {
      const name = toolNameOf(payload);
      // A matcher only scopes events that carry a tool name; others always run.
      if (name !== undefined && !matcher.test(name)) return;
    }
    const envelope = {
      event: cfg.event,
      payload: redactArgs(payload),
    };
    const runOpts = ctx.signal ? { signal: ctx.signal } : {};
    let result: CommandHookResult;
    try {
      result = await runCommandHook(cfg, envelope, runOpts);
    } catch (err) {
      // The child never spawned/executed (e.g. ENOENT, EACCES) — `runCommandHook`
      // rejects rather than resolving to a result. Surface this as a
      // `HookExecutionError` so the bus can fail CLOSED on a veto-capable event
      // by default (see bus.ts); the hook's own `failOpen` opts out per-hook.
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger?.("error", `command hook failed to execute for "${cfg.event}"`, {
        command: cfg.command,
        error: message,
      });
      throw new HookExecutionError(`hook execution failed: ${message}`, { failOpen: cfg.failOpen });
    }
    return resultToVerdict<E>(result);
  };
}

/**
 * Register every command hook declared in a validated {@link HooksConfig} into
 * `bus`. No-op when `enabled` is false. Returns a single unregister function
 * that removes all of them.
 */
export function registerCommandHooks(bus: HookBus, cfg: HooksConfig): () => void {
  if (!cfg.enabled) return () => {};
  const off: Array<() => void> = [];
  for (const hook of cfg.hooks) {
    off.push(bus.register(hook.event, commandHookHandler(hook)));
  }
  return () => {
    for (const fn of off) fn();
  };
}
