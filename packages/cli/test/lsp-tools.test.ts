/**
 * Offline tests for the LSP-backed agent tools. No real language server is
 * spawned: a mock {@link LspClientLike} + a DI `opener` drive the whole flow, and
 * the graceful-degradation path (no server installed) is exercised directly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lspTools, type LspClientLike, type LspOpener } from "../src/lsp-tools.js";
import type { ToolContext, ToolResult } from "@nexuscode/tools";
import type { Diagnostic, Hover, Location, Position, WorkspaceEdit } from "@nexuscode/lsp";

let WORK: string;
const REL = "target.ts";

beforeAll(() => {
  WORK = mkdtempSync(join(tmpdir(), "nx-lsp-"));
  writeFileSync(join(WORK, REL), "export function greet(name: string) { return name; }\n", "utf8");
});
afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: WORK, runId: "r", traceId: "t" };
}

/** A deterministic mock LSP client that records opened documents. */
class MockClient implements LspClientLike {
  opened: string[] = [];
  disposed = false;
  openDocument(uri: string): void {
    this.opened.push(uri);
  }
  closeDocument(): void {}
  async definition(uri: string, _pos: Position): Promise<Location[]> {
    return [{ uri, range: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } } }];
  }
  async references(uri: string, _pos: Position, _incl?: boolean): Promise<Location[]> {
    return [
      { uri, range: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } } },
      { uri: "file:///other.ts", range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } } },
    ];
  }
  async safeRename(uri: string, _pos: Position, newName: string): Promise<WorkspaceEdit | null> {
    return {
      changes: {
        [uri]: [{ range: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } }, newText: newName }],
      },
    };
  }
  async hover(_uri: string, _pos: Position): Promise<Hover | null> {
    return { contents: { kind: "markdown", value: "function greet(name: string): string" } };
  }
  async waitForDiagnostics(_uri: string, _timeout?: number): Promise<Diagnostic[]> {
    return [
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, severity: 1, message: "Cannot find name 'x'." },
    ];
  }
  getDiagnostics(): Diagnostic[] {
    return [];
  }
}

function mockOpener(client: MockClient): LspOpener {
  return async () => ({ ok: true, opened: { client, dispose: async () => { client.disposed = true; } } });
}

function toolByName(name: string, opener: LspOpener) {
  const tool = lspTools({ opener }).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

async function runText(name: string, input: Record<string, unknown>, opener: LspOpener): Promise<ToolResult> {
  const tool = toolByName(name, opener);
  return (await tool.run(input, ctx())) as ToolResult;
}

function text(r: ToolResult): string {
  return r.content.map((b) => ("text" in b ? (b as { text?: string }).text ?? "" : "")).join("");
}

describe("lspTools — registration", () => {
  it("exposes the five LSP tools with correct permission classes", () => {
    const tools = lspTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual([
      "lsp_definition",
      "lsp_diagnostics",
      "lsp_hover",
      "lsp_references",
      "lsp_rename",
    ]);
    expect(byName.get("lsp_definition")!.permission).toBe("read");
    expect(byName.get("lsp_references")!.permission).toBe("read");
    expect(byName.get("lsp_diagnostics")!.permission).toBe("read");
    expect(byName.get("lsp_hover")!.permission).toBe("read");
    // rename mutates the workspace → write.
    expect(byName.get("lsp_rename")!.permission).toBe("write");
  });
});

describe("lspTools — operations against a mock server", () => {
  it("lsp_definition returns the definition location", async () => {
    const r = await runText("lsp_definition", { file: REL, line: 0, character: 16 }, mockOpener(new MockClient()));
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/:10:4/);
  });

  it("lsp_references returns every reference", async () => {
    const r = await runText("lsp_references", { file: REL, line: 0, character: 16 }, mockOpener(new MockClient()));
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/2 reference/);
    expect(text(r)).toMatch(/other\.ts:3:2/);
  });

  it("lsp_rename returns the workspace edit", async () => {
    const r = await runText("lsp_rename", { file: REL, line: 0, character: 16, newName: "hello" }, mockOpener(new MockClient()));
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/rename → "hello"/);
    expect(text(r)).toMatch(/"hello"/);
  });

  it("lsp_rename filters out an edit targeting a file outside the workspace, noting the drop", async () => {
    class EscapingRenameClient extends MockClient {
      override async safeRename(uri: string, _pos: Position, newName: string): Promise<WorkspaceEdit | null> {
        return {
          changes: {
            [uri]: [{ range: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } }, newText: newName }],
            "file:///etc/passwd": [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "pwned" },
            ],
          },
        };
      }
    }
    const r = await runText(
      "lsp_rename",
      { file: REL, line: 0, character: 16, newName: "hello" },
      mockOpener(new EscapingRenameClient()),
    );
    expect(r.ok).toBe(true);
    const body = text(r);
    expect(body).toMatch(/rename → "hello"/);
    expect(body).not.toContain("/etc/passwd");
    expect(body).not.toContain("pwned");
    expect(body).toMatch(/note:.*1 edit\(s\).*dropped/);
    // The in-workspace edit still made it through.
    expect(body).toMatch(/1 edit\(s\) across 1 file\(s\)/);
  });

  it("lsp_rename requires newName", async () => {
    const r = await runText("lsp_rename", { file: REL, line: 0, character: 16 }, mockOpener(new MockClient()));
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/newName/);
  });

  it("lsp_diagnostics reports diagnostics", async () => {
    const r = await runText("lsp_diagnostics", { file: REL }, mockOpener(new MockClient()));
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/error 2:0 Cannot find name/);
  });

  it("lsp_hover returns hover text", async () => {
    const r = await runText("lsp_hover", { file: REL, line: 0, character: 16 }, mockOpener(new MockClient()));
    expect(r.ok).toBe(true);
    expect(text(r)).toMatch(/function greet/);
  });

  it("disposes the client after the call", async () => {
    const client = new MockClient();
    await runText("lsp_definition", { file: REL, line: 0, character: 16 }, mockOpener(client));
    expect(client.disposed).toBe(true);
  });
});

describe("lspTools — graceful degradation (no crash)", () => {
  it("returns an isError result (not a throw) when no server is installed", async () => {
    const opener: LspOpener = async () => ({ ok: false, reason: "no language server for typescript" });
    const r = await runText("lsp_definition", { file: REL, line: 0, character: 4 }, opener);
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no language server available/);
  });

  it("degrades when the file's language is unknown", async () => {
    writeFileSync(join(WORK, "data.unknownext"), "x", "utf8");
    const r = await runText("lsp_definition", { file: "data.unknownext", line: 0, character: 0 }, mockOpener(new MockClient()));
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/no known language/);
  });

  it("requires a file argument", async () => {
    const r = await runText("lsp_definition", { line: 0, character: 0 }, mockOpener(new MockClient()));
    expect(r.ok).toBe(false);
    expect(text(r)).toMatch(/"file"/);
  });
});
