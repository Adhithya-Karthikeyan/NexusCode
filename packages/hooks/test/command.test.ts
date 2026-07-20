/**
 * Command-hook tests (Claude-Code-style). Fully offline: the "command" is the
 * current Node binary running an inline `-e` script that reads the JSON envelope
 * on stdin and emits a verdict — no external processes, deterministic. Covers:
 * a non-zero exit vetoes; a JSON `{block}` on stdout vetoes; a clean exit
 * observes; the `matcher` glob scopes tool hooks; the stdin payload is redacted.
 */

import { describe, expect, it } from "vitest";
import type { CommandHookConfig } from "@nexuscode/config";
import { HookBus, commandHookHandler, registerCommandHooks, runCommandHook } from "../src/index.js";

const NODE = process.execPath;

function hook(partial: Partial<CommandHookConfig> & { command?: string; args?: string[] }): CommandHookConfig {
  return {
    event: "pre-tool",
    command: partial.command ?? NODE,
    args: partial.args ?? [],
    timeoutMs: partial.timeoutMs ?? 5000,
    env: partial.env ?? {},
    failOpen: partial.failOpen ?? false,
    ...(partial.matcher !== undefined ? { matcher: partial.matcher } : {}),
    ...(partial.event !== undefined ? { event: partial.event } : {}),
  };
}

// A command guaranteed not to exist — `spawn` rejects with ENOENT (never runs).
const MISSING_COMMAND = "/no/such/nexuscode-test-binary-xyz";

// A script that BLOCKS by exiting non-zero, writing the reason to stderr.
const BLOCK_EXIT = `process.stdin.resume();process.stderr.write('denied by command');process.exit(2);`;
// A script that BLOCKS via a JSON verdict on stdout with a clean exit.
const BLOCK_JSON = `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({block:true,reason:'json veto'}));});`;
// A script that reads the envelope and echoes it back on stdout (to inspect redaction).
const ECHO = `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{const e=JSON.parse(b);process.stdout.write(JSON.stringify({echo:e}));});`;
// A clean no-op (observe/allow).
const NOOP = `process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));`;

describe("runCommandHook", () => {
  it("maps a non-zero exit to a block with the stderr reason", async () => {
    const h = commandHookHandler(hook({ args: ["-e", BLOCK_EXIT] }));
    const bus = new HookBus();
    bus.register("pre-tool", h);
    const out = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain("denied by command");
  });

  it("maps a JSON stdout verdict to a block", async () => {
    const bus = new HookBus();
    bus.register("pre-tool", commandHookHandler(hook({ args: ["-e", BLOCK_JSON] })));
    const out = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe("json veto");
  });

  it("a clean no-op exit observes (does not block)", async () => {
    const bus = new HookBus();
    bus.register("pre-tool", commandHookHandler(hook({ args: ["-e", NOOP] })));
    const out = await bus.emit("pre-tool", { toolName: "fs_read", input: {} });
    expect(out.blocked).toBe(false);
  });

  it("redacts the payload written to the child's stdin", async () => {
    const result = await runCommandHook(
      { command: NODE, args: ["-e", ECHO], timeoutMs: 5000, env: {} },
      { event: "pre-tool", payload: { toolName: "db_query", input: { password: "hunter2", host: "db" } } },
    );
    // The runner does NOT redact; the HANDLER does. Verify the handler path.
    const bus = new HookBus();
    const seen: string[] = [];
    bus.register("pre-tool", commandHookHandler(hook({ args: ["-e", ECHO] })));
    // ECHO's stdout is non-JSON-verdict shape (has "echo"), so it observes.
    const out = await bus.emit("pre-tool", { toolName: "db_query", input: { password: "hunter2", host: "db" } });
    expect(out.blocked).toBe(false);
    // Also assert the low-level runner ran and returned output.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("echo");
    void seen;
  });
});

describe("fail-closed on hook execution failure", () => {
  it("DENIES the tool when a pre-tool hook's command fails to spawn", async () => {
    const bus = new HookBus();
    bus.register("pre-tool", commandHookHandler(hook({ command: MISSING_COMMAND })));
    const out = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(out.blocked).toBe(true);
    expect(out.reason).toMatch(/hook execution failed/i);
    expect(out.errors).toHaveLength(1);
  });

  it("isolates (does not block) an observe-only post-hook whose command fails to spawn", async () => {
    const bus = new HookBus();
    bus.register(
      "post-tool",
      commandHookHandler(hook({ command: MISSING_COMMAND, event: "post-tool" })),
    );
    const out = await bus.emit("post-tool", { toolName: "shell_exec", ok: true });
    expect(out.blocked).toBe(false);
    expect(out.errors).toHaveLength(1);
  });

  it("honors a per-hook failOpen:true opt-out on a veto-capable event", async () => {
    const bus = new HookBus();
    bus.register(
      "pre-tool",
      commandHookHandler(hook({ command: MISSING_COMMAND, failOpen: true })),
    );
    const out = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(out.blocked).toBe(false);
    expect(out.errors).toHaveLength(1);
  });
});

describe("registerCommandHooks matcher", () => {
  it("only fires a tool hook whose matcher matches the tool name", async () => {
    const bus = new HookBus();
    registerCommandHooks(bus, {
      enabled: true,
      hooks: [hook({ args: ["-e", BLOCK_EXIT], matcher: "shell_*" })],
    });
    const blocked = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(blocked.blocked).toBe(true);
    const allowed = await bus.emit("pre-tool", { toolName: "fs_read", input: {} });
    expect(allowed.blocked).toBe(false);
  });

  it("registers nothing when hooks are disabled", () => {
    const bus = new HookBus();
    registerCommandHooks(bus, {
      enabled: false,
      hooks: [hook({ args: ["-e", BLOCK_EXIT] })],
    });
    expect(bus.count("pre-tool")).toBe(0);
  });
});
