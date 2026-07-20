/**
 * @nexuscode/memory — the memory subsystem (system-spec §4).
 *
 * Three tiers behind one API ({@link MemoryStore}): `short` (conversation turns
 * + scratchpad, session-scoped), `long` (preferences/style/conventions), and
 * `knowledge` (documents/architecture/decisions). Durable tiers persist to a
 * JSON file under the shared data dir; ranking is lexical by default with a
 * pluggable {@link ScoreFn} seam for future embeddings.
 *
 * Also ships {@link ingestInstructionFiles}: hierarchical ingestion of
 * CLAUDE.md / AGENTS.md / .nexus/memory (project overrides user/global).
 */

export type {
  MemoryTier,
  MemoryKind,
  MemoryItem,
  MemoryPut,
  MemoryPatch,
  MemoryFilter,
  SearchOptions,
  SearchHit,
  ScoreFn,
} from "./types.js";

export { MemoryStore, openMemory } from "./store.js";
export type { MemoryStoreOptions } from "./store.js";

export { lexicalScore, tokenize, estimateTokens, precedenceBoost } from "./score.js";

export { memoryDataDir, memoryFile } from "./paths.js";

export { ingestInstructionFiles, instructionId } from "./ingest.js";
export type { IngestOptions, IngestResult } from "./ingest.js";
