/**
 * A minimal, dependency-free semver range checker — just enough for the plugin
 * system's `engines` compatibility gate (system-spec §9 "versioning"). A plugin
 * declares which host it targets (e.g. `engines.nexuscode: "^1.2.0"`) and the
 * host checks its own version against that range before ever importing the
 * plugin module. Keeping this self-contained means the whole discovery/versioning
 * path stays offline and adds no third-party dependency.
 *
 * Supported range grammar (a comma/space-separated conjunction of comparators):
 *   *  x  X            → any version
 *   1.2.3             → exact
 *   =1.2.3            → exact
 *   >1.2.3  >=1.2.3   → greater-than [-or-equal]
 *   <1.2.3  <=1.2.3   → less-than [-or-equal]
 *   ^1.2.3            → caret (compatible-with; ^0.x pins the minor, ^0.0.x the patch)
 *   ~1.2.3            → tilde (approximately; allows patch-level changes)
 *   1.2.x  1.x        → wildcard segments (treated as ^-style ranges)
 * Pre-release identifiers are parsed but compared as "lower than" any release of
 * the same core version, which is sufficient for the compat gate.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, e.g. ["beta", "1"]. Empty ⇒ a release. */
  prerelease: string[];
}

const CORE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a strict `major.minor.patch[-prerelease][+build]` string. `null` if invalid. */
export function parseSemVer(input: string): SemVer | null {
  const m = CORE.exec(input.trim());
  if (!m) return null;
  const [, maj, min, pat, pre] = m;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    prerelease: pre ? pre.split(".") : [],
  };
}

/** Numeric comparison of two parsed versions. Returns -1 / 0 / 1. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // A version WITH a prerelease is lower than the same core WITHOUT one.
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const x = ap[i]!;
    const y = bp[i]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1; // numeric identifiers are lower than alphanumeric
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  if (ap.length === bp.length) return 0;
  return ap.length < bp.length ? -1 : 1;
}

/** Parse a possibly-partial version like "1", "1.2", "1.2.x" into fixed segments. */
function parsePartial(token: string): {
  major: number | undefined;
  minor: number | undefined;
  patch: number | undefined;
} {
  const parts = token.split(".");
  const seg = (s: string | undefined): number | undefined => {
    if (s === undefined) return undefined;
    if (s === "*" || s === "x" || s === "X") return undefined;
    if (!/^\d+$/.test(s)) return undefined;
    return Number(s);
  };
  return { major: seg(parts[0]), minor: seg(parts[1]), patch: seg(parts[2]) };
}

/** Build the [min, max) bounds a caret range `^token` allows. */
function caretBounds(token: string): { min: SemVer; max: SemVer } {
  const { major = 0, minor = 0, patch = 0 } = parsePartial(token);
  const min: SemVer = { major, minor, patch, prerelease: [] };
  let max: SemVer;
  if (major > 0) max = { major: major + 1, minor: 0, patch: 0, prerelease: [] };
  else if (minor > 0) max = { major: 0, minor: minor + 1, patch: 0, prerelease: [] };
  else max = { major: 0, minor: 0, patch: patch + 1, prerelease: [] };
  return { min, max };
}

/** Build the [min, max) bounds a tilde range `~token` allows. */
function tildeBounds(token: string): { min: SemVer; max: SemVer } {
  const parts = token.split(".");
  const { major = 0, minor = 0, patch = 0 } = parsePartial(token);
  const min: SemVer = { major, minor, patch, prerelease: [] };
  // `~1.2.3` and `~1.2` ⇒ >=1.2.0 <1.3.0 ; `~1` ⇒ >=1.0.0 <2.0.0.
  const max: SemVer =
    parts.length >= 2
      ? { major, minor: minor + 1, patch: 0, prerelease: [] }
      : { major: major + 1, minor: 0, patch: 0, prerelease: [] };
  return { min, max };
}

/** Build the [min, max) bounds a wildcard/partial range like `1.2.x` or `1` allows. */
function wildcardBounds(token: string): { min: SemVer; max: SemVer } | "any" {
  const { major, minor } = parsePartial(token);
  if (major === undefined) return "any";
  if (minor === undefined) {
    return {
      min: { major, minor: 0, patch: 0, prerelease: [] },
      max: { major: major + 1, minor: 0, patch: 0, prerelease: [] },
    };
  }
  return {
    min: { major, minor, patch: 0, prerelease: [] },
    max: { major, minor: minor + 1, patch: 0, prerelease: [] },
  };
}

/** Evaluate a single comparator against `v`. */
function satisfiesComparator(v: SemVer, comparator: string): boolean {
  const token = comparator.trim();
  if (token === "" || token === "*" || token === "x" || token === "X") return true;

  if (token.startsWith("^")) {
    const { min, max } = caretBounds(token.slice(1));
    return compareSemVer(v, min) >= 0 && compareSemVer(v, max) < 0;
  }
  if (token.startsWith("~")) {
    const { min, max } = tildeBounds(token.slice(1));
    return compareSemVer(v, min) >= 0 && compareSemVer(v, max) < 0;
  }
  if (token.startsWith(">=")) {
    const b = parseSemVer(normalizeCore(token.slice(2)));
    return b !== null && compareSemVer(v, b) >= 0;
  }
  if (token.startsWith("<=")) {
    const b = parseSemVer(normalizeCore(token.slice(2)));
    return b !== null && compareSemVer(v, b) <= 0;
  }
  if (token.startsWith(">")) {
    const b = parseSemVer(normalizeCore(token.slice(1)));
    return b !== null && compareSemVer(v, b) > 0;
  }
  if (token.startsWith("<")) {
    const b = parseSemVer(normalizeCore(token.slice(1)));
    return b !== null && compareSemVer(v, b) < 0;
  }
  const eq = token.startsWith("=") ? token.slice(1) : token;
  // Wildcard/partial (e.g. "1.2.x", "1") — otherwise exact.
  if (/[xX*]/.test(eq) || eq.split(".").length < 3) {
    const bounds = wildcardBounds(eq);
    if (bounds === "any") return true;
    return compareSemVer(v, bounds.min) >= 0 && compareSemVer(v, bounds.max) < 0;
  }
  const b = parseSemVer(eq);
  return b !== null && compareSemVer(v, b) === 0;
}

/** Fill a partial core like "1" / "1.2" out to "1.0.0" / "1.2.0". */
function normalizeCore(token: string): string {
  const t = token.trim().replace(/[xX*]/g, "0");
  const parts = t.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".");
}

/**
 * Does `version` satisfy `range`? The range is a conjunction of comparators
 * separated by spaces or commas (all must hold). An empty/`*` range accepts any
 * valid version. A malformed `version` never satisfies anything.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemVer(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*") return true;
  // Split into comparators. A hyphen-range ("1.2.3 - 2.0.0") is normalized to
  // >=/<= comparators first.
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) {
    return satisfiesComparator(v, `>=${hyphen[1]}`) && satisfiesComparator(v, `<=${hyphen[2]}`);
  }
  const comparators = trimmed.split(/\s*,\s*|\s+/).filter((c) => c.length > 0);
  return comparators.every((c) => satisfiesComparator(v, c));
}

/** True when `version` is a strictly-valid semver string. */
export function isValidSemVer(version: string): boolean {
  return parseSemVer(version) !== null;
}
