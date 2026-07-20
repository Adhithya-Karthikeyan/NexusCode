/**
 * Tiny input validators for the container tools. Each tool receives `unknown`
 * and narrows it here, throwing `NexusError("invalid_argument")` with a precise,
 * secret-free message on any mismatch — the same contract the built-in tools in
 * `@nexuscode/tools` use.
 */

import { NexusError } from "@nexuscode/shared";

function fail(msg: string): never {
  throw new NexusError("invalid_argument", msg);
}

/** Assert the input is a plain object. */
export function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("expected an object argument");
  }
  return input as Record<string, unknown>;
}

/** Required string field. */
export function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string") fail(`"${key}" must be a string`);
  return v;
}

/** Optional string field. */
export function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") fail(`"${key}" must be a string`);
  return v;
}

/** Optional finite number field. */
export function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`"${key}" must be a finite number`);
  return v;
}

/** Optional boolean field. */
export function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") fail(`"${key}" must be a boolean`);
  return v;
}

/** Optional string field constrained to a fixed set of allowed values. */
export function optEnum<T extends string>(
  o: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = optString(o, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) {
    fail(`"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

/**
 * Guard a value destined for a CLI *positional* argument (a container id, pod
 * name, namespace, container name). Even though we never touch a shell, a value
 * that begins with `-` would be misread as an option flag by the CLI, so we
 * reject leading dashes and a handful of shell/whitespace metacharacters. This
 * keeps a caller from smuggling e.g. `--rm` or `; rm -rf` into an otherwise
 * read-only invocation.
 */
export function safeIdentifier(value: string, label: string): string {
  if (value.length === 0) fail(`"${label}" must not be empty`);
  if (value.startsWith("-")) fail(`"${label}" must not start with "-"`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.:/@-]*)$/.test(value)) {
    fail(`"${label}" contains invalid characters`);
  }
  return value;
}
