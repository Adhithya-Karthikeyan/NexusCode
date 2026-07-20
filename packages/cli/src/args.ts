/**
 * A tiny, dependency-free argv parser. Enough for the MVP command surface —
 * long/short flags, `=` or space separated values, repeatable flags, boolean
 * switches, and positionals — with none of the clipanion RC-API surface area.
 */

export interface ParsedArgs {
  positionals: string[];
  /** Single-valued flags (last one wins). */
  flags: Map<string, string>;
  /** Repeatable flags (e.g. `-b a -b b`). */
  multi: Map<string, string[]>;
  /** Boolean switches present with no value. */
  bools: Set<string>;
  /**
   * Raw `-`/`--` tokens (e.g. `--modle`) that matched no entry in the
   * {@link FlagSpec} — a typo like `--modle` instead of `--model`. Not an
   * error (unrecognized tokens still parse as a harmless boolean, matching
   * prior behavior), but surfaced so a caller can warn instead of silently
   * using the wrong value.
   */
  unknown: string[];
}

/** Long/short flag names that take a value. Everything else is boolean. */
export interface FlagSpec {
  /** Canonical name → set of aliases (including the canonical, without dashes). */
  value?: Record<string, string[]>;
  /** Value flags that may repeat and accumulate. */
  multi?: Record<string, string[]>;
  /** Boolean switches → aliases. */
  bool?: Record<string, string[]>;
}

function buildAliasMap(groups: Record<string, string[]> | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!groups) return m;
  for (const [canonical, aliases] of Object.entries(groups)) {
    m.set(canonical, canonical);
    for (const a of aliases) m.set(a, canonical);
  }
  return m;
}

/**
 * Edit distance (insert/delete/substitute, plus adjacent transposition as a
 * single edit — "Optimal String Alignment"), used for "did you mean". The
 * transposition case matters in practice: a typo like `modle` for `model` is
 * a single adjacent-letter swap, and treating it as 2 substitutions would let
 * an unrelated same-prefix flag (e.g. `mode`, one deletion away) outrank it.
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(dp[i - 1]![j - 1]! + cost, dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, dp[i - 2]![j - 2]! + 1);
      }
      dp[i]![j] = best;
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

/** Nearest canonical flag name to `name` within a small edit-distance budget, or undefined. */
function nearestFlagName(name: string, candidates: string[]): string | undefined {
  let bestDist = Infinity;
  let ties: string[] = [];
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestDist) {
      bestDist = d;
      ties = [c];
    } else if (d === bestDist) {
      ties.push(c);
    }
  }
  if (bestDist === 0 || bestDist > 2 || ties.length === 0) return undefined;
  // Same-length ties are the far more likely intent (a transposition or
  // substitution typo preserves length); a shorter/longer tied candidate is
  // more likely an unrelated flag that just happens to be equidistant.
  return ties.find((c) => c.length === name.length) ?? ties[0];
}

/** Human-readable "unknown flag(s)" warning, one line, with a "did you mean" per flag when close. */
function unknownFlagWarning(unknown: string[], candidates: string[]): string {
  const parts = unknown.map((tok) => {
    const raw = tok.replace(/^-+/, "");
    const name = raw.indexOf("=") >= 0 ? raw.slice(0, raw.indexOf("=")) : raw;
    const guess = nearestFlagName(name, candidates);
    return guess ? `${tok} — did you mean --${guess}?` : tok;
  });
  return `warning: unknown flag(s) ignored: ${parts.join(", ")}\n`;
}

/**
 * Parse `argv` (already sliced past `node script`). Unknown value-less tokens
 * beginning with `-` are treated as boolean switches so callers can detect them.
 */
export function parseArgs(argv: string[], spec: FlagSpec = {}): ParsedArgs {
  const valueAlias = buildAliasMap(spec.value);
  const multiAlias = buildAliasMap(spec.multi);
  const boolAlias = buildAliasMap(spec.bool);
  // Canonical (long) names only, for "did you mean" suggestions — aliases are
  // mostly single-char shorthands that make poor/confusing suggestions.
  const candidateNames = [
    ...Object.keys(spec.value ?? {}),
    ...Object.keys(spec.multi ?? {}),
    ...Object.keys(spec.bool ?? {}),
  ];

  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const bools = new Set<string>();
  const unknown: string[] = [];

  const takesValue = (name: string): "single" | "multi" | null => {
    if (valueAlias.has(name)) return "single";
    if (multiAlias.has(name)) return "multi";
    return null;
  };

  let i = 0;
  let doubleDash = false;
  while (i < argv.length) {
    const tok = argv[i];
    i++;
    if (tok === undefined) continue;

    if (doubleDash) {
      positionals.push(tok);
      continue;
    }
    if (tok === "--") {
      doubleDash = true;
      continue;
    }

    if (tok.startsWith("--") || tok.startsWith("-")) {
      const raw = tok.replace(/^-+/, "");
      const eq = raw.indexOf("=");
      const name = eq >= 0 ? raw.slice(0, eq) : raw;
      const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;

      const kind = takesValue(name);
      if (kind) {
        let value = inlineValue;
        if (value === undefined) {
          value = argv[i];
          i++;
        }
        if (value === undefined) value = "";
        if (kind === "single") {
          flags.set(valueAlias.get(name) as string, value);
        } else {
          const canon = multiAlias.get(name) as string;
          const arr = multi.get(canon) ?? [];
          arr.push(value);
          multi.set(canon, arr);
        }
      } else {
        // Unknown flag/typo (e.g. `--modle` instead of `--model`): kept as a
        // harmless boolean switch (unchanged prior behavior — never a hard
        // error), but recorded so the caller sees a visible warning instead of
        // the typo silently taking effect with no feedback.
        if (!boolAlias.has(name)) unknown.push(tok);
        const canon = boolAlias.get(name) ?? name;
        bools.add(canon);
        if (inlineValue !== undefined) flags.set(canon, inlineValue);
      }
      continue;
    }

    positionals.push(tok);
  }

  if (unknown.length > 0) {
    process.stderr.write(unknownFlagWarning(unknown, candidateNames));
  }

  return { positionals, flags, multi, bools, unknown };
}
