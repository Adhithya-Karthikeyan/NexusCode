/** Starter context sources (system-spec §3). */

export { ConversationHistorySource } from "./history.js";
export type { ConversationHistoryOptions, Turn } from "./history.js";

export { CurrentTaskSource } from "./task.js";
export type { CurrentTaskOptions } from "./task.js";

export { ProjectFilesSource } from "./files.js";
export type { ProjectFilesOptions } from "./files.js";

export { GitDiffSource } from "./git.js";
export type { GitDiffOptions, GitRunner } from "./git.js";

export { TerminalOutputSource } from "./terminal.js";
export type { TerminalEntry, TerminalOutputOptions } from "./terminal.js";

export { EnvSource } from "./env.js";
export type { EnvOptions } from "./env.js";

export { MemorySource } from "./memory.js";
export type { MemorySourceOptions } from "./memory.js";
