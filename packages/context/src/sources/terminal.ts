/**
 * TerminalOutputSource — recent terminal/command output (volatile `terminal`
 * lane, which maps onto the tool-output tier). Capping preserves the TAIL so the
 * error/result at the bottom of a log is never cut.
 */

import { truncateTail } from "../compress.js";
import type { CollectContext, ContextChunk, ContextSource } from "../types.js";

export interface TerminalEntry {
  command?: string;
  output: string;
  ts?: number;
}

export interface TerminalOutputOptions {
  /** A single blob of terminal output. */
  output?: string;
  /** Structured entries (command + output). */
  entries?: TerminalEntry[];
  /** Tail token cap per entry (default: no cap). */
  maxTokensPerEntry?: number;
  priority?: number;
}

export class TerminalOutputSource implements ContextSource {
  readonly id = "terminal-output";
  readonly kind = "volatile" as const;
  readonly priority: number;

  constructor(private readonly opts: TerminalOutputOptions = {}) {
    this.priority = opts.priority ?? 45;
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    const entries: TerminalEntry[] = this.opts.entries
      ? this.opts.entries
      : this.opts.output
        ? [{ output: this.opts.output }]
        : [];

    const chunks: ContextChunk[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      let body = entry.output;
      if (typeof this.opts.maxTokensPerEntry === "number") {
        body = truncateTail(body, this.opts.maxTokensPerEntry, ctx.estimate);
      }
      const header = entry.command ? `$ ${entry.command}\n` : "";
      chunks.push({
        id: `terminal:${i}`,
        sourceId: this.id,
        lane: "terminal",
        text: `${header}${body}`,
        priority: this.priority,
        relevance: 0.5,
        ...(typeof entry.ts === "number" ? { createdAt: entry.ts } : {}),
        title: entry.command ? `$ ${entry.command}` : "Terminal Output",
      });
    }
    return chunks;
  }
}
