/**
 * Normalized result and configuration types for the NexusCode LSP client.
 *
 * We re-export the wire types from `vscode-languageserver-protocol` (they are the
 * canonical shapes the model and callers reason about) and add a small set of
 * NexusCode-specific descriptors: {@link ServerSpec} (how to launch a language
 * server) and the {@link OpenResult} discriminated union that makes "no language
 * server installed for this language" an ordinary, non-throwing outcome.
 */

import type {
  ClientCapabilities,
  CodeAction,
  Command,
  Diagnostic,
  DocumentSymbol,
  FormattingOptions,
  Location,
  Position,
  Range,
  ServerCapabilities,
  SymbolInformation,
} from "vscode-languageserver-protocol";

export type {
  ClientCapabilities,
  CodeAction,
  CodeActionContext,
  Command,
  Diagnostic,
  DocumentSymbol,
  FormattingOptions,
  Hover,
  Location,
  LocationLink,
  MarkupContent,
  Position,
  PublishDiagnosticsParams,
  Range,
  ServerCapabilities,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

/** Result of `textDocument/documentSymbol` — servers may return either shape. */
export type DocumentSymbolResult = DocumentSymbol[] | SymbolInformation[];

/** Result of `textDocument/codeAction` — a mix of bare commands and code actions. */
export type CodeActionResult = (Command | CodeAction)[];

/** Result of `textDocument/prepareRename`. */
export type PrepareRenameResult =
  | Range
  | { range: Range; placeholder: string }
  | { defaultBehavior: boolean }
  | null;

/**
 * How to launch (or identify) a language server for one language. A single
 * language may have several candidate specs (e.g. `pyright` then `pylsp`); the
 * registry picks the first whose {@link ServerSpec.command} is on `PATH`.
 */
export interface ServerSpec {
  /** NexusCode language key, e.g. `"typescript"`, `"python"`. */
  language: string;
  /** LSP `languageId` sent in `didOpen`, e.g. `"typescript"`. */
  languageId: string;
  /** Executable to spawn, resolved against `PATH`. */
  command: string;
  /** Arguments — almost always includes a stdio flag like `--stdio`. */
  args: string[];
  /** File extensions this server handles (used for reverse lookup). */
  extensions?: string[];
  /** Root markers used to locate the workspace root (e.g. `tsconfig.json`). */
  rootMarkers?: string[];
  /** Human label for diagnostics/HUD. */
  label?: string;
}

/**
 * The outcome of asking for a client for a given language. Missing servers are a
 * first-class, non-error result (`ok: false`) so callers degrade gracefully.
 */
export type OpenResult =
  | { ok: true; client: import("./client.js").LspClient; spec: ServerSpec }
  | { ok: false; language: string; reason: string };

/** Options accepted by {@link LspClient} construction. */
export interface LspClientOptions {
  /** Absolute file URI of the workspace root, e.g. `file:///repo`. */
  rootUri?: string | null;
  /** Default `languageId` for opened documents when one is not supplied. */
  defaultLanguageId?: string;
  /** Client capabilities advertised at `initialize`. A sensible default is used. */
  clientCapabilities?: ClientCapabilities;
  /** Extra `initializationOptions` forwarded verbatim to the server. */
  initializationOptions?: unknown;
  /** Invoked for every `textDocument/publishDiagnostics` push. */
  onDiagnostics?: (uri: string, diagnostics: Diagnostic[]) => void;
  /** `name`/`version` reported to the server. */
  clientInfo?: { name: string; version?: string };
}

/** Snapshot returned by {@link LspClient.initialize}. */
export interface InitializedInfo {
  serverCapabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

/** Convenience: build a {@link Position}. */
export function position(line: number, character: number): Position {
  return { line, character };
}

/** Convenience: build a {@link Location}. */
export function location(uri: string, range: Range): Location {
  return { uri, range };
}

/** Reasonable formatting defaults. */
export const DEFAULT_FORMATTING_OPTIONS: FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
};

/** LSP code-action kinds relevant to auto-imports. */
export const AUTO_IMPORT_KINDS = [
  "quickfix",
  "source.addMissingImports",
  "source.addMissingImports.ts",
] as const;
