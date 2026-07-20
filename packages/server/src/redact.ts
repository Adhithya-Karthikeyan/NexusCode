/**
 * Config redaction for `GET /v1/config`. The NexusConfig cascade holds only
 * logical secret *references* (`apiKeyRef` / `apiKeyEnv`) by design — never key
 * VALUES — but a few nested shapes (e.g. a `db` connection's `password` /
 * `connectionString`) can carry real credentials if a user inlined them. This
 * deep-clones the config and masks any field whose key name looks credential-
 * bearing, so the endpoint can never leak a secret that slipped into config.
 */

/** Mask substituted for any value under a credential-looking key. */
export const REDACTED = "***REDACTED***";

/** Key names (case-insensitive substring match) whose values are masked. */
const SECRET_KEY = /(password|passphrase|secret|token|apikey|api_key|connectionstring|connection_string|credential|private_?key)/i;

/** Deep-clone `value`, replacing any credential-looking field value with a mask. */
export function redactConfig<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) && typeof val === "string" && val.length > 0) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val);
      }
    }
    return out;
  }
  return value;
}
