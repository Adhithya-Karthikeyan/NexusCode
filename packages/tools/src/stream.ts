/**
 * The bridge between tool execution and the frozen `StreamChunk` union. A tool's
 * streaming `output`/`result` events map onto `tool-result` chunks byte-for-byte
 * the same as a native provider tool-call or a wrapped-CLI tool result — that
 * unification is the whole point of §6. Also provides `runTool`, the driver that
 * collapses either tool return shape into a single `ToolResult`.
 */

import type { ContentBlock, StreamChunk } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types.js";

/** Build a `tool-result` StreamChunk from a finished `ToolResult`. */
export function toolResultChunk(
  runId: string,
  toolCallId: string,
  result: ToolResult,
): StreamChunk {
  return result.isError
    ? { type: "tool-result", runId, toolCallId, content: result.content, isError: true }
    : { type: "tool-result", runId, toolCallId, content: result.content };
}

/**
 * Map one streaming `ToolEvent` to a `tool-result` StreamChunk, or `undefined`
 * for events that carry no content chunk (`progress`). `output` events become
 * incremental non-error `tool-result` chunks; `result` becomes the terminal one.
 */
export function toolEventToChunk(
  runId: string,
  toolCallId: string,
  event: ToolEvent,
): StreamChunk | undefined {
  switch (event.type) {
    case "progress":
      return undefined;
    case "output":
      return { type: "tool-result", runId, toolCallId, content: event.content };
    case "result":
      return toolResultChunk(runId, toolCallId, event.result);
  }
}

function isAsyncIterable(v: unknown): v is AsyncIterable<ToolEvent> {
  return typeof v === "object" && v !== null && Symbol.asyncIterator in v;
}

/**
 * Run a tool and normalize its output to a single `ToolResult`, regardless of
 * whether it returned a `Promise<ToolResult>` or streamed `ToolEvent`s. When a
 * stream omits a terminal `result`, one is synthesized from accumulated
 * `output` blocks.
 */
export async function runTool(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const ret = tool.run(input, ctx);
  if (!isAsyncIterable(ret)) return ret;

  const accumulated: ContentBlock[] = [];
  let terminal: ToolResult | undefined;
  for await (const event of ret) {
    if (event.type === "output") accumulated.push(...event.content);
    else if (event.type === "result") terminal = event.result;
  }

  if (terminal) return terminal;
  return { ok: true, content: accumulated };
}

/**
 * Drive a tool as a stream of `StreamChunk`s stamped with `ctx.runId`. Batch
 * tools yield a single terminal `tool-result`; streaming tools yield their
 * incremental chunks followed by the terminal one.
 */
export async function* streamToolChunks(
  tool: Tool,
  input: unknown,
  toolCallId: string,
  ctx: ToolContext,
): AsyncIterable<StreamChunk> {
  const runId = ctx.runId ?? "";
  const ret = tool.run(input, ctx);
  if (!isAsyncIterable(ret)) {
    yield toolResultChunk(runId, toolCallId, await ret);
    return;
  }
  for await (const event of ret) {
    const chunk = toolEventToChunk(runId, toolCallId, event);
    if (chunk) yield chunk;
  }
}
