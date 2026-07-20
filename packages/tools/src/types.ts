/**
 * The Tool contract (system-spec §6). Everything external to the model — files,
 * shell, git, web — is a Tool. A Tool declares metadata, JSON-Schema parameters,
 * a coarse permission class, and an optional timeout, then executes either as a
 * single `Promise<ToolResult>` or as a stream of `ToolEvent`s. Streaming events
 * map losslessly onto the frozen `StreamChunk` `tool-result` shape (see
 * `./stream.ts`), so a built-in tool and a wrapped-CLI tool audit identically.
 */

import type { ContentBlock } from "@nexuscode/shared";

/** Coarse capability class the PermissionGate reasons over. */
export type ToolPermission = "read" | "write" | "exec" | "network";

/** Optional structured trace event a tool may emit for the audit log. */
export interface ToolTraceEvent {
  type: string;
  ts: number;
  data?: unknown;
}

/**
 * Execution context handed to every tool call. Mirrors the relevant subset of
 * the kernel's `CallContext`: an `AbortSignal` for cancellation, the workspace
 * root every filesystem tool is confined to, and correlation ids for tracing.
 */
export interface ToolContext {
  /** Threaded to fetch/child.kill(); tools MUST honor it. */
  signal: AbortSignal;
  /** Workspace root. Filesystem tools resolve and confine paths within this. */
  cwd: string;
  /** The Run this call belongs to (stamped onto emitted StreamChunks). */
  runId?: string;
  /** Correlation id for trace events. */
  traceId?: string;
  /** Trace sink (no-op in tests). */
  emit?: (event: ToolTraceEvent) => void;
}

/** The terminal value of a tool call. */
export interface ToolResult {
  /** Convenience mirror of `!isError`. */
  ok: boolean;
  /** Normalized output blocks (text, image, nested tool_result, …). */
  content: ContentBlock[];
  /** True when this result represents a failure the model should see. */
  isError?: boolean;
}

/**
 * A streaming tool emits zero or more `progress`/`output` events and MAY end
 * with a `result`. When it omits the terminal `result`, the driver synthesizes
 * one from the accumulated `output` blocks (see `runTool`).
 */
export type ToolEvent =
  | { type: "progress"; message: string }
  | { type: "output"; content: ContentBlock[] }
  | { type: "result"; result: ToolResult };

/**
 * A Tool. `run` returns EITHER a `Promise<ToolResult>` (batch) OR an
 * `AsyncIterable<ToolEvent>` (streaming). Input is `unknown`: each tool
 * validates against its own `parameters` schema and throws `NexusError`
 * (`invalid_argument`) on malformed input.
 */
export interface Tool {
  /** Stable machine name, e.g. "fs_read". Unique within a registry. */
  name: string;
  /** One-line human/model-facing description. */
  description: string;
  /** JSON Schema for `run`'s input. */
  parameters: Record<string, unknown>;
  /**
   * Coarse permission class the gate evaluates. This is the tool's declared
   * ceiling; a tool whose real capability depends on its input MAY additionally
   * implement {@link Tool.permissionFor} to refine the class per call. When
   * present, `permissionFor` is authoritative for the gate; `permission` remains
   * the fail-closed fallback (and the class shown when no input is available).
   */
  permission: ToolPermission;
  /**
   * Optional per-call permission refinement. When a tool's real capability
   * varies with its arguments — e.g. a DB tool that reads a LOCAL sqlite file
   * (`read`) vs. opens a socket to a REMOTE server (`network`) vs. runs a
   * mutation (`write`) — it returns the effective class for THIS `input`. The
   * gate calls it (never throws: any error falls back to {@link Tool.permission})
   * and evaluates the returned class against the mode policy, so a networked or
   * mutating call can never be under-classified as `read`. Must be pure and
   * side-effect-free; it runs before any approval prompt.
   */
  permissionFor?(input: unknown): ToolPermission;
  /** Optional wall-clock budget in ms (advisory; shell enforces it). */
  timeoutMs?: number;
  run(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> | Promise<ToolResult>;
}

/** Build a `text` content block. */
export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

/** Build a successful `ToolResult` from plain text. */
export function okText(text: string): ToolResult {
  return { ok: true, content: [textBlock(text)] };
}

/** Build a failing `ToolResult` from plain text. */
export function errText(text: string): ToolResult {
  return { ok: false, content: [textBlock(text)], isError: true };
}
