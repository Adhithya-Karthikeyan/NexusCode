/**
 * Public shapes for the prompt engine.
 */

import type { MissingVarBehavior, PromptVars } from "./interpolate.js";

/** A single few-shot demonstration appended after a task prompt body. */
export interface FewShotExample {
  input: string;
  output: string;
  /** Optional label rendered above the pair (e.g. "Refactor"). */
  label?: string;
}

/** A registered template body, keyed by `id` + `version`. */
export interface Template {
  id: string;
  version: string;
  body: string;
}

/** Options for {@link PromptEngine.assemble}. */
export interface AssembleOptions {
  /** Few-shot examples appended after the interpolated body. */
  fewShot?: FewShotExample[];
  /** Pin a specific version; defaults to the latest registered version of the id. */
  version?: string;
  /** Missing-variable behavior; defaults to `"throw"`. */
  onMissing?: MissingVarBehavior;
}

/** A recorded assembly — which template/version produced an output. */
export interface AssemblyRecord {
  id: string;
  version: string;
}

/** Named sections for {@link PromptEngine.compose}. All optional; empty ones are omitted. */
export interface ComposeParts {
  /** Base identity / role — the most static, cache-friendly segment. Goes first. */
  identity?: string;
  /** Capability statements (what the agent can do). Static. */
  capabilities?: string[];
  /** Ingested memory (CLAUDE.md / AGENTS.md, pinned facts). Static-ish. */
  memory?: string[];
  /** Project conventions / house rules. */
  conventions?: string[];
}

export type { MissingVarBehavior, PromptVars };
