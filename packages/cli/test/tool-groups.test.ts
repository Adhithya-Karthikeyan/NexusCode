/**
 * Wave-9 tool-group wiring tests. All OFFLINE: the db group is exercised against
 * a REAL, local SQLite file (better-sqlite3, no network); the network/write and
 * optional-integration paths assert the PermissionGate denial and the graceful
 * "not installed" degradation WITHOUT ever touching a real network / cloud / DB
 * or launching a browser.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusConfig, type NexusConfig as NexusConfigT } from "@nexuscode/config";
import { ToolRegistry } from "@nexuscode/tools";
import {
  buildToolGroup,
  groupOfTool,
  registerToolGroups,
  reportToolGroups,
  probeIntegrations,
  TOOL_GROUP_NAMES,
} from "../src/tool-groups.js";
import { cmdTools, type Io } from "../src/commands.js";
import type { ParsedArgs } from "../src/args.js";

// ── helpers ────────────────────────────────────────────────────────────────

function cfg(overrides: Record<string, unknown> = {}): NexusConfigT {
  return NexusConfig.parse({ tools: overrides });
}

function allGroupsConfig(): NexusConfigT {
  return cfg({ enabledGroups: [...TOOL_GROUP_NAMES] });
}

interface Capture {
  out: string;
  err: string;
  io: Io;
}
function capture(): Capture {
  const c: Capture = {
    out: "",
    err: "",
    io: {
      out: (s: string) => {
        c.out += s;
      },
      err: (s: string) => {
        c.err += s;
      },
    },
  };
  return c;
}

function makeArgs(opts: {
  positionals?: string[];
  flags?: Record<string, string>;
  multi?: Record<string, string[]>;
  bools?: string[];
}): ParsedArgs {
  return {
    positionals: opts.positionals ?? [],
    flags: new Map(Object.entries(opts.flags ?? {})),
    multi: new Map(Object.entries(opts.multi ?? {})),
    bools: new Set(opts.bools ?? []),
  };
}

/** Run a command handler with an isolated user-config dir carrying `toolsCfg`. */
async function withConfig(
  toolsCfg: Record<string, unknown>,
  fn: (run: (args: ParsedArgs) => Promise<{ code: number } & Capture>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nx-toolscfg-"));
  const prev = process.env.NEXUS_CONFIG_DIR;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ tools: toolsCfg }));
  process.env.NEXUS_CONFIG_DIR = dir;
  try {
    await fn(async (args) => {
      const c = capture();
      const code = await cmdTools(args, c.io);
      return { code, ...c };
    });
  } finally {
    if (prev === undefined) delete process.env.NEXUS_CONFIG_DIR;
    else process.env.NEXUS_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── pure module: catalog, grouping, registration ─────────────────────────────

describe("tool-groups module — catalog + registration", () => {
  it("every group builds its declared tools with a coarse permission class", () => {
    const config = allGroupsConfig();
    for (const g of TOOL_GROUP_NAMES) {
      const tools = buildToolGroup(g, config);
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        expect(["read", "write", "exec", "network"]).toContain(t.permission);
        expect(groupOfTool(t.name)).toBe(g);
      }
    }
  });

  it("registerToolGroups only registers ENABLED groups (opt-in per project)", () => {
    const reg = new ToolRegistry();
    registerToolGroups(reg, cfg({ enabledGroups: ["db"] }));
    expect(reg.has("db_query")).toBe(true);
    expect(reg.has("db_schema")).toBe(true);
    // A disabled group's tools are absent.
    expect(reg.has("web_fetch")).toBe(false);
    expect(reg.has("cloud_list")).toBe(false);
  });

  it("registers the full known-tool surface when every group is enabled", () => {
    const reg = new ToolRegistry();
    const result = registerToolGroups(reg, allGroupsConfig());
    const names = reg.names();
    for (const expected of [
      "web_search",
      "web_fetch",
      "web_crawl",
      "browser_navigate",
      "db_query",
      "db_schema",
      "cloud_list",
      "cloud_describe",
      "docker_ps",
      "k8s_get",
      "ai_vision",
      "ai_ocr",
    ]) {
      expect(names).toContain(expected);
    }
    // Every group reported.
    expect(result.map((r) => r.group).sort()).toEqual([...TOOL_GROUP_NAMES].sort());
  });

  it("never overwrites an already-registered (e.g. built-in / MCP) tool name", () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "db_query",
      description: "pre-existing",
      parameters: { type: "object" },
      permission: "read",
      run: async () => ({ ok: true, content: [{ type: "text", text: "builtin" }] }),
    });
    // Should not throw on the duplicate name; it is skipped.
    expect(() => registerToolGroups(reg, cfg({ enabledGroups: ["db"] }))).not.toThrow();
    expect(reg.get("db_query").description).toBe("pre-existing");
  });

  it("probes optional integrations: sqlite present, postgres absent (offline)", async () => {
    const db = await probeIntegrations("db");
    const sqlite = db.find((i) => i.name === "better-sqlite3");
    const pg = db.find((i) => i.name === "pg");
    expect(sqlite?.available).toBe(true); // repo dependency
    expect(pg?.available).toBe(false); // not installed
    // web declares no optional integration (native fetch).
    expect(await probeIntegrations("web")).toEqual([]);
  });

  it("reportToolGroups reflects enabled state per group", async () => {
    const reports = await reportToolGroups(cfg({ enabledGroups: ["db", "web"] }));
    const byName = new Map(reports.map((r) => [r.group, r]));
    expect(byName.get("db")?.enabled).toBe(true);
    expect(byName.get("web")?.enabled).toBe(true);
    expect(byName.get("cloud")?.enabled).toBe(false);
    expect(byName.get("db")?.toolNames).toContain("db_schema");
  });
});

// ── `nexus tools list` ───────────────────────────────────────────────────────

describe("nexus tools list", () => {
  it("lists the new tools grouped, with permission + integration availability (json)", async () => {
    await withConfig({ enabledGroups: ["db", "web", "cloud"] }, async (run) => {
      const r = await run(makeArgs({ positionals: ["list"], flags: { output: "json" } }));
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out) as {
        groups: Array<{ group: string; enabled: boolean; tools: string[]; integrations: unknown[] }>;
        tools: Array<{ name: string; permission: string; group: string; enabled: boolean }>;
      };
      // All six groups are reported (enabled or not).
      expect(parsed.groups.map((g) => g.group).sort()).toEqual([...TOOL_GROUP_NAMES].sort());
      const db = parsed.groups.find((g) => g.group === "db");
      expect(db?.enabled).toBe(true);
      expect(db?.tools).toContain("db_schema");
      // Tool rows carry permission + group.
      const fetchRow = parsed.tools.find((t) => t.name === "web_fetch");
      expect(fetchRow?.permission).toBe("network");
      expect(fetchRow?.group).toBe("web");
      const schemaRow = parsed.tools.find((t) => t.name === "db_schema");
      // db tools declare a fail-closed `network` ceiling (refined per call at
      // gate time: sqlite→read, remote drivers→network, sqlite mutation→write).
      expect(schemaRow?.permission).toBe("network");
    });
  });

  it("text output groups tools and marks enabled/disabled", async () => {
    await withConfig({ enabledGroups: ["db"] }, async (run) => {
      const r = await run(makeArgs({ positionals: ["list"] }));
      expect(r.code).toBe(0);
      expect(r.out).toContain("db_query");
      expect(r.out).toContain("[on ] db");
      expect(r.out).toContain("[off] cloud");
    });
  });
});

// ── `nexus tools run` — read-class tool against a REAL local SQLite ──────────

describe("nexus tools run — read-class db tool (offline SQLite)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "nx-db-"));
    const { default: Database } = (await import("better-sqlite3")) as unknown as {
      default: new (p: string) => { exec(s: string): void; close(): void };
    };
    const db = new Database(join(workspace, "app.db"));
    db.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    db.exec("INSERT INTO widgets (name) VALUES ('alpha'), ('beta');");
    db.close();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("db_schema runs in read-only mode and introspects the table", async () => {
    await withConfig({ enabledGroups: ["db"] }, async (run) => {
      const r = await run(
        makeArgs({
          positionals: ["run", "db_schema"],
          flags: { cwd: workspace, output: "json" },
          multi: { args: [JSON.stringify({ connection: { driver: "sqlite", file: "app.db" } })] },
        }),
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out) as { ok: boolean; content: Array<{ type: string; text?: string }> };
      expect(parsed.ok).toBe(true);
      const text = parsed.content.map((b) => b.text ?? "").join("");
      expect(text).toContain("widgets");
      expect(text).toContain("name");
    });
  });

  it("db_query resolves a NAMED connection from config", async () => {
    await withConfig(
      { enabledGroups: ["db"], db: { connections: { app: { driver: "sqlite", file: "app.db" } } } },
      async (run) => {
        const r = await run(
          makeArgs({
            positionals: ["run", "db_query"],
            flags: { cwd: workspace, output: "json" },
            multi: { args: [JSON.stringify({ connection: "app", sql: "SELECT COUNT(*) AS n FROM widgets" })] },
          }),
        );
        expect(r.code).toBe(0);
        const parsed = JSON.parse(r.out) as { ok: boolean; content: Array<{ text?: string }> };
        expect(parsed.ok).toBe(true);
        expect(parsed.content.map((b) => b.text ?? "").join("")).toContain('"n": 2');
      },
    );
  });
});

// ── `nexus tools run` — PermissionGate + graceful degradation ────────────────

describe("nexus tools run — permissions + optional integration absent", () => {
  it("a NETWORK tool is denied in read-only mode (needs approval)", async () => {
    await withConfig({ enabledGroups: ["web"] }, async (run) => {
      const r = await run(
        makeArgs({
          positionals: ["run", "web_fetch"],
          multi: { args: [JSON.stringify({ url: "https://example.com" })] },
        }),
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("not permitted");
      // Crucially: the tool never ran (no network) — the gate blocked it.
    });
  });

  it("an allowlisted network tool passes the gate even in read-only mode", async () => {
    // cloud_list is network; allowlisted ⇒ gate allows, then it degrades to a
    // clean 'unavailable' (no SDK/creds) — proving approval path + graceful absence.
    await withConfig({ enabledGroups: ["cloud"], allow: ["cloud_list"] }, async (run) => {
      const r = await run(
        makeArgs({
          positionals: ["run", "cloud_list"],
          multi: { args: [JSON.stringify({ vendor: "aws", resourceType: "s3" })] },
        }),
      );
      // It passed the gate (no "not permitted"); the tool itself reports unavailable.
      expect(r.err).not.toContain("not permitted");
      expect(r.code).toBe(1);
      expect(`${r.out}${r.err}`.toLowerCase()).toContain("unavailable");
    });
  });

  it("a REMOTE db_query is gated as network and denied in read-only mode", async () => {
    // A networked DB call must be classified `network` (not `read`), so read-only
    // mode blocks it before any socket opens — closing the escalation-ladder gap.
    await withConfig({ enabledGroups: ["db"] }, async (run) => {
      const r = await run(
        makeArgs({
          positionals: ["run", "db_query"],
          multi: { args: [JSON.stringify({ connection: { driver: "postgres", host: "localhost" }, sql: "SELECT 1" })] },
        }),
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("not permitted");
    });
  });

  it("optional integration absent ⇒ clean 'not installed', never a crash (postgres)", async () => {
    // Allowlist db_query so it passes the (now network-class) gate; the postgres
    // driver is absent ⇒ the tool returns a clean isError result (no crash).
    await withConfig({ enabledGroups: ["db"], allow: ["db_query"] }, async (run) => {
      const r = await run(
        makeArgs({
          positionals: ["run", "db_query"],
          flags: { output: "json" },
          multi: { args: [JSON.stringify({ connection: { driver: "postgres", host: "localhost" }, sql: "SELECT 1" })] },
        }),
      );
      const parsed = JSON.parse(r.out) as { ok: boolean; content: Array<{ text?: string }> };
      expect(parsed.ok).toBe(false);
      expect(parsed.content.map((b) => b.text ?? "").join("")).toContain("not installed");
      expect(r.code).toBe(1);
    });
  });

  it("a tool from a DISABLED group is not runnable until the group is enabled", async () => {
    await withConfig({ enabledGroups: [] }, async (run) => {
      const r = await run(
        makeArgs({
          positionals: ["run", "cloud_list"],
          multi: { args: [JSON.stringify({ vendor: "aws", resourceType: "s3" })] },
        }),
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("cloud");
      expect(r.err).toContain("not enabled");
    });
  });
});
