import { describe, it, expect } from "vitest";
import { createOpenAICompatAdapter } from "@nexuscode/provider-openai";
import type OpenAI from "openai";

/**
 * The per-adapter client cache used to be keyed by the plaintext resolved API
 * key (a live secret sitting as a Map key for the adapter's lifetime). It is
 * now keyed by a SHA-256 digest of the credential — this asserts the cache
 * still reuses a client for a repeated credential (preserving the socket-pool
 * win) while never retaining the plaintext key itself.
 */
describe("OpenAICompatAdapter — client cache", () => {
  it("keys the client cache by a digest, not the plaintext credential, and still reuses the client", async () => {
    const adapter = createOpenAICompatAdapter({
      id: "test-compat",
      apiKey: "sk-test-plaintext-secret-123",
    }) as unknown as {
      clientFor: (ctx?: unknown) => Promise<OpenAI>;
      clients: Map<string, OpenAI>;
    };

    const first = await adapter.clientFor();
    const second = await adapter.clientFor();

    // Socket-pool reuse is preserved: the same credential resolves to the same client.
    expect(second).toBe(first);
    expect(adapter.clients.size).toBe(1);

    const [cacheKey] = [...adapter.clients.keys()];
    expect(cacheKey).not.toBe("sk-test-plaintext-secret-123");
    expect(cacheKey).not.toContain("sk-test-plaintext-secret-123");
    // A SHA-256 hex digest, not a reversible transform of the key.
    expect(cacheKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives distinct credentials distinct cache entries", async () => {
    const adapter = createOpenAICompatAdapter({ id: "test-compat" }) as unknown as {
      clientFor: (ctx: { credential: { value: string } }) => Promise<OpenAI>;
      clients: Map<string, OpenAI>;
    };

    const a = await adapter.clientFor({ credential: { value: "key-a" } });
    const b = await adapter.clientFor({ credential: { value: "key-b" } });

    expect(a).not.toBe(b);
    expect(adapter.clients.size).toBe(2);
  });
});
