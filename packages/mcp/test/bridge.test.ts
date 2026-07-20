import { describe, it, expect, afterEach } from "vitest";
import {
  mcpToolToTool,
  bridgeClientTools,
  classifyPermission,
  bridgedToolName,
  mapMcpContent,
} from "../src/index.js";
import { runTool, ToolRegistry, PermissionGate, type ToolContext } from "@nexuscode/tools";
import { startHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), runId: "r1" };
}

describe("permission classification", () => {
  it("does not trust an untrusted server's readOnlyHint — floors at network (needs approval)", () => {
    expect(classifyPermission({ name: "x", inputSchema: {}, annotations: { readOnlyHint: true } })).toBe("network");
    expect(classifyPermission({ name: "x", inputSchema: {} })).toBe("network");
  });

  it("honors readOnlyHint → read only when the server's annotations are explicitly trusted", () => {
    expect(
      classifyPermission(
        { name: "x", inputSchema: {}, annotations: { readOnlyHint: true } },
        { trustAnnotations: true },
      ),
    ).toBe("read");
    // Trust alone does not invent read-only-ness for an unannotated tool.
    expect(classifyPermission({ name: "x", inputSchema: {} }, { trustAnnotations: true })).toBe("network");
  });

  it("never classifies a destructiveHint tool as read, trusted or not", () => {
    expect(classifyPermission({ name: "x", inputSchema: {}, annotations: { destructiveHint: true } })).toBe("exec");
    expect(
      classifyPermission({ name: "x", inputSchema: {}, annotations: { destructiveHint: true } }, { trustAnnotations: true }),
    ).toBe("exec");
    // A server declaring BOTH hints (contradictory) still never gets "read".
    expect(
      classifyPermission(
        { name: "x", inputSchema: {}, annotations: { destructiveHint: true, readOnlyHint: true } },
        { trustAnnotations: true },
      ),
    ).toBe("exec");
  });
});

describe("content mapping", () => {
  it("maps text, image, resource, and audio blocks", () => {
    expect(mapMcpContent({ type: "text", text: "hi" })).toEqual([{ type: "text", text: "hi" }]);
    expect(mapMcpContent({ type: "image", data: "abc", mimeType: "image/png" })).toEqual([
      { type: "image", mime: "image/png", data: "abc" },
    ]);
    expect(mapMcpContent({ type: "resource", resource: { uri: "u", text: "body" } })).toEqual([
      { type: "text", text: "body" },
    ]);
    expect(mapMcpContent({ type: "audio", data: "x", mimeType: "audio/wav" })).toEqual([
      { type: "text", text: "[audio audio/wav]" },
    ]);
  });
});

describe("bridged tool naming", () => {
  it("namespaces by server by default and can be disabled", () => {
    expect(bridgedToolName("gh", "search")).toBe("gh__search");
    expect(bridgedToolName("gh", "search", { namespace: false })).toBe("search");
    expect(bridgedToolName("gh", "search", { separator: "." })).toBe("gh.search");
  });
});

describe("mcpToolToTool bridge", () => {
  it("wraps an MCP tool as a @nexuscode Tool and runs it via runTool", async () => {
    harness = await startHarness("gh");
    const descriptors = await harness.client.listTools();
    const addDesc = descriptors.find((d) => d.name === "add")!;

    const tool = mcpToolToTool(harness.client, addDesc);
    expect(tool.name).toBe("gh__add");
    expect(tool.permission).toBe("network");
    expect(tool.parameters["type"]).toBe("object");

    const result = await runTool(tool, { a: 4, b: 5 }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "9" });
  });

  it("surfaces an MCP tool error as an error ToolResult", async () => {
    harness = await startHarness();
    const descriptors = await harness.client.listTools();
    const boomDesc = descriptors.find((d) => d.name === "boom")!;
    const tool = mcpToolToTool(harness.client, boomDesc);
    const result = await runTool(tool, {}, ctx());
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("bridges into a ToolRegistry and passes the PermissionGate", async () => {
    harness = await startHarness("srv");
    // This test models a server explicitly configured as trusted
    // (`trustAnnotations: true`) so its `readOnlyHint` tool downgrades to
    // "read" — an untrusted server's readOnlyHint floors at "network" instead
    // (see bridge.test.ts's "permission classification" suite).
    const tools = await bridgeClientTools(harness.client, { trustAnnotations: true });
    expect(tools.map((t) => t.name).sort()).toEqual(["srv__add", "srv__boom", "srv__echo"]);

    const registry = new ToolRegistry();
    registry.registerAll(tools);
    expect(registry.has("srv__echo")).toBe(true);

    // echo is read-only → allowed in read-only mode without approval.
    const gate = new PermissionGate({ mode: "read-only" });
    const echo = registry.get("srv__echo");
    const echoDecision = await gate.check(echo, { message: "hi" });
    expect(echoDecision.allowed).toBe(true);

    // add is network → asks; no approver ⇒ denied.
    const add = registry.get("srv__add");
    const addDecision = await gate.check(add, { a: 1, b: 2 });
    expect(addDecision.allowed).toBe(false);

    // …but an approver flips it, and the tool then runs through the loop.
    const gate2 = new PermissionGate({ mode: "read-only", approve: async () => true });
    const addDecision2 = await gate2.check(add, { a: 1, b: 2 });
    expect(addDecision2.allowed).toBe(true);
    const result = await runTool(add, { a: 1, b: 2 }, ctx());
    expect(result.content[0]).toMatchObject({ type: "text", text: "3" });
  });
});
