/**
 * BigQuery driver — OPTIONAL LAZY dependency (`@google-cloud/bigquery`). Loaded
 * via dynamic `import()` and feature-detected; absent ⇒
 * {@link DriverUnavailableError} and graceful degradation. Not a hard dependency.
 *
 * Parameters are passed positionally to `query({ query, params })` — BigQuery
 * binds `?` placeholders itself; we never interpolate. A service-account key file
 * path is confined to the workspace by the resolver.
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

/** `BigQuery.query` resolves to `[rows, ...]`; we only need the rows. */
type BqQueryResponse = [Array<Record<string, unknown>>, ...unknown[]];
interface BqInstance {
  query(opts: { query: string; params?: unknown[]; location?: string }): Promise<BqQueryResponse>;
}
interface BqModule {
  BigQuery: new (config: Record<string, unknown>) => BqInstance;
}

export interface BigQueryDriverConfig extends DbConnectionConfig {
  /** Key file already resolved to an absolute, workspace-confined path. */
  resolvedKeyFilename?: string;
}

export class BigQueryDriver implements DbDriver {
  readonly dialect = "bigquery" as const;
  private readonly bq: BqInstance;
  private readonly location: string | undefined;

  private constructor(bq: BqInstance, location: string | undefined) {
    this.bq = bq;
    this.location = location;
  }

  static async open(config: BigQueryDriverConfig): Promise<BigQueryDriver> {
    const mod = await lazyImport<BqModule>("@google-cloud/bigquery", "bigquery");
    const cfg: Record<string, unknown> = {};
    if (config.projectId !== undefined) cfg.projectId = config.projectId;
    if (config.resolvedKeyFilename !== undefined) cfg.keyFilename = config.resolvedKeyFilename;
    const bq = new mod.BigQuery(cfg);
    return new BigQueryDriver(bq, config.location);
  }

  private runQuery(sql: string, params: unknown[]): Promise<BqQueryResponse> {
    const opts: { query: string; params?: unknown[]; location?: string } = { query: sql };
    if (params.length > 0) opts.params = params;
    if (this.location) opts.location = this.location;
    return this.bq.query(opts);
  }

  async query(sql: string, params: readonly unknown[], opts?: QueryOptions): Promise<QueryResult> {
    const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
    const [all] = await withDeadline(this.runQuery(sql, [...params]), opts?.timeoutMs, opts?.signal);
    const truncated = all.length > maxRows;
    const rows = truncated ? all.slice(0, maxRows) : all;
    const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
    return { columns, rows, rowCount: rows.length, truncated };
  }

  async introspect(opts?: IntrospectOptions): Promise<TableInfo[]> {
    // BigQuery groups tables under datasets; `schema` selects the dataset.
    const dataset = opts?.schema;
    if (!dataset) {
      throw new Error("bigquery introspection requires `schema` (the dataset id)");
    }
    const params: unknown[] = [];
    let where = "1 = 1";
    if (opts?.table) {
      where += " AND table_name = ?";
      params.push(opts.table);
    }
    // INFORMATION_SCHEMA is scoped to the dataset via the fully-qualified path.
    const qualified = "`" + dataset.replace(/`/g, "") + "`.INFORMATION_SCHEMA.COLUMNS";
    const sql = `
      SELECT table_name, column_name, data_type, is_nullable
      FROM ${qualified}
      WHERE ${where}
      ORDER BY table_name, ordinal_position`;
    const [rows] = await withDeadline(this.runQuery(sql, params), opts?.timeoutMs, opts?.signal);
    const byTable = new Map<string, TableInfo>();
    for (const raw of rows) {
      const r = raw as {
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      };
      let t = byTable.get(r.table_name);
      if (!t) {
        t = { name: r.table_name, schema: dataset, columns: [] };
        byTable.set(r.table_name, t);
      }
      const col: ColumnInfo = {
        name: r.column_name,
        type: r.data_type,
        nullable: String(r.is_nullable).toUpperCase() === "YES",
        primaryKey: false,
      };
      t.columns.push(col);
    }
    return [...byTable.values()];
  }

  close(): Promise<void> {
    // The BigQuery client is stateless HTTP; nothing to release.
    return Promise.resolve();
  }
}

const DEFAULT_MAX_ROWS = 1000;
