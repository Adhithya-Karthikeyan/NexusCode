/**
 * The default {@link DriverResolver}: dispatch a connection config to the right
 * backend. SQLite is opened directly (always available); every other backend is
 * loaded lazily inside its own module and throws {@link DriverUnavailableError}
 * when its client library is absent. Path-shaped fields (SQLite file, BigQuery
 * key file) are confined to the workspace before use.
 */

import { NexusError } from "@nexuscode/shared";
import { resolveInWorkspaceSync } from "@nexuscode/tools";
import type { DbConnectionConfig, DbDriver, DriverResolveContext } from "../driver.js";
import { SqliteDriver } from "./sqlite.js";
import { PostgresDriver } from "./postgres.js";
import { MysqlDriver } from "./mysql.js";
import { SnowflakeDriver } from "./snowflake.js";
import { BigQueryDriver, type BigQueryDriverConfig } from "./bigquery.js";

export async function defaultResolveDriver(
  config: DbConnectionConfig,
  ctx: DriverResolveContext,
): Promise<DbDriver> {
  switch (config.driver) {
    case "sqlite": {
      const file = config.file ?? ":memory:";
      const sqliteConfig = config.readonly !== undefined
        ? { file, readonly: config.readonly }
        : { file };
      return SqliteDriver.open(sqliteConfig, ctx.cwd);
    }
    case "postgres":
      return PostgresDriver.open(config);
    case "mysql":
      return MysqlDriver.open(config);
    case "snowflake":
      return SnowflakeDriver.open(config);
    case "bigquery": {
      const bqConfig: BigQueryDriverConfig = { ...config };
      if (config.keyFilename) {
        bqConfig.resolvedKeyFilename = resolveInWorkspaceSync(ctx.cwd, config.keyFilename);
      }
      return BigQueryDriver.open(bqConfig);
    }
    default:
      throw new NexusError(
        "invalid_argument",
        `unknown database driver: ${String((config as { driver?: unknown }).driver)}`,
      );
  }
}

export { SqliteDriver } from "./sqlite.js";
export { PostgresDriver } from "./postgres.js";
export { MysqlDriver } from "./mysql.js";
export { SnowflakeDriver } from "./snowflake.js";
export { BigQueryDriver } from "./bigquery.js";
export { DEFAULT_MAX_ROWS } from "./sqlite.js";
