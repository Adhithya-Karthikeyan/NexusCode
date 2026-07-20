/**
 * {@link LanguageServerRegistry} — maps a NexusCode language key to one or more
 * candidate {@link ServerSpec}s and feature-detects which are actually installed
 * on `PATH`. This is the graceful-degradation seam: when no server is installed
 * for a language, {@link openLanguageServer} returns `{ ok: false, reason }`
 * rather than throwing, so the coding loop can fall back to the repo map.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { join, delimiter, extname, sep } from "node:path";

import { spawnLspClient, type LspClient } from "./client.js";
import type { LspClientOptions, OpenResult, ServerSpec } from "./types.js";

/**
 * Default, widely-used language servers. Multiple entries per language are tried
 * in order; the first whose command is on `PATH` wins. These are launch recipes
 * only — nothing here spawns a process until {@link openLanguageServer}.
 */
export const DEFAULT_SERVER_SPECS: ServerSpec[] = [
  {
    language: "typescript",
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".mts", ".cts"],
    rootMarkers: ["tsconfig.json", "package.json", ".git"],
    label: "typescript-language-server",
  },
  {
    language: "typescriptreact",
    languageId: "typescriptreact",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".tsx"],
    rootMarkers: ["tsconfig.json", "package.json", ".git"],
    label: "typescript-language-server",
  },
  {
    language: "javascript",
    languageId: "javascript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    rootMarkers: ["package.json", "jsconfig.json", ".git"],
    label: "typescript-language-server",
  },
  {
    language: "python",
    languageId: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
    label: "pyright",
  },
  {
    language: "python",
    languageId: "python",
    command: "pylsp",
    args: [],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", ".git"],
    label: "python-lsp-server",
  },
  {
    language: "rust",
    languageId: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml", ".git"],
    label: "rust-analyzer",
  },
  {
    language: "go",
    languageId: "go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    rootMarkers: ["go.mod", ".git"],
    label: "gopls",
  },
];

/**
 * Return true if `command` is resolvable on `PATH`. Absolute/relative paths are
 * checked directly. Cross-platform: on Windows, PATHEXT extensions are probed.
 * Pure filesystem — no process is launched.
 */
export function isCommandInstalled(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!command) return false;

  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  const canExec = (p: string): boolean => {
    for (const ext of exts) {
      const candidate = p + ext;
      try {
        accessSync(candidate, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
        return true;
      } catch {
        // try next ext
      }
    }
    return false;
  };

  // Explicit path (contains a separator) → check as-is.
  if (command.includes(sep) || command.includes("/")) {
    return canExec(command);
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    if (canExec(join(dir, command))) return true;
  }
  return false;
}

export class LanguageServerRegistry {
  private readonly specs: ServerSpec[] = [];
  private readonly installedCache = new Map<string, boolean>();

  constructor(specs: ServerSpec[] = DEFAULT_SERVER_SPECS) {
    for (const s of specs) this.register(s);
  }

  /** Add a candidate spec. Later registrations for a language are lower priority. */
  register(spec: ServerSpec): this {
    this.specs.push(spec);
    return this;
  }

  /** All registered specs (in registration order). */
  all(): ServerSpec[] {
    return [...this.specs];
  }

  /** Candidate specs for a language, in priority order. */
  candidates(language: string): ServerSpec[] {
    return this.specs.filter((s) => s.language === language);
  }

  /** Reverse-lookup a language from a file path's extension. */
  languageForPath(path: string): string | null {
    const ext = extname(path).toLowerCase();
    if (!ext) return null;
    for (const s of this.specs) {
      if (s.extensions?.some((e) => e.toLowerCase() === ext)) return s.language;
    }
    return null;
  }

  /** True if any candidate server for the language is installed. */
  isInstalledFor(language: string, env?: NodeJS.ProcessEnv): boolean {
    return this.resolve(language, env) !== null;
  }

  /**
   * The first installed candidate spec for a language, or `null` when none is
   * installed. Installation checks are memoized per command.
   */
  resolve(language: string, env: NodeJS.ProcessEnv = process.env): ServerSpec | null {
    for (const spec of this.candidates(language)) {
      let installed = this.installedCache.get(spec.command);
      if (installed === undefined) {
        installed = isCommandInstalled(spec.command, env);
        this.installedCache.set(spec.command, installed);
      }
      if (installed) return spec;
    }
    return null;
  }

  /** Clear the memoized installation checks (e.g. after installing a server). */
  clearInstallCache(): void {
    this.installedCache.clear();
  }
}

/** Process-wide default registry. */
export const defaultRegistry = new LanguageServerRegistry();

/**
 * Resolve, spawn, and initialize a language server for `language`. On success
 * returns `{ ok: true, client }` with an initialized client; when no server is
 * installed (or a spawn/initialize failure occurs) returns `{ ok: false,
 * reason }` — it never throws, so callers degrade gracefully.
 */
export async function openLanguageServer(
  language: string,
  options: LspClientOptions = {},
  registry: LanguageServerRegistry = defaultRegistry,
): Promise<OpenResult> {
  const spec = registry.resolve(language);
  if (!spec) {
    return { ok: false, language, reason: `no language server for ${language}` };
  }

  let client: LspClient;
  try {
    client = spawnLspClient(spec, options);
  } catch (err) {
    return {
      ok: false,
      language,
      reason: `failed to start ${spec.command} for ${language}: ${errText(err)}`,
    };
  }

  try {
    await client.initialize();
  } catch (err) {
    await client.dispose().catch(() => undefined);
    return {
      ok: false,
      language,
      reason: `failed to initialize ${spec.command} for ${language}: ${errText(err)}`,
    };
  }

  return { ok: true, client, spec };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
