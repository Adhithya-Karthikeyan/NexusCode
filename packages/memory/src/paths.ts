/**
 * Data-dir resolution for durable memory. Reuses the canonical `nexusPaths().data`
 * location that the CLI already uses for history/secrets — we do NOT duplicate
 * that logic, only layer an explicit override (constructor option) and a
 * `NEXUS_DATA_DIR` env hook (for tests and sandboxes) on top of it.
 */

import { join } from "node:path";
import { nexusPaths } from "@nexuscode/config";

/** The directory durable memory is stored under. */
export function memoryDataDir(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return explicit ?? env["NEXUS_DATA_DIR"] ?? nexusPaths().data;
}

/** The concrete JSON file the durable tiers persist to. */
export function memoryFile(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(memoryDataDir(explicit, env), "memory.json");
}
