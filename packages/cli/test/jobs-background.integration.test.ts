/**
 * GAPS G4 — `nexus jobs list` used to unconditionally report "no background
 * jobs" (empty), even right after `jobs run` launched one, because jobs were
 * tracked only in the launching process's in-memory `ProcessManager`. `jobs
 * run --background` (alias `--bg`) now detaches the command and records it in
 * a durable registry under the data dir, so a LATER, separate invocation can
 * `jobs list` / `jobs logs <id>` / `jobs kill <id>` it. These tests exercise
 * that across real, separate process invocations of the built binary — the
 * whole point of the fix — plus the identity-checked kill safety rule (never
 * signal a pid that no longer matches what was recorded).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-jobs-cfg-")), "cfg");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-jobs-cwd-"));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function freshDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), "nx-jobs-data-")), "data");
}

function runCli(args: string[], dataDir: string): Promise<CliResult> {
  return spawnCli(BIN, args, {
    cwd: WORK_DIR,
    env: {
      ...process.env,
      NEXUS_CONFIG_DIR: CONFIG_DIR,
      NEXUS_DATA_DIR: dataDir,
      NEXUS_HISTORY_DISABLED: "1",
      NEXUS_VAULT_PASSPHRASE: "test-passphrase",
    },
  });
}

interface JobRow {
  id: string;
  pid: number;
  command: string;
  args: string[];
  status: string;
  exitCode: number | null;
  signal: string | null;
}

async function pollUntil(
  fn: () => Promise<JobRow | undefined>,
  predicate: (row: JobRow | undefined) => boolean,
  timeoutMs = 10_000,
  intervalMs = 200,
): Promise<JobRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: JobRow | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite`);
  }
});

describe("nexus jobs --background (GAPS G4)", () => {
  it("a job launched with --bg is listable, has its logs readable, from a SEPARATE invocation", async () => {
    const dataDir = freshDataDir();

    const launch = await runCli(
      ["jobs", "run", "--bg", "-o", "json", "--", "node", "-e", "console.log('BG_JOB_OK')"],
      dataDir,
    );
    expect(launch.code).toBe(0);
    const launched = JSON.parse(launch.stdout.trim()) as { id: string; background: boolean };
    expect(launched.background).toBe(true);
    expect(launched.id).toMatch(/^job_/);

    // SEPARATE invocation: `jobs list` must see it (poll — the detached
    // command may finish before we get to check, that's fine, we just want
    // to observe a settled terminal state rather than racing it).
    const settled = await pollUntil(
      async () => {
        const list = await runCli(["jobs", "list", "-o", "json"], dataDir);
        const jobs = JSON.parse(list.stdout.trim()) as JobRow[];
        return jobs.find((j) => j.id === launched.id);
      },
      (row) => row !== undefined && row.status !== "running",
    );
    expect(settled).toBeDefined();
    expect(settled?.status).toBe("exited");
    expect(settled?.exitCode).toBe(0);

    // SEPARATE invocation: `jobs logs <id>` reads the captured output.
    const logs = await runCli(["jobs", "logs", launched.id], dataDir);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("BG_JOB_OK");
  }, 30_000);

  it("`jobs kill <id>` stops a running background job from a SEPARATE invocation, then reports it killed", async () => {
    const dataDir = freshDataDir();

    const launch = await runCli(
      ["jobs", "run", "--bg", "-o", "json", "--", "node", "-e", "setInterval(function(){}, 1000)"],
      dataDir,
    );
    expect(launch.code).toBe(0);
    const launched = JSON.parse(launch.stdout.trim()) as { id: string };

    // Confirm it is actually running before we try to kill it.
    const running = await pollUntil(
      async () => {
        const list = await runCli(["jobs", "list", "-o", "json"], dataDir);
        const jobs = JSON.parse(list.stdout.trim()) as JobRow[];
        return jobs.find((j) => j.id === launched.id);
      },
      (row) => row !== undefined,
    );
    expect(running?.status).toBe("running");
    const pid = running?.pid as number;

    const kill = await runCli(["jobs", "kill", launched.id, "-o", "json"], dataDir);
    expect(kill.code).toBe(0);
    expect(JSON.parse(kill.stdout.trim())).toMatchObject({ id: launched.id, ok: true, status: "killed" });

    // The OS process is actually gone, not just the record.
    expect(() => process.kill(pid, 0)).toThrow();

    const after = await runCli(["jobs", "list", "-o", "json"], dataDir);
    const jobs = JSON.parse(after.stdout.trim()) as JobRow[];
    expect(jobs.find((j) => j.id === launched.id)?.status).toBe("killed");
  }, 30_000);

  it("`jobs kill`/`jobs logs` on an unknown id fail clearly (exit 1), not silently", async () => {
    const dataDir = freshDataDir();
    const kill = await runCli(["jobs", "kill", "job_does_not_exist"], dataDir);
    expect(kill.code).toBe(1);
    expect(kill.stderr).toContain('no background job "job_does_not_exist"');

    const logs = await runCli(["jobs", "logs", "job_does_not_exist"], dataDir);
    expect(logs.code).toBe(1);
    expect(logs.stderr).toContain('no background job "job_does_not_exist"');
  }, 20_000);

  it("`jobs kill` refuses to signal a pid whose recorded identity no longer matches (pid-reuse safety)", async () => {
    const dataDir = freshDataDir();

    // A real, currently-alive process to serve as "some unrelated process
    // that now happens to occupy a recycled pid" from the registry's POV.
    const bystander = await runCli(
      ["jobs", "run", "--bg", "-o", "json", "--", "node", "-e", "setInterval(function(){}, 1000)"],
      dataDir,
    );
    const bystanderInfo = JSON.parse(bystander.stdout.trim()) as { id: string };
    const row = await pollUntil(
      async () => {
        const list = await runCli(["jobs", "list", "-o", "json"], dataDir);
        const jobs = JSON.parse(list.stdout.trim()) as JobRow[];
        return jobs.find((j) => j.id === bystanderInfo.id);
      },
      (r) => r !== undefined,
    );
    const pid = row?.pid as number;

    // Hand-craft a registry entry pointing a DIFFERENT job id at that same
    // live pid, but with a command name that cannot possibly match — exactly
    // what a recycled pid pointed at an unrelated process would look like.
    const registryFile = join(dataDir, "jobs.json");
    const raw = JSON.parse(readFileSync(registryFile, "utf8")) as { version: 1; jobs: unknown[] };
    raw.jobs.push({
      id: "job_impersonator",
      pid,
      command: "definitely-not-node",
      args: [],
      cwd: WORK_DIR,
      logFile: join(dataDir, "job-logs", "job_impersonator.log"),
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      signal: null,
      endedAt: null,
    });
    writeFileSync(registryFile, JSON.stringify(raw, null, 2));

    const kill = await runCli(["jobs", "kill", "job_impersonator"], dataDir);
    expect(kill.code).toBe(1);
    expect(kill.stderr).toMatch(/refusing to signal/);

    // The bystander process must have survived the refused kill attempt.
    expect(() => process.kill(pid, 0)).not.toThrow();

    // Clean up the real bystander process so the test doesn't leak it.
    const realKill = await runCli(["jobs", "kill", bystanderInfo.id], dataDir);
    expect(realKill.code).toBe(0);
  }, 30_000);
});
