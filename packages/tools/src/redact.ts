/**
 * Secret redaction for logged tool arguments and output. Nothing a tool touches
 * should reach a trace sink, approval prompt, or audit log with a live
 * credential in it. Two layers: key-name heuristics (a field literally named
 * `password`/`token`/…) and value patterns (provider key shapes, bearer tokens,
 * private-key blocks). Redaction is conservative-but-eager on obvious secrets
 * and deliberately does NOT try to catch every high-entropy string, to avoid
 * mangling legitimate content.
 */

export const REDACTED = "[REDACTED]";

/** Field names whose values are always masked regardless of shape. */
const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|auth|credential|access[-_]?key|private[-_]?key|session[-_]?token|cookie|bearer)/i;

/** Value shapes that are masked wherever they appear inside a string. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bxai-[A-Za-z0-9_-]{16,}\b/g, // xAI
  /\bAIza[A-Za-z0-9_-]{16,}\b/g, // Google API key
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g, // GitHub classic tokens (ghp_, gho_, …)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe live/test keys (underscore form)
  /\bnpm_[A-Za-z0-9]{30,}\b/g, // npm automation/publish token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, // Authorization: Bearer …
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // raw JWT (eyJ… header.payload.sig), no Bearer prefix
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, // PEM
];

/**
 * Assignment-style credentials in free text: a key whose *name* contains a
 * secret word (`DB_PASSWORD=…`, `const password = "…"`, `"api_key": "…"`,
 * `client_secret: …`) followed by `:`/`=` and a value token. The key name and
 * operator are preserved; only the value is masked. The leading `[\w.$-]*`
 * absorbs identifier prefixes/suffixes (e.g. `DB_`, `_env`) so wrapped names
 * are caught too.
 */
const SECRET_ASSIGNMENT =
  /([\w.$-]*(?:password|passwd|secret|token|api[_-]?key|apikey|client[_-]?secret|access[_-]?key|auth[_-]?token|session[_-]?token))(["']?\s*[:=]\s*)(["']?)([^\s"';,)}\]]+)/gi;

/**
 * Passwords embedded in a connection URL's authority
 * (`postgres://user:pw@host`, `redis://:pw@host`). Scheme, user and host are
 * preserved; only the password segment between `:` and `@` is masked.
 */
const URL_AUTHORITY_CRED = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):([^\s:/@]+)@/gi;

/** Mask secret-shaped substrings inside a string. */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(SECRET_ASSIGNMENT, (_m, key, sep, quote) => `${key}${sep}${quote}${REDACTED}`);
  out = out.replace(URL_AUTHORITY_CRED, (_m, prefix) => `${prefix}:${REDACTED}@`);
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Deep-clone `value`, masking any secret-named field's value entirely and
 * scrubbing secret-shaped substrings from every string. Recursion is depth- and
 * breadth-bounded so a pathological input can never hang the logger.
 */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[…]";
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 1000).map((v) => redactArgs(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redactArgs(v, depth + 1);
  }
  return out;
}
