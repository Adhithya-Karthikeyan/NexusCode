/**
 * @nexuscode/lsp — Code Intelligence over the Language Server Protocol
 * (system-spec §12).
 *
 * A JSON-RPC-over-stdio LSP *client* ({@link LspClient}) that drives one language
 * server through its full lifecycle — `initialize`/`initialized`, document
 * synchronization (`didOpen`/`didChange`/`didClose`), and the ground-truth
 * queries the coding loop needs: goto-definition, find-references, prepare+rename
 * → `WorkspaceEdit`, formatting, hover, document symbols, code actions (incl.
 * auto-imports), and push diagnostics.
 *
 * A {@link LanguageServerRegistry} maps a language to candidate server launch
 * recipes and feature-detects which are installed; {@link openLanguageServer}
 * spawns + initializes one, or returns a clear `{ ok: false, reason }` when no
 * server is installed — degrading gracefully instead of crashing.
 *
 * The client is transport-agnostic: it is built from a `MessageConnection`, so
 * it can be driven by a real spawned server or an in-process JSON-RPC mock (used
 * for fully-offline tests). Nothing here touches the network.
 */

export {
  LspClient,
  LspLifecycleError,
  spawnLspClient,
  defaultClientCapabilities,
  normalizeLocations,
} from "./client.js";

export {
  LanguageServerRegistry,
  DEFAULT_SERVER_SPECS,
  defaultRegistry,
  openLanguageServer,
  isCommandInstalled,
} from "./registry.js";

export {
  position,
  location,
  DEFAULT_FORMATTING_OPTIONS,
  AUTO_IMPORT_KINDS,
} from "./types.js";

export type {
  ServerSpec,
  OpenResult,
  LspClientOptions,
  InitializedInfo,
  DocumentSymbolResult,
  CodeActionResult,
  PrepareRenameResult,
  // Re-exported wire types (from vscode-languageserver-protocol):
  ClientCapabilities,
  ServerCapabilities,
  Location,
  LocationLink,
  Position,
  Range,
  Hover,
  MarkupContent,
  WorkspaceEdit,
  TextEdit,
  Diagnostic,
  PublishDiagnosticsParams,
  DocumentSymbol,
  SymbolInformation,
  CodeAction,
  Command,
  CodeActionContext,
  FormattingOptions,
} from "./types.js";
