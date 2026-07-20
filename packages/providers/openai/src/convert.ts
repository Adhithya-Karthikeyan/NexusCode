/**
 * Translate NexusCode's normalized {@link ChatRequest} into the OpenAI
 * Chat Completions request body. Chat Completions (not Responses) is the wire
 * format every OpenAI-compatible backend speaks — Grok, Ollama, Groq, DeepSeek,
 * Mistral — so this one converter serves the native adapter and the compat
 * transport alike.
 */

import type OpenAI from "openai";
import type {
  ChatRequest,
  ContentBlock,
  Message,
  ToolChoice,
  ToolDef,
} from "@nexuscode/core";

type ChatMessageParam = OpenAI.ChatCompletionMessageParam;
type ContentPart = OpenAI.ChatCompletionContentPart;
type ChatTool = OpenAI.ChatCompletionTool;
type ChatToolChoice = OpenAI.ChatCompletionToolChoiceOption;
type StreamingParams = OpenAI.ChatCompletionCreateParamsStreaming;

/** Knobs the caller (native vs compat) flips when shaping the body. */
export interface BodyOptions {
  /** logical model id → native id (identity when absent). */
  resolveModel: (model: string) => string;
  /** Ask for a trailing usage-only chunk. Disable for backends that reject it. */
  includeUsage: boolean;
  /** Emit `reasoning_effort` for o-series style models. Off for plain compat. */
  supportsReasoningEffort: boolean;
}

/** Build a data: URL for an inline base64 image, or pass through a remote URL. */
function imagePartUrl(block: Extract<ContentBlock, { type: "image" }>): string {
  const { data, mime } = block;
  if (typeof data === "string") return `data:${mime};base64,${data}`;
  return data.url;
}

/** Map an audio MIME type to the two formats Chat Completions `input_audio` accepts. */
function audioFormat(mime: string): "wav" | "mp3" {
  const m = mime.toLowerCase();
  if (m.includes("mp3") || m.includes("mpeg")) return "mp3";
  return "wav";
}

/** Convert one normalized message's blocks into OpenAI content parts. */
function toUserParts(blocks: ContentBlock[]): string | ContentPart[] {
  // Fast path: a single text block becomes a plain string (widest support).
  const first = blocks[0];
  if (blocks.length === 1 && first?.type === "text") return first.text;
  const parts: ContentPart[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image") {
      parts.push({ type: "image_url", image_url: { url: imagePartUrl(b) } });
    } else if (b.type === "audio") {
      // Chat Completions accepts inline base64 audio only (no URL form); a URL
      // reference degrades to a text note so the request stays valid.
      if (typeof b.data === "string") {
        parts.push({
          type: "input_audio",
          input_audio: { data: b.data, format: audioFormat(b.mime) },
        });
      } else {
        parts.push({ type: "text", text: `[audio: ${b.data.url}]` });
      }
    }
  }
  if (parts.length === 0) return "";
  return parts;
}

/** Extract concatenated plain text from a block list. */
function textFrom(blocks: ContentBlock[]): string {
  let out = "";
  for (const b of blocks) if (b.type === "text") out += b.text;
  return out;
}

/**
 * Map the normalized message history to OpenAI params. Assistant tool calls and
 * `tool` results are threaded through so multi-turn tool loops round-trip.
 */
export function toOpenAIMessages(messages: Message[]): ChatMessageParam[] {
  const out: ChatMessageParam[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        out.push({ role: "system", content: textFrom(msg.content) });
        break;

      case "user": {
        // A user message may itself carry tool_result blocks (some callers put
        // them there); split those into dedicated tool messages.
        const toolResults = msg.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
        );
        const rest = msg.content.filter((b) => b.type !== "tool_result");
        if (rest.length > 0) out.push({ role: "user", content: toUserParts(rest) });
        for (const tr of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: tr.toolCallId,
            content: textFrom(tr.content),
          });
        }
        break;
      }

      case "tool":
        out.push({
          role: "tool",
          tool_call_id: msg.toolCallId ?? "",
          content: textFrom(msg.content),
        });
        break;

      case "assistant": {
        const text = textFrom(msg.content);
        const toolUses = msg.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
        );
        const assistant: OpenAI.ChatCompletionAssistantMessageParam = { role: "assistant" };
        if (text) assistant.content = text;
        if (toolUses.length > 0) {
          assistant.tool_calls = toolUses.map((t) => ({
            id: t.id,
            type: "function",
            function: {
              name: t.name,
              arguments: typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? {}),
            },
          }));
        }
        // An assistant turn with neither text nor tool calls still needs content.
        if (assistant.content === undefined && assistant.tool_calls === undefined) {
          assistant.content = "";
        }
        out.push(assistant);
        break;
      }
    }
  }
  return out;
}

/** Convert NexusCode tool defs to OpenAI function tools. */
export function toOpenAITools(tools: ToolDef[]): ChatTool[] {
  return tools.map((t) => {
    const fn: ChatTool["function"] = { name: t.name, parameters: t.parameters };
    if (t.description !== undefined) fn.description = t.description;
    return { type: "function", function: fn };
  });
}

/** Convert the normalized tool-choice to OpenAI's shape. */
export function toOpenAIToolChoice(choice: ToolChoice): ChatToolChoice {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  return { type: "function", function: { name: choice.name } };
}

/** Assemble the full streaming request body from a normalized request. */
export function buildStreamingBody(req: ChatRequest, opts: BodyOptions): StreamingParams {
  const messages: ChatMessageParam[] = [];
  if (req.system !== undefined && req.system !== "") {
    messages.push({ role: "system", content: req.system });
  }
  messages.push(...toOpenAIMessages(req.messages));

  const body: StreamingParams = {
    model: opts.resolveModel(req.model),
    messages,
    stream: true,
  };
  if (opts.includeUsage) body.stream_options = { include_usage: true };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools && req.tools.length > 0) body.tools = toOpenAITools(req.tools);
  if (req.toolChoice !== undefined) body.tool_choice = toOpenAIToolChoice(req.toolChoice);
  if (req.responseFormat) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: req.responseFormat.schema, strict: true },
    };
  }
  if (opts.supportsReasoningEffort && req.reasoning?.enabled && req.reasoning.effort) {
    body.reasoning_effort = req.reasoning.effort;
  }
  // Escape hatch: verbatim provider-specific params win over everything above.
  if (req.providerExtensions) Object.assign(body, req.providerExtensions);
  return body;
}
