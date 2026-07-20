/**
 * Tiny input validators for the web tool group. Every tool receives `unknown`
 * and narrows it here, throwing a `NexusError("invalid_argument")` with a
 * precise, secret-free message on any mismatch. Mirrors the internal validators
 * of `@nexuscode/tools` (which are not part of that package's public surface).
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

/** Required string field (non-empty). */
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

/** Optional boolean field. */
export function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") fail(`"${key}" must be a boolean`);
  return v;
}
