/**
 * SQL statement classification. We never parse SQL fully — we only need to tell
 * a read (SELECT/EXPLAIN/PRAGMA-get/…) apart from a mutation (INSERT/UPDATE/DDL/…)
 * so the tool layer can refuse writes that were not explicitly opted into via the
 * `write` flag. This is a coarse, conservative gate: anything not clearly a read
 * is treated as a mutation.
 */

/** Strip `--` line comments and `/* *\/` block comments from a SQL string. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

/** Leading keywords that begin a read-only statement. */
const READ_LEADERS = new Set([
  "select",
  "explain",
  "show",
  "describe",
  "desc",
  "values",
  "table",
  "pragma",
]);

/** Keywords that, anywhere in a CTE / compound statement, imply a mutation. */
const MUTATION_KEYWORDS = /\b(insert|update|delete|merge|create|drop|alter|truncate|replace|grant|revoke|call|attach|detach|vacuum)\b/i;

/**
 * True when `sql` is (conservatively) a data- or schema-mutating statement.
 *
 * Rules:
 *   - Comment-stripped, the first keyword decides the common case.
 *   - `WITH` (CTE) is a mutation only if the body contains a mutation keyword
 *     (e.g. Postgres `WITH ... DELETE`), otherwise a read.
 *   - `PRAGMA name = value` (an assignment) is a write; `PRAGMA name` is a read.
 *   - Anything whose leading keyword is not a known read leader is a mutation.
 */
export function isMutation(sql: string): boolean {
  const s = stripSqlComments(sql).trim().toLowerCase();
  if (s.length === 0) return false;
  const first = /^[a-z_]+/.exec(s)?.[0] ?? "";

  if (first === "with") {
    return MUTATION_KEYWORDS.test(s);
  }
  if (READ_LEADERS.has(first)) {
    // A PRAGMA that assigns (`pragma foo = bar`) mutates; a plain read does not.
    if (first === "pragma" && /=/.test(s)) return true;
    return false;
  }
  return true;
}

/**
 * Normalize a single bind parameter into a value the SQLite / SQL driver layer
 * accepts. Booleans become 1/0, `undefined` becomes null, Dates become ISO
 * strings, and plain objects/arrays are JSON-encoded. Numbers, strings, bigints,
 * Buffers/typed-arrays and null pass through untouched.
 */
export function normalizeBindValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return v;
  // Fallback: encode structured values so a driver never receives an opaque object.
  return JSON.stringify(v);
}
