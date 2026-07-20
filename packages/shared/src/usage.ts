/**
 * Usage & cost — frozen contract. One normalized `Usage` struct across every
 * provider; `Pricing` is config-driven (USD per 1M tokens) and never hardcoded.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache read tokens. */
  cacheReadTokens?: number;
  /** Anthropic prompt-cache write/creation tokens. */
  cacheWriteTokens?: number;
  /** OpenAI reasoning / Anthropic thinking tokens billed separately. */
  reasoningTokens?: number;
  /** Some CLIs report cost directly (e.g. Claude Code `result.total_cost_usd`). */
  reportedCostUsd?: number;
  /** Computed by {@link computeCost}; 0 for local models (Ollama). */
  costUsd?: number;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  reasoningPerMTok?: number;
}

/**
 * Compute USD cost for a usage record. Prefers a CLI-reported number when
 * present (trust the backend's own figure), else prices each token bucket from
 * the config table. Cache tokens fall back to the input rate when no dedicated
 * cache rate is configured.
 */
export function computeCost(u: Usage, p: Pricing): number {
  if (u.reportedCostUsd != null) return u.reportedCostUsd;
  const m = (n: number | undefined, rate: number | undefined): number =>
    ((n ?? 0) * (rate ?? 0)) / 1_000_000;
  return (
    m(u.inputTokens, p.inputPerMTok) +
    m(u.outputTokens, p.outputPerMTok) +
    m(u.cacheReadTokens, p.cacheReadPerMTok ?? p.inputPerMTok) +
    m(u.cacheWriteTokens, p.cacheWritePerMTok ?? p.inputPerMTok) +
    m(u.reasoningTokens, p.reasoningPerMTok)
  );
}

/** Sum a set of usage records into one aggregate (for compare/race totals). */
export function sumUsage(usages: readonly (Usage | undefined)[]): Usage {
  const acc: Usage = { inputTokens: 0, outputTokens: 0 };
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let cost = 0;
  let sawCost = false;
  for (const u of usages) {
    if (!u) continue;
    acc.inputTokens += u.inputTokens;
    acc.outputTokens += u.outputTokens;
    cacheRead += u.cacheReadTokens ?? 0;
    cacheWrite += u.cacheWriteTokens ?? 0;
    reasoning += u.reasoningTokens ?? 0;
    if (u.costUsd != null || u.reportedCostUsd != null) {
      cost += u.costUsd ?? u.reportedCostUsd ?? 0;
      sawCost = true;
    }
  }
  if (cacheRead) acc.cacheReadTokens = cacheRead;
  if (cacheWrite) acc.cacheWriteTokens = cacheWrite;
  if (reasoning) acc.reasoningTokens = reasoning;
  if (sawCost) acc.costUsd = cost;
  return acc;
}
