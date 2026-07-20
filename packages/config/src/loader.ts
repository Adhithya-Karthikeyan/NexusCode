/**
 * Config loading & precedence. Each layer is deep-merged low→high; **arrays
 * replace, not concat** (a project can fully override routing). Highest wins:
 *
 *   1. CLI flags          (passed in `opts.flags`)
 *   2. Env overrides      (NEXUS_*, non-secret only)
 *   3. Project config     (./nexuscode.config.* | package.json#nexuscode | .nexusrc)
 *   4. User config        ($XDG_CONFIG_HOME/nexuscode/config.yaml, via env-paths)
 *   5. Built-in defaults  (zod .default())
 *
 * Provider key *values* never enter this cascade — see ./secrets.
 */

import { join } from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import { NexusError } from "@nexuscode/shared";
import { NexusConfig, type NexusConfigInput } from "./schema.js";
import { nexusPaths } from "./paths.js";

export type ConfigLayer = "defaults" | "user" | "project" | "env" | "flags";

export interface LoadConfigOptions {
  /** Directory to search from for a project config (default `process.cwd()`). */
  cwd?: string;
  /** Highest-precedence overrides (parsed CLI flags). */
  flags?: NexusConfigInput;
  /** Environment source for NEXUS_* overrides (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Explicit project config file to load instead of searching. */
  configPath?: string;
  /** Override the user config directory (mainly for tests). */
  userConfigDir?: string;
  /** Sink for non-fatal warnings (default: write a line to `process.stderr`). */
  onWarning?: (message: string) => void;
}

export interface LoadedConfig {
  config: NexusConfig;
  /** Layers that actually contributed data, lowest→highest. */
  layers: ConfigLayer[];
  /** Resolved project config file, if one was found. */
  projectFilepath: string | undefined;
  /** Resolved user config file, if one was found. */
  userFilepath: string | undefined;
  /** Non-fatal warnings raised while loading (e.g. unrecognized keys ignored). */
  warnings: string[];
}

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `source` onto `target`. Arrays replace; undefined is ignored. */
function deepMerge(target: Plain, source: Plain): Plain {
  const out: Plain = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (isPlainObject(prev) && isPlainObject(v)) {
      out[k] = deepMerge(prev, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** An `unrecognized_keys` zod issue, narrowed for the strip-and-retry path below. */
type UnrecognizedKeysIssue = Extract<z.ZodIssue, { code: "unrecognized_keys" }>;

function isUnrecognizedKeysIssue(issue: z.ZodIssue): issue is UnrecognizedKeysIssue {
  return issue.code === "unrecognized_keys";
}

/** Delete `keys` from the plain object living at `path` inside `data`, if present.
 * `path` may traverse through arrays (e.g. a `providers[]` entry), so indexing
 * tolerates both plain objects and arrays; only the final container — the one
 * that actually raised `unrecognized_keys` — is required to be a plain object. */
function stripKeysAtPath(data: Plain, path: (string | number)[], keys: string[]): void {
  let cur: unknown = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  if (isPlainObject(cur)) {
    for (const k of keys) delete cur[k];
  }
}

/**
 * Scrub executable launch recipes out of the UNTRUSTED project-config layer,
 * mutating `project` in place and returning the names of the fields dropped.
 *
 * Spawn-bearing / code-loading config fields are launch instructions:
 * `lsp.servers[]` and stdio `mcp[]`/subprocess `providers[]` each carry a
 * `command` + `args` that end up in `child_process.spawn`; each `hooks.hooks[]`
 * command hook likewise spawns a child on a lifecycle event; and `plugins.dirs`
 * / `plugins.scanNodeModules` cause arbitrary local modules to be `import()`-ed
 * (top-level module code runs with full Node privileges BEFORE any capability
 * check). Accepting any of these from a project config (a file that ships inside
 * a cloned repo) is a workspace-trust RCE — merely running any `nexus` command in
 * the cloned directory would spawn/import attacker-controlled code with the
 * victim's privileges and env. There is no workspace-trust prompt or command
 * allowlist, so these fields are honored ONLY from the user/global layer; the
 * project layer may still contribute every non-executable setting (routing,
 * pricing, budgets, …).
 */
function stripUntrustedSpawnFields(project: Plain): string[] {
  const dropped: string[] = [];

  // lsp.servers[]: each entry is a { command, args } launch recipe → direct spawn.
  const lsp = project["lsp"];
  if (isPlainObject(lsp) && lsp["servers"] !== undefined) {
    delete lsp["servers"];
    dropped.push("lsp.servers");
  }

  // mcp[] stdio entries: a `command` spawns a local MCP server process.
  const mcp = project["mcp"];
  if (Array.isArray(mcp)) {
    const kept = mcp.filter((e) => !(isPlainObject(e) && typeof e["command"] === "string"));
    if (kept.length !== mcp.length) {
      project["mcp"] = kept;
      dropped.push("mcp[stdio]");
    }
  }

  // providers[] with a `command`: subprocess coding-CLI adapters spawn a local binary.
  const providers = project["providers"];
  if (Array.isArray(providers)) {
    const kept = providers.filter((e) => !(isPlainObject(e) && typeof e["command"] === "string"));
    if (kept.length !== providers.length) {
      project["providers"] = kept;
      dropped.push("providers[command]");
    }
  }

  // hooks.hooks[]: each command hook carries a `command` + `args` that
  // `@nexuscode/hooks` feeds to `child_process.spawn` on a lifecycle event
  // (session-start fires on the very first command) → direct spawn. The rest of
  // the `hooks` block (e.g. the `enabled` master switch) is a harmless toggle and
  // is preserved; only the executable hook list is dropped.
  const hooks = project["hooks"];
  if (isPlainObject(hooks) && hooks["hooks"] !== undefined) {
    delete hooks["hooks"];
    dropped.push("hooks.hooks");
  }

  // plugins.dirs / plugins.scanNodeModules: both drive the PluginHost to
  // `import()` local modules, running their top-level code with full Node
  // privileges before any capability gate. A repo pointing `dirs` at its own
  // `./.evil` (or shipping `node_modules/nexuscode-plugin-x`) would auto-execute
  // on the next invocation. Drop the extra dirs and force node_modules scanning
  // OFF for the project layer; plugin discovery is honored only from user config
  // + the explicit `NEXUS_PLUGINS_DIR` / trusted-workspace seams (see extensions).
  const plugins = project["plugins"];
  if (isPlainObject(plugins)) {
    if (plugins["dirs"] !== undefined) {
      delete plugins["dirs"];
      dropped.push("plugins.dirs");
    }
    if (plugins["scanNodeModules"] !== undefined) {
      plugins["scanNodeModules"] = false;
      dropped.push("plugins.scanNodeModules");
    }
  }

  return dropped;
}

/** Map recognized NEXUS_* env vars into a partial config (non-secret only). */
export function envOverrides(env: NodeJS.ProcessEnv): NexusConfigInput {
  const out: NexusConfigInput = {};
  const provider = env["NEXUS_DEFAULT_PROVIDER"];
  if (provider) out.defaultProvider = provider;
  const model = env["NEXUS_DEFAULT_MODEL"];
  if (model) out.defaultModel = model;
  const approval = env["NEXUS_APPROVAL"];
  if (approval === "auto" || approval === "confirm" || approval === "dry-run") out.approval = approval;
  const dbPath = env["NEXUS_HISTORY_DB"];
  if (dbPath) out.history = { dbPath };
  const historyOff = env["NEXUS_HISTORY_DISABLED"];
  if (historyOff === "1" || historyOff === "true") {
    out.history = { ...(out.history ?? {}), enabled: false };
  }
  return out;
}

/**
 * The user-config filenames probed inside the user config dir, in PRECEDENCE
 * order — the FIRST one that exists wins outright and the rest are never read.
 *
 * Exported because anything that WRITES user config has to target the same file
 * this list resolves to. A writer that always emits `config.json` while this
 * list puts `config.yaml` first produces a silent no-op: the write succeeds, and
 * the shadowing YAML keeps winning every subsequent load.
 */
export const USER_CONFIG_FILENAMES = [
  "config.yaml",
  "config.yml",
  "config.json",
  ".nexusrc",
  ".nexusrc.json",
] as const;

async function loadUserConfig(dir: string): Promise<{ data: Plain; filepath: string } | null> {
  // `.load()` targets an explicit file, so no search strategy is involved.
  const explorer = cosmiconfig("nexuscode");
  for (const name of USER_CONFIG_FILENAMES) {
    try {
      const res = await explorer.load(join(dir, name));
      if (res && !res.isEmpty && isPlainObject(res.config)) {
        return { data: res.config, filepath: res.filepath };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      // A malformed but present user config is a real error.
      throw new NexusError("config_invalid", `failed to load user config ${name}`, { cause: e });
    }
  }
  return null;
}

async function loadProjectConfig(
  cwd: string,
  configPath: string | undefined,
): Promise<{ data: Plain; filepath: string } | null> {
  const explorer = cosmiconfig("nexuscode", { searchStrategy: "project" });
  try {
    const res = configPath ? await explorer.load(configPath) : await explorer.search(cwd);
    if (res && !res.isEmpty && isPlainObject(res.config)) {
      return { data: res.config, filepath: res.filepath };
    }
  } catch (e) {
    throw new NexusError("config_invalid", "failed to load project config", { cause: e });
  }
  return null;
}

/**
 * Load, merge, and validate the effective configuration. Throws
 * `NexusError("config_invalid")` on a zod validation failure.
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const userDir = opts.userConfigDir ?? nexusPaths().config;

  const user = await loadUserConfig(userDir);
  const project = await loadProjectConfig(cwd, opts.configPath);
  const envLayer = envOverrides(env);
  const flagsLayer = (opts.flags ?? {}) as Plain;

  const warnings: string[] = [];
  const warn = opts.onWarning ?? ((message: string) => process.stderr.write(`${message}\n`));

  const layers: ConfigLayer[] = ["defaults"];
  let merged: Plain = {};
  if (user) {
    merged = deepMerge(merged, user.data);
    layers.push("user");
  }
  if (project) {
    // The project layer is UNTRUSTED (it ships inside the cloned repo). Scrub its
    // executable launch recipes before merging so a malicious repo can never make
    // us spawn a command — see stripUntrustedSpawnFields. Clone first so we never
    // mutate cosmiconfig's cached result object.
    const projectData = structuredClone(project.data);
    const dropped = stripUntrustedSpawnFields(projectData);
    if (dropped.length > 0) {
      const message =
        `nexuscode: ignoring executable launch recipe(s) [${dropped.join(", ")}] from the project ` +
        `config at ${project.filepath} — spawn-bearing fields are only honored from your user/global ` +
        `config (workspace trust: a cloned repo must not be able to run commands on your machine).`;
      warnings.push(message);
      warn(message);
    }
    merged = deepMerge(merged, projectData);
    layers.push("project");
  }
  if (Object.keys(envLayer).length > 0) {
    merged = deepMerge(merged, envLayer as Plain);
    layers.push("env");
  }
  if (Object.keys(flagsLayer).length > 0) {
    merged = deepMerge(merged, flagsLayer);
    layers.push("flags");
  }

  let parsed = NexusConfig.safeParse(merged);

  // A config with unknown keys (e.g. a typo, or a stale key from an older
  // version) must never brick every command. Strip exactly the unrecognized
  // keys and retry; only genuinely unusable data (wrong type on a KNOWN key)
  // is still a hard error.
  if (!parsed.success) {
    const unknownKeyIssues = parsed.error.issues.filter(isUnrecognizedKeysIssue);
    if (unknownKeyIssues.length > 0) {
      const stripped = structuredClone(merged);
      const removed: string[] = [];
      for (const issue of unknownKeyIssues) {
        for (const k of issue.keys) removed.push([...issue.path, k].join("."));
        stripKeysAtPath(stripped, issue.path, issue.keys);
      }
      const retried = NexusConfig.safeParse(stripped);
      if (retried.success) {
        const message =
          `nexuscode: config has unrecognized key(s) [${removed.join(", ")}] — ` +
          `ignoring them and continuing with the valid subset + defaults.`;
        warnings.push(message);
        warn(message);
        parsed = retried;
      }
    }
  }

  if (!parsed.success) {
    throw new NexusError("config_invalid", `invalid configuration: ${formatZodError(parsed.error)}`, {
      detail: { issues: parsed.error.issues },
    });
  }

  return {
    config: parsed.data,
    layers,
    projectFilepath: project?.filepath,
    userFilepath: user?.filepath,
    warnings,
  };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
