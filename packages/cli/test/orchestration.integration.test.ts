/**
 * Wave 3 CLI wiring, exercised end-to-end over the built binary with the offline
 * mock providers: `race` (first/best), `consensus` (judged merge), `chain`
 * (staged hand-offs), `route explain` (which provider a rule picks) and
 * `route test` (a routed run, including a transparent cross-provider failover).
 * No network, no keys — everything runs against mock / mock-flaky.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-orch-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-orch-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-orch-cwd-"));

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
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });
}

interface RunJson {
  provider: string;
  model: string;
  status: string;
  text: string;
}
interface OrchestrationJson {
  kind: string;
  partial: boolean;
  winner: RunJson | null;
  runs: RunJson[];
  merged?: { text: string | null; pickedFrom: string | null; scores: { runId: string; score: number }[] };
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite (CI builds first)`);
  }
});

describe("nexus compare (mock lanes, plain -o text)", () => {
  it("renders each provider lane as a SEPARATE labeled block — not interleaved", async () => {
    const r = await runCli(["compare", "-b", "mock", "-b", "mock:mock-smart", "-o", "text", "hi there"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    // Both lane headers appear, each on its own line.
    const fastHeader = lines.findIndex((l) => l === "── mock:mock-fast ──");
    const smartHeader = lines.findIndex((l) => l === "── mock:mock-smart ──");
    expect(fastHeader).toBeGreaterThanOrEqual(0);
    expect(smartHeader).toBeGreaterThan(fastHeader);
    // The fast lane's answer sits under its own header, before the next lane's
    // header — i.e. the two lanes are NOT interleaved into one line.
    const fastBody = lines.slice(fastHeader + 1, smartHeader).join("\n");
    expect(fastBody).toContain("Echo: hi there");
    // The smart lane's distinctive text is NOT mixed into the fast lane's block.
    expect(fastBody).not.toContain("Considering your request");
    const smartBody = lines.slice(smartHeader + 1).join("\n");
    expect(smartBody).toContain("Considering your request");
    // Per-lane summary footer (status + cost) is emitted to stderr.
    expect(r.stderr).toMatch(/\[lane mock:mock-fast\] status=ok/);
    expect(r.stderr).toMatch(/\[lane mock:mock-smart\] status=ok/);
  }, 20_000);
});

describe("nexus race (mock lanes)", () => {
  it("--mode first settles on a healthy winner and exits 0", async () => {
    const r = await runCli(["race", "-b", "mock", "-b", "mock:mock-smart", "-o", "json", "hi there"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as OrchestrationJson;
    expect(obj.kind).toBe("race");
    expect(obj.winner).not.toBeNull();
    expect(obj.winner!.status).toBe("ok");
    expect(obj.partial).toBe(false);
  }, 20_000);

  it("--mode best runs both lanes and picks a judged winner", async () => {
    const r = await runCli(["race", "--mode", "best", "-b", "mock", "-b", "mock:mock-smart", "-o", "json", "hi"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as OrchestrationJson;
    expect(obj.runs).toHaveLength(2);
    expect(obj.runs.every((x) => x.status === "ok")).toBe(true);
    expect(obj.winner).not.toBeNull();
    // The judge scored both anonymized candidates.
    expect(obj.merged?.scores.length).toBe(2);
  }, 20_000);

  it("-o ndjson emits per-lane events keyed by distinct lanes", async () => {
    const r = await runCli(["race", "-b", "mock", "-b", "mock:mock-smart", "-o", "ndjson", "hi"]);
    expect(r.code).toBe(0);
    const events = r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { t: string; lane?: string });
    expect(events.map((e) => e.t)).toContain("session");
    expect(events.map((e) => e.t)).toContain("text");
    const lanes = new Set(events.filter((e) => e.lane).map((e) => e.lane));
    expect(lanes.size).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("requires at least two backends", async () => {
    const r = await runCli(["race", "-b", "mock", "hi"]);
    expect(r.code).toBe(2);
  }, 20_000);

  it("-o text renders labeled lane blocks then a clear winner line", async () => {
    const r = await runCli(["race", "--mode", "best", "-b", "mock", "-b", "mock:mock-smart", "-o", "text", "hi"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("── mock:mock-fast ──");
    expect(r.stdout).toContain("── mock:mock-smart ──");
    // The settled winner line names the picked provider (not interleaved deltas).
    expect(r.stdout).toMatch(/race — winner mock:mock-(fast|smart)/);
    expect(r.stderr).toMatch(/\[lane mock:mock-\w+\] status=ok winner/);
  }, 20_000);
});

describe("nexus consensus (mock lanes, judged merge)", () => {
  it("reconciles two lanes into a merged answer and exits 0", async () => {
    const r = await runCli(["consensus", "-b", "mock", "-b", "mock:mock-smart", "-o", "json", "hi"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as OrchestrationJson;
    expect(obj.kind).toBe("consensus");
    expect(obj.merged).toBeDefined();
    expect(typeof obj.merged!.text).toBe("string");
    expect(obj.merged!.pickedFrom).not.toBeNull();
    expect(obj.partial).toBe(false);
  }, 20_000);

  it("accepts a --judge model hint without requiring network", async () => {
    const r = await runCli(["consensus", "--judge", "mock-smart", "-b", "mock", "-b", "mock:mock-smart", "-o", "json", "hi"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as OrchestrationJson;
    expect(obj.merged).toBeDefined();
  }, 20_000);
});

describe("nexus chain (staged hand-offs)", () => {
  it("runs the default plan→edit→review preset, threading each hand-off", async () => {
    const r = await runCli(["chain", "-o", "json", "build a thing"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as OrchestrationJson;
    expect(obj.kind).toBe("chain");
    expect(obj.runs).toHaveLength(3);
    expect(obj.runs.every((x) => x.status === "ok")).toBe(true);
    expect(obj.winner).not.toBeNull();
    // The final stage's text is derived from the prior stages (hand-off threaded).
    expect(obj.winner!.text).toContain("build a thing");
  }, 20_000);

  it("accepts an explicit --stages spec", async () => {
    const r = await runCli(["chain", "--stages", "mock:mock-fast,mock:mock-smart", "-o", "json", "plan then write"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as OrchestrationJson;
    expect(obj.runs).toHaveLength(2);
    expect(obj.runs[1]!.model).toBe("mock-smart");
  }, 20_000);
});

describe("nexus route explain", () => {
  it("prints the chosen provider for an explicit rule (text)", async () => {
    const r = await runCli(["route", "explain", "--optimize", "explicit", "--allow", "mock/mock-fast"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("chosen: mock/mock-fast");
  }, 20_000);

  it("-o json returns the chosen candidate and the ordered list", async () => {
    const r = await runCli(["route", "explain", "--optimize", "local", "-o", "json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as {
      optimize: string;
      chosen: { providerId: string; modelId: string; reason: string } | null;
      candidates: { providerId: string; reason: string }[];
    };
    expect(obj.optimize).toBe("local");
    expect(obj.chosen).not.toBeNull();
    // Local runtimes (lmstudio / vllm) sort ahead of the cloud/mock providers.
    expect(["lmstudio", "vllm"]).toContain(obj.chosen!.providerId);
    expect(obj.candidates.length).toBeGreaterThan(1);
  }, 20_000);
});

describe("nexus route test (routed run + live failover)", () => {
  it("runs the chosen provider and streams its answer", async () => {
    const r = await runCli(["route", "test", "--optimize", "explicit", "--allow", "mock/mock-fast", "hi there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Echo: hi there");
    expect(r.stderr).toContain("answered by mock:mock-fast");
  }, 20_000);

  it("fails over from a failing provider to a healthy one (end-to-end)", async () => {
    const r = await runCli([
      "route",
      "test",
      "--optimize",
      "explicit",
      "--allow",
      "mock-flaky/mock-fast",
      "--allow",
      "mock/mock-fast",
      "--retries",
      "1",
      "-o",
      "json",
      "hi",
    ]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as RunJson & { failovers: string[] };
    // The winner is the healthy fallback, reached via a transparent hand-off.
    expect(obj.provider).toBe("mock");
    expect(obj.status).toBe("ok");
    expect(obj.failovers).toContain("mock-flaky→mock");
  }, 20_000);
});

describe("nexus providers list / doctor (default catalog)", () => {
  it("providers list shows the new compat + azure + flaky/slow providers", async () => {
    const r = await runCli(["providers", "list"]);
    expect(r.code).toBe(0);
    for (const id of ["groq", "together", "deepseek", "mistral", "openrouter", "nvidia", "lmstudio", "vllm", "azure-openai", "mock-flaky", "mock-slow"]) {
      expect(r.stdout).toContain(id);
    }
    // Keyless compat providers are marked "needs key", not failed.
    expect(r.stdout).toMatch(/key\s+groq \(openai-compat\) — needs key: GROQ_API_KEY/);
  }, 20_000);

  it("doctor lists the catalog and still exits 0 with only mock credentialed", async () => {
    const r = await runCli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[ok\]\s+mock /);
    expect(r.stdout).toMatch(/\[key\]\s+groq/);
    expect(r.stdout).toContain("azure-openai");
  }, 20_000);
});
