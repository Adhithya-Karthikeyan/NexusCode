/**
 * Safe {{variable}} interpolation — no `eval`, no `Function`, no template-literal
 * execution. Placeholders are matched by a fixed regex and substituted in a
 * single left-to-right pass, so a value that itself contains `{{x}}` is never
 * re-expanded (a template-injection guard). Object values serialize with sorted
 * keys so the same inputs always produce byte-identical output (cache stability).
 */

import { NexusError } from "@nexuscode/shared";

/** Variable bag. Values are stringified deterministically at substitution time. */
export type PromptVars = Record<string, unknown>;

/** What to do when a referenced `{{var}}` has no value. */
export type MissingVarBehavior = "throw" | "empty" | "keep";

/**
 * Matches `{{ name }}` / `{{name}}` / `{{a.b.c}}`. A name starts with a letter
 * or underscore and may contain letters, digits, underscores and dots (dotted
 * paths index into nested objects). Anything else is left untouched.
 */
const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

/** Stable JSON: object keys sorted recursively so serialization is deterministic. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/** Coerce a resolved value to its prompt string form. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return stableStringify(value);
}

/** Resolve a dotted path against the vars bag. Returns `undefined` if any hop is absent. */
function lookup(vars: PromptVars, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = vars;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    // Own-property only: never resolve inherited prototype members
    // (`constructor`, `__proto__`, `toString`, …) — that would leak internals.
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Substitute every `{{var}}` in `body` from `vars`. A single pass — substituted
 * text is never rescanned. Missing variables are handled per `onMissing`.
 */
export function interpolate(
  body: string,
  vars: PromptVars = {},
  onMissing: MissingVarBehavior = "throw",
): string {
  return body.replace(TOKEN, (match, path: string) => {
    const value = lookup(vars, path);
    if (value === undefined || value === null) {
      if (onMissing === "throw") {
        throw new NexusError("invalid_argument", `missing template variable: ${path}`, {
          detail: { variable: path },
        });
      }
      if (onMissing === "empty") return "";
      return match; // "keep": leave the literal placeholder in place
    }
    return stringify(value);
  });
}

/** Unique, sorted list of variable names referenced by a template body. */
export function referencedVars(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(TOKEN)) found.add(m[1]!);
  return [...found].sort();
}
