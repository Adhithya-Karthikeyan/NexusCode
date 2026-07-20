/**
 * CurrentTaskSource — the active task/instruction (volatile `task` lane, pinned
 * so it survives compaction). Rendered next to the user's query.
 */

import type { CollectContext, ContextChunk, ContextSource } from "../types.js";

export interface CurrentTaskOptions {
  task: string;
  priority?: number;
  /** Pinned by default: the current task is never trimmed. */
  pinned?: boolean;
}

export class CurrentTaskSource implements ContextSource {
  readonly id = "current-task";
  readonly kind = "volatile" as const;
  readonly priority: number;

  constructor(private readonly opts: CurrentTaskOptions) {
    this.priority = opts.priority ?? 90;
  }

  async collect(_ctx: CollectContext): Promise<ContextChunk[]> {
    const task = this.opts.task.trim();
    if (task.length === 0) return [];
    return [
      {
        id: "task:current",
        sourceId: this.id,
        lane: "task",
        text: task,
        priority: this.priority,
        relevance: 1,
        pinned: this.opts.pinned ?? true,
        title: "Current Task",
      },
    ];
  }
}
