/**
 * Token estimation seam. The default reuses `@nexuscode/memory`'s char/4
 * heuristic (floored at word count) — good enough to budget context, and a
 * clean seam for a real provider tokenizer later (Anthropic count-tokens,
 * tiktoken, Gemini countTokens, local tokenizer.json).
 */

import { estimateTokens } from "@nexuscode/memory";
import type { TokenEstimator } from "./types.js";

/** The default char/4 estimator. Never a substitute for a provider tokenizer. */
export const defaultEstimator: TokenEstimator = (text) => estimateTokens(text);
