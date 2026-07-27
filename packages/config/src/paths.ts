/**
 * Canonical on-disk locations, resolved via `env-paths` (XDG on Linux, the
 * platform-native dirs on macOS/Windows). Suffix disabled so the app dir is
 * simply "nexuscode".
 */

import { join } from "node:path";
import envPaths from "env-paths";

const paths = envPaths("nexuscode", { suffix: "" });

export interface NexusPaths {
  /** Config directory (user config.yaml lives here). */
  config: string;
  /** Data directory (history.db, secrets vault). */
  data: string;
  /** Cache directory. */
  cache: string;
  /** Default SQLite history db path. */
  historyDb: string;
  /** Default encrypted-secrets vault path. */
  secretsFile: string;
}

/**
 * `NEXUS_CONFIG_DIR` / `NEXUS_DATA_DIR` / `NEXUS_CACHE_DIR` redirect the
 * respective directory wholesale — the same env vars a dozen call sites
 * across the CLI already check ad hoc (`env.NEXUS_DATA_DIR ?? nexusPaths().data`
 * in enterprise/extensions/reliability/power, `@nexuscode/{tasks,memory,rag}`'s
 * own `paths.ts`). Resolving them HERE, once, means every consumer of the
 * derived `historyDb`/`secretsFile` — which previously had no override seam of
 * their own and fell straight through to the real machine-wide path even when
 * the caller had clearly asked for an isolated data dir — is covered too, with
 * no per-call-site change required. Read fresh per call (not memoized with the
 * `envPaths()` result above) so a caller that sets the env var before its
 * first real use — every integration test spawns a fresh process, but a
 * same-process caller could set it just as easily — sees it take effect.
 */
export function nexusPaths(): NexusPaths {
  const config = process.env["NEXUS_CONFIG_DIR"] || paths.config;
  const data = process.env["NEXUS_DATA_DIR"] || paths.data;
  const cache = process.env["NEXUS_CACHE_DIR"] || paths.cache;
  return {
    config,
    data,
    cache,
    historyDb: join(data, "history.db"),
    secretsFile: join(data, "secrets.enc.json"),
  };
}
