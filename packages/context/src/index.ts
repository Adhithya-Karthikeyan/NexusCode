/**
 * @nexuscode/context — the Context Engine (system-spec §3). Intelligently
 * assembles the context a provider receives: it collects from pluggable
 * {@link ContextSource}s, RANKS by relevance + priority, DEDUPES, COMPRESSES
 * oversized chunks, and PACKS within a token budget — returning a cache-stable
 * `system` prefix (STATIC lanes first, deterministic serialization) plus volatile
 * `messages` (history + query), and a full {@link ContextReport} for
 * attribution/observability (real-vs-nominal tokens, what was included/dropped).
 *
 * Cache invariant (feature-catalog #3): STATIC context first, VOLATILE last;
 * trimming/compaction only ever mutates the volatile tail, so provider
 * prompt-caches hit.
 */

export { ContextEngine } from "./engine.js";

export { defaultEstimator } from "./tokens.js";
export { truncateMiddle, truncateTail } from "./compress.js";

export {
  CONTEXT_LANES,
  type AssembleOptions,
  type AssembleResult,
  type Breakpoint,
  type CollectContext,
  type CompressedChunk,
  type CompressResult,
  type Compressor,
  type ContextChunk,
  type ContextKind,
  type ContextLane,
  type ContextReport,
  type ContextSource,
  type DropReason,
  type DroppedChunk,
  type IncludedChunk,
  type LaneReport,
  type SourceReport,
  type TokenEstimator,
} from "./types.js";

export {
  LANE_TABLE,
  STATIC_LANES,
  VOLATILE_LANES,
  isStatic,
  laneIndex,
  laneKind,
  laneTitle,
} from "./lanes.js";

export {
  ConversationHistorySource,
  CurrentTaskSource,
  EnvSource,
  GitDiffSource,
  MemorySource,
  ProjectFilesSource,
  TerminalOutputSource,
} from "./sources/index.js";
export type {
  ConversationHistoryOptions,
  CurrentTaskOptions,
  EnvOptions,
  GitDiffOptions,
  GitRunner,
  MemorySourceOptions,
  ProjectFilesOptions,
  TerminalEntry,
  TerminalOutputOptions,
  Turn,
} from "./sources/index.js";
