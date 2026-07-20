import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type OpenAI from "openai";
import type { CallContext } from "@nexuscode/core";
import { sharedHttpAgent, sharedHttpsAgent, resetHttpPool } from "@nexuscode/shared";
import { createOpenAICompatAdapter } from "@nexuscode/provider-openai";

/**
 * Connection pooling (system-spec §23): the compat adapter's SDK client must be
 * built with the process-wide keep-alive agent so sockets are reused across
 * calls instead of re-dialed. Proven two ways: (1) the client's `httpAgent` IS
 * the shared singleton (and is shared across adapters), and (2) two real chat
 * calls to a local server reuse ONE TCP connection.
 */
function ctx(signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId: "run_ka" };
}

describe("OpenAICompatAdapter — keep-alive connection pooling", () => {
  afterEach(() => {
    resetHttpPool();
  });

  it("builds the SDK client with the shared keep-alive agent (per scheme), reused across adapters", async () => {
    const httpAdapter = createOpenAICompatAdapter({
      id: "ka-http",
      baseURL: "http://127.0.0.1:1/v1",
      requiresAuth: false,
    }) as unknown as { clientFor: () => Promise<OpenAI> };
    const httpsAdapter = createOpenAICompatAdapter({
      id: "ka-https",
      apiKey: "sk-x",
    }) as unknown as { clientFor: () => Promise<OpenAI> };
    const httpAdapter2 = createOpenAICompatAdapter({
      id: "ka-http-2",
      baseURL: "http://other.local:9/v1",
      requiresAuth: false,
    }) as unknown as { clientFor: () => Promise<OpenAI> };

    const c1 = await httpAdapter.clientFor();
    const c2 = await httpsAdapter.clientFor();
    const c3 = await httpAdapter2.clientFor();

    // http backend → the shared http agent; https backend → the shared https agent.
    expect(c1.httpAgent).toBe(sharedHttpAgent());
    expect(c2.httpAgent).toBe(sharedHttpsAgent());
    // Two DIFFERENT http adapters share the SAME agent (one process-wide socket pool).
    expect(c3.httpAgent).toBe(c1.httpAgent);
    expect((c1.httpAgent as { options: { keepAlive?: boolean } }).options.keepAlive).toBe(true);
  });

  it("honors an explicit httpAgent override", async () => {
    const custom = sharedHttpAgent(); // any agent; identity is what we check
    const adapter = createOpenAICompatAdapter({
      id: "ka-override",
      baseURL: "http://127.0.0.1:1/v1",
      requiresAuth: false,
      httpAgent: custom,
    }) as unknown as { clientFor: () => Promise<OpenAI> };
    const client = await adapter.clientFor();
    expect(client.httpAgent).toBe(custom);
  });

  it("reuses ONE TCP socket across two sequential chat calls (real local server)", async () => {
    resetHttpPool();
    let connections = 0;
    let requests = 0;
    const server: Server = createServer((req, res) => {
      requests++;
      // Drain the request body, then reply with a minimal OpenAI-compat SSE stream.
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "1",
            object: "chat.completion.chunk",
            created: 0,
            model: "m",
            choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "1",
            object: "chat.completion.chunk",
            created: 0,
            model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.on("connection", () => {
      connections++;
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const adapter = createOpenAICompatAdapter({
        id: "ka-live",
        baseURL: `http://127.0.0.1:${port}/v1`,
        requiresAuth: false,
        includeUsage: false,
      });
      const ac = new AbortController();
      const req = {
        model: "m",
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      };

      const first = await adapter.chat(req, ctx(ac.signal));
      const second = await adapter.chat(req, ctx(ac.signal));

      expect(first.finishReason).toBe("stop");
      expect(second.finishReason).toBe("stop");
      // Two requests were served...
      expect(requests).toBe(2);
      // ...over a SINGLE reused keep-alive connection (the pooling win).
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
