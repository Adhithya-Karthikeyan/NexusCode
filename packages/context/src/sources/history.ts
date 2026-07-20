/**
 * ConversationHistorySource — prior turns of the conversation (volatile,
 * `history` lane). Accepts turns directly, or pulls them from a `@nexuscode/memory`
 * MemoryStore's short-tier conversation log.
 */

import type { MemoryStore } from "@nexuscode/memory";
import type { Role } from "@nexuscode/shared";
import type { CollectContext, ContextChunk, ContextSource } from "../types.js";

export interface Turn {
  role: Role | string;
  text: string;
  /** Epoch millis; used to order turns chronologically. */
  ts?: number;
}

export interface ConversationHistoryOptions {
  /** Turns provided directly (highest precedence). */
  turns?: Turn[];
  /** A MemoryStore to pull `store.turns()` from when `turns` is omitted. */
  store?: MemoryStore;
  /** Keep only the most recent N turns. */
  maxTurns?: number;
  priority?: number;
}

function normalizeRole(role: Role | string): Role {
  return role === "assistant" || role === "system" || role === "tool" ? role : "user";
}

function roleFromTags(tags: string[] | undefined): string | undefined {
  const tag = tags?.find((t) => t.startsWith("role:"));
  return tag?.slice("role:".length);
}

export class ConversationHistorySource implements ContextSource {
  readonly id = "conversation-history";
  readonly kind = "volatile" as const;
  readonly priority: number;

  constructor(private readonly opts: ConversationHistoryOptions = {}) {
    this.priority = opts.priority ?? 40;
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    let turns: Turn[] = this.opts.turns ?? [];
    if (!this.opts.turns && this.opts.store) {
      turns = this.opts.store.turns().map((item) => ({
        role: roleFromTags(item.tags) ?? "user",
        text: item.text,
        ts: item.createdAt,
      }));
    }
    if (typeof this.opts.maxTurns === "number") {
      turns = turns.slice(-this.opts.maxTurns);
    }
    return turns.map((turn, i) => ({
      id: `history:${turn.ts ?? "n"}:${i}`,
      sourceId: this.id,
      lane: "history",
      text: turn.text,
      role: normalizeRole(turn.role),
      priority: this.priority,
      createdAt: turn.ts ?? ctx.now - (turns.length - i),
    }));
  }
}
