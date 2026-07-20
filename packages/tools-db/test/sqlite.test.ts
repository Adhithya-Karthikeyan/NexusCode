/**
 * SQLite driver round-trips against a REAL, offline better-sqlite3 database in a
 * temp workspace — no network, no external service. Exercises the full
 * `db_query` / `db_schema` seam end-to-end through the tools' `run()`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import { createDbTools } from "../src/index.js";

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
  const out = tool.run(input, ctxFor(cwd));
  // db tools are batch (Promise<ToolResult>).
  return (await out) as ToolResult;
}

describe("db tools — SQLite (real, offline)", () => {
  let dir: string;
  let query: Tool;
  let schema: Tool;
  const conn = (dir: string) => ({ driver: "sqlite" as const, file: "app.db" });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nexus-db-"));
    const tools = createDbTools();
    query = tools.find((t) => t.name === "db_query")!;
    schema = tools.find((t) => t.name === "db_schema")!;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("declares a network ceiling and classifies sqlite calls per input", () => {
    expect(query.name).toBe("db_query");
    expect(schema.name).toBe("db_schema");
    // Fail-closed declared ceiling: an unrefined DB call is treated as network.
    expect(query.permission).toBe("network");
    expect(schema.permission).toBe("network");
    // Per-call refinement: a LOCAL sqlite read/schema is `read`.
    const sqliteConn = { driver: "sqlite", file: "app.db" };
    expect(query.permissionFor?.({ connection: sqliteConn, sql: "SELECT 1" })).toBe("read");
    expect(schema.permissionFor?.({ connection: sqliteConn })).toBe("read");
    // A sqlite mutation the caller opted into is a `write` (denied in read-only/plan).
    expect(
      query.permissionFor?.({ connection: sqliteConn, sql: "DELETE FROM t", write: true }),
    ).toBe("write");
    // A REMOTE driver opens a socket ⇒ `network` (gated by the mode's net policy).
    expect(query.permissionFor?.({ connection: { driver: "postgres" }, sql: "SELECT 1" })).toBe(
      "network",
    );
    expect(schema.permissionFor?.({ connection: { driver: "mysql" } })).toBe("network");
    expect(query.timeoutMs).toBeGreaterThan(0);
  });

  it("creates, inserts and selects with bound params (round-trip)", async () => {
    const create = await call(
      query,
      {
        connection: conn(dir),
        sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)",
        write: true,
      },
      dir,
    );
    expect(create.isError).toBeFalsy();

    const ins = await call(
      query,
      {
        connection: conn(dir),
        sql: "INSERT INTO users (name, age) VALUES (?, ?), (?, ?)",
        params: ["Ada", 36, "Alan", 41],
        write: true,
      },
      dir,
    );
    expect(ins.isError).toBeFalsy();
    expect(JSON.parse(textOf(ins)).changes).toBe(2);

    const sel = await call(
      query,
      {
        connection: conn(dir),
        sql: "SELECT id, name, age FROM users WHERE age > ? ORDER BY age",
        params: [30],
      },
      dir,
    );
    expect(sel.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(sel));
    expect(parsed.columns).toEqual(["id", "name", "age"]);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.rows.map((r: { name: string }) => r.name)).toEqual(["Ada", "Alan"]);
  });

  it("introspects tables and columns via db_schema", async () => {
    await call(
      query,
      {
        connection: conn(dir),
        sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER DEFAULT 0)",
        write: true,
      },
      dir,
    );
    const res = await call(schema, { connection: conn(dir) }, dir);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res));
    expect(parsed.dialect).toBe("sqlite");
    const items = parsed.tables.find((t: { name: string }) => t.name === "items");
    expect(items).toBeTruthy();
    const cols = items.columns as Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>;
    const id = cols.find((c) => c.name === "id")!;
    expect(id.primaryKey).toBe(true);
    const label = cols.find((c) => c.name === "label")!;
    expect(label.nullable).toBe(false);
    expect(label.type.toUpperCase()).toContain("TEXT");
  });

  it("filters introspection to a single table", async () => {
    await call(query, { connection: conn(dir), sql: "CREATE TABLE a (x INTEGER)", write: true }, dir);
    await call(query, { connection: conn(dir), sql: "CREATE TABLE b (y INTEGER)", write: true }, dir);
    const res = await call(schema, { connection: conn(dir), table: "b" }, dir);
    const parsed = JSON.parse(textOf(res));
    expect(parsed.tables.map((t: { name: string }) => t.name)).toEqual(["b"]);
  });

  it("treats a bound parameter as data, not SQL (injection is inert)", async () => {
    await call(query, { connection: conn(dir), sql: "CREATE TABLE t (v TEXT)", write: true }, dir);
    await call(
      query,
      { connection: conn(dir), sql: "INSERT INTO t (v) VALUES (?)", params: ["x'); DROP TABLE t;--"], write: true },
      dir,
    );
    // If the payload had executed, this select would fail (table dropped).
    const sel = await call(query, { connection: conn(dir), sql: "SELECT v FROM t" }, dir);
    expect(sel.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(sel));
    expect(parsed.rows[0].v).toBe("x'); DROP TABLE t;--");
  });
});
