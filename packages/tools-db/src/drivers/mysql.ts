/**
 * MySQL driver — OPTIONAL LAZY dependency (`mysql2`). Loaded via dynamic
 * `import("mysql2/promise")` and feature-detected; absent ⇒
 * {@link DriverUnavailableError} and graceful degradation. Not a hard dependency.
 *
 * Parameters are bound as `?` placeholders via `execute()` (prepared) — never
 * interpolated. Introspection reads `information_schema` with bound filters.
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

interface MysqlFieldPacket {
  name: string;
}
interface MysqlOkPacket {
  affectedRows?: number;
}
interface MysqlConnection {
  execute(sql: string, values: unknown[]): Promise<[unknown, MysqlFieldPacket[] | undefined]>;
  end(): Promise<void>;
}
interface MysqlModule {
  createConnection(config: Record<string, unknown>): Promise<MysqlConnection>;
}

export class MysqlDriver implements DbDriver {
  readonly dialect = "mysql" as const;
  private readonly conn: MysqlConnection;

  private constructor(conn: MysqlConnection) {
    this.conn = conn;
  }

  static async open(config: DbConnectionConfig): Promise<MysqlDriver> {
    const mysql = await lazyImport<MysqlModule>("mysql2/promise", "mysql");
    const connConfig: Record<string, unknown> = {};
    if (config.connectionString) connConfig.uri = config.connectionString;
    if (config.host !== undefined) connConfig.host = config.host;
    if (config.port !== undefined) connConfig.port = config.port;
    if (config.user !== undefined) connConfig.user = config.user;
    if (config.password !== undefined) connConfig.password = config.password;
    if (config.database !== undefined) connConfig.database = config.database;
    if (config.ssl) connConfig.ssl = {};
    const conn = await mysql.createConnection(connConfig);
    return new MysqlDriver(conn);
  }

  async query(sql: string, params: readonly unknown[], opts?: QueryOptions): Promise<QueryResult> {
    const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
    const [rowsOrOk, fields] = await withDeadline(
      this.conn.execute(sql, [...params]),
      opts?.timeoutMs,
      opts?.signal,
    );
    // A SELECT yields an array of row objects; a mutation yields an OK packet.
    if (Array.isArray(rowsOrOk)) {
      const all = rowsOrOk as Array<Record<string, unknown>>;
      const truncated = all.length > maxRows;
      const rows = truncated ? all.slice(0, maxRows) : all;
      const columns = (fields ?? []).map((f) => f.name);
      return { columns, rows, rowCount: rows.length, truncated };
    }
    const ok = rowsOrOk as MysqlOkPacket;
    return { columns: [], rows: [], rowCount: 0, truncated: false, changes: ok.affectedRows ?? 0 };
  }

  async introspect(opts?: IntrospectOptions): Promise<TableInfo[]> {
    const params: unknown[] = [];
    let where = "c.table_schema = DATABASE()";
    if (opts?.schema) {
      where = "c.table_schema = ?";
      params.push(opts.schema);
    }
    if (opts?.table) {
      where += " AND c.table_name = ?";
      params.push(opts.table);
    }
    const sql = `
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.column_key
      FROM information_schema.columns c
      WHERE ${where}
      ORDER BY c.table_name, c.ordinal_position`;
    const [rows] = await withDeadline(this.conn.execute(sql, params), opts?.timeoutMs, opts?.signal);
    const recs = (Array.isArray(rows) ? rows : []) as Array<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      column_key: string;
    }>;
    const byTable = new Map<string, TableInfo>();
    for (const r of recs) {
      let t = byTable.get(r.table_name);
      if (!t) {
        t = { name: r.table_name, schema: r.table_schema, columns: [] };
        byTable.set(r.table_name, t);
      }
      const col: ColumnInfo = {
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        primaryKey: r.column_key === "PRI",
        default: r.column_default,
      };
      t.columns.push(col);
    }
    return [...byTable.values()];
  }

  async close(): Promise<void> {
    try {
      await this.conn.end();
    } catch {
      /* idempotent */
    }
  }
}

const DEFAULT_MAX_ROWS = 1000;
