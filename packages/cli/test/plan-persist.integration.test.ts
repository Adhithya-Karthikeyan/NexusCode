/**
 * GAPS G3 — `nexus plan` used to draft a plan against a `:memory:` TaskStore
 * and throw it away: nothing ever wrote it into the durable store `nexus task
 * list` reads, so a generated plan could never be listed, and the app's Tasks
 * tab could never show one. `cmdPlan` now persists the settled plan into the
 * durable store BY DEFAULT (ids, parent/subtask structure, and dependency
 * edges intact), with `--no-persist` as the opt-out. These tests exercise
 * that round-trip through the real built binary, across separate invocations
 * (persistence would be meaningless if verified only within one process).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-plan-cfg-")), "cfg");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-plan-cwd-"));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Fresh DATA_DIR per test so persisted tasks from one test never leak into another. */
function freshDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "nx-plan-data-")), "data");
}

function runCli(args: string[], dataDir: string, input = ""): Promise<CliResult> {
  return spawnCli(BIN, args, {
    cwd: WORK_DIR,
    input,
    env: {
      ...process.env,
      NEXUS_CONFIG_DIR: CONFIG_DIR,
      NEXUS_DATA_DIR: dataDir,
      NEXUS_HISTORY_DISABLED: "1",
      NEXUS_VAULT_PASSPHRASE: "test-passphrase",
    },
  });
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  parentId?: string;
  deps: string[];
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite`);
  }
});

describe("nexus plan persistence (GAPS G3)", () => {
  it("persists the drafted plan into the durable store by default — visible to a SEPARATE `task list` invocation", async () => {
    const dataDir = freshDataDir();

    const plan = await runCli(["plan", "build a login page", "-p", "mock", "-m", "mock-tools"], dataDir);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("plan for: build a login page");
    // The confirmation line + at least one printed id (this run's OWN process —
    // not yet proof of cross-invocation durability, just that persistence ran).
    expect(plan.stderr).toMatch(/\[plan\] persisted \d+ tasks? to the durable store/);
    const printedIds = [...plan.stderr.matchAll(/^ {2}(\S+) {2}/gm)].map((m) => m[1] as string);
    expect(printedIds.length).toBeGreaterThan(0);

    // A SEPARATE `nexus task list` invocation — the actual point of G3.
    const list = await runCli(["task", "list", "-o", "json"], dataDir);
    expect(list.code).toBe(0);
    const tasks = JSON.parse(list.stdout.trim()) as TaskRow[];
    expect(tasks.length).toBe(printedIds.length);

    const ids = new Set(tasks.map((t) => t.id));
    for (const id of printedIds) expect(ids.has(id)).toBe(true);

    // Structural integrity: every parentId/dep the durable copy carries must
    // resolve to another task in the SAME persisted set — not dangling, and
    // not silently dropped.
    for (const t of tasks) {
      if (t.parentId !== undefined) expect(ids.has(t.parentId)).toBe(true);
      for (const d of t.deps) expect(ids.has(d)).toBe(true);
    }
  }, 30_000);

  it("`--no-persist` previews the plan but writes nothing to the durable store", async () => {
    const dataDir = freshDataDir();

    const plan = await runCli(
      ["plan", "--no-persist", "build a login page", "-p", "mock", "-m", "mock-tools"],
      dataDir,
    );
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain("plan for: build a login page");
    expect(plan.stderr).toContain("[plan] --no-persist: not written to the durable store");
    expect(plan.stderr).not.toMatch(/\[plan\] persisted/);

    const list = await runCli(["task", "list", "-o", "json"], dataDir);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout.trim())).toEqual([]);
  }, 30_000);
});
