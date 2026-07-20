/**
 * Snowflake driver — OPTIONAL LAZY dependency (`snowflake-sdk`). Loaded via
 * dynamic `import()` and feature-detected; absent ⇒ {@link DriverUnavailableError}
 * and graceful degradation. Not a hard dependency.
 *
 * The SDK is callback-based; we wrap `connect` and `execute` in promises.
 * Parameters are bound via `binds` (`?` placeholders) — never interpolated.
 */

import { lazyImport, withDeadline } from "./lazy.js";
import type {
  ColumnInfo,
  DbConnectionConfig,
  DbDriver,
  IntrospectOptions,
  QueryOptions,
  QueryResult,
  TableInfo,
} from "../driver.js";

interface SfColumn {
  getName(): string;
}
interface SfStatement {
  getColumns(): SfColumn[] | undefined;
}
interface SfConnection {
  connect(cb: (err: unknown, conn: SfConnection) => void): void;
  execute(opts: {
    sqlText: string;
    binds?: unknown[];
    complete: (err: unknown, stmt: SfStatement, rows: Array<Record<string, unknown>> | undefined) => void;
  }): void;
  destroy(cb: (err: unknown) => void): void;
}
interface SfModule {
  createConnection(config: Record<string, unknown>): SfConnection;
}

export class SnowflakeDriver implements DbDriver {
  readonly dialect = "snowflake" as const;
  private readonly conn: SfConnection;

  private constructor(conn: SfConnection) {
    this.conn = conn;
  }

  static async open(config: DbConnectionConfig): Promise<SnowflakeDriver> {
    const sdk = await lazyImport<SfModule>("snowflake-sdk", "snowflake");
    const cfg: Record<string, unknown> = {};
    if (config.account !== undefined) cfg.account = config.account;
    if (config.user !== undefined) cfg.username = config.user;
    if (config.password !== undefined) cfg.password = config.password;
    if (config.database !== undefined) cfg.database = config.database;
    if (config.schema !== undefined) cfg.schema = config.schema;
    if (config.warehouse !== undefined) cfg.warehouse = config.warehouse;
    if (config.role !== undefined) cfg.role = config.role;
    const conn = sdk.createConnection(cfg);
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => (err ? reject(toError(err)) : resolve()));
    });
    return new SnowflakeDriver(conn);
  }

  private exec(
    sqlText: string,
    binds: unknown[],
  ): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      this.conn.execute({
        sqlText,
        binds,
        complete: (err, stmt, rows) => {
          if (err) {
            reject(toError(err));
            return;
          }
          const columns = (stmt.getColumns() ?? []).map((c) => c.getName());
          resolve({ columns, rows: rows ?? [] });
        },
      });
    });
  }

  async query(sql: string, params: readonly unknown[], opts?: QueryOptions): Promise<QueryResult> {
    const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
    const { columns, rows: all } = await withDeadline(
      this.exec(sql, [...params]),
      opts?.timeoutMs,
      opts?.signal,
    );
    const truncated = all.length > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;
    return { columns, rows, rowCount: rows.length, truncated };
  }

  async introspect(opts?: IntrospectOptions): Promise<TableInfo[]> {
    const binds: unknown[] = [];
    let where = "1 = 1";
    if (opts?.schema) {
      where += " AND table_schema = ?";
      binds.push(opts.schema);
    }
    if (opts?.table) {
      where += " AND table_name = ?";
      binds.push(opts.table);
    }
    const sql = `
      SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE ${where}
      ORDER BY table_name, ordinal_position`;
    const { rows } = await withDeadline(this.exec(sql, binds), opts?.timeoutMs, opts?.signal);
    const byTable = new Map<string, TableInfo>();
    for (const raw of rows) {
      const r = normalizeKeys(raw);
      const tableName = String(r.table_name);
      let t = byTable.get(tableName);
      if (!t) {
        t = { name: tableName, columns: [] };
        if (r.table_schema) t.schema = String(r.table_schema);
        byTable.set(tableName, t);
      }
      const col: ColumnInfo = {
        name: String(r.column_name),
        type: String(r.data_type),
        nullable: String(r.is_nullable).toUpperCase() === "YES",
        primaryKey: false,
        default: r.column_default == null ? null : String(r.column_default),
      };
      t.columns.push(col);
    }
    return [...byTable.values()];
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      try {
        this.conn.destroy(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

/** Snowflake upper-cases unquoted identifiers; fold result keys to lower case. */
function normalizeKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

const DEFAULT_MAX_ROWS = 1000;
