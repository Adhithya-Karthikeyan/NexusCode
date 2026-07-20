/**
 * @nexuscode/tools — the tool framework (system-spec §6). Everything external to
 * the model is a Tool: a name, JSON-Schema parameters, a permission class, an
 * optional timeout, and a `run` that returns either a `ToolResult` or a stream
 * of `ToolEvent`s mapped onto the frozen `StreamChunk` `tool-result` shape.
 *
 * Exports: the Tool contract, a `ToolRegistry`, a `PermissionGate`
 * (read-only / workspace-write / full-access / plan, with allow/deny lists,
 * approval callback, and secret redaction), the streaming bridge (`runTool`,
 * `streamToolChunks`, `toolResultChunk`), and a starter built-in suite
 * (`fs_read`, `fs_write`, `fs_patch`, `fs_search`, `shell_exec`).
 */

export type {
  Tool,
  ToolContext,
  ToolTraceEvent,
  ToolResult,
  ToolEvent,
  ToolPermission,
} from "./types.js";
export { textBlock, okText, errText } from "./types.js";

export { ToolRegistry } from "./registry.js";

export { PermissionGate } from "./permission.js";
export type {
  PermissionMode,
  PermissionGateOptions,
  PermissionDecision,
  ApprovalRequest,
  ApproveFn,
} from "./permission.js";

export { redactArgs, redactSecrets, REDACTED } from "./redact.js";

export {
  assertAllowedUrl,
  BlockedUrlError,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateHostname,
  expandIPv6,
} from "./ssrf.js";
export type { SsrfOptions } from "./ssrf.js";

export { resolveInWorkspace, resolveInWorkspaceSync, stripDiffPrefix } from "./paths.js";

export { runTool, streamToolChunks, toolResultChunk, toolEventToChunk } from "./stream.js";

export { fsReadTool, fsWriteTool, fsSearchTool } from "./fs.js";
export {
  fsPatchTool,
  PatchError,
  parseUnifiedDiff,
  applyHunks,
  applyUnifiedDiff,
} from "./patch.js";
export { shellExecTool, DEFAULT_SHELL_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, scrubSecretEnv } from "./shell.js";
export { globToRegExp, walkFiles, DEFAULT_IGNORE } from "./glob.js";

export { builtinTools, registerBuiltins } from "./builtins.js";

// Terminal integration (§13): background jobs, streaming, ANSI, history, PTY seam.
export * from "./terminal/index.js";
