import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Wave-10 wiring integration tests. They exercise the CLI surface end-to-end
 * against the built binary, fully offline:
 *   - `nexus serve` binds + answers GET /v1/health on an ephemeral port.
 *   - a fake plugin's contributed tool appears in `tools list`.
 *   - a configured pre-tool command hook vetoes a tool in an agent run.
 *   - `nexus plugin list` shows the fake plugin.
 */

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PLUGINS_DIR = fileURLToPath(new URL("./fixtures/plugins", import.meta.url));
const BLOCK_HOOK = fileURLToPath(new URL("./fixtures/block-pretool-hook.mjs", import.meta.url));

const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-w10-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-w10-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-w10-cwd-"));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const baseEnv = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  NEXUS_CONFIG_DIR: CONFIG_DIR,
  NEXUS_DATA_DIR: DATA_DIR,
  NEXUSCODE_DATA_DIR: DATA_DIR,
  NEXUS_HISTORY_DISABLED: "1",
  NEXUS_VAULT_PASSPHRASE: "test-passphrase",
});

function runCli(args: string[], input = "", extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: WORK_DIR,
      env: { ...baseEnv(), ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** Spawn a long-running command, resolving once stdout matches `ready`. */
function spawnUntil(
  args: string[],
  ready: RegExp,
  extraEnv: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<{ child: ChildProcess; stdout: string; match: RegExpMatchArray }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: WORK_DIR,
      env: { ...baseEnv(), ...extraEnv },
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out waiting for ${ready} (got: ${stdout})`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      const match = stdout.match(ready);
      if (match) {
        clearTimeout(timer);
        resolve({ child, stdout, match });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!stdout.match(ready)) reject(new Error(`process exited before ready (got: ${stdout})`));
    });
  });
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite`);
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(WORK_DIR, "agent-note.txt"), "AGENT_FILE_CONTENT", "utf8");
});

describe("nexus serve (REST daemon)", () => {
  it("binds an ephemeral port and answers GET /v1/health without auth", async () => {
    const { child, match } = await spawnUntil(
      ["serve", "--host", "127.0.0.1", "--port", "0"],
      /listening on (http:\/\/127\.0\.0\.1:\d+)/,
    );
    const url = match[1] as string;
    try {
      const res = await fetch(`${url}/v1/health`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok: boolean; version: string };
      expect(body.ok).toBe(true);

      // A data route without a bearer token is rejected (401).
      const denied = await fetch(`${url}/v1/providers`);
      expect(denied.status).toBe(401);
    } finally {
      child.kill("SIGTERM");
    }
  }, 30_000);
});

describe("nexus plugin (discovery + management)", () => {
  it("plugin list shows the fake plugin (text)", async () => {
    const r = await runCli(["plugin", "list"], "", { NEXUS_PLUGINS_DIR: PLUGINS_DIR });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nexuscode-plugin-wave10");
  }, 20_000);

  it("plugin list -o json reports the plugin's declared contributions", async () => {
    const r = await runCli(["plugin", "list", "-o", "json"], "", { NEXUS_PLUGINS_DIR: PLUGINS_DIR });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout.trim()) as {
      plugins: Array<{ name: string; contributions: { tools: string[]; providers: string[] } }>;
    };
    const p = doc.plugins.find((x) => x.name === "nexuscode-plugin-wave10");
    expect(p).toBeDefined();
    expect(p?.contributions.tools).toContain("wave10_ping");
    expect(p?.contributions.providers).toContain("wave10-llm");
  }, 20_000);
});

describe("nexus tools list (plugin contributions)", () => {
  it("shows the plugin-contributed tool alongside the built-in groups", async () => {
    const r = await runCli(["tools", "list"], "", { NEXUS_PLUGINS_DIR: PLUGINS_DIR });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("wave10_ping");
    expect(r.stdout).toContain("via nexuscode-plugin-wave10");
  }, 20_000);

  it("-o json includes the plugin tool in the plugins array", async () => {
    const r = await runCli(["tools", "list", "-o", "json"], "", { NEXUS_PLUGINS_DIR: PLUGINS_DIR });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout.trim()) as { plugins: Array<{ name: string; plugin: string }> };
    expect(doc.plugins.some((t) => t.name === "wave10_ping")).toBe(true);
  }, 20_000);
});

describe("nexus agent (pre-tool hook veto)", () => {
  it("a configured pre-tool command hook vetoes the fs_read tool", async () => {
    // Write a config declaring a pre-tool command hook that blocks every tool.
    const config = {
      hooks: {
        enabled: true,
        hooks: [
          {
            event: "pre-tool",
            command: process.execPath,
            args: [BLOCK_HOOK],
            matcher: "*",
          },
        ],
      },
    };
    writeFileSync(join(CONFIG_DIR, "config.json"), JSON.stringify(config), "utf8");

    const r = await runCli(["agent", "-p", "mock", "-m", "mock-tools", "agent-note.txt"]);
    expect(r.code).toBe(0);
    // The tool was vetoed, so the file content never reaches the answer…
    expect(r.stdout).not.toContain("AGENT_FILE_CONTENT");
    // …and the veto reason surfaces on the tool-result / stderr trail.
    expect(r.stderr).toMatch(/blocked by hook|vetoed by wave10 test hook|\[tool-result\] error/);
  }, 30_000);

  it("without the hook, the same run reads the file (control)", async () => {
    // Overwrite config with no hooks so the tool loop runs unobstructed.
    writeFileSync(join(CONFIG_DIR, "config.json"), JSON.stringify({}), "utf8");
    const r = await runCli(["agent", "-p", "mock", "-m", "mock-tools", "agent-note.txt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("AGENT_FILE_CONTENT");
  }, 30_000);
});
