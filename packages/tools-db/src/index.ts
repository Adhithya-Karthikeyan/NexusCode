/**
 * @nexuscode/tools-db — database tools for the NexusCode tool framework
 * (system-spec §6, Databases). Two tools over a single {@link DbDriver} seam:
 *
 *   - `db_query`  — run a PARAMETERIZED statement (params bound, never
 *                   interpolated); mutations require an explicit `write: true`.
 *   - `db_schema` — introspect tables/columns (name, type, nullability, PK).
 *
 * SQLite (better-sqlite3) ships as the ALWAYS-AVAILABLE, fully offline real
 * driver used to verify the whole seam in tests. Postgres (`pg`), MySQL
 * (`mysql2`), Snowflake (`snowflake-sdk`) and BigQuery (`@google-cloud/bigquery`)
 * are OPTIONAL LAZY dependencies loaded via dynamic `import()` and feature-
 * detected at call time — absent ⇒ a clean "X not installed (npm i <pkg>)"
 * ToolResult, never a crash. None are hard dependencies.
 *
 * Use {@link createDbTools} to get the group's `Tool[]` for registration.
 */

export { createDbTools, DEFAULT_DB_TIMEOUT_MS } from "./tools.js";
export type { CreateDbToolsOptions } from "./tools.js";

export type {
  DbDialect,
  DbDriver,
  DbConnectionConfig,
  DriverResolver,
  DriverResolveContext,
  QueryOptions,
  QueryResult,
  IntrospectOptions,
  ColumnInfo,
  TableInfo,
} from "./driver.js";
export { DriverUnavailableError } from "./driver.js";

export {
  defaultResolveDriver,
  SqliteDriver,
  PostgresDriver,
  MysqlDriver,
  SnowflakeDriver,
  BigQueryDriver,
  DEFAULT_MAX_ROWS,
} from "./drivers/index.js";

export { isMutation, stripSqlComments, normalizeBindValue } from "./sql.js";
