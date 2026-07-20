/**
 * SQLite driver, backed by `better-sqlite3` — the ALWAYS-AVAILABLE, fully
 * offline real driver used to exercise the whole `db_query` / `db_schema` seam
 * in tests. `better-sqlite3` is already a repo dependency; it is still loaded via
 * dynamic `import()` so a native-load failure degrades to a clean error instead
 * of crashing at module load.
 *
 * Safety:
 *   - Parameters are bound positionally (`?`) — never interpolated.
 *   - The SQLite file is confined to the workspace via `resolveInWorkspaceSync`
 *     (":memory:" is exempt); no path may escape the workspace root.
 *   - Introspection reads `sqlite_master` + `PRAGMA table_info`; the only place a
 *     table name is inlined (PRAGMA cannot bind identifiers) it is a name that
 *     came from `sqlite_master` and is additionally identifier-quoted.
 */

import { resolveInWorkspaceSync } from "@nexuscode/tools";
import { normalizeBindValue } from "../sql.js";
import type {
  ColumnInfo,
  DbDriver,
  IntrospectOptions,
  QueryOptions,
  QueryResult,
  TableInfo,
} from "../driver.js";
import { DriverUnavailableError } from "../driver.js";

/** The subset of the better-sqlite3 surface we depend on. */
interface SqliteStatement {
  reader: boolean;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  columns(): Array<{ name: string }>;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  pragma(source: string): unknown;
  close(): void;
}
type SqliteCtor = new (path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDatabase;

/** Double-quote-escape a SQLite identifier for the one PRAGMA that can't bind. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface SqliteDriverConfig {
  /** File path (already workspace-resolved) or ":memory:". */
  file: string;
  readonly?: boolean;
}

export class SqliteDriver implements DbDriver {
  readonly dialect = "sqlite" as const;
  private readonly db: SqliteDatabase;

  private constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Open a SQLite database. `config.file` is confined to `cwd` (unless
   * ":memory:"). Throws {@link DriverUnavailableError} when better-sqlite3
   * itself cannot be loaded.
   */
  static async open(config: SqliteDriverConfig, cwd: string): Promise<SqliteDriver> {
    const pkg = "better-sqlite3";
    let Database: SqliteCtor;
    try {
      const mod = (await import(pkg)) as unknown as { default: SqliteCtor };
      Database = mod.default;
    } catch {
      throw new DriverUnavailableError(pkg, "sqlite");
    }
    const path = config.file === ":memory:" ? ":memory:" : resolveInWorkspaceSync(cwd, config.file);
    const opts = config.readonly ? { readonly: true } : {};
    const db = new Database(path, opts);
    return new SqliteDriver(db);
  }

  query(sql: string, params: readonly unknown[], opts?: QueryOptions): Promise<QueryResult> {
    if (opts?.signal?.aborted) {
      return Promise.reject(new Error("query aborted"));
    }
    const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
    const bind = params.map(normalizeBindValue);
    const stmt = this.db.prepare(sql);

    if (stmt.reader) {
      const all = stmt.all(...bind);
      const truncated = all.length > maxRows;
      const rows = truncated ? all.slice(0, maxRows) : all;
      const columns = stmt.columns().map((c) => c.name);
      return Promise.resolve({ columns, rows, rowCount: rows.length, truncated });
    }

    const info = stmt.run(...bind);
    return Promise.resolve({
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      changes: info.changes,
    });
  }

  introspect(opts?: IntrospectOptions): Promise<TableInfo[]> {
    const tableFilter = opts?.table;
    // Table names are bound (`?`), never interpolated.
    const listSql =
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
      (tableFilter ? " AND name = ?" : "") +
      " ORDER BY name";
    const listStmt = this.db.prepare(listSql);
    const names = (tableFilter ? listStmt.all(tableFilter) : listStmt.all()) as Array<{
      name: string;
    }>;

    const out: TableInfo[] = [];
    for (const { name } of names) {
      // PRAGMA cannot bind an identifier; `name` comes from sqlite_master and is
      // additionally identifier-quoted, so there is no injection surface.
      const info = this.db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const columns: ColumnInfo[] = info.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.notnull === 0,
        primaryKey: c.pk > 0,
        default: c.dflt_value,
      }));
      out.push({ name, columns });
    }
    return Promise.resolve(out);
  }

  close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      /* idempotent close: a double close must never throw */
    }
    return Promise.resolve();
  }
}

/** Default per-query row cap shared with the network drivers. */
export const DEFAULT_MAX_ROWS = 1000;
