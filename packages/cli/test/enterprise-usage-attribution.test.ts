/**
 * Regression tests for two enterprise-CLI defects, driven end-to-end through
 * the built binary (offline: no provider, no network, no keys).
 *
 *  1. `nexus usage` FABRICATED principal attribution. The run history has no
 *     principal column, yet the command re-recorded every historical run under
 *     whoever happened to be calling — so `NEXUS_PRINCIPAL=bob nexus usage`
 *     reported alice's runs as bob's, and handed a read-only `viewer` the
 *     organization's total spend.
 *
 *  2. `budget set` silently no-op'd whenever a `config.yaml` existed: the
 *     loader returns on the FIRST matching candidate (`config.yaml` before
 *     `config.json`) while the writer always emitted `config.json`, so the
 *     write landed in a permanently shadowed file and still reported success.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One isolated HOME-equivalent sandbox: its own config dir, data dir and cwd. */
function sandbox(): { configDir: string; dataDir: string; workDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nx-usage-"));
  const configDir = join(root, "cfg");
  const dataDir = join(root, "data");
  const workDir = join(root, "cwd");
  for (const d of [configDir, dataDir, workDir]) mkdirSync(d, { recursive: true });
  return { configDir, dataDir, workDir };
}

function runCli(
  box: { configDir: string; dataDir: string; workDir: string },
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: box.workDir,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: box.configDir,
        NEXUS_DATA_DIR: box.dataDir,
        NEXUSCODE_DATA_DIR: box.dataDir,
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end("");
  });
}

/**
 * Seed a history database with one settled run. Mirrors the `run_summary`
 * schema in `src/history.ts` — note it has NO principal column, which is the
 * whole reason per-principal figures cannot honestly be derived from it.
 */
async function seedHistory(dbPath: string, runId: string): Promise<void> {
  const { default: Database } = (await import("better-sqlite3")) as unknown as {
    default: new (p: string) => {
      exec(sql: string): unknown;
      prepare(sql: string): { run(...p: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS run_summary (
    run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
    finish_reason TEXT, text TEXT NOT NULL, input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, cost_usd REAL, created_at INTEGER NOT NULL)`);
  db.prepare(
    `INSERT INTO run_summary VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(runId, "s1", "t1", "mock", "mock-model", "ok", "stop", "hi", 100, 50, 0.25, Date.now());
  db.close();
}

/** Enterprise config with alice=admin and bob=viewer. */
const ENTERPRISE_CONFIG = {
  enterprise: {
    mode: "on",
    defaultPrincipal: "alice",
    principals: [
      { id: "alice", roles: ["admin"] },
      { id: "bob", roles: ["viewer"] },
    ],
  },
};

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite`);
  }
});

describe("nexus usage — honest attribution (no invented per-principal figures)", () => {
  it("never reports org-wide history as the CALLER's own spend", async () => {
    const box = sandbox();
    const dbPath = join(box.dataDir, "history.db");
    await seedHistory(dbPath, "run-alice-1");
    writeFileSync(join(box.configDir, "config.json"), JSON.stringify(ENTERPRISE_CONFIG), "utf8");

    // alice is an admin, so she may read the org-wide report.
    const res = await runCli(box, ["usage", "-o", "json"], {
      NEXUS_HISTORY_DB: dbPath,
      NEXUS_PRINCIPAL: "alice",
    });
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout) as {
      scope: string;
      attribution: string;
      byPrincipal: Record<string, { count: number }>;
      totals: { count: number };
    };
    expect(report.totals.count).toBe(1);
    // The figures are labelled for what they are…
    expect(report.scope).toBe("org-wide");
    expect(report.attribution).toBe("none");
    // …and the run is NOT claimed as the caller's.
    expect(Object.keys(report.byPrincipal)).toEqual(["(unattributed)"]);
    expect(report.byPrincipal["alice"]).toBeUndefined();
  });

  it("denies a viewer-role principal the org-wide spend report", async () => {
    const box = sandbox();
    const dbPath = join(box.dataDir, "history.db");
    await seedHistory(dbPath, "run-alice-1");
    writeFileSync(join(box.configDir, "config.json"), JSON.stringify(ENTERPRISE_CONFIG), "utf8");

    const res = await runCli(box, ["usage"], {
      NEXUS_HISTORY_DB: dbPath,
      NEXUS_PRINCIPAL: "bob",
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/DENY/);
    expect(res.stderr).toMatch(/bob/);
    // No spend figure leaks on the denied path.
    expect(res.stdout).not.toMatch(/cost=\$/);
  });

  it("states the org-wide scope in the human-readable report", async () => {
    const box = sandbox();
    const dbPath = join(box.dataDir, "history.db");
    await seedHistory(dbPath, "run-alice-1");
    writeFileSync(join(box.configDir, "config.json"), JSON.stringify(ENTERPRISE_CONFIG), "utf8");

    const res = await runCli(box, ["usage"], {
      NEXUS_HISTORY_DB: dbPath,
      NEXUS_PRINCIPAL: "alice",
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/ORG-WIDE/);
    expect(res.stdout).toMatch(/no per-principal attribution/);
    // The old, false claim must be gone.
    expect(res.stdout).not.toMatch(/attributed to alice/);
  });

  it("leaves single-user (enterprise off) usage working — nothing to gate", async () => {
    const box = sandbox();
    const dbPath = join(box.dataDir, "history.db");
    await seedHistory(dbPath, "run-solo-1");
    // No enterprise config at all: mode defaults off.
    const res = await runCli(box, ["usage"], { NEXUS_HISTORY_DB: dbPath });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/1 run\(s\)/);
  });
});

describe("user-config writes target the file the loader actually reads", () => {
  it("does not silently succeed when a config.yaml shadows config.json", async () => {
    const box = sandbox();
    // A real YAML user config — first in the loader's probe order, so it wins.
    writeFileSync(
      join(box.configDir, "config.yaml"),
      "defaultProvider: mock\nenterprise:\n  mode: on\n",
      "utf8",
    );

    const res = await runCli(box, [
      "budget", "set",
      "--id", "b1", "--scope", "org", "--key", "acme",
      "--limit", "10", "--window", "day",
    ]);

    // The old behavior: exit 0, "budget b1 set", and config.json created but
    // permanently shadowed. Now it must fail loudly and name the winning file.
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/config\.yaml/);
    expect(res.stderr).toMatch(/precedence/);
    expect(res.stdout).not.toMatch(/budget "b1" set/);
    // Critically: no shadowed file was left behind pretending to hold the budget.
    const shadowed = join(box.configDir, "config.json");
    if (existsSync(shadowed)) {
      expect(readFileSync(shadowed, "utf8")).not.toMatch(/b1/);
    }
    rmSync(box.configDir, { recursive: true, force: true });
  });

  it("fails `config set` loudly (not with a stack trace) under a shadowing config.yaml", async () => {
    // Every writeUserConfig caller is affected, not just `budget set`. The
    // message must stay readable — it is the only thing telling the user which
    // file is winning.
    const box = sandbox();
    writeFileSync(join(box.configDir, "config.yaml"), "defaultProvider: mock\n", "utf8");

    const res = await runCli(box, ["config", "set", "defaultModel", "gpt-4o"]);
    expect(res.code).toBe(1);
    const message = `${res.stdout}${res.stderr}`;
    expect(message).toMatch(/config\.yaml/);
    expect(message).toMatch(/precedence/);
    // A raw stack trace would bury the explanation.
    expect(message).not.toMatch(/\s+at .+:\d+:\d+/);
    expect(existsSync(join(box.configDir, "config.json"))).toBe(false);
  });

  it("writes into the .nexusrc the loader reads instead of a shadowed config.json", async () => {
    const box = sandbox();
    // `.nexusrc` outranks `config.json` and holds JSON, so it can be updated
    // in place — the write must land THERE, not in a new shadowed config.json.
    const rc = join(box.configDir, ".nexusrc");
    writeFileSync(rc, JSON.stringify({ defaultProvider: "mock" }), "utf8");

    const res = await runCli(box, [
      "budget", "set",
      "--id", "b1", "--scope", "org", "--key", "acme",
      "--limit", "10", "--window", "day",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/\.nexusrc/);

    const written = JSON.parse(readFileSync(rc, "utf8")) as {
      defaultProvider: string;
      enterprise: { budgets: { id: string; limitUsd: number }[] };
    };
    // Merged, not clobbered.
    expect(written.defaultProvider).toBe("mock");
    expect(written.enterprise.budgets[0]?.id).toBe("b1");
    expect(written.enterprise.budgets[0]?.limitUsd).toBe(10);
    // And nothing shadowed was created.
    expect(existsSync(join(box.configDir, "config.json"))).toBe(false);
  });

  it("still writes config.json on a fresh install and the budget takes effect", async () => {
    const box = sandbox();
    const res = await runCli(box, [
      "budget", "set",
      "--id", "b1", "--scope", "org", "--key", "acme",
      "--limit", "10", "--window", "day",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/config\.json/);

    // The round trip that mattered: `budget show` reads through the real
    // precedence-aware loader and must see what `set` just wrote.
    const show = await runCli(box, ["budget", "show", "-o", "json"]);
    expect(show.code).toBe(0);
    const parsed = JSON.parse(show.stdout) as { budgets: { id: string }[] };
    expect(parsed.budgets.map((b) => b.id)).toContain("b1");
  });
});
