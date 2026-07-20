/**
 * Terminal integration (system-spec §13): background jobs, streaming output,
 * ANSI passthrough, interrupt, command history, and an interactive shell/PTY
 * seam. Re-exported from `@nexuscode/tools`.
 */

export { AsyncBroadcast } from "./async-broadcast.js";
export { ANSI_PATTERN, stripAnsi, hasAnsi } from "./ansi.js";
export {
  ProcessManager,
  Job,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_MAX_JOB_RUNTIME_MS,
  type JobSpec,
  type JobInfo,
  type JobStatus,
  type OutputChunk,
  type OutputStream,
  type ProcessManagerOptions,
} from "./process-manager.js";
export {
  CommandHistory,
  defaultHistoryPath,
  scrubHistoryArgs,
  type HistoryEntry,
  type CommandHistoryOptions,
} from "./history.js";
export {
  jobTools,
  jobSpawnTool,
  jobListTool,
  jobOutputTool,
  jobKillTool,
} from "./tools.js";
export {
  createPty,
  createDefaultPty,
  ChildProcessPty,
  loadNodePty,
  isNodePtyAvailable,
  type Pty,
  type PtySession,
  type PtySpawnOptions,
  type PtyBackendOptions,
  type PtyExit,
} from "./pty.js";
