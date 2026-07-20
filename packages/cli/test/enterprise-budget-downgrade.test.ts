/**
 * Offline regression test for the §25 cost-control DOWNGRADE verdict in the
 * `nexus agent` run path. A budget with `onExceed:"downgrade"` must reroute an
 * over-budget run onto the cheaper model BEFORE dispatch — not silently proceed
 * on the original (expensive) model. Driven end-to-end through the built CLI
 * against the offline mock provider (no network, no keys).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-ent-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-ent-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-ent-cwd-"));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], input = ""): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUSCODE_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
      },
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

function writeConfig(config: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, "config.json"), JSON.stringify(config), "utf8");
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite`);
  }
});

describe("nexus agent — budget onExceed:downgrade reroutes before dispatch (§25)", () => {
  it("reroutes an over-budget run onto the cheaper model and proceeds (exit 0)", async () => {
    // Price mock-fast so the pre-run projection is ~$0.5 (512 output tok @ $1000/MTok),
    // far above the $0.0001 per-run cap → the budget verdict is "downgrade".
    writeConfig({
      pricing: { "mock-fast": { inputPer1M: 1000, outputPer1M: 1000 } },
      enterprise: {
        mode: "on",
        principals: [{ id: "alice", roles: ["developer"] }],
        budgets: [
          {
            id: "tiny",
            scope: "principal",
            key: "alice",
            limitUsd: 0.0001,
            window: "run",
            onExceed: "downgrade",
            downgradeTo: "mock/mock-smart",
          },
        ],
      },
    });

    const r = await runCli(["agent", "-p", "mock", "-m", "mock-fast", "--principal", "alice", "hello there"]);

    // The run must PROCEED (not be blocked) after downgrading.
    expect(r.code).toBe(0);
    // The reroute notice names the cheaper target.
    expect(r.stderr).toContain("budget downgrade");
    expect(r.stderr).toContain("mock/mock-smart");
    // It must NOT have been blocked as a plain deny.
    expect(r.stderr).not.toContain("run blocked by budget");
  }, 30_000);

  it("onExceed:deny still blocks an over-budget run (exit 1)", async () => {
    writeConfig({
      pricing: { "mock-fast": { inputPer1M: 1000, outputPer1M: 1000 } },
      enterprise: {
        mode: "on",
        principals: [{ id: "bob", roles: ["developer"] }],
        budgets: [
          {
            id: "hard",
            scope: "principal",
            key: "bob",
            limitUsd: 0.0001,
            window: "run",
            onExceed: "deny",
          },
        ],
      },
    });

    const r = await runCli(["agent", "-p", "mock", "-m", "mock-fast", "--principal", "bob", "hello there"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("run blocked by budget");
  }, 30_000);
});
