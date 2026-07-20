/**
 * REST daemon tests — fully offline. Every test boots a real in-process
 * `NexusServer` on an ephemeral loopback port over the `mock` provider (which
 * the runtime bootstrap always registers), then drives it with the global
 * `fetch`. No external network is ever touched: the mock provider streams
 * deterministic text and the SecretStore is an in-memory stub.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SecretSource, SecretStore } from "@nexuscode/config";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { createNexusServer, NexusServer, redactConfig, REDACTED } from "../src/index.js";

/** A deterministic, in-memory SecretStore so tests never touch the keychain/file. */
class MemStore implements SecretStore {
  readonly map = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.map.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.map.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.map.delete(ref);
  }
  async source(ref: string): Promise<SecretSource | null> {
    return this.map.has(ref) ? "file" : null;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(
  opts: Parameters<typeof createNexusServer>[0] = {},
): Promise<{ server: NexusServer; base: string; token: string; secrets: MemStore }> {
  const secrets = opts.secrets instanceof MemStore ? opts.secrets : new MemStore();
  const server = await createNexusServer({
    secrets,
    nexusOptions: { config: { defaultProvider: "mock", defaultModel: "mock-fast" } },
    ...opts,
  });
  await server.listen();
  cleanups.push(() => server.close());
  return { server, base: server.url, token: server.authToken, secrets: secrets as MemStore };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Consume an SSE response body into a list of `{ event, data }` frames. */
async function readSse(res: Response, maxFrames = 200): Promise<Array<{ event: string; data: unknown }>> {
  const frames: Array<{ event: string; data: unknown }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      frames.push({ event, data: data ? JSON.parse(data) : undefined });
      if (event === "end" || frames.length >= maxFrames) {
        await reader.cancel().catch(() => {});
        return frames;
      }
    }
  }
  return frames;
}

describe("health", () => {
  it("responds ok WITHOUT authentication (liveness probe)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; uptimeMs: number };
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeMs).toBe("number");
  });
});

describe("authentication", () => {
  it("rejects an unauthenticated data request with 401", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/providers`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a wrong bearer token with 401", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/providers`, { headers: auth("not-the-token") });
    expect(res.status).toBe(401);
  });

  it("generates and persists a token via the SecretStore on first run", async () => {
    const secrets = new MemStore();
    const { token } = await boot({ secrets });
    expect(token.length).toBeGreaterThan(20);
    expect(secrets.map.get("nexus.server.token")).toBe(token);

    // A second server over the same store reuses the persisted token.
    const second = await boot({ secrets });
    expect(second.token).toBe(token);
  });

  it("uses an explicit token when provided", async () => {
    const { base, token } = await boot({ token: "explicit-secret-token-value" });
    expect(token).toBe("explicit-secret-token-value");
    const res = await fetch(`${base}/v1/providers`, { headers: auth(token) });
    expect(res.status).toBe(200);
  });
});

describe("introspection", () => {
  it("lists providers including the mock provider", async () => {
    const { base, token } = await boot();
    const res = await fetch(`${base}/v1/providers`, { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ id: string; models: string[]; available?: boolean }> };
    const mock = body.providers.find((p) => p.id === "mock");
    expect(mock).toBeDefined();
    expect(mock!.models).toContain("mock-fast");
    expect(mock!.available).toBe(true);
  });

  it("lists tools", async () => {
    const { base, token } = await boot();
    const res = await fetch(`${base}/v1/tools`, { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: unknown[] };
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("returns a redacted config that never exposes an inlined secret", async () => {
    const secretValue = "super-secret-db-password-DO-NOT-LEAK";
    const { base, token } = await boot({
      nexusOptions: {
        config: {
          defaultProvider: "mock",
          defaultModel: "mock-fast",
          tools: {
            db: { connections: { main: { driver: "postgres", password: secretValue } } },
          },
        },
      },
    });
    const res = await fetch(`${base}/v1/config`, { headers: auth(token) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secretValue);
    expect(text).toContain(REDACTED);
    const body = JSON.parse(text) as { config: { tools: { db: { connections: { main: { password: string } } } } } };
    expect(body.config.tools.db.connections.main.password).toBe(REDACTED);
  });
});

describe("runs + SSE", () => {
  it("starts a single run and streams its UiEvents (text + done) over SSE", async () => {
    const { base, token } = await boot();

    const start = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ kind: "single", prompt: "hello world" }),
    });
    expect(start.status).toBe(202);
    const started = (await start.json()) as { runId: string; kind: string; events: string };
    expect(started.kind).toBe("single");
    expect(started.runId).toBeTruthy();

    const sse = await fetch(`${base}${started.events}`, { headers: auth(token) });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toMatch(/text\/event-stream/);

    const frames = await readSse(sse);
    const kinds = frames.map((f) => f.event);
    const text = frames
      .filter((f) => f.event === "text")
      .map((f) => (f.data as { delta: string }).delta)
      .join("");

    expect(text.length).toBeGreaterThan(0);
    expect(kinds).toContain("done");
    expect(kinds).toContain("end");
  });

  it("rejects an unknown provider run with 400", async () => {
    const { base, token } = await boot();
    const res = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ kind: "single", prompt: "hi", opts: { provider: "does-not-exist" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("rejects a run with a missing prompt with 400", async () => {
    const { base, token } = await boot();
    const res = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ kind: "single" }),
    });
    expect(res.status).toBe(400);
  });

  it("fans a compare run across two mock backends", async () => {
    const { base, token } = await boot();
    const start = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ kind: "compare", prompt: "compare me", providers: ["mock/mock-fast", "mock/mock-fast"] }),
    });
    expect(start.status).toBe(202);
    const started = (await start.json()) as { runId: string; events: string };
    const sse = await fetch(`${base}${started.events}`, { headers: auth(token) });
    const frames = await readSse(sse);
    expect(frames.some((f) => f.event === "text")).toBe(true);
    expect(frames.some((f) => f.event === "end")).toBe(true);
  });

  it("exposes the run in GET /v1/runs and GET /v1/runs/:id", async () => {
    const { base, token } = await boot();
    const start = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ kind: "single", prompt: "track me" }),
    });
    const { runId } = (await start.json()) as { runId: string };

    const list = await fetch(`${base}/v1/runs`, { headers: auth(token) });
    const listed = (await list.json()) as { runs: Array<{ id: string }> };
    expect(listed.runs.some((r) => r.id === runId)).toBe(true);

    const one = await fetch(`${base}/v1/runs/${runId}`, { headers: auth(token) });
    expect(one.status).toBe(200);
    const body = (await one.json()) as { run: { id: string; kind: string } };
    expect(body.run.id).toBe(runId);
    expect(body.run.kind).toBe("single");

    const missing = await fetch(`${base}/v1/runs/does-not-exist`, { headers: auth(token) });
    expect(missing.status).toBe(404);
  });
});

describe("sessions", () => {
  it("lists the default session and returns it by id", async () => {
    const { base, token } = await boot();
    const list = await fetch(`${base}/v1/sessions`, { headers: auth(token) });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    const id = body.sessions[0]!.id;

    const one = await fetch(`${base}/v1/sessions/${encodeURIComponent(id)}`, { headers: auth(token) });
    expect(one.status).toBe(200);
    const got = (await one.json()) as { session: { id: string } };
    expect(got.session.id).toBe(id);

    const missing = await fetch(`${base}/v1/sessions/nope`, { headers: auth(token) });
    expect(missing.status).toBe(404);
  });
});

describe("security defaults", () => {
  it("binds to loopback by default", async () => {
    const { server } = await boot();
    const addr = server.address!;
    expect(["127.0.0.1", "::1"]).toContain(addr.address);
  });

  it("emits no CORS header by default", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/v1/health`);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("emits a CORS header when explicitly enabled", async () => {
    const { base } = await boot({ cors: true });
    const res = await fetch(`${base}/v1/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

/** Poll `predicate` until it's true, or throw once `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A slow custom mock provider: ~4 chunks, each delayed, so a run stays "running" a while. */
function slowProvider(id = "mock-slow-test"): ReturnType<typeof createMockAdapter> {
  return createMockAdapter({ id, delayMs: 300 });
}

describe("resource limits", () => {
  it("returns 429 once maxConcurrentRuns is exceeded", async () => {
    const { base, token } = await boot({
      maxConcurrentRuns: 1,
      nexusOptions: {
        config: { defaultProvider: "mock", defaultModel: "mock-fast" },
        providers: [slowProvider()],
      },
    });

    const first = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "single",
        prompt: "hold this slot",
        opts: { provider: "mock-slow-test", model: "mock-fast" },
      }),
    });
    expect(first.status).toBe(202);

    const second = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ kind: "single", prompt: "should be rejected while the slot is held" }),
    });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("too_many_runs");
  });

  it("returns 429 once maxSseConnections is exceeded", async () => {
    const { base, token } = await boot({
      maxSseConnections: 1,
      nexusOptions: {
        config: { defaultProvider: "mock", defaultModel: "mock-fast" },
        providers: [slowProvider()],
      },
    });
    const start = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "single",
        prompt: "stream me slowly",
        opts: { provider: "mock-slow-test", model: "mock-fast" },
      }),
    });
    const { events } = (await start.json()) as { events: string };

    const firstStream = await fetch(`${base}${events}`, { headers: auth(token) });
    expect(firstStream.status).toBe(200);

    const secondStream = await fetch(`${base}${events}`, { headers: auth(token) });
    expect(secondStream.status).toBe(429);

    await firstStream.body?.cancel().catch(() => {});
  });

  it("cleans up the tracked SSE connection count on client disconnect", async () => {
    const { base, token, server } = await boot({
      nexusOptions: {
        config: { defaultProvider: "mock", defaultModel: "mock-fast" },
        providers: [slowProvider()],
      },
    });

    const start = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "single",
        prompt: "stream me slowly",
        opts: { provider: "mock-slow-test", model: "mock-fast" },
      }),
    });
    const { events } = (await start.json()) as { events: string };

    expect(server.activeSseConnections).toBe(0);

    const controller = new AbortController();
    const sse = await fetch(`${base}${events}`, { headers: auth(token), signal: controller.signal });
    const reader = sse.body!.getReader();
    await reader.read(); // the primed "open" frame — proves the stream is live
    expect(server.activeSseConnections).toBe(1);

    controller.abort();
    await reader.cancel().catch(() => {});

    // The server's `req` "close" handling is async — poll for it to settle.
    await waitFor(() => server.activeSseConnections === 0);
  });
});

describe("redactConfig unit", () => {
  it("masks credential-looking keys at any depth and leaves others intact", () => {
    const input = {
      defaultProvider: "mock",
      nested: { apiKey: "abc", label: "keep-me", connectionString: "postgres://u:p@h/db" },
      list: [{ password: "x" }, { note: "fine" }],
    };
    const out = redactConfig(input);
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.connectionString).toBe(REDACTED);
    expect(out.nested.label).toBe("keep-me");
    expect(out.list[0].password).toBe(REDACTED);
    expect(out.list[1].note).toBe("fine");
    expect(out.defaultProvider).toBe("mock");
  });
});
