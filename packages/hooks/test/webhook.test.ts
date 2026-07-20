/**
 * WebhookDispatcher tests. Fully offline: an in-process `node:http` receiver on
 * 127.0.0.1 stands in for the external endpoint (reached via `allowPrivate`).
 * Covers: a subscribed event POSTs an HMAC-SIGNED, SECRET-REDACTED envelope to
 * the local receiver; the SSRF guard BLOCKS a private target (169.254.169.254)
 * when private access is not opted in; retries with backoff on a transient
 * failure; and event filtering.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecretStore } from "@nexuscode/config";
import type { WebhookConfig } from "@nexuscode/config";
import {
  WebhookDispatcher,
  signBody,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  type FetchLike,
} from "../src/index.js";

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function fakeSecretStore(map: Record<string, string>): SecretStore {
  return {
    get: async (ref: string) => map[ref] ?? null,
    set: async () => {},
    delete: async () => {},
    source: async (ref: string) => (ref in map ? "env" : null),
  };
}

function webhook(overrides: Partial<WebhookConfig> & Pick<WebhookConfig, "url" | "events">): WebhookConfig {
  return {
    enabled: true,
    timeoutMs: 2000,
    maxRetries: 2,
    ssrfAllowlist: [],
    allowPrivate: false,
    ...overrides,
  };
}

describe("WebhookDispatcher local delivery", () => {
  let server: Server;
  let url: string;
  let received: Received[];

  beforeEach(async () => {
    received = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = 200;
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}/hook`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POSTs a signed, secret-redacted envelope on a subscribed event", async () => {
    const secret = "whsec_test_1234567890";
    const dispatcher = new WebhookDispatcher({
      secretStore: fakeSecretStore({ "webhook.signing": secret }),
      now: () => 1_700_000_000_000,
    });

    const wh = webhook({
      url,
      events: ["pre-tool"],
      secretRef: "webhook.signing",
      allowPrivate: true, // reach the local 127.0.0.1 receiver
    });

    const [delivery] = await dispatcher.dispatch(
      "pre-tool",
      { toolName: "db_query", input: { password: "hunter2", apiKey: "sk-abcdef1234567890xyz", host: "db.internal" } },
      [wh],
    );

    expect(delivery?.ok).toBe(true);
    expect(delivery?.blocked).toBe(false);
    expect(delivery?.attempts).toBe(1);
    expect(received).toHaveLength(1);

    const got = received[0]!;
    // Event header + valid HMAC signature over the exact received body.
    expect(got.headers[EVENT_HEADER]).toBe("pre-tool");
    expect(got.headers[SIGNATURE_HEADER]).toBe(signBody(got.body, secret));

    // Secrets are redacted; the secret VALUE never appears in the payload.
    expect(got.body).not.toContain("hunter2");
    expect(got.body).not.toContain("sk-abcdef1234567890xyz");
    expect(got.body).toContain("[REDACTED]");

    const envelope = JSON.parse(got.body) as {
      event: string;
      timestamp: number;
      payload: { input: { password: string; apiKey: string; host: string } };
    };
    expect(envelope.event).toBe("pre-tool");
    expect(envelope.timestamp).toBe(1_700_000_000_000);
    expect(envelope.payload.input.password).toBe("[REDACTED]");
    expect(envelope.payload.input.apiKey).toBe("[REDACTED]");
    expect(envelope.payload.input.host).toBe("db.internal"); // non-secret preserved
  });

  it("does not deliver to a webhook not subscribed to the event", async () => {
    const dispatcher = new WebhookDispatcher();
    const wh = webhook({ url, events: ["session-start"], allowPrivate: true });
    const out = await dispatcher.dispatch("pre-tool", { toolName: "x", input: {} }, [wh]);
    expect(out).toHaveLength(0);
    expect(received).toHaveLength(0);
  });
});

describe("WebhookDispatcher SSRF guard", () => {
  it("blocks a private/link-local target when allowPrivate is false", async () => {
    let dialed = false;
    const spyFetch: FetchLike = async () => {
      dialed = true;
      return { ok: true, status: 200 };
    };
    const dispatcher = new WebhookDispatcher({ fetchImpl: spyFetch });

    const wh = webhook({ url: "http://169.254.169.254/latest/meta-data", events: ["pre-tool"] });
    const [delivery] = await dispatcher.dispatch("pre-tool", { toolName: "x", input: {} }, [wh]);

    expect(delivery?.blocked).toBe(true);
    expect(delivery?.ok).toBe(false);
    expect(delivery?.attempts).toBe(0);
    expect(delivery?.error).toMatch(/private|loopback|blocked/i);
    expect(dialed).toBe(false); // the guard runs BEFORE any request
  });

  it("blocks a loopback hostname target when allowPrivate is false", async () => {
    let dialed = false;
    const dispatcher = new WebhookDispatcher({
      fetchImpl: async () => {
        dialed = true;
        return { ok: true, status: 200 };
      },
    });
    const wh = webhook({ url: "http://localhost:9999/hook", events: ["pre-tool"] });
    const [delivery] = await dispatcher.dispatch("pre-tool", { toolName: "x", input: {} }, [wh]);
    expect(delivery?.blocked).toBe(true);
    expect(dialed).toBe(false);
  });

  it("does NOT follow a 30x redirect to cloud-metadata (169.254.169.254)", async () => {
    let calls = 0;
    const redirectingFetch: FetchLike = async () => {
      calls += 1;
      return {
        ok: false,
        status: 302,
        headers: {
          get: (name: string) => (name.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data" : null),
        },
      };
    };
    const dispatcher = new WebhookDispatcher({ fetchImpl: redirectingFetch });
    const wh = webhook({ url: "https://example.com/hook", events: ["pre-tool"], allowPrivate: false });
    const [delivery] = await dispatcher.dispatch("pre-tool", { toolName: "x", input: {} }, [wh]);

    expect(delivery?.blocked).toBe(true);
    expect(delivery?.ok).toBe(false);
    expect(delivery?.error).toMatch(/private|loopback|blocked/i);
    // The redirect target was NEVER dialed — only the one (redirecting) request.
    expect(calls).toBe(1);
  });

  it("does NOT follow a 30x redirect to a loopback address (127.0.0.1)", async () => {
    let calls = 0;
    const redirectingFetch: FetchLike = async () => {
      calls += 1;
      return {
        ok: false,
        status: 307,
        headers: {
          get: (name: string) => (name.toLowerCase() === "location" ? "http://127.0.0.1:9999/internal" : null),
        },
      };
    };
    const dispatcher = new WebhookDispatcher({ fetchImpl: redirectingFetch });
    const wh = webhook({ url: "https://example.com/hook", events: ["pre-tool"], allowPrivate: false });
    const [delivery] = await dispatcher.dispatch("pre-tool", { toolName: "x", input: {} }, [wh]);

    expect(delivery?.blocked).toBe(true);
    expect(delivery?.ok).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("WebhookDispatcher retries", () => {
  it("retries with backoff on a transient failure then succeeds", async () => {
    const slept: number[] = [];
    let calls = 0;
    const flaky: FetchLike = async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return { ok: true, status: 200 };
    };
    const dispatcher = new WebhookDispatcher({
      fetchImpl: flaky,
      sleep: async (ms) => { slept.push(ms); },
    });
    const wh = webhook({ url: "https://example.com/hook", events: ["post-run"], maxRetries: 3, allowPrivate: false });
    const [delivery] = await dispatcher.dispatch("post-run", { status: "ok" }, [wh]);
    expect(delivery?.ok).toBe(true);
    expect(delivery?.attempts).toBe(3);
    expect(slept).toEqual([100, 200]); // exponential backoff between the 3 attempts
  });

  it("gives up after maxRetries and reports the last error", async () => {
    const dispatcher = new WebhookDispatcher({
      fetchImpl: async () => ({ ok: false, status: 500 }),
      sleep: async () => {},
    });
    const wh = webhook({ url: "https://example.com/hook", events: ["on-error"], maxRetries: 1 });
    const [delivery] = await dispatcher.dispatch("on-error", { message: "boom" }, [wh]);
    expect(delivery?.ok).toBe(false);
    expect(delivery?.attempts).toBe(2); // 1 initial + 1 retry
    expect(delivery?.status).toBe(500);
    expect(delivery?.error).toBe("HTTP 500");
  });
});
