/**
 * Tiny input validators for the AI tools. Every tool receives `unknown` and
 * narrows it here, throwing `NexusError("invalid_argument")` with a precise,
 * secret-free message on any mismatch — matching the built-in tool contract in
 * `@nexuscode/tools`.
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
  if (typeof v !== "string" || v.length === 0) fail(`"${key}" must be a non-empty string`);
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

/** Optional enum-of-strings field. */
export function optEnum<T extends string>(
  o: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(`"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}
