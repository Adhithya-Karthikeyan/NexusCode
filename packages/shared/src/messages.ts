/**
 * Message & request model — the normalized superset. Provider-specific richness
 * that we do not model is preserved via `providerExtensions` (outbound) and the
 * per-chunk `raw` passthrough (inbound), so nothing is flattened away.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string | { url: string } }
  | { type: "audio"; mime: string; data: string | { url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: ContentBlock[]; isError?: boolean }
  | { type: "thinking"; text: string; signature?: string };

export interface Message {
  role: Role;
  content: ContentBlock[];
  /** Set on tool-role messages that answer a specific tool call. */
  toolCallId?: string;
  /** Optional name (tool/function name, or a named participant). */
  name?: string;
}

/** JSON-Schema tool definition. */
export interface ToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface ReasoningOptions {
  enabled: boolean;
  budgetTokens?: number;
  effort?: "low" | "medium" | "high";
}

export interface ResponseFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  /** Logical model id; resolved to a native model via config/registry. */
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningOptions;
  responseFormat?: ResponseFormat;
  /** Never dropped, never portable across providers. */
  providerExtensions?: Record<string, unknown>;
}

/** Convenience: a single user-text message array. */
export function userText(text: string): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

/** Extract the concatenated plain text from a message's content blocks. */
export function textOf(message: Message): string {
  let out = "";
  for (const b of message.content) if (b.type === "text") out += b.text;
  return out;
}
