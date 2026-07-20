/**
 * {@link LspClient} — a Language Server Protocol client that drives one language
 * server over JSON-RPC. It is transport-agnostic: construct it directly from a
 * {@link MessageConnection} (used by the in-process mock in tests) or via
 * {@link spawnLspClient}, which forks a real server and wires its stdio.
 *
 * Lifecycle: `initialize()` → `openDocument()` → query methods (`definition`,
 * `references`, `rename`, `formatting`, `hover`, `documentSymbol`, `codeAction`,
 * `diagnostics`) → `dispose()`. Every request honours the standard LSP method
 * names and normalizes the several legal response shapes into one predictable
 * form so callers never branch on server quirks.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";

import type {
  ClientCapabilities,
  CodeActionContext,
  Diagnostic,
  FormattingOptions,
  Hover,
  Location,
  Position,
  Range,
  ServerCapabilities,
} from "vscode-languageserver-protocol";

import {
  AUTO_IMPORT_KINDS,
  DEFAULT_FORMATTING_OPTIONS,
  type CodeActionResult,
  type DocumentSymbolResult,
  type InitializedInfo,
  type LspClientOptions,
  type PrepareRenameResult,
  type ServerSpec,
} from "./types.js";
import type { WorkspaceEdit } from "vscode-languageserver-protocol";

// ── LSP method names ─────────────────────────────────────────────────────────
// Wire method strings are part of the frozen protocol, so referencing them
// directly (rather than pulling the request-type value objects) keeps the module
// dependency-light while staying spec-exact.
const M = {
  initialize: "initialize",
  initialized: "initialized",
  shutdown: "shutdown",
  exit: "exit",
  didOpen: "textDocument/didOpen",
  didChange: "textDocument/didChange",
  didClose: "textDocument/didClose",
  definition: "textDocument/definition",
  references: "textDocument/references",
  prepareRename: "textDocument/prepareRename",
  rename: "textDocument/rename",
  formatting: "textDocument/formatting",
  hover: "textDocument/hover",
  documentSymbol: "textDocument/documentSymbol",
  codeAction: "textDocument/codeAction",
  publishDiagnostics: "textDocument/publishDiagnostics",
} as const;

/** A minimal, broadly-compatible set of client capabilities. */
export function defaultClientCapabilities(): ClientCapabilities {
  return {
    textDocument: {
      synchronization: { dynamicRegistration: false },
      definition: { linkSupport: true },
      references: {},
      rename: { prepareSupport: true },
      formatting: {},
      hover: { contentFormat: ["markdown", "plaintext"] },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: ["quickfix", "refactor", "source", "source.organizeImports"],
          },
        },
      },
      publishDiagnostics: { relatedInformation: true },
    },
    workspace: {
      workspaceEdit: { documentChanges: true },
      applyEdit: true,
    },
  };
}

interface TextDocumentIdentifierParams {
  textDocument: { uri: string };
  position: Position;
}

/** Thrown when a method is called before {@link LspClient.initialize}. */
export class LspLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspLifecycleError";
  }
}

export class LspClient {
  readonly connection: MessageConnection;
  private readonly options: LspClientOptions;
  private readonly childProcess: ChildProcess | undefined;

  private started = false;
  private initialized = false;
  private disposed = false;
  private serverCapabilities: ServerCapabilities = {};
  private serverInfo: { name: string; version?: string } | undefined;

  /** Open document versions, keyed by URI. */
  private readonly versions = new Map<string, number>();
  /** Latest diagnostics per URI, from `publishDiagnostics`. */
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  /** Pending waiters for diagnostics on a URI. */
  private readonly diagWaiters = new Map<string, Array<(d: Diagnostic[]) => void>>();

  constructor(connection: MessageConnection, options: LspClientOptions = {}, childProcess?: ChildProcess) {
    this.connection = connection;
    this.options = options;
    this.childProcess = childProcess;

    this.connection.onNotification(M.publishDiagnostics, (params: unknown) => {
      const p = params as { uri?: string; diagnostics?: Diagnostic[] } | undefined;
      if (!p || typeof p.uri !== "string") return;
      const diags = Array.isArray(p.diagnostics) ? p.diagnostics : [];
      this.diagnostics.set(p.uri, diags);
      const waiters = this.diagWaiters.get(p.uri);
      if (waiters && waiters.length > 0) {
        this.diagWaiters.delete(p.uri);
        for (const resolve of waiters) resolve(diags);
      }
      this.options.onDiagnostics?.(p.uri, diags);
    });
  }

  /** Begin listening on the connection. Idempotent. */
  start(): void {
    if (this.started) return;
    this.connection.listen();
    this.started = true;
  }

  /**
   * Perform the `initialize` request and send the `initialized` notification.
   * Returns the server's advertised capabilities.
   */
  async initialize(): Promise<InitializedInfo> {
    this.assertLive();
    this.start();

    const params = {
      processId: process.pid,
      clientInfo: this.options.clientInfo ?? { name: "nexuscode-lsp", version: "0.0.0" },
      rootUri: this.options.rootUri ?? null,
      capabilities: this.options.clientCapabilities ?? defaultClientCapabilities(),
      ...(this.options.initializationOptions !== undefined
        ? { initializationOptions: this.options.initializationOptions }
        : {}),
      workspaceFolders: this.options.rootUri
        ? [{ uri: this.options.rootUri, name: "workspace" }]
        : null,
    };

    const result = (await this.connection.sendRequest(M.initialize, params)) as {
      capabilities?: ServerCapabilities;
      serverInfo?: { name: string; version?: string };
    };

    this.serverCapabilities = result?.capabilities ?? {};
    this.serverInfo = result?.serverInfo;
    this.connection.sendNotification(M.initialized, {});
    this.initialized = true;

    return {
      serverCapabilities: this.serverCapabilities,
      ...(this.serverInfo ? { serverInfo: this.serverInfo } : {}),
    };
  }

  /** Server capabilities captured at {@link initialize}. */
  getServerCapabilities(): ServerCapabilities {
    return this.serverCapabilities;
  }

  // ── Document synchronization ──────────────────────────────────────────────

  /** Send `textDocument/didOpen`. Tracks version 1 for the URI. */
  openDocument(uri: string, text: string, languageId?: string): void {
    this.assertInitialized();
    const version = 1;
    this.versions.set(uri, version);
    this.connection.sendNotification(M.didOpen, {
      textDocument: {
        uri,
        languageId: languageId ?? this.options.defaultLanguageId ?? "plaintext",
        version,
        text,
      },
    });
  }

  /**
   * Send a full-document `textDocument/didChange`, bumping the version. Opens the
   * document implicitly (version starts at 1) if it was never opened.
   */
  changeDocument(uri: string, text: string): void {
    this.assertInitialized();
    const next = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, next);
    this.connection.sendNotification(M.didChange, {
      textDocument: { uri, version: next },
      contentChanges: [{ text }],
    });
  }

  /** Send `textDocument/didClose`. */
  closeDocument(uri: string): void {
    this.assertInitialized();
    this.versions.delete(uri);
    this.connection.sendNotification(M.didClose, { textDocument: { uri } });
  }

  // ── Navigation & intelligence ─────────────────────────────────────────────

  /** goto-definition. Normalizes `Location | Location[] | LocationLink[]` → `Location[]`. */
  async definition(uri: string, pos: Position): Promise<Location[]> {
    this.assertInitialized();
    const raw = await this.connection.sendRequest(M.definition, this.at(uri, pos));
    return normalizeLocations(raw);
  }

  /** find-references. */
  async references(uri: string, pos: Position, includeDeclaration = true): Promise<Location[]> {
    this.assertInitialized();
    const raw = await this.connection.sendRequest(M.references, {
      ...this.at(uri, pos),
      context: { includeDeclaration },
    });
    return normalizeLocations(raw);
  }

  /** `textDocument/prepareRename` — validates the symbol under the cursor. */
  async prepareRename(uri: string, pos: Position): Promise<PrepareRenameResult> {
    this.assertInitialized();
    const raw = (await this.connection.sendRequest(M.prepareRename, this.at(uri, pos))) as
      | PrepareRenameResult
      | undefined;
    return raw ?? null;
  }

  /**
   * `textDocument/rename` → a `WorkspaceEdit`, or `null` when unsupported. Any
   * edit whose target URI resolves outside {@link LspClientOptions.rootUri} is
   * dropped before the edit is returned — a language server has no business
   * naming a file outside the workspace it was opened against, and this client
   * is the first line of defense against a buggy or compromised one doing so
   * (see also the second, tool-facing filter in `lsp_rename`).
   */
  async rename(uri: string, pos: Position, newName: string): Promise<WorkspaceEdit | null> {
    this.assertInitialized();
    const raw = (await this.connection.sendRequest(M.rename, {
      ...this.at(uri, pos),
      newName,
    })) as WorkspaceEdit | null | undefined;
    if (!raw) return null;
    const rootUri = this.options.rootUri;
    if (!rootUri) return raw; // no configured workspace root to confine against
    return confineWorkspaceEdit(raw, rootUri);
  }

  /**
   * Prepare-then-rename convenience: runs `prepareRename` first (when the server
   * supports it) and skips the rename if the position is not renamable.
   */
  async safeRename(uri: string, pos: Position, newName: string): Promise<WorkspaceEdit | null> {
    this.assertInitialized();
    if (this.serverCapabilities.renameProvider && typeof this.serverCapabilities.renameProvider === "object") {
      const prep = await this.prepareRename(uri, pos);
      if (prep === null) return null;
      if (typeof prep === "object" && "defaultBehavior" in prep && prep.defaultBehavior === false) {
        return null;
      }
    }
    return this.rename(uri, pos, newName);
  }

  /** `textDocument/formatting` → `TextEdit[]`. */
  async formatting(uri: string, options?: FormattingOptions) {
    this.assertInitialized();
    const raw = await this.connection.sendRequest(M.formatting, {
      textDocument: { uri },
      options: options ?? DEFAULT_FORMATTING_OPTIONS,
    });
    return Array.isArray(raw) ? raw : [];
  }

  /** `textDocument/hover`. */
  async hover(uri: string, pos: Position): Promise<Hover | null> {
    this.assertInitialized();
    const raw = (await this.connection.sendRequest(M.hover, this.at(uri, pos))) as Hover | null | undefined;
    return raw ?? null;
  }

  /** `textDocument/documentSymbol` → hierarchical `DocumentSymbol[]` or flat `SymbolInformation[]`. */
  async documentSymbol(uri: string): Promise<DocumentSymbolResult> {
    this.assertInitialized();
    const raw = await this.connection.sendRequest(M.documentSymbol, {
      textDocument: { uri },
    });
    return (Array.isArray(raw) ? raw : []) as DocumentSymbolResult;
  }

  /** `textDocument/codeAction` for a range with an explicit context. */
  async codeAction(uri: string, range: Range, context?: CodeActionContext): Promise<CodeActionResult> {
    this.assertInitialized();
    const raw = await this.connection.sendRequest(M.codeAction, {
      textDocument: { uri },
      range,
      context: context ?? { diagnostics: [] },
    });
    return (Array.isArray(raw) ? raw : []) as CodeActionResult;
  }

  /**
   * Auto-imports: request quick-fix / add-missing-import code actions over a
   * range, seeded with the current diagnostics so the server can resolve missing
   * symbols. Returns only the actions whose kind is import-related.
   */
  async autoImports(uri: string, range: Range): Promise<CodeActionResult> {
    this.assertInitialized();
    const diagnostics = this.diagnostics.get(uri) ?? [];
    const actions = await this.codeAction(uri, range, {
      diagnostics,
      only: [...AUTO_IMPORT_KINDS],
    });
    return actions.filter((a) => {
      if (!("kind" in a) || typeof a.kind !== "string") return true;
      return AUTO_IMPORT_KINDS.some((k) => a.kind === k || a.kind!.startsWith(k));
    });
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /** The most recent diagnostics pushed for a URI (empty if none seen yet). */
  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  /** All diagnostics currently held, keyed by URI. */
  allDiagnostics(): Map<string, Diagnostic[]> {
    return new Map(this.diagnostics);
  }

  /**
   * Resolve when diagnostics for `uri` arrive. If some are already cached they
   * are returned immediately. Rejects on `timeoutMs` (default 2000ms).
   */
  waitForDiagnostics(uri: string, timeoutMs = 2000): Promise<Diagnostic[]> {
    const existing = this.diagnostics.get(uri);
    if (existing) return Promise.resolve(existing);

    return new Promise<Diagnostic[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.diagWaiters.get(uri);
        if (list) {
          const idx = list.indexOf(wrapped);
          if (idx >= 0) list.splice(idx, 1);
        }
        reject(new Error(`timed out waiting for diagnostics on ${uri}`));
      }, timeoutMs);

      const wrapped = (d: Diagnostic[]) => {
        clearTimeout(timer);
        resolve(d);
      };

      const list = this.diagWaiters.get(uri) ?? [];
      list.push(wrapped);
      this.diagWaiters.set(uri, list);
    });
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /** Graceful `shutdown`/`exit`, then dispose the connection and reap the child. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.initialized) {
        await this.connection.sendRequest(M.shutdown).catch(() => undefined);
        // Await the flush so the write completes before we tear the transport down.
        await this.connection.sendNotification(M.exit).catch(() => undefined);
      }
    } catch {
      // Best-effort; teardown must never throw.
    } finally {
      try {
        this.connection.dispose();
      } catch {
        // ignore
      }
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill();
      }
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private at(uri: string, position: Position): TextDocumentIdentifierParams {
    return { textDocument: { uri }, position };
  }

  private assertLive(): void {
    if (this.disposed) throw new LspLifecycleError("LSP client has been disposed");
  }

  private assertInitialized(): void {
    this.assertLive();
    if (!this.initialized) throw new LspLifecycleError("LSP client is not initialized; call initialize() first");
  }
}

/**
 * Spawn a real language server described by `spec` and return a ready-to-use
 * (but not yet initialized) {@link LspClient}. The caller must `await
 * client.initialize()`. Never call this in tests — use the in-process mock.
 */
export function spawnLspClient(spec: ServerSpec, options: LspClientOptions = {}): LspClient {
  const child = spawn(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stdin) {
    throw new Error(`failed to open stdio for language server '${spec.command}'`);
  }
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  const opts: LspClientOptions = {
    ...options,
    defaultLanguageId: options.defaultLanguageId ?? spec.languageId,
  };
  return new LspClient(connection, opts, child);
}

// ── normalization helpers ─────────────────────────────────────────────────────

interface LocationLinkLike {
  targetUri: string;
  targetSelectionRange?: Range;
  targetRange: Range;
}

function isLocation(v: unknown): v is Location {
  return !!v && typeof v === "object" && "uri" in v && "range" in v;
}

function isLocationLink(v: unknown): v is LocationLinkLike {
  return !!v && typeof v === "object" && "targetUri" in v && "targetRange" in v;
}

// ── workspace-confinement for rename edits ───────────────────────────────────

/**
 * True when `uri` (a `file://` URI) resolves to a path inside `rootUri` (also a
 * `file://` URI). Non-`file://` URIs are rejected outright (nothing to confine
 * against). Checked both lexically and (best-effort) via `realpath`, so a
 * symlink inside the root that points outside it cannot be used to escape.
 * Paths that don't exist yet (e.g. a `CreateFile` targeting a brand-new file)
 * are tolerated — the lexical check alone still applies to them.
 */
async function isWithinRoot(uri: string, rootUri: string): Promise<boolean> {
  if (!uri.startsWith("file://") || !rootUri.startsWith("file://")) return false;

  let targetPath: string;
  let rootPath: string;
  try {
    targetPath = fileURLToPath(uri);
    rootPath = fileURLToPath(rootUri);
  } catch {
    return false;
  }

  if (escapesRoot(rootPath, targetPath)) return false;

  const [realRoot, realTarget] = await Promise.all([
    realpath(rootPath).catch(() => rootPath),
    realpath(targetPath).catch(() => targetPath),
  ]);
  return !escapesRoot(realRoot, realTarget);
}

function escapesRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/** The URI(s) a single `documentChanges` entry targets (kind-dependent). */
function documentChangeUris(change: NonNullable<WorkspaceEdit["documentChanges"]>[number]): {
  uri: string;
  secondaryUri?: string;
} {
  if ("textDocument" in change) return { uri: change.textDocument.uri };
  if ("oldUri" in change) return { uri: change.oldUri, secondaryUri: change.newUri };
  return { uri: change.uri };
}

/**
 * Filter a `WorkspaceEdit` down to only the `changes`/`documentChanges` entries
 * whose target URI (both endpoints, for a rename operation) resolves inside
 * `rootUri`. See {@link LspClient.rename}.
 */
async function confineWorkspaceEdit(edit: WorkspaceEdit, rootUri: string): Promise<WorkspaceEdit> {
  const out: WorkspaceEdit = {};

  if (edit.changes) {
    const changes: NonNullable<WorkspaceEdit["changes"]> = {};
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (await isWithinRoot(uri, rootUri)) changes[uri] = edits;
    }
    if (Object.keys(changes).length > 0) out.changes = changes;
  }

  if (Array.isArray(edit.documentChanges)) {
    const kept: NonNullable<WorkspaceEdit["documentChanges"]> = [];
    for (const change of edit.documentChanges) {
      const { uri, secondaryUri } = documentChangeUris(change);
      const ok =
        (await isWithinRoot(uri, rootUri)) &&
        (secondaryUri === undefined || (await isWithinRoot(secondaryUri, rootUri)));
      if (ok) kept.push(change);
    }
    if (kept.length > 0) out.documentChanges = kept;
  }

  if (edit.changeAnnotations) out.changeAnnotations = edit.changeAnnotations;
  return out;
}

/** Collapse the three legal definition/reference response shapes to `Location[]`. */
export function normalizeLocations(raw: unknown): Location[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: Location[] = [];
  for (const item of items) {
    if (isLocation(item)) {
      out.push({ uri: item.uri, range: item.range });
    } else if (isLocationLink(item)) {
      out.push({ uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange });
    }
  }
  return out;
}
