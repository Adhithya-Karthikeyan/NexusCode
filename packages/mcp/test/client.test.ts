import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import {
  McpClientManager,
  McpClient,
  parseMcpServerConfig,
  resolveTransport,
  trackChildPid,
  reapTrackedChildren,
} from "../src/index.js";
import { startHarness, buildTestMcpServer, type Harness } from "./harness.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** `true` while `pid` still exists (works without permission to signal it). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `check` until it's true or `timeoutMs` elapses (SIGKILL isn't instant). */
async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

describe("connect timeout (never hang on an unresponsive server — regression for the silent-hang bug)", () => {
  it("a stalled handshake fails fast with a clear error instead of hanging forever", async () => {
    // The client half of a linked in-memory pair whose peer is deliberately
    // never `.connect()`-ed — nothing will ever answer the `initialize`
    // request. This stands in for a real stdio server that spawns but stalls
    // before speaking MCP (a slow cold start, or one blocked acquiring a lock
    // already held by another running instance of itself — see
    // DEFAULT_CONNECT_TIMEOUT_MS in client.ts). Before the fix this hung the
    // whole CLI command indefinitely with zero output.
    const [clientTransport] = InMemoryTransport.createLinkedPair();
    const client = McpClient.withTransport("stalled", { timeoutMs: 50 });

    const started = Date.now();
    await expect(client.connectTransport(clientTransport)).rejects.toThrow(/timed out/);
    // Generous margin over the 50ms configured timeout — the point is "did
    // not hang", not exact timing.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(client.isConnected()).toBe(false);
  }, 10_000);

  it("connectAll bounds a stalled real subprocess and still reports the rest — never the sum of every server's timeout", async () => {
    const mgr = new McpClientManager();
    // A real child process that spawns successfully but never speaks a word
    // of MCP — the exact "spawned but stalled" shape a hung local server
    // takes. `resolveTransport`/`StdioClientTransport` genuinely spawn this.
    mgr.add(
      parseMcpServerConfig({
        name: "stalled-subprocess",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000_000)"],
        timeoutMs: 300,
      }),
    );
    // A server that fails immediately (ENOENT) — must not be delayed behind
    // the stalled one if connects genuinely run concurrently.
    mgr.add(
      parseMcpServerConfig({
        name: "unreachable",
        transport: "stdio",
        command: "definitely-not-a-real-binary-xyz",
        timeoutMs: 300,
      }),
    );

    const started = Date.now();
    const outcomes = await mgr.connectAll();
    const elapsedMs = Date.now() - started;

    // Bounded by ~one timeout with slack for process spawn — NOT the sum of
    // both servers' timeouts (which would be the old sequential behavior),
    // and nowhere near the old real-world hangs (minutes).
    expect(elapsedMs).toBeLessThan(5_000);

    const byName = new Map(outcomes.map((o) => [o.name, o]));
    expect(byName.get("stalled-subprocess")?.ok).toBe(false);
    expect(String(byName.get("stalled-subprocess")?.error)).toMatch(/timed out/);
    expect(byName.get("unreachable")?.ok).toBe(false);

    await mgr.closeAll();
  }, 15_000);
});

describe("child-process reaper (never leak a spawned MCP server — regression for the real kyp-mem leak)", () => {
  it("reapTrackedChildren SIGKILLs a tracked pid nothing else ever closed", async () => {
    // Stand-in for "a real MCP server child, tracked, whose McpClient.close()
    // never ran" — the exact shape a caller that connects outside a
    // try/finally (or a process killed by an unhandled SIGTERM) leaves behind.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000_000)"]);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    trackChildPid(pid);
    reapTrackedChildren();

    await waitUntil(() => !isAlive(pid), 2_000);
    expect(isAlive(pid)).toBe(false);
  });

  it("a REAL spawned stdio server that connects successfully and is never close()d is still reaped", async () => {
    // The fixture is a genuine MCP server over stdio (not the in-memory
    // harness) — this is a full end-to-end run of `resolveTransport` →
    // `connectTransport` spawning and speaking to an actual OS subprocess,
    // exactly like the real `kyp-mem serve` in the field.
    const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
    const config = parseMcpServerConfig({
      name: "reaper-fixture",
      transport: "stdio",
      command: process.execPath,
      args: [fixture],
    });
    const transport = await resolveTransport(config);
    const client = McpClient.withTransport("reaper-fixture");
    await client.connectTransport(transport);
    expect(client.isConnected()).toBe(true);

    const pid = (transport as { pid?: number | null }).pid;
    expect(typeof pid).toBe("number");
    expect(isAlive(pid as number)).toBe(true);

    // Deliberately do NOT call client.close() — simulate a caller that threw
    // (or a process that was SIGTERM'd) before its own cleanup ever ran.
    // `reapTrackedChildren` stands in for the process 'exit'/SIGTERM listener
    // firing, without actually tearing down the test runner to prove it.
    reapTrackedChildren();

    await waitUntil(() => !isAlive(pid as number), 2_000);
    expect(isAlive(pid as number)).toBe(false);
  }, 10_000);
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
