/**
 * `nexus keys set <ref>` interactive hidden-prompt tests (BUG: the hidden TTY
 * reader must actually capture what's typed and persist it via the
 * SecretStore). Drives the reader with a SIMULATED TTY input stream — no real
 * terminal required — via the injectable `stdin` parameter on
 * `promptHiddenValue` / `resolveSecretValue` / `cmdKeys`.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretStore } from "@nexuscode/config";
import { cmdKeys, promptHiddenValue, resolveSecretValue, type HiddenStdin, type Io } from "../src/commands.js";
import type { ParsedArgs } from "../src/args.js";

/** A minimal fake TTY stdin: a real EventEmitter driving `promptHiddenValue`'s "data" listener. */
class FakeTtyStdin extends EventEmitter implements HiddenStdin {
  isTTY = true;
  isRaw = false;
  rawModeCalls: boolean[] = [];
  setRawMode(mode: boolean): void {
    this.rawModeCalls.push(mode);
    this.isRaw = mode;
  }
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
}

function makeIo(): { io: Io; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      out: (s) => {
        stdout += s;
      },
      err: (s) => {
        stderr += s;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parsedArgs(positionals: string[], bools: string[] = []): ParsedArgs {
  return { positionals, flags: new Map(), multi: new Map(), bools: new Set(bools) };
}

describe("promptHiddenValue — simulated TTY hidden input", () => {
  it("captures characters typed before Enter and echoes nothing about the value", async () => {
    const stdin = new FakeTtyStdin();
    const { io, stdout, stderr } = makeIo();

    const promise = promptHiddenValue("secret value (input hidden): ", io, stdin);
    // The Promise executor runs synchronously, so the "data" listener is
    // already attached by the time we get here — no need to await first.
    stdin.emit("data", "sk-ant-testfromtty1234");
    stdin.emit("data", "\r");

    expect(await promise).toBe("sk-ant-testfromtty1234");
    expect(stdout()).toBe("");
    expect(stderr()).not.toContain("sk-ant-testfromtty1234");
    // Raw mode was engaged for the read, then restored to the prior state.
    expect(stdin.rawModeCalls[0]).toBe(true);
    expect(stdin.rawModeCalls.at(-1)).toBe(false);
  });

  it("handles Backspace before Enter", async () => {
    const stdin = new FakeTtyStdin();
    const { io } = makeIo();
    const promise = promptHiddenValue("label: ", io, stdin);
    stdin.emit("data", "abcd");
    stdin.emit("data", ""); // Backspace removes the trailing "d"
    stdin.emit("data", "\n");
    expect(await promise).toBe("abc");
  });

  it("resolves \"\" immediately when stdin is not a TTY (no listener attached)", async () => {
    const stdin = new FakeTtyStdin();
    stdin.isTTY = false;
    const { io } = makeIo();
    expect(await promptHiddenValue("label: ", io, stdin)).toBe("");
    expect(stdin.rawModeCalls).toEqual([]);
  });
});

describe("resolveSecretValue — TTY path (no explicit value, no --stdin)", () => {
  it("falls through to the hidden TTY reader and returns the captured value", async () => {
    const stdin = new FakeTtyStdin();
    const { io } = makeIo();
    const args = parsedArgs(["set", "anthropic"]);

    const promise = resolveSecretValue(args, io, stdin);
    stdin.emit("data", "sk-ant-viaresolve5678\r");

    expect(await promise).toBe("sk-ant-viaresolve5678");
  });
});

describe("cmdKeys 'set' via a simulated TTY — captures AND saves", () => {
  const ref = `hidden-tty-test-${randomUUID()}`;
  const passphrase = "hidden-prompt-test-passphrase";
  let savedPassphrase: string | undefined = undefined;
  let savedConfigDir: string | undefined = undefined;
  let configDir = "";

  afterEach(async () => {
    const store = createSecretStore({ passphrase });
    await store.delete(ref);
    if (savedPassphrase === undefined) delete process.env.NEXUS_VAULT_PASSPHRASE;
    else process.env.NEXUS_VAULT_PASSPHRASE = savedPassphrase;
    if (savedConfigDir === undefined) delete process.env.NEXUS_CONFIG_DIR;
    else process.env.NEXUS_CONFIG_DIR = savedConfigDir;
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it("a non-empty captured value is persisted via the SecretStore and a confirmation is printed", async () => {
    savedPassphrase = process.env.NEXUS_VAULT_PASSPHRASE;
    process.env.NEXUS_VAULT_PASSPHRASE = passphrase;
    savedConfigDir = process.env.NEXUS_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "nx-keys-tty-"));
    process.env.NEXUS_CONFIG_DIR = configDir;

    const stdin = new FakeTtyStdin();
    const { io, stdout } = makeIo();
    const args = parsedArgs(["set", ref]);

    // Unlike calling `promptHiddenValue`/`resolveSecretValue` directly, `cmdKeys`
    // does real async work first (`loadEffectiveConfig` + `buildRuntime`) before
    // it ever reaches the TTY read, so the "data" listener isn't attached
    // synchronously — wait for it before emitting the simulated keystrokes.
    const promise = cmdKeys(args, io, stdin);
    while (stdin.listenerCount("data") === 0) {
      await new Promise((r) => setImmediate(r));
    }
    stdin.emit("data", "sk-ant-hiddencapture98765");
    stdin.emit("data", "\r");
    const code = await promise;

    expect(code).toBe(0);
    // Never the raw value — only the masked confirmation.
    expect(stdout()).not.toContain("hiddencapture98765");
    expect(stdout()).toContain("sk-ant-…8765");
    expect(stdout()).toContain("saved");
    expect(stdout()).toContain(ref);

    // The captured value was actually PERSISTED (not just printed): read it
    // back through a fresh SecretStore instance.
    const store = createSecretStore({ passphrase });
    expect(await store.get(ref)).toBe("sk-ant-hiddencapture98765");
  });
});
