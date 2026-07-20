import { describe, it, expect, afterEach } from "vitest";
import { McpClientManager, McpClient } from "../src/index.js";
import { startHarness, buildTestMcpServer, type Harness } from "./harness.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("McpClient over an in-process server", () => {
  it("connects and discovers tools", async () => {
    harness = await startHarness();
    expect(harness.client.isConnected()).toBe(true);

    const tools = await harness.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "boom", "echo"]);

    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.description).toContain("Echo");
    expect(echo.inputSchema["type"]).toBe("object");
    expect(echo.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns its content", async () => {
    harness = await startHarness();
    const res = await harness.client.callTool("add", { a: 2, b: 3 });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: "5" });
  });

  it("propagates a tool error via isError", async () => {
    harness = await startHarness();
    const res = await harness.client.callTool("boom", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: "kaboom" });
  });

  it("browses and reads resources", async () => {
    harness = await startHarness();
    const resources = await harness.client.listResources();
    expect(resources.map((r) => r.uri)).toContain("test://greeting");

    const contents = await harness.client.readResource("test://greeting");
    expect(contents[0]).toMatchObject({ text: "hello from resource" });
  });

  it("lists and gets prompt templates", async () => {
    harness = await startHarness();
    const prompts = await harness.client.listPrompts();
    const greet = prompts.find((p) => p.name === "greet")!;
    expect(greet).toBeTruthy();
    expect(greet.arguments?.[0]?.name).toBe("name");

    const got = await harness.client.getPrompt("greet", { name: "Ada" });
    expect(JSON.stringify(got.messages)).toContain("Say hello to Ada.");
  });

  it("honors an abort signal on callTool", async () => {
    harness = await startHarness();
    const ac = new AbortController();
    ac.abort();
    await expect(harness.client.callTool("add", { a: 1, b: 1 }, { signal: ac.signal })).rejects.toBeTruthy();
  });

  it("throws when calling before connecting", async () => {
    const client = McpClient.withTransport("orphan");
    await expect(client.listTools()).rejects.toThrow(/not connected/);
  });
});

describe("McpClientManager (multiple servers + discovery)", () => {
  it("connects two servers and aggregates their tools", async () => {
    const mgr = new McpClientManager();

    // Two independent in-process servers.
    for (const name of ["srvA", "srvB"]) {
      const server = buildTestMcpServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = McpClient.withTransport(name);
      await client.connectTransport(ct);
      mgr.addClient(client);
    }

    expect(mgr.names().sort()).toEqual(["srvA", "srvB"]);

    const discovered = await mgr.discoverTools();
    // 3 tools per server × 2 servers.
    expect(discovered).toHaveLength(6);
    const servers = new Set(discovered.map((d) => d.server));
    expect(servers).toEqual(new Set(["srvA", "srvB"]));

    await mgr.closeAll();
  });

  it("rejects duplicate server names", () => {
    const mgr = new McpClientManager();
    mgr.addClient(McpClient.withTransport("dup"));
    expect(() => mgr.addClient(McpClient.withTransport("dup"))).toThrow(/duplicate/);
  });

  it("throws on an unknown server lookup", () => {
    const mgr = new McpClientManager();
    expect(() => mgr.get("ghost")).toThrow(/ghost/);
  });
});
