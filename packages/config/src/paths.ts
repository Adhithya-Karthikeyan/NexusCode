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

export function nexusPaths(): NexusPaths {
  return {
    config: paths.config,
    data: paths.data,
    cache: paths.cache,
    historyDb: join(paths.data, "history.db"),
    secretsFile: join(paths.data, "secrets.enc.json"),
  };
}
