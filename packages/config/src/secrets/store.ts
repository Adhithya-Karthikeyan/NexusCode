/**
 * `SecretStore` — frozen contract. Config holds only logical references
 * (`apiKeyRef` / `apiKeyEnv`); the store resolves them to actual key values and
 * reports which backend answered (surfaced by `nexus doctor`). Secrets are
 * never written to SQLite history or the trace store.
 */

export type SecretSource = "env" | "keychain" | "file";

export interface SecretStore {
  /** Resolve a logical ref to its key value, or null if unset everywhere. */
  get(ref: string): Promise<string | null>;
  /** Persist a key value (writes to the highest available durable backend). */
  set(ref: string, value: string): Promise<void>;
  /** Remove a key value from every writable backend. */
  delete(ref: string): Promise<void>;
  /** Which backend currently answers `get(ref)`, or null if none. */
  source(ref: string): Promise<SecretSource | null>;
}
