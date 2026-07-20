/**
 * The `DbDriver` seam — the single abstraction every database backend implements
 * so the `db_query` / `db_schema` tools stay dialect-agnostic.
 *
 * A driver does exactly three things: run a *parameterized* statement, introspect
 * table/column metadata, and close. SQLite (better-sqlite3) is the always-present,
 * offline-testable real implementation; Postgres, MySQL, Snowflake and BigQuery
 * are optional lazy drivers loaded via dynamic `import()` and feature-detected at
 * call time — absent ⇒ a clean {@link DriverUnavailableError}, never a crash.
 *
 * Contract invariants for every implementation:
 *   - Parameters are ALWAYS bound, never interpolated into the SQL string.
 *   - Row count and serialized size are bounded by the caller (`maxRows`).
 *   - Secrets in connection config never appear in thrown error messages.
 */

/** The supported SQL dialects / driver kinds. */
export type DbDialect = "sqlite" | "postgres" | "mysql" | "snowflake" | "bigquery";

/** Per-call execution knobs threaded from the tool layer. */
export interface QueryOptions {
  /** Cancellation from the kernel; drivers that can cancel MUST honor it. */
  signal?: AbortSignal;
  /** Advisory wall-clock budget in ms for network drivers. */
  timeoutMs?: number;
  /** Hard cap on rows materialized/returned. */
  maxRows?: number;
}

/** A normalized query outcome, dialect-independent. */
export interface QueryResult {
  /** Column names in result order (empty for pure mutations). */
  columns: string[];
  /** Result rows as plain objects, capped at `maxRows`. */
  rows: Array<Record<string, unknown>>;
  /** Number of rows returned (post-cap) for reads. */
  rowCount: number;
  /** True when rows were truncated at `maxRows`. */
  truncated: boolean;
  /** Affected-row count for mutations (INSERT/UPDATE/DELETE/…), when known. */
  changes?: number;
}

/** One column's introspected metadata. */
export interface ColumnInfo {
  name: string;
  /** Declared/native type as reported by the backend. */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Default expression, when the backend reports one. */
  default?: string | null;
}

/** One table's introspected metadata. */
export interface TableInfo {
  name: string;
  /** Owning schema/namespace, when the backend is multi-schema. */
  schema?: string;
  columns: ColumnInfo[];
}

/** Filters for {@link DbDriver.introspect}. */
export interface IntrospectOptions {
  /** Restrict to a single schema/namespace. */
  schema?: string;
  /** Restrict to a single table. */
  table?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The seam every backend implements. */
export interface DbDriver {
  readonly dialect: DbDialect;
  /** Run a parameterized statement. Params are bound, never interpolated. */
  query(sql: string, params: readonly unknown[], opts?: QueryOptions): Promise<QueryResult>;
  /** Introspect table/column metadata. */
  introspect(opts?: IntrospectOptions): Promise<TableInfo[]>;
  /** Release the connection/handle. Must be idempotent and never throw. */
  close(): Promise<void>;
}

/**
 * Thrown when an optional driver's client library is not installed. The tool
 * layer converts it into a friendly `isError` ToolResult ("X not installed
 * (npm i <pkg>)") so a missing dependency degrades gracefully instead of
 * crashing the process.
 */
export class DriverUnavailableError extends Error {
  readonly pkg: string;
  readonly dialect: string;
  constructor(pkg: string, dialect: string) {
    super(`${dialect} driver not installed (npm i ${pkg})`);
    this.name = "DriverUnavailableError";
    this.pkg = pkg;
    this.dialect = dialect;
  }
}

/** Connection configuration accepted by the default driver resolver. */
export interface DbConnectionConfig {
  /** Which backend to open. */
  driver: DbDialect;

  // --- sqlite ---
  /** SQLite file path (workspace-relative) or ":memory:". */
  file?: string;
  /** Open the SQLite database read-only. */
  readonly?: boolean;

  // --- network drivers (pg / mysql / snowflake) ---
  /** Full connection string (pg/mysql), used verbatim when present. */
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;

  // --- snowflake ---
  account?: string;
  warehouse?: string;
  role?: string;
  schema?: string;

  // --- bigquery ---
  projectId?: string;
  /** Path to a service-account key file (workspace-relative). */
  keyFilename?: string;
  location?: string;
}

/** Context handed to a {@link DriverResolver}. */
export interface DriverResolveContext {
  /** Workspace root used to confine SQLite file / key file paths. */
  cwd: string;
}

/**
 * The seam that turns a connection config into a live {@link DbDriver}. The
 * default implementation dispatches on `config.driver`; tests inject a fake so
 * no real database or network is ever touched.
 */
export type DriverResolver = (
  config: DbConnectionConfig,
  ctx: DriverResolveContext,
) => Promise<DbDriver>;
