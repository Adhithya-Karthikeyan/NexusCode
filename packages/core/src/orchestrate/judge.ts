/**
 * Judge factory — one `Judge` interface, two grounded implementations selected
 * by `JudgeSpec.domain` (design spec §5.7). `"chat"` → an LLM rubric over
 * anonymized answers; `"code"` → `git apply` + gates over diffs. Every model
 * call is pluggable so the whole layer is exercisable offline.
 */

import type { Judge, JudgeSpec } from "../types.js";
import { createChatJudge, type ChatJudgeOptions } from "./chat-judge.js";
import { createDiffJudge, type DiffJudgeOptions } from "./diff-judge.js";

export * from "./chat-judge.js";
export * from "./diff-judge.js";

export interface CreateJudgeOptions {
  chat?: ChatJudgeOptions;
  diff?: DiffJudgeOptions;
}

/** Build the judge implied by `spec.domain`. */
export function createJudge(spec: JudgeSpec, opts: CreateJudgeOptions = {}): Judge {
  return spec.domain === "code"
    ? createDiffJudge(spec, opts.diff ?? {})
    : createChatJudge(spec, opts.chat ?? {});
}
