/**
 * EnvSource — selected environment variables (static `env` lane). Secret-looking
 * values are masked by default so credentials never enter the window. Keys are
 * emitted in sorted order for deterministic, cache-stable serialization.
 */

import type { CollectContext, ContextChunk, ContextSource } from "../types.js";

const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|AUTH)/i;
const MASK = "***";

export interface EnvOptions {
  /** Which keys to include (default: none — env is opt-in to avoid leakage). */
  keys?: string[];
  /** Source map (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Mask secret-looking values (default true). */
  redact?: boolean;
  priority?: number;
}

export class EnvSource implements ContextSource {
  readonly id = "env";
  readonly kind = "static" as const;
  readonly priority: number;

  constructor(private readonly opts: EnvOptions = {}) {
    this.priority = opts.priority ?? 65;
  }

  async collect(_ctx: CollectContext): Promise<ContextChunk[]> {
    const env = this.opts.env ?? (process.env as Record<string, string | undefined>);
    const redact = this.opts.redact ?? true;
    const keys = [...(this.opts.keys ?? [])].sort();

    const lines: string[] = [];
    for (const key of keys) {
      const value = env[key];
      if (value === undefined) continue;
      const shown = redact && SECRET_RE.test(key) ? MASK : value;
      lines.push(`${key}=${shown}`);
    }
    if (lines.length === 0) return [];

    return [
      {
        id: "env:vars",
        sourceId: this.id,
        lane: "env",
        text: lines.join("\n"),
        priority: this.priority,
        relevance: 0.5,
        title: "Environment Variables",
      },
    ];
  }
}
