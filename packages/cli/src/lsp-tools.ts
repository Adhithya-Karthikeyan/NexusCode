/**
 * LSP-backed agent tools (system-spec §12). Each exposes one Code-Intelligence
 * operation — goto-definition, find-references, rename, diagnostics, hover — as a
 * first-class {@link Tool} so the native tool loop / OODA agent can navigate code
 * with ground-truth answers from a language server.
 *
 * Permission classes follow the operation: the query tools are `read`; `lsp_rename`
 * is `write` (it produces a workspace edit). Every tool degrades gracefully: when
 * no language server is installed for the file's language (or the file's language
 * is unknown) it returns a normal `isError` {@link ToolResult} with a clear
 * message — never a throw, never a crash. Servers are spawned lazily per call and
 * disposed after; nothing here touches the network.
 *
 * The `opener` seam makes the whole thing offline-testable: inject a function that
 * returns an in-process mock LSP client and the tools run without any real server.
 */

import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  errText,
  okText,
  resolveInWorkspace,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@nexuscode/tools";
import {
  LanguageServerRegistry,
  defaultRegistry,
  openLanguageServer,
  type Diagnostic,
  type Hover,
  type Location,
  type LspClientOptions,
  type Position,
  type WorkspaceEdit,
} from "@nexuscode/lsp";

/** The minimal LSP client surface these tools drive (satisfied by `LspClient`). */
export interface LspClientLike {
  openDocument(uri: string, text: string, languageId?: string): void;
  closeDocument(uri: string): void;
  definition(uri: string, pos: Position): Promise<Location[]>;
  references(uri: string, pos: Position, includeDeclaration?: boolean): Promise<Location[]>;
  safeRename(uri: string, pos: Position, newName: string): Promise<WorkspaceEdit | null>;
  hover(uri: string, pos: Position): Promise<Hover | null>;
  waitForDiagnostics(uri: string, timeoutMs?: number): Promise<Diagnostic[]>;
  getDiagnostics(uri: string): Diagnostic[];
}

/** A ready, initialized client plus its teardown. */
export interface OpenedLsp {
  client: LspClientLike;
  dispose(): Promise<void>;
}

/** Open (or decline to open) a language server for `language`. Never throws. */
export type LspOpener = (
  language: string,
  opts: LspClientOptions,
) => Promise<{ ok: true; opened: OpenedLsp } | { ok: false; reason: string }>;

export interface LspToolsOptions {
  /** Server registry used to map a file to a language + resolve a launch recipe. */
  registry?: LanguageServerRegistry;
  /** Request timeout (ms) for diagnostics waits. Default 5000. */
  timeoutMs?: number;
  /**
   * DI seam: open an initialized client for a language. Defaults to spawning a
   * real server via {@link openLanguageServer} (which itself returns a
   * non-throwing `{ ok:false }` when none is installed). Tests inject a mock.
   */
  opener?: LspOpener;
}

/** The default opener: spawn + initialize a real server, degrading gracefully. */
function defaultOpener(registry: LanguageServerRegistry): LspOpener {
  return async (language, opts) => {
    const res = await openLanguageServer(language, opts, registry);
    if (!res.ok) return { ok: false, reason: res.reason };
    return {
      ok: true,
      opened: { client: res.client, dispose: () => res.client.dispose() },
    };
  };
}

interface RunSetup {
  opened: OpenedLsp;
  uri: string;
  language: string;
}

/**
 * Resolve the file, determine its language, open a server, and open the document.
 * Returns either a ready {@link RunSetup} or a graceful `ToolResult` describing why
 * it could not (unknown language / no server / unreadable file).
 */
async function setup(
  input: unknown,
  ctx: ToolContext,
  registry: LanguageServerRegistry,
  opener: LspOpener,
): Promise<RunSetup | ToolResult> {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const file = o.file ?? o.path;
  if (typeof file !== "string" || file.length === 0) {
    return errText(`lsp: "file" (a workspace-relative path) is required`);
  }

  let abs: string;
  try {
    abs = await resolveInWorkspace(ctx.cwd, file);
  } catch (e) {
    return errText(`lsp: ${(e as Error).message}`);
  }

  const language = registry.languageForPath(file);
  if (!language) {
    return errText(`lsp: no known language for "${file}" (unsupported extension) — code navigation unavailable`);
  }

  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch (e) {
    return errText(`lsp: cannot read "${file}": ${(e as Error).message}`);
  }

  const rootUri = pathToFileURL(ctx.cwd.endsWith("/") ? ctx.cwd : `${ctx.cwd}/`).href;
  const opened = await opener(language, { rootUri, defaultLanguageId: language });
  if (!opened.ok) {
    return errText(
      `lsp: no language server available for ${language} — ${opened.reason}. ` +
        `Install one (e.g. typescript-language-server, pyright, gopls) to enable code navigation.`,
    );
  }

  const uri = pathToFileURL(abs).href;
  try {
    opened.opened.client.openDocument(uri, text, language);
  } catch (e) {
    await opened.opened.dispose().catch(() => undefined);
    return errText(`lsp: failed to open document: ${(e as Error).message}`);
  }
  return { opened: opened.opened, uri, language };
}

/** Read an integer field (line/character), defaulting to 0. */
function intField(input: unknown, name: string): number {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const v = o[name];
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 0;
}

function posOf(input: unknown): Position {
  return { line: intField(input, "line"), character: intField(input, "character") };
}

/** Render a `Location[]` as one `uri:line:character` per line. */
function renderLocations(locs: Location[]): string {
  if (locs.length === 0) return "(none)";
  return locs
    .map((l) => `${l.uri}:${l.range.start.line}:${l.range.start.character}`)
    .join("\n");
}

/**
 * Second-layer confinement for `lsp_rename`: drop any `changes`/`documentChanges`
 * entry in the `WorkspaceEdit` whose target URI resolves outside `cwd` (the
 * tool's workspace root) before it is serialized back to the model. This
 * backstops the confinement already applied inside `@nexuscode/lsp`'s
 * `LspClient.rename` — a compromised/buggy language server, or a client that
 * bypasses that layer (e.g. a test double implementing {@link LspClientLike}
 * directly), must still never be able to smuggle an edit to a file outside the
 * project via the tool surface exposed to the model.
 */
async function confineToWorkspace(
  edit: WorkspaceEdit,
  cwd: string,
): Promise<{ edit: WorkspaceEdit; droppedCount: number }> {
  let droppedCount = 0;

  const withinWorkspace = async (uri: string): Promise<boolean> => {
    if (!uri.startsWith("file://")) return false;
    let p: string;
    try {
      p = fileURLToPath(uri);
    } catch {
      return false;
    }
    try {
      await resolveInWorkspace(cwd, p);
      return true;
    } catch {
      return false;
    }
  };

  const out: WorkspaceEdit = {};

  if (edit.changes) {
    const changes: NonNullable<WorkspaceEdit["changes"]> = {};
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (await withinWorkspace(uri)) {
        changes[uri] = edits;
      } else {
        droppedCount++;
      }
    }
    if (Object.keys(changes).length > 0) out.changes = changes;
  }

  if (Array.isArray(edit.documentChanges)) {
    const kept: NonNullable<WorkspaceEdit["documentChanges"]> = [];
    for (const change of edit.documentChanges) {
      const uri = "textDocument" in change ? change.textDocument.uri : "oldUri" in change ? change.oldUri : change.uri;
      const secondaryUri = "oldUri" in change ? change.newUri : undefined;
      const ok =
        (await withinWorkspace(uri)) && (secondaryUri === undefined || (await withinWorkspace(secondaryUri)));
      if (ok) {
        kept.push(change);
      } else {
        droppedCount++;
      }
    }
    if (kept.length > 0) out.documentChanges = kept;
  }

  if (edit.changeAnnotations) out.changeAnnotations = edit.changeAnnotations;
  return { edit: out, droppedCount };
}

const POSITION_PARAMS = {
  file: { type: "string", description: "Workspace-relative path of the file." },
  line: { type: "number", description: "0-based line of the symbol." },
  character: { type: "number", description: "0-based character/column of the symbol." },
} as const;

/**
 * Build the LSP tool set. Wire these into the agent's {@link ToolRegistry} when
 * code navigation is desired (guarded by `config.lsp.enabled`).
 */
export function lspTools(opts: LspToolsOptions = {}): Tool[] {
  const registry = opts.registry ?? defaultRegistry;
  const opener = opts.opener ?? defaultOpener(registry);
  const timeoutMs = opts.timeoutMs ?? 5000;

  const withServer = async (
    input: unknown,
    ctx: ToolContext,
    op: (s: RunSetup) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const s = await setup(input, ctx, registry, opener);
    if (!("opened" in s)) return s; // graceful ToolResult
    try {
      return await op(s);
    } catch (e) {
      return errText(`lsp: ${(e as Error).message}`);
    } finally {
      await s.opened.dispose().catch(() => undefined);
    }
  };

  const definition: Tool = {
    name: "lsp_definition",
    description: "Go to the definition(s) of the symbol at a file position, via the language server.",
    permission: "read",
    parameters: {
      type: "object",
      properties: { ...POSITION_PARAMS },
      required: ["file", "line", "character"],
      additionalProperties: false,
    },
    run: (input, ctx) =>
      withServer(input, ctx, async (s) => {
        const locs = await s.opened.client.definition(s.uri, posOf(input));
        return okText(`definition(s):\n${renderLocations(locs)}`);
      }),
  };

  const references: Tool = {
    name: "lsp_references",
    description: "Find all references to the symbol at a file position, via the language server.",
    permission: "read",
    parameters: {
      type: "object",
      properties: {
        ...POSITION_PARAMS,
        includeDeclaration: { type: "boolean", description: "Include the declaration (default true)." },
      },
      required: ["file", "line", "character"],
      additionalProperties: false,
    },
    run: (input, ctx) =>
      withServer(input, ctx, async (s) => {
        const o = input as Record<string, unknown>;
        const include = o.includeDeclaration === undefined ? true : o.includeDeclaration === true;
        const locs = await s.opened.client.references(s.uri, posOf(input), include);
        return okText(`${locs.length} reference(s):\n${renderLocations(locs)}`);
      }),
  };

  const rename: Tool = {
    name: "lsp_rename",
    description: "Rename the symbol at a file position across the workspace; returns the workspace edit.",
    permission: "write",
    parameters: {
      type: "object",
      properties: {
        ...POSITION_PARAMS,
        newName: { type: "string", description: "The new symbol name." },
      },
      required: ["file", "line", "character", "newName"],
      additionalProperties: false,
    },
    run: (input, ctx) =>
      withServer(input, ctx, async (s) => {
        const o = input as Record<string, unknown>;
        const newName = o.newName;
        if (typeof newName !== "string" || newName.length === 0) {
          return errText(`lsp_rename: "newName" is required`);
        }
        const rawEdit = await s.opened.client.safeRename(s.uri, posOf(input), newName);
        if (!rawEdit) return errText(`lsp_rename: the symbol at this position cannot be renamed`);
        const { edit, droppedCount } = await confineToWorkspace(rawEdit, ctx.cwd);
        const changes = edit.changes ?? {};
        const docChanges = Array.isArray(edit.documentChanges) ? edit.documentChanges : [];
        const fileCount = Object.keys(changes).length + docChanges.length;
        const editCount = Object.values(changes).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
        const note =
          droppedCount > 0
            ? `\n(note: ${droppedCount} edit(s) targeting file(s) outside the workspace were dropped)`
            : "";
        return okText(
          `rename → "${newName}": ${editCount} edit(s) across ${fileCount} file(s)\n${JSON.stringify(edit)}${note}`,
        );
      }),
  };

  const diagnostics: Tool = {
    name: "lsp_diagnostics",
    description: "Get the language server's diagnostics (errors/warnings) for a file.",
    permission: "read",
    parameters: {
      type: "object",
      properties: { file: POSITION_PARAMS.file },
      required: ["file"],
      additionalProperties: false,
    },
    run: (input, ctx) =>
      withServer(input, ctx, async (s) => {
        const diags = await s.opened.client
          .waitForDiagnostics(s.uri, timeoutMs)
          .catch(() => s.opened.client.getDiagnostics(s.uri));
        if (diags.length === 0) return okText("no diagnostics");
        const sev = ["", "error", "warning", "information", "hint"];
        const lines = diags.map(
          (d) => `${sev[d.severity ?? 1] ?? "info"} ${d.range.start.line}:${d.range.start.character} ${d.message}`,
        );
        return okText(`${diags.length} diagnostic(s):\n${lines.join("\n")}`);
      }),
  };

  const hover: Tool = {
    name: "lsp_hover",
    description: "Get hover info (type/signature/docs) for the symbol at a file position.",
    permission: "read",
    parameters: {
      type: "object",
      properties: { ...POSITION_PARAMS },
      required: ["file", "line", "character"],
      additionalProperties: false,
    },
    run: (input, ctx) =>
      withServer(input, ctx, async (s) => {
        const h = await s.opened.client.hover(s.uri, posOf(input));
        if (!h || h.contents == null) return okText("(no hover info)");
        return okText(`hover:\n${renderHover(h)}`);
      }),
  };

  return [definition, references, rename, diagnostics, hover];
}

/** Flatten the several legal `Hover.contents` shapes to plain text. */
function renderHover(h: Hover): string {
  const c = h.contents as unknown;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((part) => (typeof part === "string" ? part : (part as { value?: string }).value ?? "")).join("\n");
  }
  if (c && typeof c === "object" && "value" in c) return String((c as { value: unknown }).value);
  return "";
}
