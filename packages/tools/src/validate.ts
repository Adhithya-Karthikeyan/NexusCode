/**
 * Tiny input validators shared by the built-in tools. Every tool receives
 * `unknown` and narrows it here, throwing a `NexusError("invalid_argument")`
 * with a precise, secret-free message on any mismatch.
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

/** Optional array-of-strings field. */
export function optStringArray(o: Record<string, unknown>, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    fail(`"${key}" must be an array of strings`);
  }
  return v as string[];
}

/** Optional string→string record field. */
export function optStringRecord(
  o: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(`"${key}" must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") fail(`"${key}.${k}" must be a string`);
    out[k] = val;
  }
  return out;
}
