/**
 * Data-dir resolution for the persisted RAG index. Reuses the canonical
 * `nexusPaths().data` location the CLI already uses (history/secrets/memory),
 * layering an explicit override and the `NEXUS_DATA_DIR` env hook (tests,
 * sandboxes) on top — mirroring the memory subsystem exactly.
 */

import { join } from "node:path";
import { nexusPaths } from "@nexuscode/config";

/** The directory the RAG index is stored under. */
export function ragDataDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? env["NEXUS_DATA_DIR"] ?? nexusPaths().data;
}

/** The concrete JSON file the vector store persists to. */
export function ragStoreFile(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(ragDataDir(explicit, env), "rag-index.json");
}
