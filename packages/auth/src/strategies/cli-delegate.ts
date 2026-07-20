/**
 * The `"cli-delegate"` {@link AuthStrategy} for wrapped vendor coding CLIs
 * (claude-code / codex / gemini-cli). We do NOT reimplement the vendor's OAuth —
 * that would be wrong and fragile. Instead:
 *
 *   • `status()`  — detects an EXISTING vendor session OFFLINE by checking the
 *                   known credential file(s) the vendor writes under $HOME
 *                   (e.g. `~/.claude/.credentials.json`, `~/.codex/auth.json`),
 *                   and reports "not installed" when the binary is absent.
 *   • `login()`   — runs the vendor CLI's OWN login subcommand, feature-detected
 *                   (e.g. `claude /login`, `codex login`, `gemini` auth), letting
 *                   the vendor drive its real browser/device flow on the user's
 *                   TTY. The subprocess adapter then reuses that session.
 *   • `resolveCredential()` — returns `"none"`: the wrapped CLI authenticates
 *                   itself from its own session; NexusCode injects no token.
 *
 * Every filesystem/exec touch goes through the injectable {@link StrategyExec}
 * so detection + invocation are testable offline against a fake vendor CLI.
 */

import { join } from "node:path";
import type { AuthStatus, AuthStrategy, LoginStrategyOptions, ResolvedCredential } from "./types.js";
import { defaultExec, type StrategyExec } from "./exec.js";

export interface CliDelegateSpec {
  /** The NexusCode provider id (e.g. `"claude-code"`). */
  providerId: string;
  /** The vendor CLI binary (e.g. `"claude"`). */
  bin: string;
  /** Human-friendly vendor label (default = bin). */
  label?: string;
  /**
   * Argv for the vendor's own login (feature-detected per CLI). Runs
   * interactively so the vendor can drive its real browser/device flow.
   */
  loginArgs: string[];
  /** Argv for the vendor's own logout, when it exposes one. */
  logoutArgs?: string[];
  /**
   * Session/credential files the vendor writes on a successful login, relative
   * to $HOME. Their existence is the OFFLINE "already logged in" signal.
   */
  sessionFiles: string[];
}

export interface CliDelegateStrategyOptions {
  spec: CliDelegateSpec;
  /** Injectable environment surface (default real fs/exec). */
  exec?: StrategyExec;
}

/** Build a `"cli-delegate"` strategy from a per-CLI spec. */
export function createCliDelegateStrategy(opts: CliDelegateStrategyOptions): AuthStrategy {
  const { spec } = opts;
  const exec = opts.exec ?? defaultExec();
  const providerId = spec.providerId;
  const vendor = spec.label ?? spec.bin;
  const label = `cli session (${spec.bin})`;

  const installed = (): boolean => exec.which(spec.bin);

  const hasSession = (): boolean => {
    const home = exec.home();
    return spec.sessionFiles.some((rel) => exec.fileExists(join(home, rel)));
  };

  const status = async (): Promise<AuthStatus> => {
    if (!installed()) {
      return {
        providerId,
        kind: "cli-delegate",
        loggedIn: false,
        method: label,
        detail: `${spec.bin} not installed (run its installer, then \`nexus login ${providerId}\`)`,
      };
    }
    if (hasSession()) {
      return {
        providerId,
        kind: "cli-delegate",
        loggedIn: true,
        method: label,
        detail: `${vendor} session detected`,
      };
    }
    return {
      providerId,
      kind: "cli-delegate",
      loggedIn: false,
      method: label,
      detail: `${vendor} installed but not logged in — run \`nexus login ${providerId}\``,
    };
  };

  const login = async (loginOpts: LoginStrategyOptions = {}): Promise<AuthStatus> => {
    if (!installed()) {
      throw new Error(
        `${providerId}: ${spec.bin} is not installed — install the vendor CLI first, then log in with it`,
      );
    }
    // Delegate to the vendor CLI's OWN login: it drives the real flow on the TTY.
    const result = await exec.run(spec.bin, spec.loginArgs, {
      interactive: true,
      ...(loginOpts.signal ? { signal: loginOpts.signal } : {}),
      ...(loginOpts.timeoutMs !== undefined ? { timeoutMs: loginOpts.timeoutMs } : {}),
    });
    if (result.spawnError) {
      throw new Error(`${providerId}: failed to run \`${spec.bin} ${spec.loginArgs.join(" ")}\`: ${result.spawnError}`);
    }
    if (result.code !== 0 && result.code !== null) {
      throw new Error(
        `${providerId}: \`${spec.bin} ${spec.loginArgs.join(" ")}\` exited ${result.code}${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
      );
    }
    return status();
  };

  const logout = async (): Promise<void> => {
    if (spec.logoutArgs && installed()) {
      await exec.run(spec.bin, spec.logoutArgs, { interactive: true });
    }
    // We never delete the vendor's credential files ourselves — the vendor owns
    // that store. When no logout subcommand exists, logout is a no-op by design.
  };

  const resolveCredential = async (): Promise<ResolvedCredential> => {
    // The wrapped CLI authenticates from its own session; inject nothing.
    return { kind: "none", value: "" };
  };

  return { providerId, kind: "cli-delegate", label, login, logout, status, resolveCredential };
}
