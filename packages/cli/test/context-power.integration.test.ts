/**
 * Wave-5 context-power integration tests — drive the real `nexus` binary end to
 * end, fully offline (mock provider + deterministic hashing embedder + temp
 * dirs). Covers: `index` then `search` returns a cited chunk; the response cache
 * short-circuits an identical `ask` and reports token savings; `cache stats` /
 * `cache clear`; and `doctor` surfacing the rag/repomap/cache subsystems.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-cp-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-cp-data-")), "data");
const CACHE_DIR = join(mkdtempSync(join(tmpdir(), "nx-cp-cache-")), "cache");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-cp-cwd-"));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], input = "", extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUS_CACHE_DIR: CACHE_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
        ...extraEnv,
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

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite`);
  }
  // A tiny cross-referencing fixture project inside the working dir.
  writeFileSync(
    join(WORK_DIR, "router.ts"),
    [
      "// The router selects a provider candidate for a request.",
      "export function selectProvider(rule: string): string {",
      "  return chooseCandidate(rule);",
      "}",
      "export function chooseCandidate(rule: string): string {",
      "  return rule.includes('cheap') ? 'ollama' : 'anthropic';",
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(WORK_DIR, "cache.ts"),
    [
      "// The response cache short-circuits identical requests to save tokens.",
      "import { selectProvider } from './router.js';",
      "export function cachedSelect(rule: string): string {",
      "  return selectProvider(rule);",
      "}",
    ].join("\n"),
    "utf8",
  );
});

describe("nexus index + search (RAG, offline hashing embedder)", () => {
  it("indexes the working dir, then search returns a cited chunk", async () => {
    const idx = await runCli(["index", "-o", "json"]);
    expect(idx.code).toBe(0);
    const idxObj = JSON.parse(idx.stdout.trim()) as {
      documents: number;
      chunks: number;
      repoMap: { symbols: number };
    };
    expect(idxObj.documents).toBeGreaterThan(0);
    expect(idxObj.chunks).toBeGreaterThan(0);
    expect(idxObj.repoMap.symbols).toBeGreaterThan(0);

    const search = await runCli(["search", "-o", "json", "response cache saves tokens"]);
    expect(search.code).toBe(0);
    const results = JSON.parse(search.stdout.trim()) as Array<{
      score: number;
      text: string;
      citation: { source: string | null; docId: string; span: { start: number; end: number } };
    }>;
    expect(results.length).toBeGreaterThan(0);
    // The top hit carries a citation pointing at a real source file + span.
    expect(results[0]!.citation.source).toBeTruthy();
    expect(typeof results[0]!.citation.span.start).toBe("number");
    // And it retrieved the cache-related chunk.
    const joined = results.map((r) => r.text).join("\n");
    expect(joined.toLowerCase()).toContain("cache");
  }, 30_000);

  it("text mode prints a cited chunk line (source:span score)", async () => {
    const search = await runCli(["search", "provider candidate"]);
    expect(search.code).toBe(0);
    expect(search.stdout).toMatch(/\.ts:\d+-\d+\s+score=/);
  }, 30_000);
});

describe("nexus ask response cache (CAG short-circuit + savings)", () => {
  it("a second identical run is served from cache with token savings", async () => {
    const enable = await runCli(["config", "set", "cache.enabled", "true"]);
    expect(enable.code).toBe(0);

    const first = await runCli(["ask", "-p", "mock", "hello-cache-run"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Echo: hello-cache-run");
    expect(first.stderr).not.toContain("[cache] hit");

    const second = await runCli(["ask", "-p", "mock", "hello-cache-run"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Echo: hello-cache-run");
    expect(second.stderr).toContain("[cache] hit");
    const m = /saved (\d+) tokens/.exec(second.stderr);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  }, 30_000);

  it("cache stats report the persisted response entries, and clear empties them", async () => {
    const stats = await runCli(["cache", "stats", "-o", "json"]);
    expect(stats.code).toBe(0);
    const s = JSON.parse(stats.stdout.trim()) as { responses: number; embeddings: number; enabled: boolean };
    expect(s.enabled).toBe(true);
    expect(s.responses).toBeGreaterThan(0);
    // The index step warmed the embedding cache too.
    expect(s.embeddings).toBeGreaterThan(0);

    const clear = await runCli(["cache", "clear"]);
    expect(clear.code).toBe(0);

    const after = await runCli(["cache", "stats", "-o", "json"]);
    const s2 = JSON.parse(after.stdout.trim()) as { responses: number; embeddings: number };
    expect(s2.responses).toBe(0);
    expect(s2.embeddings).toBe(0);
  }, 30_000);
});

describe("nexus doctor (context-power subsystems)", () => {
  it("reports rag, repomap, and cache lines and stays exit 0", async () => {
    const r = await runCli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[ok\]\s+rag/);
    expect(r.stdout).toMatch(/\[ok\]\s+repomap/);
    expect(r.stdout).toMatch(/\[ok\]\s+cache/);
  }, 30_000);
});
