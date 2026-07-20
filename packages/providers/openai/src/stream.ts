/**
 * The heart of the transport: consume an OpenAI Chat Completions stream and
 * re-emit it as the normalized {@link StreamChunk} union. One `run-start`
 * first, one terminal (`run-end` | `error`) last — exactly as the contract
 * requires. `ctx.signal` is threaded into the SDK call so an abort tears the
 * socket down and surfaces as a non-retryable `cancelled`.
 */

import type OpenAI from "openai";
import type {
  ContentBlock,
  FinishReason,
  Message,
  StreamChunk,
  Usage,
} from "@nexuscode/core";
import type { CallContext } from "@nexuscode/core";
import { mapOpenAIError } from "./errors.js";

type CompletionUsage = OpenAI.CompletionUsage;
type StreamingParams = OpenAI.ChatCompletionCreateParamsStreaming;

/** Map OpenAI's `completion.usage` block onto the normalized {@link Usage}. */
export function usageFrom(u: CompletionUsage | null | undefined): Usage | undefined {
  if (!u) return undefined;
  const usage: Usage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning) usage.reasoningTokens = reasoning;
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (cached) usage.cacheReadTokens = cached;
  return usage;
}

type WireFinishReason = OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"];

/** Map the wire `finish_reason` onto the normalized {@link FinishReason}. */
function mapFinish(reason: WireFinishReason): FinishReason | undefined {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    default:
      return undefined;
  }
}

/** In-flight tool call being assembled across deltas. */
interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

/** Options controlling zero-cost reporting (Ollama) etc. */
export interface StreamOptions {
  /** Force `usage.costUsd = 0` (local/free backends). */
  zeroCost?: boolean;
}

/**
 * Drive the SDK stream and yield normalized chunks. Errors are emitted as a
 * terminal `error` chunk (never thrown) so a single consumer loop and the
 * central retry wrapper can both handle them uniformly.
 */
export async function* streamChatCompletion(
  client: OpenAI,
  body: StreamingParams,
  ctx: CallContext,
  adapterId: string,
  streamOpts: StreamOptions = {},
): AsyncIterable<StreamChunk> {
  const runId = ctx.runId;
  yield { type: "run-start", runId, adapterId, model: body.model, ts: Date.now() };

  if (ctx.signal.aborted) {
    yield {
      type: "error",
      runId,
      error: mapOpenAIError(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
        adapterId,
      ),
      retryable: false,
    };
    return;
  }

  let textBuf = "";
  const toolsByIndex = new Map<number, PendingToolCall>();
  const toolOrder: number[] = [];
  let usage: Usage | undefined;
  let finish: FinishReason | undefined;
  let refusal = "";

  try {
    const stream = await client.chat.completions.create(body, { signal: ctx.signal });

    for await (const part of stream) {
      if (part.usage) {
        const mapped = usageFrom(part.usage);
        if (mapped) usage = mapped;
      }
      const choice = part.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta) {
        if (typeof delta.content === "string" && delta.content.length > 0) {
          textBuf += delta.content;
          yield { type: "text-delta", runId, text: delta.content, channel: "answer" };
        }
        if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
          refusal += delta.refusal;
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let pending = toolsByIndex.get(idx);
            if (!pending) {
              pending = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "", started: false };
              toolsByIndex.set(idx, pending);
              toolOrder.push(idx);
            }
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;

            // Announce the call once we know its id + name.
            if (!pending.started && pending.id && pending.name) {
              pending.started = true;
              yield { type: "tool-call-start", runId, id: pending.id, name: pending.name };
            }
            const argsDelta = tc.function?.arguments;
            if (typeof argsDelta === "string" && argsDelta.length > 0) {
              pending.args += argsDelta;
              if (pending.started) {
                yield { type: "tool-call-delta", runId, id: pending.id, argsJsonDelta: argsDelta };
              }
            }
          }
        }
      }

      const mappedFinish = mapFinish(choice.finish_reason);
      if (mappedFinish) finish = mappedFinish;
    }
  } catch (err) {
    const adapterError = mapOpenAIError(err, adapterId);
    yield { type: "error", runId, error: adapterError, retryable: adapterError.retryable };
    return;
  }

  // Finalize any assembled tool calls.
  const content: ContentBlock[] = [];
  const emittedText = refusal ? textBuf + refusal : textBuf;
  if (emittedText) content.push({ type: "text", text: emittedText });

  for (const idx of toolOrder) {
    const pending = toolsByIndex.get(idx);
    if (!pending || !pending.id) continue;
    if (!pending.started) {
      // Never announced (missing name mid-stream) — announce now for symmetry.
      yield { type: "tool-call-start", runId, id: pending.id, name: pending.name };
    }
    let input: unknown = pending.args;
    if (pending.args) {
      try {
        input = JSON.parse(pending.args);
      } catch {
        input = pending.args;
      }
    } else {
      input = {};
    }
    yield { type: "tool-call-end", runId, id: pending.id, input };
    content.push({ type: "tool_use", id: pending.id, name: pending.name, input });
  }

  if (!finish) finish = refusal ? "content_filter" : toolOrder.length > 0 ? "tool_use" : "stop";

  if (usage && streamOpts.zeroCost) usage = { ...usage, costUsd: 0 };
  if (usage) yield { type: "usage", runId, usage };

  const message: Message = { role: "assistant", content };
  const end: Extract<StreamChunk, { type: "run-end" }> = {
    type: "run-end",
    runId,
    finishReason: finish,
    message,
    ts: Date.now(),
  };
  if (usage) end.usage = usage;
  yield end;
}
