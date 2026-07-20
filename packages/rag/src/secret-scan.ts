/**
 * Secret scanning + redaction (system-spec §16 / §17 — "no secret persisted into
 * the index/cache" invariant, and no third-party exfiltration via a remote
 * embedder). Before a chunk is embedded, stored, or persisted, its text is run
 * through {@link redactSecrets}, which replaces known credential shapes with a
 * fixed placeholder. This guarantees that:
 *   - `rag-index.json` never contains a raw secret (nothing sensitive at rest),
 *   - a remote embedder (`ollama`/`openai`) never receives a raw secret over the
 *     network (no exfiltration path), and
 *   - {@link RagRetrievalSource} never surfaces a secret back into the LLM
 *     context.
 *
 * Detection is intentionally conservative — structured, high-signal patterns
 * (known token prefixes and PEM private-key blocks) plus assignment-shaped
 * `name = value` credential lines — so it does not corrupt ordinary source code
 * while still catching the common leak shapes. It is a defense-in-depth
 * complement to the file-level secret denylist in the project walker (which keeps
 * `.env`, `*.pem`, `id_rsa`, … out of the indexer in the first place).
 */

/** The text substituted in place of a detected secret. */
export const SECRET_PLACEHOLDER = "[REDACTED-SECRET]";

/**
 * Structured, high-confidence secret shapes. These match verbatim credential
 * material (provider token prefixes, PEM private-key blocks) with a low
 * false-positive rate on ordinary prose/code.
 */
const STRUCTURED_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (RSA/EC/OPENSSH/PGP/generic).
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  // OpenAI / Anthropic style `sk-...` (incl. `sk-proj-`, `sk-ant-`).
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  // Stripe live/test keys.
  /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  // GitHub personal-access / fine-grained / OAuth / app tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{12,}\b/g,
  // Google API keys / OAuth tokens.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  // Generic JWTs (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

/**
 * Assignment-shaped credential lines: a secret-ish key name followed by `=`/`:`
 * and a value of meaningful length. Only the value is redacted (group 3), so the
 * variable name — useful context — is preserved. This catches `.env`-style
 * `API_KEY=...`, `password: "..."`, `client_secret = '...'`, etc.
 */
const ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|passwd|password|pwd|token|bearer|session[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(["']?)([^\s"'`]{8,})(\2)/gi;

/** Result of scanning a chunk of text for secrets. */
export interface SecretScanResult {
  /** The text with every detected secret replaced by {@link SECRET_PLACEHOLDER}. */
  redacted: string;
  /** How many distinct secret occurrences were redacted. */
  count: number;
}

/**
 * Replace every detected secret in `text` with {@link SECRET_PLACEHOLDER}.
 * Returns the sanitized text and the number of redactions. Idempotent: running
 * it again over already-redacted text is a no-op (the placeholder matches none of
 * the patterns).
 */
export function scanSecrets(text: string): SecretScanResult {
  let count = 0;
  let out = text;

  for (const pattern of STRUCTURED_PATTERNS) {
    out = out.replace(pattern, () => {
      count++;
      return SECRET_PLACEHOLDER;
    });
  }

  out = out.replace(ASSIGNMENT_PATTERN, (_m, prefix: string, quote: string, value: string) => {
    // Don't redact an already-redacted value or an obvious env-var reference.
    if (value === SECRET_PLACEHOLDER || /^\$[A-Za-z{]/.test(value)) return `${prefix}${quote}${value}${quote}`;
    count++;
    return `${prefix}${quote}${SECRET_PLACEHOLDER}${quote}`;
  });

  return { redacted: out, count };
}

/** Convenience: the sanitized text only. */
export function redactSecrets(text: string): string {
  return scanSecrets(text).redacted;
}

/** True when `text` contains at least one detectable secret. */
export function containsSecret(text: string): boolean {
  return scanSecrets(text).count > 0;
}
