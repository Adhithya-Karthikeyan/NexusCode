/**
 * @nexuscode/git — Git Intelligence (system-spec §14) for NexusCode (Wave 6).
 *
 * Two layers, both offline-verifiable:
 *   1. Git-context helpers (`status`, `diff`, `log`, `blame`, `branch`, …) that
 *      shell out through `execFile` (never a shell) and parse git's
 *      machine-readable output into typed structures.
 *   2. Provider-driven flows (`explainDiff`, `reviewChanges`,
 *      `generateCommitMessage`, `generatePrDescription`, `semanticDiff`,
 *      `conflictAssist`) that take an injected `ProviderAdapter`, build a
 *      deterministic prompt from redacted git context, consume the streaming
 *      seam, and return a typed result. Never shell-inject; never leak secrets.
 */

export {
  runGit,
  runGitOrThrow,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_GIT_MAX_BUFFER,
  type GitExecOptions,
  type GitExecResult,
} from "./exec.js";

export {
  isGitRepo,
  repoRoot,
  status,
  diff,
  log,
  branch,
  currentBranch,
  blame,
  type GitContextOptions,
  type FileStatus,
  type StatusResult,
  type DiffOptions,
  type LogEntry,
  type LogOptions,
  type BranchInfo,
  type BlameLine,
  type BlameOptions,
} from "./context.js";

export {
  explainDiff,
  reviewChanges,
  generateCommitMessage,
  generatePrDescription,
  semanticDiff,
  conflictAssist,
  lineChanges,
  parseConflicts,
  stripConflictMarkers,
  type FlowOptions,
  type ReviewSeverity,
  type ReviewComment,
  type ReviewResult,
  type CommitMessage,
  type PrInput,
  type PrDescription,
  type LineChanges,
  type SemanticDiffResult,
  type ConflictHunk,
  type ConflictResolution,
} from "./flows.js";
