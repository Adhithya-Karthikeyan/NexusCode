import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PKG = fileURLToPath(new URL("../package.json", import.meta.url));
const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-cli-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-cwd-"));

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
        NEXUSCODE_DATA_DIR: DATA_DIR,
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
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite (CI builds first)`);
  }
});

describe("nexus ask (mock provider)", () => {
  it("streams assistant text to stdout and exits 0", async () => {
    const r = await runCli(["ask", "-p", "mock", "hi there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Echo: hi there");
  }, 20_000);

  it("-o json emits a single valid JSON object with the answer text", async () => {
    const r = await runCli(["ask", "-p", "mock", "-o", "json", "hi there"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as {
      provider: string;
      status: string;
      text: string;
      usage: { outputTokens: number };
    };
    expect(obj.provider).toBe("mock");
    expect(obj.status).toBe("ok");
    expect(obj.text).toContain("Echo: hi there");
    expect(obj.usage.outputTokens).toBeGreaterThan(0);
  }, 20_000);

  it("-o ndjson emits one UiEvent per line (session … text … done)", async () => {
    const r = await runCli(["ask", "-p", "mock", "-o", "ndjson", "stream me"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const events = lines.map((l) => JSON.parse(l) as { t: string });
    const types = events.map((e) => e.t);
    expect(types).toContain("session");
    expect(types).toContain("text");
    expect(types).toContain("done");

    // Every line is a well-formed UiEvent object with a `t` discriminator.
    for (const e of events) expect(typeof e.t).toBe("string");

    // Concatenated text deltas reproduce the streamed answer.
    const text = events
      .filter((e): e is { t: "text"; delta: string } => e.t === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toContain("Echo: stream me");
  }, 20_000);

  it("-o ndjson emits exactly one usage UiEvent per single run (no duplicate from run-end)", async () => {
    const r = await runCli(["ask", "-p", "mock", "-o", "ndjson", "hi"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as { t: string });
    const usageEvents = events.filter((e) => e.t === "usage");
    expect(usageEvents).toHaveLength(1);
    expect(events.filter((e) => e.t === "done")).toHaveLength(1);
  }, 20_000);

  it("reads the prompt from stdin when piped", async () => {
    const r = await runCli(["ask", "-p", "mock", "-o", "json"], "piped question here");
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as { text: string };
    expect(obj.text).toContain("piped question here");
  }, 20_000);

  it("exits non-zero with no prompt and no stdin", async () => {
    const r = await runCli(["ask", "-p", "mock"], "");
    expect(r.code).toBe(2);
  }, 20_000);
});

describe("nexus first-run fallback (no keys, default provider unavailable)", () => {
  it("bare `ask` (no -p) falls back to mock with a one-line notice, exit 0 — never dead-ends", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-fresh-")), "cfg");
    const r = await runCli(["ask", "hi"], "", { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("anthropic");
    expect(r.stderr).toContain("mock");
    expect(r.stdout).toContain("Echo: hi");
  }, 20_000);

  it("explicit -p anthropic still errors clearly when unavailable (explicit path is unchanged)", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-fresh-")), "cfg");
    const r = await runCli(["ask", "-p", "anthropic", "hi"], "", { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("anthropic");
    expect(r.stderr).toContain("not available");
  }, 20_000);

  it("`ask -p mock` regression: exits 0 with no fallback notice", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-fresh-")), "cfg");
    const r = await runCli(["ask", "-p", "mock", "hi"], "", { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("has no key");
  }, 20_000);

  it("`tui` on a non-TTY prints the linear-mode fallback, not the provider dead-end", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-fresh-")), "cfg");
    const r = await runCli(["tui"], "", { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("is not available");
  }, 20_000);
});

describe("nexus doctor", () => {
  it("exits 0 with the mock provider healthy", async () => {
    const r = await runCli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mock");
    expect(r.stdout).toMatch(/\[ok\]\s+mock/);
  }, 20_000);
});

describe("nexus compare (mock lanes)", () => {
  it("-o json returns both lanes settled", async () => {
    const r = await runCli(["compare", "-b", "mock", "-b", "mock:mock-smart", "-o", "json", "greet"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as { kind: string; runs: { model: string }[] };
    expect(obj.kind).toBe("compare");
    expect(obj.runs).toHaveLength(2);
    expect(obj.runs.map((x) => x.model).sort()).toEqual(["mock-fast", "mock-smart"]);
  }, 20_000);
});

describe("nexus keys (never prints secret values)", () => {
  it("stores a key and prints only its redaction", async () => {
    const r = await runCli(["keys", "set", "demoref", "sk-ant-supersecretvalue9999"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("supersecretvalue");
    expect(r.stdout).toContain("sk-ant-…9999");
  }, 20_000);

  it("reads the value from stdin with --stdin (no argv/positional exposure) and never echoes it", async () => {
    const r = await runCli(["keys", "set", "stdinref", "--stdin"], "sk-ant-fromstdinsecret1234\n");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("fromstdinsecret");
    expect(r.stderr).not.toContain("fromstdinsecret");
    expect(r.stdout).toContain("sk-ant-…1234");
  }, 20_000);

  it("errors cleanly with no positional value, no --stdin, and no TTY", async () => {
    const r = await runCli(["keys", "set", "notty-ref"], "");
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
  }, 20_000);
});

describe("nexus config", () => {
  it("set then get round-trips a value; path points at the config file", async () => {
    const set = await runCli(["config", "set", "defaultProvider", "mock"]);
    expect(set.code).toBe(0);
    const get = await runCli(["config", "get", "defaultProvider"]);
    expect(get.code).toBe(0);
    expect(get.stdout).toContain("mock");
    const path = await runCli(["config", "path"]);
    expect(path.stdout).toContain("config.json");
  }, 20_000);

  it("rejects an unknown key without writing the config file (no brick)", async () => {
    const before = await runCli(["config", "get"]);
    expect(before.code).toBe(0);

    const r = await runCli(["config", "set", "badkey.x", "y"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/badkey/);

    // The file on disk is untouched — no "badkey" leaked in, and a later load
    // still succeeds (the classic brick this guards against).
    const after = await runCli(["config", "get"]);
    expect(after.code).toBe(0);
    expect(after.stdout).toBe(before.stdout);
    expect(JSON.parse(after.stdout) as Record<string, unknown>).not.toHaveProperty("badkey");

    const doctor = await runCli(["doctor"]);
    expect(doctor.code).toBe(0);
  }, 20_000);

  it("rejects `__proto__` config keys cleanly instead of polluting Object.prototype", async () => {
    const r = await runCli(["config", "set", "__proto__.x", "y"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    // The child process rejected the write; confirm the *next* process still
    // sees a clean, unpolluted Object.prototype (a polluted prototype would
    // surface as a spurious own-enumerable-like `x` on any plain object).
    const check = await runCli(["config", "get"]);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout) as Record<string, unknown>).not.toHaveProperty("x");
  }, 20_000);
});

describe("nexus bin aliases", () => {
  it("exposes `nexus` as the ONLY global binary", () => {
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin.nexus).toBe("./dist/index.js");
    expect(Object.keys(pkg.bin)).toEqual(["nexus"]);
  });

  // The short `nx` / `ai` aliases were deliberately dropped before the first public
  // release: `nx` is the Nx monorepo build tool's command, so shipping it would
  // silently hijack `nx` for anyone who has Nx installed, and `ai` is generic
  // enough to collide with other tools. Installing NexusCode must not break a
  // user's existing toolchain.
  it("does NOT claim the conflict-prone `nx` or `ai` names", () => {
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin.nx).toBeUndefined();
    expect(pkg.bin.ai).toBeUndefined();
  });
});

describe("nexus memory (durable store round-trip)", () => {
  it("add → list → get → rm round-trips through the durable store", async () => {
    const add = await runCli(["memory", "add", "hustle and validate", "--tier", "long", "--tags", "x,y"]);
    expect(add.code).toBe(0);
    const m = /added (\S+)/.exec(add.stdout);
    expect(m).not.toBeNull();
    const id = m![1]!;

    const list = await runCli(["memory", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain("hustle and validate");

    const get = await runCli(["memory", "get", id, "-o", "json"]);
    expect(get.code).toBe(0);
    const item = JSON.parse(get.stdout.trim()) as { id: string; text: string; tags?: string[] };
    expect(item.id).toBe(id);
    expect(item.text).toBe("hustle and validate");
    expect(item.tags).toEqual(["x", "y"]);

    const rm = await runCli(["memory", "rm", id]);
    expect(rm.code).toBe(0);
    const after = await runCli(["memory", "get", id]);
    expect(after.code).not.toBe(0);
  }, 20_000);
});

// Force the coding CLIs to be treated as absent regardless of what is actually
// installed on the host, so the degradation paths are deterministic offline.
const ABSENT_BINS = {
  NEXUS_CLAUDE_CODE_BIN: "/nonexistent/nx-absent-claude",
  NEXUS_CODEX_BIN: "/nonexistent/nx-absent-codex",
};

describe("nexus providers list (subprocess coding CLIs in the catalog)", () => {
  it("lists claude-code and codex in the catalog", async () => {
    const r = await runCli(["providers", "list", "-o", "json"]);
    expect(r.code).toBe(0);
    const statuses = JSON.parse(r.stdout.trim()) as { id: string; kind: string; available: boolean; detail?: string }[];
    const byId = new Map(statuses.map((s) => [s.id, s]));
    expect(byId.get("claude-code")?.kind).toBe("subprocess");
    expect(byId.get("codex")?.kind).toBe("subprocess");
  }, 20_000);

  it("shows the coding CLIs 'not installed' (never a crash) when the binary is absent", async () => {
    const r = await runCli(["providers", "list", "-o", "json"], "", ABSENT_BINS);
    expect(r.code).toBe(0);
    const statuses = JSON.parse(r.stdout.trim()) as { id: string; available: boolean; detail?: string }[];
    const cc = statuses.find((s) => s.id === "claude-code");
    expect(cc?.available).toBe(false);
    expect(cc?.detail).toMatch(/not installed/);
  }, 20_000);

  it("doctor stays exit 0 with the coding CLIs not installed and reports the mcp line", async () => {
    const r = await runCli(["doctor"], "", ABSENT_BINS);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("claude-code");
    expect(r.stdout).toMatch(/\[--\]\s+claude-code/);
    // No MCP servers configured by default → the doctor line says so.
    expect(r.stdout).toMatch(/mcp servers/);
  }, 20_000);
});

describe("nexus providers list (native cloud models: gemini / bedrock / vertex)", () => {
  // Force a credential-free Gemini env so its needs-key path is deterministic.
  const NO_GEMINI = { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" };

  it("lists gemini, bedrock, and vertex in the catalog (no crash)", async () => {
    const r = await runCli(["providers", "list", "-o", "json"], "", NO_GEMINI);
    expect(r.code).toBe(0);
    const statuses = JSON.parse(r.stdout.trim()) as { id: string; kind: string; available: boolean; needsKey?: boolean }[];
    const byId = new Map(statuses.map((s) => [s.id, s]));
    expect(byId.get("gemini")?.kind).toBe("gemini");
    expect(byId.get("bedrock")?.kind).toBe("bedrock");
    expect(byId.get("vertex")?.kind).toBe("vertex");
    // All register (available) without a network call.
    expect(byId.get("gemini")?.available).toBe(true);
    expect(byId.get("bedrock")?.available).toBe(true);
    expect(byId.get("vertex")?.available).toBe(true);
    // Gemini with no key shows needs-key.
    expect(byId.get("gemini")?.needsKey).toBe(true);
  }, 20_000);

  it("doctor reports the native providers and the LSP line, exit 0", async () => {
    const r = await runCli(["doctor"], "", NO_GEMINI);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/gemini/);
    expect(r.stdout).toMatch(/bedrock/);
    expect(r.stdout).toMatch(/vertex/);
    // LSP subsystem line is present and reports server detection.
    expect(r.stdout).toMatch(/lsp\s+—/);
    expect(r.stdout).toMatch(/language server\(s\) detected/);
  }, 20_000);
});

describe("nexus models (provider-scoped, live listModels + curated fallback)", () => {
  // The reported bug: the model listing dumped EVERY provider's models (the whole
  // global cross-provider catalog). The fix scopes it to ONE provider via the
  // same `listModelsForProvider` runtime helper the TUI `/model` picker uses —
  // live `adapter.listModels()` when reachable, curated fallback otherwise.

  it("`models -p mock` lists ONLY the mock provider's models (no cross-provider leak)", async () => {
    const r = await runCli(["models", "-p", "mock"]);
    expect(r.code).toBe(0);
    // Header names the single scoped provider …
    expect(r.stdout).toMatch(/^mock \(mock\)/m);
    // … and its real models are listed …
    expect(r.stdout).toContain("mock-fast");
    expect(r.stdout).toContain("mock-smart");
    expect(r.stdout).toContain("mock-tools");
    // … while NO other provider's models leak in (the bug).
    expect(r.stdout).not.toContain("gpt-4o");
    expect(r.stdout).not.toContain("gemini");
    expect(r.stdout).not.toContain("claude-3");
    expect(r.stdout).not.toContain("nova-pro");
  }, 20_000);

  it("positional `models mock` is scoped identically to `-p mock`", async () => {
    const r = await runCli(["models", "mock"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mock-fast");
    expect(r.stdout).not.toContain("gpt-4o");
    expect(r.stdout).not.toContain("gemini");
  }, 20_000);

  it("`-o json` emits ONE provider object whose models are all mock-scoped", async () => {
    const r = await runCli(["models", "mock", "-o", "json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as {
      provider: string;
      kind: string;
      available: boolean;
      models: { id: string; hint?: string }[];
    };
    expect(obj.provider).toBe("mock");
    expect(obj.models.length).toBeGreaterThan(0);
    const ids = obj.models.map((m) => m.id);
    expect(ids).toContain("mock-fast");
    // Not a global dump: no foreign-provider model ids present.
    expect(ids.some((id) => id.includes("gpt") || id.includes("gemini"))).toBe(false);
  }, 20_000);

  it("an unknown provider errors clearly (exit 1) instead of dumping the catalog", async () => {
    const r = await runCli(["models", "totally-unknown"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not available");
  }, 20_000);
});

describe("nexus lsp (code intelligence, graceful degradation)", () => {
  it("degrades gracefully (never crashes) with no language server installed", async () => {
    const file = "sample.ts";
    writeFileSync(join(WORK_DIR, file), "export const x = 1;\n", "utf8");
    // With no server on PATH the command reports it and exits 0 (informational);
    // if a real server happens to be installed it returns results — also exit 0.
    const r = await runCli(["lsp", "diagnostics", file]);
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined.length).toBeGreaterThan(0);
    // Either a graceful "no language server" note or real diagnostics output.
    expect(combined).toMatch(/language server|diagnostic|no diagnostics/i);
  }, 20_000);

  it("reports a clear usage error for a missing file argument", async () => {
    const r = await runCli(["lsp", "definition"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/nexus lsp/);
  }, 20_000);
});

describe("nexus code (subprocess coding agent through the engine)", () => {
  beforeAll(() => {
    chmodSync(FAKE_CLAUDE, 0o755);
  });

  it("degrades with a clear message (exit 1) when the CLI is not installed", async () => {
    const r = await runCli(["code", "--agent", "claude-code", "fix the bug"], "", ABSENT_BINS);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/claude-code/);
    expect(r.stderr).toMatch(/not installed/);
  }, 20_000);

  it("drives the fake CLI through the engine and emits diff + tool_result UiEvents (ndjson)", async () => {
    const r = await runCli(
      ["code", "--agent", "claude-code", "-o", "ndjson", "fix the bug"],
      "",
      { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE },
    );
    expect(r.code).toBe(0);
    const events = r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { t: string; path?: string; patch?: string; delta?: string });
    const types = events.map((e) => e.t);
    expect(types).toContain("session");
    expect(types).toContain("diff");
    expect(types).toContain("tool_result");
    expect(types).toContain("done");

    const diff = events.find((e) => e.t === "diff");
    expect(diff?.path).toBe("src/app.ts");
    expect(diff?.patch).toContain("+const a = 2;");
  }, 20_000);
});

describe("nexus mcp (declare + discover tools from an in-process stdio server)", () => {
  it("add → list → tools discovers the fake server's tools → rm", async () => {
    const add = await runCli(["mcp", "add", "fakefs", "--transport", "stdio", "--command", process.execPath, "--args", FAKE_MCP]);
    expect(add.code).toBe(0);
    expect(add.stdout).toMatch(/added mcp server "fakefs"/);

    const list = await runCli(["mcp", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("fakefs");
    expect(list.stdout).toContain("stdio");

    const tools = await runCli(["mcp", "tools"]);
    expect(tools.code).toBe(0);
    expect(tools.stdout).toMatch(/\[ok\]\s+fakefs/);
    expect(tools.stdout).toContain("fakefs__echo");
    expect(tools.stdout).toContain("fakefs__add");

    const toolsJson = await runCli(["mcp", "tools", "-o", "json"]);
    const parsed = JSON.parse(toolsJson.stdout.trim()) as {
      servers: { name: string; connected: boolean; toolCount: number }[];
      tools: { server: string; name: string }[];
    };
    expect(parsed.servers[0]?.connected).toBe(true);
    expect(parsed.servers[0]?.toolCount).toBe(2);
    expect(parsed.tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);

    const rm = await runCli(["mcp", "rm", "fakefs"]);
    expect(rm.code).toBe(0);
    const listAfter = await runCli(["mcp", "list"]);
    expect(listAfter.stdout).not.toContain("fakefs");
  }, 30_000);

  it("mcp tools degrades gracefully (exit 0) when a declared server is unreachable", async () => {
    const add = await runCli(["mcp", "add", "broken", "--transport", "stdio", "--command", "definitely-not-a-real-binary-xyz"]);
    expect(add.code).toBe(0);
    const tools = await runCli(["mcp", "tools"]);
    expect(tools.code).toBe(0);
    expect(tools.stdout).toMatch(/\[--\]\s+broken/);
    expect(tools.stdout).toMatch(/unreachable/);
    await runCli(["mcp", "rm", "broken"]);
  }, 20_000);

  it("rejects an invalid declaration without writing it (stdio needs a command)", async () => {
    const r = await runCli(["mcp", "add", "nocmd", "--transport", "stdio"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/command/);
    const list = await runCli(["mcp", "list"]);
    expect(list.stdout).not.toContain("nocmd");
  }, 20_000);

  it("mcp call invokes a discovered tool and prints its real result", async () => {
    const add = await runCli(["mcp", "add", "callfs", "--transport", "stdio", "--command", process.execPath, "--args", FAKE_MCP]);
    expect(add.code).toBe(0);

    // --json object args
    const echo = await runCli(["mcp", "call", "callfs", "echo", "--json", '{"message":"hi there"}']);
    expect(echo.code).toBe(0);
    expect(echo.stdout).toContain("hi there");

    // --arg K=V scalar coercion (numbers)
    const sum = await runCli(["mcp", "call", "callfs", "add", "--arg", "a=2", "--arg", "b=3"]);
    expect(sum.code).toBe(0);
    expect(sum.stdout.trim()).toContain("5");

    // json output mode returns the structured MCP result
    const asJson = await runCli(["mcp", "call", "callfs", "echo", "--json", '{"message":"J"}', "-o", "json"]);
    expect(asJson.code).toBe(0);
    const parsed = JSON.parse(asJson.stdout.trim()) as { content: { type: string; text?: string }[] };
    expect(parsed.content.some((c) => c.type === "text" && c.text === "J")).toBe(true);

    // unknown tool → exit 1 with the available list
    const bad = await runCli(["mcp", "call", "callfs", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/no tool "nope"/);
    expect(bad.stderr).toMatch(/available:/);

    await runCli(["mcp", "rm", "callfs"]);
  }, 30_000);

  it("mcp add <known-name> seeds the server config from the template (flag-free)", async () => {
    const add = await runCli(["mcp", "add", "kyp-mem"]);
    expect(add.code).toBe(0);
    expect(add.stdout).toMatch(/added mcp server "kyp-mem" \(stdio\)/);

    const list = await runCli(["mcp", "list", "-o", "json"]);
    const servers = JSON.parse(list.stdout.trim()) as {
      name: string;
      transport: string;
      command?: string;
      args: string[];
      env?: Record<string, string>;
    }[];
    const kyp = servers.find((s) => s.name === "kyp-mem");
    expect(kyp).toBeTruthy();
    expect(kyp?.transport).toBe("stdio");
    expect(kyp?.command).toBe("kyp-mem");
    expect(kyp?.args).toEqual(["serve"]);
    expect(kyp?.env?.KYP_VAULT).toBeTruthy();

    // Explicit flags still override the template.
    await runCli(["mcp", "rm", "kyp-mem"]);
    const overridden = await runCli([
      "mcp", "add", "kyp-mem",
      "--command", "/custom/kyp-mem",
      "--env", "KYP_VAULT=/custom/vault",
    ]);
    expect(overridden.code).toBe(0);
    const list2 = await runCli(["mcp", "list", "-o", "json"]);
    const servers2 = JSON.parse(list2.stdout.trim()) as { name: string; command?: string; env?: Record<string, string> }[];
    const kyp2 = servers2.find((s) => s.name === "kyp-mem");
    expect(kyp2?.command).toBe("/custom/kyp-mem");
    expect(kyp2?.env?.KYP_VAULT).toBe("/custom/vault");

    await runCli(["mcp", "rm", "kyp-mem"]);
  }, 20_000);
});

describe("nexus agent (native tool loop, mock-tools)", () => {
  beforeAll(() => {
    writeFileSync(join(WORK_DIR, "agent-note.txt"), "AGENT_FILE_CONTENT", "utf8");
  });

  it("reads a file via the built-in fs_read tool, feeds it back, and answers", async () => {
    const r = await runCli(["agent", "-p", "mock", "-m", "mock-tools", "agent-note.txt"]);
    expect(r.code).toBe(0);
    // Tool activity is on stderr; the final answer (referencing file content) on stdout.
    expect(r.stderr).toContain("[tool-call] fs_read");
    expect(r.stderr).toContain("[tool-result] ok");
    expect(r.stdout).toContain("AGENT_FILE_CONTENT");
  }, 20_000);

  it("-o ndjson surfaces the tool_call + tool_result + text UiEvents", async () => {
    const r = await runCli(["ask", "--tools", "-p", "mock", "-m", "mock-tools", "-o", "ndjson", "agent-note.txt"]);
    expect(r.code).toBe(0);
    const events = r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { t: string });
    const types = events.map((e) => e.t);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("text");
    expect(types).toContain("done");

    const answer = events
      .filter((e): e is { t: "text"; delta: string } => e.t === "text")
      .map((e) => e.delta)
      .join("");
    expect(answer).toContain("AGENT_FILE_CONTENT");
  }, 20_000);
});

describe("nexus agent --role (Wave 7 OODA framework)", () => {
  it("runs the OODA loop for a role, streaming plan/reflect/progress and exiting 0", async () => {
    const r = await runCli([
      "agent",
      "add a hello function",
      "-p",
      "mock",
      "-m",
      "mock-tools",
      "--role",
      "coder",
      "--max-steps",
      "4",
    ]);
    expect(r.code).toBe(0);
    // OODA phases ride the reasoning channel → stderr (not the leaked-prompt bug).
    expect(r.stderr).toContain("observing context and plan");
    expect(r.stderr).toMatch(/Plan updated/);
    expect(r.stderr).toContain("Run finished");
    expect(r.stderr).toContain("[agent] role=coder");
    // The flags were parsed, not leaked into the prompt echoed back by the mock.
    expect(r.stdout).not.toContain("coder 4");
  }, 30_000);

  it("agent --role emits a machine-readable JSON result with the plan", async () => {
    const r = await runCli([
      "agent",
      "do the thing",
      "-p",
      "mock",
      "-m",
      "mock-tools",
      "--role",
      "reviewer",
      "--max-steps",
      "2",
      "-o",
      "json",
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout.trim()) as { role: string; stopReason: string; plan: unknown[] };
    expect(doc.role).toBe("reviewer");
    expect(typeof doc.stopReason).toBe("string");
    expect(Array.isArray(doc.plan)).toBe(true);
  }, 30_000);

  it("rejects an unknown role with a usage error", async () => {
    const r = await runCli(["agent", "x", "-p", "mock", "-m", "mock-tools", "--role", "wizard"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown role/);
  }, 20_000);
});

describe("nexus plan (planner role → task plan)", () => {
  it("drafts a task plan for an objective and exits 0", async () => {
    const r = await runCli(["plan", "build a login page", "-p", "mock", "-m", "mock-tools"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plan for: build a login page");
    expect(r.stderr).toContain("[agent] role=planner");
  }, 30_000);
});

describe("nexus task (durable task management, §15)", () => {
  it("add → list → done → rm round-trips through the durable store", async () => {
    const add = await runCli(["task", "add", "write tests"]);
    expect(add.code).toBe(0);
    const id = add.stdout.trim().split(/\s+/)[1] as string;
    expect(id).toMatch(/^task_/);

    const list = await runCli(["task", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("write tests");
    expect(list.stdout).toContain(id);

    const done = await runCli(["task", "done", id]);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("[done]");

    const rm = await runCli(["task", "rm", id]);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain(`removed ${id}`);
  }, 20_000);

  it("task list is empty and exits 0 on a fresh store", async () => {
    const r = await runCli(["task", "clear"]);
    expect(r.code).toBe(0);
    const list = await runCli(["task", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("no tasks");
  }, 20_000);
});

describe("nexus jobs (terminal integration, §13)", () => {
  it("jobs (no args) lists background jobs and exits 0", async () => {
    const r = await runCli(["jobs"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no background jobs");
  }, 20_000);

  it("jobs run launches a command as a job, streams its output, and records history", async () => {
    const run = await runCli(["jobs", "run", "--", "node", "-e", "console.log('JOB_OK')"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("JOB_OK");
    expect(run.stderr).toContain("[job] exited exit=0");

    const hist = await runCli(["jobs", "history"]);
    expect(hist.code).toBe(0);
    expect(hist.stdout).toContain("node");
  }, 20_000);

  it("jobs pty reports the feature-detected PTY seam and exits 0", async () => {
    const r = await runCli(["jobs", "pty"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pty:/);
  }, 20_000);
});
