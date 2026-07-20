/**
 * Read/write helpers for the *user* config file the CLI mutates (`config set`,
 * `providers add`, `mcp add`, `plugin add`, `budget set`).
 *
 * The one rule this module exists to hold: **the file we write must be the file
 * the loader reads.** `loadConfig` probes `USER_CONFIG_FILENAMES` in order and
 * returns on the FIRST hit, so a `config.yaml` shadows a `config.json`
 * completely. Writing blindly to `config.json` therefore produced a silent
 * no-op for every YAML user — reported success, exit 0, nothing changed. So
 * writes now target whichever candidate the loader would actually pick.
 *
 * Serialization stays JSON (no YAML dependency), which is safe because JSON is
 * valid YAML — a JSON document written into `config.yaml` / `.nexusrc` still
 * loads. What we cannot do is REWRITE a file whose existing content is real
 * YAML: we would have to parse it to preserve it, and dropping it silently is
 * exactly the data loss this module is guarding against. That case fails loudly
 * instead, naming the file that is winning.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NexusConfig as NexusConfigSchema,
  USER_CONFIG_FILENAMES,
  nexusPaths,
  type NexusConfigInput,
} from "@nexuscode/config";

/** The file written when the user config dir holds no config yet. */
const DEFAULT_USER_CONFIG_NAME = "config.json";

/**
 * Raised when the config file in force cannot be rewritten (see
 * {@link writeUserConfig}). This is operator error, not a crash, so the empty
 * `clipanion` marker asks the CLI's error formatter to print just the message —
 * a stack trace would bury the one line that tells the user which file is
 * winning. (Any future formatter that ignores the marker still prints the
 * message first, so the failure stays loud either way.)
 */
export class UserConfigWriteError extends Error {
  readonly clipanion = {};
  constructor(message: string) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

/** The directory the CLI reads/writes user config in (env override for tests). */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["NEXUS_CONFIG_DIR"] ?? nexusPaths().config;
}

/**
 * Content cosmiconfig would report as `isEmpty` — a blank or comments-only
 * file, which the loader SKIPS, so it shadows nothing and is free to overwrite.
 */
function isEffectivelyEmpty(text: string): boolean {
  return text.split("\n").every((line) => {
    const t = line.trim();
    return t === "" || t.startsWith("#");
  });
}

/**
 * Does this text parse as a YAML MAPPING — the only shape the loader accepts?
 *
 * A top-level `key:` at column 0 is the signature; a sequence (`- item`), a
 * bare scalar or `null` is not a mapping, so the loader's `isPlainObject` check
 * rejects it and moves on to the next candidate. Deliberately conservative: an
 * unrecognized shape is treated as NOT shadowing, which resolves to the same
 * file the loader would land on.
 */
function looksLikeYamlMapping(text: string): boolean {
  return text
    .split("\n")
    .some((line) => /^(?![#\s-])[^:]*:(\s|$)/.test(line.replace(/\r$/, "")));
}

/** Where user config lives right now, and whether this module may rewrite it. */
export interface UserConfigTarget {
  /** The file the loader actually reads. May not exist yet. */
  file: string;
  /**
   * Set when `file` exists with content we cannot safely round-trip (real
   * YAML). Rewriting it as JSON would silently discard whatever we failed to
   * parse, so writes refuse; the string explains which file is winning.
   */
  blocked: string | undefined;
  /** Current contents, when they parse as JSON. */
  data: NexusConfigInput;
}

/**
 * Resolve the user config file the loader would load, mirroring its probe order
 * exactly, plus whether we can rewrite it in place.
 */
export function resolveUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfigTarget {
  const dir = userConfigDir(env);
  for (const name of USER_CONFIG_FILENAMES) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    let raw: string;
    try {
      raw = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    // Blank/comments-only: the loader skips it, so keep probing.
    if (isEffectivelyEmpty(raw)) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { file: candidate, blocked: undefined, data: parsed as NexusConfigInput };
      }
    } catch {
      /* not JSON — decide below whether it shadows anything */
    }
    // Not JSON. The loader only accepts a candidate that parses to a plain
    // OBJECT (`isPlainObject`), so YAML that yields a sequence, a scalar or
    // null is skipped there too and shadows nothing — blocking on it would
    // brick every mutation while blaming the wrong file. Keep probing unless
    // this really is a mapping.
    if (!looksLikeYamlMapping(raw)) continue;
    return {
      file: candidate,
      blocked:
        `${candidate} is your effective user config (it takes precedence over every other ` +
        `candidate in ${dir}) and this command can only write JSON, so it cannot update it ` +
        `without discarding your existing settings. Edit ${candidate} by hand, or convert it ` +
        `to ${join(dir, DEFAULT_USER_CONFIG_NAME)} and delete it.`,
      data: {},
    };
  }
  return { file: join(dir, DEFAULT_USER_CONFIG_NAME), blocked: undefined, data: {} };
}

/**
 * The config file actually in force — what `nexus config path` should print and
 * what a mutation will target. Falls back to `config.json` when none exists yet.
 */
export function userConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolveUserConfig(env).file;
}

/**
 * The current user config, for a read-MODIFY-write cycle.
 *
 * Throws when the file in force cannot be parsed here. Returning `{}` instead
 * would hand every caller a false empty baseline: `mcp rm` / `plugin remove`
 * decide "no such entry" and return BEFORE reaching the write, so they would
 * report a confident, wrong "no server X" for a server the user can plainly see
 * in `mcp list`. Failing here makes those paths as loud as the `add` paths.
 */
export function readUserConfig(env: NodeJS.ProcessEnv = process.env): NexusConfigInput {
  const target = resolveUserConfig(env);
  if (target.blocked) throw new UserConfigWriteError(target.blocked);
  return target.data;
}

/**
 * Persist the user config, targeting the file the loader actually reads.
 *
 * Throws when that file holds YAML we cannot round-trip — a loud failure is the
 * only honest option, since the alternatives are clobbering the user's settings
 * or reporting a success that changes nothing.
 */
export function writeUserConfig(
  data: NexusConfigInput | Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const target = resolveUserConfig(env);
  if (target.blocked) throw new UserConfigWriteError(target.blocked);
  mkdirSync(userConfigDir(env), { recursive: true });
  // Write to a temp file and rename: a crash or a full disk mid-write would
  // otherwise leave a truncated config that fails schema validation and bricks
  // every later command. 0600 because this file can hold principal tokens.
  const tmp = `${target.file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target.file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup; report the original failure */
    }
    throw err;
  }
  return target.file;
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
