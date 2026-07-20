/**
 * Write-gate, graceful-degradation, and path-confinement behavior. Uses the real
 * SQLite driver for the write-gate, a FAKE resolver for path/close assertions,
 * and the real (missing) optional drivers for graceful degradation — no network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import { PermissionGate } from "@nexuscode/tools";
import { createDbTools, type DbDriver, type DriverResolver } from "../src/index.js";

function ctxFor(cwd: string): ToolContext {
  return { signal: new AbortController().signal, cwd };
}
function textOf(r: ToolResult): string {
  return r.content
    .filter((b: ContentBlock): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}
async function call(tool: Tool, input: unknown, cwd: string): Promise<ToolResult> {
  return (await tool.run(input, ctxFor(cwd))) as ToolResult;
}

describe("db_query — write gate", () => {
  let dir: string;
  let query: Tool;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nexus-db-"));
    query = createDbTools().find((t) => t.name === "db_query")!;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a mutation when write is not set", async () => {
    const res = await call(
      query,
      { connection: { driver: "sqlite", file: "g.db" }, sql: "CREATE TABLE z (a INTEGER)" },
      dir,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("write: true");
  });

  it("allows the same mutation when write: true", async () => {
    const res = await call(
      query,
      { connection: { driver: "sqlite", file: "g.db" }, sql: "CREATE TABLE z (a INTEGER)", write: true },
      dir,
    );
    expect(res.isError).toBeFalsy();
  });

  it("allows a read without write", async () => {
    const res = await call(query, { connection: { driver: "sqlite", file: ":memory:" }, sql: "SELECT 1 AS n" }, dir);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res)).rows[0].n).toBe(1);
  });

  it("refuses DELETE/UPDATE/INSERT without write", async () => {
    for (const sql of ["DELETE FROM z", "UPDATE z SET a = 1", "INSERT INTO z VALUES (1)", "DROP TABLE z"]) {
      const res = await call(query, { connection: { driver: "sqlite", file: ":memory:" }, sql }, dir);
      expect(res.isError, sql).toBe(true);
    }
  });
});

describe("db_query — PermissionGate classification (escalation ladder)", () => {
  const query = createDbTools().find((t) => t.name === "db_query")!;
  const schema = createDbTools().find((t) => t.name === "db_schema")!;
  const sqlite = { driver: "sqlite", file: "app.db" };

  it("denies a REMOTE db_query in read-only mode (no approver ⇒ network ask→deny)", async () => {
    const gate = new PermissionGate({ mode: "read-only" });
    const d = await gate.check(query, { connection: { driver: "postgres" }, sql: "SELECT 1" });
    expect(d.permission).toBe("network");
    expect(d.allowed).toBe(false);
  });

  it("denies a REMOTE db_query in plan mode outright (network deny)", async () => {
    const gate = new PermissionGate({ mode: "plan" });
    const d = await gate.check(query, { connection: { driver: "mysql" }, sql: "SELECT 1" });
    expect(d.permission).toBe("network");
    expect(d.allowed).toBe(false);
  });

  it("allows a LOCAL sqlite read in read-only mode (classified read)", async () => {
    const gate = new PermissionGate({ mode: "read-only" });
    const d = await gate.check(query, { connection: sqlite, sql: "SELECT 1" });
    expect(d.permission).toBe("read");
    expect(d.allowed).toBe(true);
  });

  it("denies a sqlite MUTATION with write:true in read-only mode (classified write)", async () => {
    const gate = new PermissionGate({ mode: "read-only" });
    const d = await gate.check(query, { connection: sqlite, sql: "DELETE FROM t", write: true });
    expect(d.permission).toBe("write");
    expect(d.allowed).toBe(false);
  });

  it("denies a sqlite MUTATION with write:true in plan mode too", async () => {
    const gate = new PermissionGate({ mode: "plan" });
    const d = await gate.check(query, { connection: sqlite, sql: "DROP TABLE t", write: true });
    expect(d.permission).toBe("write");
    expect(d.allowed).toBe(false);
  });

  it("asks (and can approve) a REMOTE db_query in read-only mode with an approver", async () => {
    const gate = new PermissionGate({ mode: "read-only", approve: async () => true });
    const d = await gate.check(query, { connection: { driver: "bigquery" }, sql: "SELECT 1" });
    expect(d.permission).toBe("network");
    expect(d.allowed).toBe(true);
    expect(d.viaApproval).toBe(true);
  });

  it("denies a REMOTE db_schema in read-only mode as well", async () => {
    const gate = new PermissionGate({ mode: "read-only" });
    const d = await gate.check(schema, { connection: { driver: "snowflake" } });
    expect(d.permission).toBe("network");
    expect(d.allowed).toBe(false);
  });

  it("allows a sqlite read/mutation in workspace-write (read allow, write allow)", async () => {
    const gate = new PermissionGate({ mode: "workspace-write", approve: async () => false });
    const read = await gate.check(query, { connection: sqlite, sql: "SELECT 1" });
    expect(read.allowed).toBe(true);
    const write = await gate.check(query, { connection: sqlite, sql: "DELETE FROM t", write: true });
    expect(write.permission).toBe("write");
    expect(write.allowed).toBe(true);
  });
});

describe("optional drivers degrade gracefully", () => {
  const dir = tmpdir();
  it("db_query returns a friendly error when pg is not installed", async () => {
    const query = createDbTools().find((t) => t.name === "db_query")!;
    const res = await call(
      query,
      { connection: { driver: "postgres", host: "localhost", database: "x" }, sql: "SELECT 1" },
      dir,
    );
    expect(res.isError).toBe(true);
    const msg = textOf(res);
    expect(msg).toMatch(/not installed/i);
    expect(msg).toMatch(/npm i pg/);
  });

  it("db_schema returns a friendly error when mysql2 is not installed", async () => {
    const schema = createDbTools().find((t) => t.name === "db_schema")!;
    const res = await call(schema, { connection: { driver: "mysql", host: "localhost" } }, dir);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/npm i mysql2/);
  });

  it("bigquery/snowflake also degrade without crashing", async () => {
    const query = createDbTools().find((t) => t.name === "db_query")!;
    for (const driver of ["snowflake", "bigquery"] as const) {
      const res = await call(query, { connection: { driver }, sql: "SELECT 1" }, dir);
      expect(res.isError, driver).toBe(true);
      expect(textOf(res)).toMatch(/not installed/i);
    }
  });
});

describe("driver seam + lifecycle", () => {
  const dir = tmpdir();
  it("uses the injected resolver and always closes the driver", async () => {
    const close = vi.fn(async () => undefined);
    const fake: DbDriver = {
      dialect: "sqlite",
      query: async () => ({ columns: ["n"], rows: [{ n: 7 }], rowCount: 1, truncated: false }),
      introspect: async () => [{ name: "t", columns: [] }],
      close,
    };
    const resolveDriver: DriverResolver = vi.fn(async () => fake);
    const query = createDbTools({ resolveDriver }).find((t) => t.name === "db_query")!;
    const res = await call(query, { connection: { driver: "sqlite" }, sql: "SELECT 1 AS n" }, dir);
    expect(JSON.parse(textOf(res)).rows[0].n).toBe(7);
    expect(resolveDriver).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the driver even when the query throws", async () => {
    const close = vi.fn(async () => undefined);
    const fake: DbDriver = {
      dialect: "sqlite",
      query: async () => {
        throw new Error("boom");
      },
      introspect: async () => [],
      close,
    };
    const query = createDbTools({ resolveDriver: async () => fake }).find((t) => t.name === "db_query")!;
    const res = await call(query, { connection: { driver: "sqlite" }, sql: "SELECT 1" }, dir);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("boom");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("input validation & path confinement", () => {
  const dir = tmpdir();
  const query = () => createDbTools().find((t) => t.name === "db_query")!;

  it("rejects an unknown driver", async () => {
    await expect(call(query(), { connection: { driver: "oracle" }, sql: "SELECT 1" }, dir)).rejects.toThrow(
      /driver/i,
    );
  });

  it("rejects a non-array params", async () => {
    await expect(
      call(query(), { connection: { driver: "sqlite", file: ":memory:" }, sql: "SELECT 1", params: "nope" }, dir),
    ).rejects.toThrow(/params/i);
  });

  it("rejects a SQLite file path that escapes the workspace", async () => {
    const wd = mkdtempSync(path.join(tmpdir(), "nexus-db-esc-"));
    try {
      const res = await call(query(), { connection: { driver: "sqlite", file: "../../etc/evil.db" }, sql: "SELECT 1" }, wd);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/escapes workspace/i);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});
