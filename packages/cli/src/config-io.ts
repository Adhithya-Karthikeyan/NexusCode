/**
 * Read/write helpers for the *user* config file the CLI mutates (`config set`,
 * `providers add`). We standardize writes on `config.json` (no YAML dependency);
 * the loader already searches `config.json` in the user config dir. Reads go
 * through the real precedence-aware loader — this module only owns the writable
 * JSON layer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NexusConfig as NexusConfigSchema, nexusPaths, type NexusConfigInput } from "@nexuscode/config";

/** The directory the CLI reads/writes user config in (env override for tests). */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["NEXUS_CONFIG_DIR"] ?? nexusPaths().config;
}

/** The concrete file the CLI writes to. */
export function userConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDir(env), "config.json");
}

export function readUserConfig(env: NodeJS.ProcessEnv = process.env): NexusConfigInput {
  const file = userConfigFile(env);
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as NexusConfigInput) : {};
  } catch {
    return {};
  }
}

export function writeUserConfig(
  data: NexusConfigInput | Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = userConfigDir(env);
  mkdirSync(dir, { recursive: true });
  const file = userConfigFile(env);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}

/** Set a dotted path (e.g. `tui.theme`) on a plain object, coercing scalars. */
export function setPath(obj: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      throw new Error("invalid config key: " + k);
    }
    const next = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      cur[k] = created;
      cur = created;
    }
  }
  const leaf = parts[parts.length - 1] as string;
  if (leaf === "__proto__" || leaf === "constructor" || leaf === "prototype") {
    throw new Error("invalid config key: " + leaf);
  }
  cur[leaf] = coerce(value);
}

/** Read a dotted path, or undefined. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/** The top-level keys the schema actually recognizes (for error messages). */
function validKeys(): string[] {
  return Object.keys(NexusConfigSchema.shape).sort();
}

export type ConfigValidation = { ok: true } | { ok: false; message: string };

/**
 * Validate a candidate user-config object against the real schema BEFORE it is
 * ever written to disk. A bad `config set` (e.g. a typo'd or nonexistent key)
 * must fail loudly here instead of silently writing a file that bricks every
 * later command when `loadConfig` re-parses it.
 */
export function validateUserConfig(data: unknown): ConfigValidation {
  const parsed = NexusConfigSchema.safeParse(data);
  if (parsed.success) return { ok: true };
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return {
    ok: false,
    message: `invalid config — ${detail} (valid top-level keys: ${validKeys().join(", ")})`,
  };
}
