/**
 * The database tools — `db_query` and `db_schema` — built on the {@link DbDriver}
 * seam. Both declare a fail-closed `network` ceiling and refine their real
 * permission PER CALL via `Tool.permissionFor` (sqlite→read, remote drivers→
 * network, sqlite mutation→write), so the PermissionGate enforces the mode's
 * network/write policy instead of waving a networked or mutating call through as
 * a plain `read`. `db_query` additionally enforces an internal write-gate: a
 * mutating statement (INSERT/UPDATE/DDL/…) is refused unless the caller
 * explicitly sets `write: true` — defense in depth on top of the gate.
 *
 * Every query is PARAMETERIZED — bind values are threaded to the driver and
 * never interpolated into SQL. Results are bounded (`maxRows`) and the serialized
 * payload is capped so a huge table can't blow the context. A driver is opened
 * per call and always closed in `finally`. Connection secrets never appear in
 * error output.
 */

import { NexusError } from "@nexuscode/shared";
import {
  errText,
  okText,
  type Tool,
  type ToolContext,
  type ToolPermission,
  type ToolResult,
} from "@nexuscode/tools";
import type {
  DbConnectionConfig,
  DbDriver,
  DriverResolver,
  QueryResult,
  TableInfo,
} from "./driver.js";
import { DriverUnavailableError } from "./driver.js";
import { defaultResolveDriver } from "./drivers/index.js";
import { DEFAULT_MAX_ROWS } from "./drivers/sqlite.js";
import { isMutation } from "./sql.js";

/** Advisory wall-clock budget for a single database call. */
export const DEFAULT_DB_TIMEOUT_MS = 30_000;

/** Hard cap on the serialized JSON payload returned to the model (bytes). */
const MAX_RESULT_BYTES = 1024 * 1024;

const VALID_DRIVERS = new Set(["sqlite", "postgres", "mysql", "snowflake", "bigquery"]);

// ---------------------------------------------------------------------------
// input validation (local; mirrors @nexuscode/tools' internal validators)
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new NexusError("invalid_argument", msg);
}

function asObject(input: unknown, what = "argument"): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(`expected an object ${what}`);
  }
  return input as Record<string, unknown>;
}

function parseConnection(raw: unknown): DbConnectionConfig {
  const o = asObject(raw, "connection");
  const driver = o.driver;
  if (typeof driver !== "string" || !VALID_DRIVERS.has(driver)) {
    fail(`"connection.driver" must be one of: ${[...VALID_DRIVERS].join(", ")}`);
  }
  // Pass through the recognized fields with light type checks; unknown fields are
  // ignored rather than trusted.
  const cfg: Record<string, unknown> = { driver };
  const str = (k: string): void => {
    const v = o[k];
    if (v !== undefined) {
      if (typeof v !== "string") fail(`"connection.${k}" must be a string`);
      cfg[k] = v;
    }
  };
  const num = (k: string): void => {
    const v = o[k];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v)) fail(`"connection.${k}" must be a number`);
      cfg[k] = v;
    }
  };
  const bool = (k: string): void => {
    const v = o[k];
    if (v !== undefined) {
      if (typeof v !== "boolean") fail(`"connection.${k}" must be a boolean`);
      cfg[k] = v;
    }
  };
  str("file");
  bool("readonly");
  str("connectionString");
  str("host");
  num("port");
  str("user");
  str("password");
  str("database");
  bool("ssl");
  str("account");
  str("warehouse");
  str("role");
  str("schema");
  str("projectId");
  str("keyFilename");
  str("location");
  return cfg as unknown as DbConnectionConfig;
}

function parseParams(raw: unknown): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`"params" must be an array`);
  return raw as unknown[];
}

/** Convert a driver failure into a friendly, secret-free ToolResult. */
function driverError(err: unknown): ToolResult {
  if (err instanceof DriverUnavailableError) {
    return errText(err.message);
  }
  if (err instanceof NexusError) {
    // NexusError messages are already curated (no secrets).
    return errText(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return errText(`database error: ${msg}`);
}

/** Serialize a query result as JSON, capping the payload size. */
function formatQueryResult(dialect: string, r: QueryResult): ToolResult {
  const payload: Record<string, unknown> = {
    dialect,
    columns: r.columns,
    rowCount: r.rowCount,
    truncated: r.truncated,
  };
  if (r.changes !== undefined) payload.changes = r.changes;

  let rows = r.rows;
  let text = JSON.stringify({ ...payload, rows }, jsonSafe, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    // Progressively shed rows until the payload fits, flagging the truncation.
    while (rows.length > 0 && Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
      rows = rows.slice(0, Math.max(0, Math.floor(rows.length / 2)));
      text = JSON.stringify({ ...payload, truncated: true, rows }, jsonSafe, 2);
    }
  }
  return okText(text);
}

/** JSON replacer: bigints → strings, Buffers → base64, so nothing throws. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

// ---------------------------------------------------------------------------
// permission classification (per-call, consumed by the PermissionGate)
// ---------------------------------------------------------------------------
//
// The static `permission` field is a coarse fail-closed CEILING (`network`);
// the real capability of a DB call depends on its arguments, so both tools
// implement `Tool.permissionFor` to refine the class the gate evaluates:
//
//   - sqlite  → a LOCAL file: `read` (or `write` for an opted-in mutation).
//   - postgres/mysql/snowflake/bigquery → open a socket to a REMOTE server, so
//     they are `network` and are gated by the mode's network policy
//     (denied in plan, ask in read-only/workspace-write).
//   - an unknown/malformed driver → `network` (fail closed; the call is rejected
//     by validation anyway, but it must never be under-classified as `read`).
//
// This closes the escalation-ladder gap: a networked or mutating DB call can no
// longer be treated as a plain `read` that read-only/plan modes wave through.

/** Best-effort extraction of `connection.driver` from raw tool input (never throws). */
function driverOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const conn = (input as Record<string, unknown>).connection;
  if (typeof conn !== "object" || conn === null) return undefined;
  const d = (conn as Record<string, unknown>).driver;
  return typeof d === "string" ? d : undefined;
}

/** Effective permission for a `db_query` call. Pure; safe to call before validation. */
function queryPermissionFor(input: unknown): ToolPermission {
  if (driverOf(input) === "sqlite") {
    const o = input as Record<string, unknown> | null;
    const sql = o && typeof o.sql === "string" ? o.sql : "";
    const write = o ? o.write === true : false;
    // A local sqlite mutation the caller opted into is a WRITE (denied in
    // read-only/plan even if `write:true` is set by the model).
    return write && sql.length > 0 && isMutation(sql) ? "write" : "read";
  }
  // Remote driver or undeterminable ⇒ network (fail closed).
  return "network";
}

/** Effective permission for a `db_schema` call (introspection never mutates). */
function schemaPermissionFor(input: unknown): ToolPermission {
  return driverOf(input) === "sqlite" ? "read" : "network";
}

// ---------------------------------------------------------------------------
// db_query
// ---------------------------------------------------------------------------

function makeQueryTool(resolve: DriverResolver): Tool {
  return {
    name: "db_query",
    description:
      "Run a parameterized SQL query against a database (sqlite/postgres/mysql/snowflake/bigquery). " +
      "Reads (SELECT/…) are allowed; mutations require `write: true`. Params are bound, never interpolated.",
    // Declared ceiling; refined per call by `permissionFor` (sqlite→read/write,
    // remote drivers→network). Fail-closed default is `network`.
    permission: "network",
    permissionFor: queryPermissionFor,
    timeoutMs: DEFAULT_DB_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        connection: {
          type: "object",
          description: "Connection config. Requires `driver`; other fields depend on the backend.",
          properties: {
            driver: { type: "string", enum: [...VALID_DRIVERS] },
            file: { type: "string", description: "SQLite file (workspace-relative) or ':memory:'." },
            readonly: { type: "boolean" },
            connectionString: { type: "string" },
            host: { type: "string" },
            port: { type: "number" },
            user: { type: "string" },
            password: { type: "string" },
            database: { type: "string" },
            ssl: { type: "boolean" },
            account: { type: "string" },
            warehouse: { type: "string" },
            role: { type: "string" },
            schema: { type: "string" },
            projectId: { type: "string" },
            keyFilename: { type: "string" },
            location: { type: "string" },
          },
          required: ["driver"],
        },
        sql: { type: "string", description: "SQL with `?`/`$n` placeholders for bind params." },
        params: { type: "array", description: "Positional bind parameters (never interpolated)." },
        write: {
          type: "boolean",
          description: "Must be true to run a mutating statement (INSERT/UPDATE/DELETE/DDL). Default false.",
        },
        maxRows: { type: "number", description: `Row cap (default ${DEFAULT_MAX_ROWS}).` },
      },
      required: ["connection", "sql"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const connection = parseConnection(o.connection);
      const sql = o.sql;
      if (typeof sql !== "string" || sql.trim().length === 0) fail(`"sql" must be a non-empty string`);
      const params = parseParams(o.params);
      const write = o.write === true;
      if (o.write !== undefined && typeof o.write !== "boolean") fail(`"write" must be a boolean`);
      const maxRows = o.maxRows === undefined ? DEFAULT_MAX_ROWS : Number(o.maxRows);
      if (o.maxRows !== undefined && (typeof o.maxRows !== "number" || !Number.isFinite(o.maxRows))) {
        fail(`"maxRows" must be a finite number`);
      }

      // Write-gate: refuse a mutation unless explicitly opted in.
      if (isMutation(sql) && !write) {
        return errText(
          "refusing to run a mutating statement without `write: true`. " +
            "Set write:true to allow INSERT/UPDATE/DELETE/DDL.",
        );
      }

      let driver: DbDriver | undefined;
      try {
        driver = await resolve(connection, { cwd: ctx.cwd });
        const result = await driver.query(sql, params, {
          signal: ctx.signal,
          timeoutMs: DEFAULT_DB_TIMEOUT_MS,
          maxRows,
        });
        return formatQueryResult(connection.driver, result);
      } catch (err) {
        return driverError(err);
      } finally {
        if (driver) await driver.close().catch(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// db_schema
// ---------------------------------------------------------------------------

function formatSchema(dialect: string, tables: TableInfo[]): ToolResult {
  const text = JSON.stringify({ dialect, tableCount: tables.length, tables }, jsonSafe, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    return okText(
      JSON.stringify(
        {
          dialect,
          tableCount: tables.length,
          truncated: true,
          tables: tables.map((t) => ({ name: t.name, schema: t.schema, columnCount: t.columns.length })),
        },
        jsonSafe,
        2,
      ),
    );
  }
  return okText(text);
}

function makeSchemaTool(resolve: DriverResolver): Tool {
  return {
    name: "db_schema",
    description:
      "Introspect a database's tables and columns (name, type, nullability, primary key). Read-only.",
    // Declared ceiling; refined per call (sqlite→read, remote drivers→network).
    permission: "network",
    permissionFor: schemaPermissionFor,
    timeoutMs: DEFAULT_DB_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        connection: {
          type: "object",
          description: "Connection config. Requires `driver`; other fields depend on the backend.",
          properties: {
            driver: { type: "string", enum: [...VALID_DRIVERS] },
            file: { type: "string" },
            readonly: { type: "boolean" },
            connectionString: { type: "string" },
            host: { type: "string" },
            port: { type: "number" },
            user: { type: "string" },
            password: { type: "string" },
            database: { type: "string" },
            ssl: { type: "boolean" },
            account: { type: "string" },
            warehouse: { type: "string" },
            role: { type: "string" },
            schema: { type: "string" },
            projectId: { type: "string" },
            keyFilename: { type: "string" },
            location: { type: "string" },
          },
          required: ["driver"],
        },
        schema: { type: "string", description: "Restrict to one schema/namespace/dataset." },
        table: { type: "string", description: "Restrict to one table." },
      },
      required: ["connection"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const connection = parseConnection(o.connection);
      const schema = o.schema;
      const table = o.table;
      if (schema !== undefined && typeof schema !== "string") fail(`"schema" must be a string`);
      if (table !== undefined && typeof table !== "string") fail(`"table" must be a string`);

      const introspectOpts: { schema?: string; table?: string; signal?: AbortSignal; timeoutMs?: number } = {
        signal: ctx.signal,
        timeoutMs: DEFAULT_DB_TIMEOUT_MS,
      };
      if (typeof schema === "string") introspectOpts.schema = schema;
      if (typeof table === "string") introspectOpts.table = table;

      let driver: DbDriver | undefined;
      try {
        driver = await resolve(connection, { cwd: ctx.cwd });
        const tables = await driver.introspect(introspectOpts);
        return formatSchema(connection.driver, tables);
      } catch (err) {
        return driverError(err);
      } finally {
        if (driver) await driver.close().catch(() => undefined);
      }
    },
  };
}

/** Options for {@link createDbTools}. */
export interface CreateDbToolsOptions {
  /**
   * Override the driver seam (tests inject a fake so no real DB/network is hit).
   * Defaults to {@link defaultResolveDriver}.
   */
  resolveDriver?: DriverResolver;
}

/**
 * Build the database tool group (`db_query`, `db_schema`). Returns a `Tool[]` so
 * the integration layer can register them in a `ToolRegistry`.
 */
export function createDbTools(options: CreateDbToolsOptions = {}): Tool[] {
  const resolve = options.resolveDriver ?? defaultResolveDriver;
  return [makeQueryTool(resolve), makeSchemaTool(resolve)];
}
