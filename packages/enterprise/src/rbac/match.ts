/**
 * Glob matching for RBAC/policy resource + action patterns. A single `*`
 * wildcard matches any run of characters (including the `:` type separator), so
 * `*` matches every resource, `tool:*` matches `tool:fs_write`, and an exact
 * string matches only itself. Patterns are anchored end-to-end.
 */

const cache = new Map<string, RegExp>();

/** Compile a `*`-glob pattern into an anchored RegExp (memoized). */
export function patternToRegExp(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (re) return re;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  re = new RegExp(`^${escaped}$`);
  cache.set(pattern, re);
  return re;
}

/** True if `value` matches `pattern` (single `*` wildcard). */
export function matchesPattern(pattern: string, value: string): boolean {
  return patternToRegExp(pattern).test(value);
}

/** True if `value` matches ANY of `patterns`. An empty/undefined list is false. */
export function matchesAny(patterns: readonly string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matchesPattern(p, value));
}
