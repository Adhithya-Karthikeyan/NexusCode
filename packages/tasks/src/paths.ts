/**
 * Data-dir resolution for durable task state. Mirrors @nexuscode/memory: we
 * reuse the canonical `nexusPaths().data` location the CLI already uses, then
 * layer an explicit override (constructor option) and a `NEXUS_DATA_DIR` env
 * hook (for tests and sandboxes) on top of it — never duplicating that logic.
 */

import { join } from "node:path";
import { nexusPaths } from "@nexuscode/config";

/** The directory durable task state is stored under. */
export function tasksDataDir(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicit ?? env["NEXUS_DATA_DIR"] ?? nexusPaths().data;
}

/** The concrete JSON file the task store persists to. */
export function tasksFile(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(tasksDataDir(explicit, env), "tasks.json");
}
