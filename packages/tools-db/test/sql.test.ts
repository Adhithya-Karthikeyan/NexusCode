/**
 * Unit tests for the SQL classification / bind-normalization helpers.
 */

import { describe, expect, it } from "vitest";
import { isMutation, normalizeBindValue, stripSqlComments } from "../src/sql.js";

describe("isMutation", () => {
  it("classifies reads as non-mutations", () => {
    for (const sql of [
      "SELECT * FROM t",
      "  select 1",
      "EXPLAIN SELECT 1",
      "PRAGMA table_info(x)",
      "WITH cte AS (SELECT 1) SELECT * FROM cte",
      "VALUES (1),(2)",
      "SHOW TABLES",
    ]) {
      expect(isMutation(sql), sql).toBe(false);
    }
  });

  it("classifies writes/DDL as mutations", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "update t set a=1",
      "DELETE FROM t",
      "CREATE TABLE t (a INT)",
      "DROP TABLE t",
      "ALTER TABLE t ADD COLUMN b INT",
      "TRUNCATE t",
      "REPLACE INTO t VALUES (1)",
      "PRAGMA journal_mode = WAL",
      "WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)",
    ]) {
      expect(isMutation(sql), sql).toBe(true);
    }
  });

  it("ignores leading comments when classifying", () => {
    expect(isMutation("-- a comment\nSELECT 1")).toBe(false);
    expect(isMutation("/* block */ DELETE FROM t")).toBe(true);
  });
});

describe("stripSqlComments", () => {
  it("removes line and block comments", () => {
    expect(stripSqlComments("SELECT 1 -- trailing").trim()).toBe("SELECT 1");
    expect(stripSqlComments("SELECT /* mid */ 1").replace(/\s+/g, " ").trim()).toBe("SELECT 1");
  });
});

describe("normalizeBindValue", () => {
  it("coerces booleans, undefined, dates and objects; passes primitives", () => {
    expect(normalizeBindValue(true)).toBe(1);
    expect(normalizeBindValue(false)).toBe(0);
    expect(normalizeBindValue(undefined)).toBe(null);
    expect(normalizeBindValue(null)).toBe(null);
    expect(normalizeBindValue(42)).toBe(42);
    expect(normalizeBindValue("s")).toBe("s");
    expect(normalizeBindValue(new Date("2020-01-01T00:00:00.000Z"))).toBe("2020-01-01T00:00:00.000Z");
    expect(normalizeBindValue({ a: 1 })).toBe('{"a":1}');
    const buf = Buffer.from([1, 2, 3]);
    expect(normalizeBindValue(buf)).toBe(buf);
  });
});
