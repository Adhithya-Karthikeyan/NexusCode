/**
 * @nexuscode/prompt — the prompt engine (system-spec §8) for NexusCode (Wave 1).
 *
 * System + task prompts, dynamic assembly, named + versioned templates, safe
 * `{{variable}}` interpolation (no `eval`), few-shot example blocks, and
 * deterministic system-prompt composition for provider prompt-cache stability.
 */

export { PromptEngine } from "./engine.js";
export {
  interpolate,
  referencedVars,
  type MissingVarBehavior,
  type PromptVars,
} from "./interpolate.js";
export type {
  AssembleOptions,
  AssemblyRecord,
  ComposeParts,
  FewShotExample,
  Template,
} from "./types.js";
