/**
 * An in-process mock Language Server. It speaks real JSON-RPC (the same framing a
 * spawned server uses) over an in-memory duplex pair, so the client exercises its
 * entire wire path — headers, request/response correlation, notifications —
 * without any external process or network. Responses are deterministic.
 */

import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { LspClient } from "../src/client.js";
import type { LspClientOptions } from "../src/types.js";

export interface MockServerHandle {
  client: LspClient;
  server: MessageConnection;
  /** Requests received by the server, in order, as `[method, params]`. */
  received: Array<{ method: string; params: unknown }>;
  /** Notifications received by the server, in order. */
  notifications: Array<{ method: string; params: unknown }>;
  /** Push a `publishDiagnostics` notification to the client. */
  publishDiagnostics(uri: string, diagnostics: unknown[]): void;
  /**
   * Flush: JSON-RPC preserves message order on a connection, so awaiting a
   * round-trip request guarantees every earlier client→server notification has
   * already been received and its handler run. Use before asserting on
   * `received`/`notifications`.
   */
  sync(): Promise<void>;
  dispose(): Promise<void>;
}

const FILE = "file:///repo/src/target.ts";

/**
 * Wire a client to a deterministic mock server over two cross-connected
 * PassThrough streams. `client → clientToServer → server` and
 * `server → serverToClient → client`.
 */
export function createMockPair(options: LspClientOptions = {}): MockServerHandle {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  const clientConnection = createMessageConnection(
    new StreamMessageReader(serverToClient),
    new StreamMessageWriter(clientToServer),
  );
  const server = createMessageConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient),
  );

  const received: MockServerHandle["received"] = [];
  const notifications: MockServerHandle["notifications"] = [];

  const onReq = (method: string, params: unknown) => received.push({ method, params });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  server.onRequest("initialize", (params: unknown) => {
    onReq("initialize", params);
    return {
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: true,
      },
      serverInfo: { name: "mock-language-server", version: "1.0.0" },
    };
  });
  server.onRequest("shutdown", () => {
    onReq("shutdown", undefined);
    return null;
  });
  server.onRequest("$/ping", () => null);

  server.onNotification((method: string, params: unknown) => {
    notifications.push({ method, params });
  });

  // ── Queries (deterministic) ─────────────────────────────────────────────────
  server.onRequest("textDocument/definition", (params: unknown) => {
    onReq("textDocument/definition", params);
    // Return a single Location (one of the three legal shapes).
    return {
      uri: FILE,
      range: {
        start: { line: 10, character: 4 },
        end: { line: 10, character: 12 },
      },
    };
  });

  server.onRequest("textDocument/references", (params: unknown) => {
    onReq("textDocument/references", params);
    return [
      { uri: FILE, range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } } },
      {
        uri: "file:///repo/src/other.ts",
        range: { start: { line: 3, character: 8 }, end: { line: 3, character: 16 } },
      },
    ];
  });

  server.onRequest("textDocument/hover", (params: unknown) => {
    onReq("textDocument/hover", params);
    return {
      contents: { kind: "markdown", value: "```ts\nfunction greet(name: string): string\n```" },
      range: { start: { line: 10, character: 4 }, end: { line: 10, character: 12 } },
    };
  });

  server.onRequest("textDocument/documentSymbol", (params: unknown) => {
    onReq("textDocument/documentSymbol", params);
    return [
      {
        name: "greet",
        kind: 12, // Function
        range: { start: { line: 10, character: 0 }, end: { line: 12, character: 1 } },
        selectionRange: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } },
        children: [],
      },
    ];
  });

  server.onRequest("textDocument/prepareRename", (params: unknown) => {
    onReq("textDocument/prepareRename", params);
    return { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } };
  });

  server.onRequest("textDocument/rename", (params: unknown) => {
    onReq("textDocument/rename", params);
    const p = params as { newName: string };
    return {
      changes: {
        [FILE]: [
          {
            range: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } },
            newText: p.newName,
          },
        ],
      },
    };
  });

  server.onRequest("textDocument/formatting", (params: unknown) => {
    onReq("textDocument/formatting", params);
    return [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "// formatted\n",
      },
    ];
  });

  server.onRequest("textDocument/codeAction", (params: unknown) => {
    onReq("textDocument/codeAction", params);
    return [
      {
        title: "Add import from './greeter'",
        kind: "quickfix",
        edit: {
          changes: {
            [FILE]: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "import { greet } from './greeter';\n",
              },
            ],
          },
        },
      },
      {
        title: "Extract to function",
        kind: "refactor.extract",
      },
    ];
  });

  server.listen();

  const client = new LspClient(clientConnection, options);

  return {
    client,
    server,
    received,
    notifications,
    publishDiagnostics(uri: string, diagnostics: unknown[]) {
      server.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics });
    },
    async sync() {
      await clientConnection.sendRequest("$/ping");
    },
    async dispose() {
      await client.dispose().catch(() => undefined);
      await new Promise((r) => setImmediate(r));
      try {
        server.dispose();
      } catch {
        // ignore
      }
      clientToServer.end();
      serverToClient.end();
    },
  };
}

export { FILE as MOCK_FILE };
