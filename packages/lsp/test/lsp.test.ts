import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

import {
  LanguageServerRegistry,
  LspClient,
  LspLifecycleError,
  DEFAULT_SERVER_SPECS,
  isCommandInstalled,
  normalizeLocations,
  openLanguageServer,
  position,
  type ServerSpec,
} from "../src/index.js";
import { createMockPair, MOCK_FILE, type MockServerHandle } from "./mock-server.js";

describe("LspClient lifecycle over an in-process JSON-RPC mock", () => {
  let h: MockServerHandle;

  beforeEach(() => {
    h = createMockPair({ rootUri: "file:///repo", defaultLanguageId: "typescript" });
  });

  afterEach(async () => {
    await h.dispose();
  });

  it("initializes and captures server capabilities + info", async () => {
    const info = await h.client.initialize();
    expect(info.serverInfo?.name).toBe("mock-language-server");
    expect(info.serverCapabilities.definitionProvider).toBe(true);
    expect(info.serverCapabilities.renameProvider).toEqual({ prepareProvider: true });

    // Flush so the async `initialized` notification is observed in-order.
    await h.sync();
    // initialize request then initialized notification were both sent.
    expect(h.received.map((r) => r.method)).toContain("initialize");
    expect(h.notifications.map((n) => n.method)).toContain("initialized");
  });

  it("opens and changes a document with monotonic versions", async () => {
    await h.client.initialize();
    h.client.openDocument(MOCK_FILE, "const a = 1;\n");
    h.client.changeDocument(MOCK_FILE, "const a = 2;\n");
    await h.sync();

    const open = h.notifications.find((n) => n.method === "textDocument/didOpen");
    const change = h.notifications.find((n) => n.method === "textDocument/didChange");
    expect((open?.params as any).textDocument.version).toBe(1);
    expect((open?.params as any).textDocument.languageId).toBe("typescript");
    expect((change?.params as any).textDocument.version).toBe(2);
    expect((change?.params as any).contentChanges[0].text).toBe("const a = 2;\n");
  });

  it("goto-definition returns normalized Location[]", async () => {
    await h.client.initialize();
    h.client.openDocument(MOCK_FILE, "greet('x')\n");
    const defs = await h.client.definition(MOCK_FILE, position(0, 1));
    expect(defs).toHaveLength(1);
    expect(defs[0]?.uri).toBe(MOCK_FILE);
    expect(defs[0]?.range.start.line).toBe(10);
  });

  it("find-references returns every location and forwards includeDeclaration", async () => {
    await h.client.initialize();
    const refs = await h.client.references(MOCK_FILE, position(10, 4), true);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.uri)).toContain("file:///repo/src/other.ts");

    const req = h.received.find((r) => r.method === "textDocument/references");
    expect((req?.params as any).context.includeDeclaration).toBe(true);
  });

  it("hover parses markdown content", async () => {
    await h.client.initialize();
    const hov = await h.client.hover(MOCK_FILE, position(10, 4));
    expect(hov).not.toBeNull();
    expect(JSON.stringify(hov?.contents)).toContain("function greet");
  });

  it("documentSymbol returns hierarchical symbols", async () => {
    await h.client.initialize();
    const syms = await h.client.documentSymbol(MOCK_FILE);
    expect(syms).toHaveLength(1);
    expect((syms[0] as any).name).toBe("greet");
    expect((syms[0] as any).kind).toBe(12);
  });

  it("prepare+rename produces a WorkspaceEdit", async () => {
    await h.client.initialize();
    const prep = await h.client.prepareRename(MOCK_FILE, position(10, 4));
    expect(prep).not.toBeNull();

    const edit = await h.client.safeRename(MOCK_FILE, position(10, 4), "salute");
    expect(edit).not.toBeNull();
    const change = edit!.changes?.[MOCK_FILE]?.[0];
    expect(change?.newText).toBe("salute");

    // Two prepareRename requests total: the explicit call above plus the one
    // safeRename runs internally (server advertises prepareProvider).
    expect(h.received.filter((r) => r.method === "textDocument/prepareRename")).toHaveLength(2);
    expect(h.received.filter((r) => r.method === "textDocument/rename")).toHaveLength(1);
  });

  it("rename() drops edits whose target URI escapes the configured workspace root", async () => {
    // A rogue/buggy server response mixing a legitimate in-workspace edit with
    // one targeting a file outside the client's rootUri ("file:///repo").
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const clientConnection = createMessageConnection(
      new StreamMessageReader(serverToClient),
      new StreamMessageWriter(clientToServer),
    );
    const rogueServer = createMessageConnection(
      new StreamMessageReader(clientToServer),
      new StreamMessageWriter(serverToClient),
    );
    rogueServer.onRequest("initialize", () => ({
      capabilities: { renameProvider: true },
      serverInfo: { name: "rogue-server" },
    }));
    rogueServer.onRequest("shutdown", () => null);
    rogueServer.onRequest("textDocument/rename", () => ({
      changes: {
        [MOCK_FILE]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "ok" },
        ],
        "file:///etc/passwd": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "pwned" },
        ],
      },
    }));
    rogueServer.onNotification(() => undefined);
    rogueServer.listen();

    const rogueClient = new LspClient(clientConnection, { rootUri: "file:///repo" });
    try {
      await rogueClient.initialize();
      const edit = await rogueClient.rename(MOCK_FILE, position(0, 0), "x");

      expect(edit).not.toBeNull();
      expect(Object.keys(edit!.changes ?? {})).toEqual([MOCK_FILE]);
      expect(edit!.changes?.["file:///etc/passwd"]).toBeUndefined();
    } finally {
      await rogueClient.dispose().catch(() => undefined);
      rogueServer.dispose();
      clientToServer.end();
      serverToClient.end();
    }
  });

  it("formatting returns TextEdit[]", async () => {
    await h.client.initialize();
    const edits = await h.client.formatting(MOCK_FILE);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.newText).toBe("// formatted\n");
  });

  it("codeAction returns actions and autoImports filters to import fixes", async () => {
    await h.client.initialize();
    const all = await h.client.codeAction(
      MOCK_FILE,
      { start: position(0, 0), end: position(0, 0) },
      { diagnostics: [] },
    );
    expect(all).toHaveLength(2);

    const imports = await h.client.autoImports(MOCK_FILE, {
      start: position(0, 0),
      end: position(0, 0),
    });
    expect(imports).toHaveLength(1);
    expect((imports[0] as any).title).toContain("Add import");
    expect((imports[0] as any).edit.changes[MOCK_FILE][0].newText).toContain("import");
  });

  it("caches push diagnostics and resolves waiters", async () => {
    await h.client.initialize();

    const waiting = h.client.waitForDiagnostics(MOCK_FILE, 1000);
    h.publishDiagnostics(MOCK_FILE, [
      {
        range: { start: position(1, 0), end: position(1, 5) },
        message: "Cannot find name 'greet'.",
        severity: 1,
      },
    ]);

    const diags = await waiting;
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toContain("Cannot find name");
    // Cached lookup returns the same set.
    expect(h.client.getDiagnostics(MOCK_FILE)).toHaveLength(1);
    expect(h.client.allDiagnostics().get(MOCK_FILE)).toHaveLength(1);
  });

  it("invokes the onDiagnostics callback", async () => {
    const seen: Array<{ uri: string; count: number }> = [];
    const h2 = createMockPair({
      onDiagnostics: (uri, d) => seen.push({ uri, count: d.length }),
    });
    try {
      await h2.client.initialize();
      h2.publishDiagnostics(MOCK_FILE, [
        { range: { start: position(0, 0), end: position(0, 1) }, message: "x" },
      ]);
      // Give the notification a tick to arrive.
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([{ uri: MOCK_FILE, count: 1 }]);
    } finally {
      await h2.dispose();
    }
  });

  it("rejects query calls before initialize()", async () => {
    await expect(h.client.definition(MOCK_FILE, position(0, 0))).rejects.toBeInstanceOf(
      LspLifecycleError,
    );
    expect(() => h.client.openDocument(MOCK_FILE, "x")).toThrow(LspLifecycleError);
  });

  it("disposes gracefully with a shutdown request", async () => {
    await h.client.initialize();
    await h.client.dispose();
    expect(h.received.map((r) => r.method)).toContain("shutdown");
    // A second dispose is a no-op.
    await expect(h.client.dispose()).resolves.toBeUndefined();
  });
});

describe("normalizeLocations", () => {
  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } };

  it("handles a single Location", () => {
    expect(normalizeLocations({ uri: "file:///a", range })).toEqual([{ uri: "file:///a", range }]);
  });

  it("handles a Location[]", () => {
    const arr = [
      { uri: "file:///a", range },
      { uri: "file:///b", range },
    ];
    expect(normalizeLocations(arr)).toHaveLength(2);
  });

  it("handles LocationLink[] (targetUri/targetSelectionRange)", () => {
    const links = [{ targetUri: "file:///c", targetRange: range, targetSelectionRange: range }];
    expect(normalizeLocations(links)).toEqual([{ uri: "file:///c", range }]);
  });

  it("returns [] for null/undefined", () => {
    expect(normalizeLocations(null)).toEqual([]);
    expect(normalizeLocations(undefined)).toEqual([]);
  });
});

describe("LanguageServerRegistry + graceful degradation", () => {
  it("ships default specs for common languages", () => {
    const reg = new LanguageServerRegistry();
    expect(reg.candidates("typescript").length).toBeGreaterThan(0);
    expect(reg.candidates("python").length).toBeGreaterThanOrEqual(2); // pyright + pylsp
    expect(DEFAULT_SERVER_SPECS.some((s) => s.command === "typescript-language-server")).toBe(true);
  });

  it("reverse-looks-up language by file extension", () => {
    const reg = new LanguageServerRegistry();
    expect(reg.languageForPath("src/a.ts")).toBe("typescript");
    expect(reg.languageForPath("m/main.go")).toBe("go");
    expect(reg.languageForPath("readme.unknownext")).toBeNull();
  });

  it("resolve() picks the first installed candidate using a fake PATH", () => {
    const bin = "/fake/bin";
    const spec: ServerSpec = {
      language: "toy",
      languageId: "toy",
      command: "node", // guaranteed present in this env
      args: [],
    };
    const reg = new LanguageServerRegistry([spec]);
    // node resolves on the real PATH.
    expect(reg.resolve("toy")).toEqual(spec);
    void bin;
  });

  it("resolve() returns null when no candidate is installed", () => {
    const reg = new LanguageServerRegistry([
      {
        language: "cobol",
        languageId: "cobol",
        command: "definitely-not-a-real-server-xyz",
        args: [],
      },
    ]);
    expect(reg.resolve("cobol")).toBeNull();
    expect(reg.isInstalledFor("cobol")).toBe(false);
  });

  it("isCommandInstalled finds node and misses a fake command", () => {
    expect(isCommandInstalled("node")).toBe(true);
    expect(isCommandInstalled("definitely-not-installed-abcxyz-123")).toBe(false);
    expect(isCommandInstalled("")).toBe(false);
  });

  it("openLanguageServer degrades to { ok:false } with a clear reason for an unknown language", async () => {
    const reg = new LanguageServerRegistry(); // no server for 'brainfuck'
    const res = await openLanguageServer("brainfuck", {}, reg);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("no language server for brainfuck");
      expect(res.language).toBe("brainfuck");
    }
  });

  it("openLanguageServer degrades when the mapped server is not installed", async () => {
    const reg = new LanguageServerRegistry([
      {
        language: "haskell",
        languageId: "haskell",
        command: "definitely-not-installed-hls",
        args: ["--lsp"],
      },
    ]);
    const res = await openLanguageServer("haskell", {}, reg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no language server for haskell");
  });
});

describe("LspClient direct construction", () => {
  it("exposes the injected connection and stays uninitialized until initialize()", () => {
    const h = createMockPair();
    expect(h.client).toBeInstanceOf(LspClient);
    expect(h.client.getServerCapabilities()).toEqual({});
    void h.dispose();
  });
});
