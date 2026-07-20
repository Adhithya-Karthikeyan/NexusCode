/**
 * PostgreSQL driver — OPTIONAL LAZY dependency (`pg`). Loaded via dynamic
 * `import()` and feature-detected: if `pg` is not installed the resolver throws
 * {@link DriverUnavailableError} and the tool degrades gracefully. Never a hard
 * dependency, so `npm install` stays lean.
 *
 * Parameters are bound as `$1, $2, …` positional placeholders — never
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

interface PgField {
  name: string;
}
interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
  fields: PgField[];
  rowCount: number | null;
  command: string;
}
interface PgClient {
  connect(): Promise<void>;
  query(config: { text: string; values?: unknown[] }): Promise<PgQueryResult>;
  end(): Promise<void>;
}
interface PgModule {
  Client: new (config: Record<string, unknown>) => PgClient;
}

const READ_COMMANDS = new Set(["SELECT", "SHOW", "EXPLAIN", "WITH"]);

export class PostgresDriver implements DbDriver {
  readonly dialect = "postgres" as const;
  private readonly client: PgClient;

  private constructor(client: PgClient) {
    this.client = client;
  }

  static async open(config: DbConnectionConfig): Promise<PostgresDriver> {
    const pg = await lazyImport<PgModule>("pg", "postgres");
    const clientConfig: Record<string, unknown> = {};
    if (config.connectionString) clientConfig.connectionString = config.connectionString;
    if (config.host !== undefined) clientConfig.host = config.host;
    if (config.port !== undefined) clientConfig.port = config.port;
    if (config.user !== undefined) clientConfig.user = config.user;
    if (config.password !== undefined) clientConfig.password = config.password;
    if (config.database !== undefined) clientConfig.database = config.database;
    if (config.ssl !== undefined) clientConfig.ssl = config.ssl;
    const client = new pg.Client(clientConfig);
    await client.connect();
    return new PostgresDriver(client);
  }

  async query(sql: string, params: readonly unknown[], opts?: QueryOptions): Promise<QueryResult> {
    const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
    const res = await withDeadline(
      this.client.query({ text: sql, values: [...params] }),
      opts?.timeoutMs,
      opts?.signal,
    );
    const isRead = READ_COMMANDS.has(res.command?.toUpperCase?.() ?? "");
    const all = res.rows ?? [];
    const truncated = all.length > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;
    const columns = (res.fields ?? []).map((f) => f.name);
    const result: QueryResult = {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
    };
    if (!isRead) result.changes = res.rowCount ?? 0;
    return result;
  }

  async introspect(opts?: IntrospectOptions): Promise<TableInfo[]> {
    const schema = opts?.schema ?? "public";
    const params: unknown[] = [schema];
    let where = "c.table_schema = $1";
    if (opts?.table) {
      params.push(opts.table);
      where += " AND c.table_name = $2";
    }
    const sql = `
      SELECT
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.table_schema, kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk
        ON pk.table_schema = c.table_schema
       AND pk.table_name = c.table_name
       AND pk.column_name = c.column_name
      WHERE ${where}
      ORDER BY c.table_name, c.ordinal_position`;
    const res = await withDeadline(
      this.client.query({ text: sql, values: params }),
      opts?.timeoutMs,
      opts?.signal,
    );
    return groupColumns(
      res.rows as Array<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        is_pk: boolean;
      }>,
      schema,
    );
  }

  async close(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      /* idempotent */
    }
  }
}

function groupColumns(
  rows: Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_pk: boolean;
  }>,
  schema: string,
): TableInfo[] {
  const byTable = new Map<string, TableInfo>();
  for (const r of rows) {
    let t = byTable.get(r.table_name);
    if (!t) {
      t = { name: r.table_name, schema, columns: [] };
      byTable.set(r.table_name, t);
    }
    const col: ColumnInfo = {
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      primaryKey: r.is_pk,
      default: r.column_default,
    };
    t.columns.push(col);
  }
  return [...byTable.values()];
}

const DEFAULT_MAX_ROWS = 1000;
