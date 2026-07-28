import { describe, it, expect } from "vitest";
import { createAnthropicAdapter, DEFAULT_ANTHROPIC_MODELS } from "@nexuscode/provider-anthropic";

/**
 * `listModels()` on the native Anthropic adapter queries `GET /v1/models` with
 * the resolved auth header + `anthropic-version`, mapping `data[].id`. A fake
 * `fetch` is injected so the parse and the auth-header wiring are verified with
 * no live network; any failure or missing key degrades to the curated list.
 */

const modelMap = { claude: "claude-sonnet-4-5" };

/** A fake fetch that records the request and returns a canned models payload. */
function fakeFetch(data: Array<{ id: string }>, capture?: { url?: string; headers?: Headers }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.headers = new Headers(init?.headers);
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("anthropic — listModels", () => {
  it("parses the live /v1/models response into Claude model ids", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const adapter = createAnthropicAdapter(
      { modelMap, fetchImpl: fakeFetch([{ id: "claude-opus-4-1" }, { id: "claude-sonnet-4-5" }], capture) },
      async () => "sk-ant-test",
    );
    const models = await adapter.listModels!();
    expect(models.map((m) => m.id)).toEqual(["claude-opus-4-1", "claude-sonnet-4-5"]);
    // Hit the real models endpoint with the api-key + version headers.
    expect(capture.url).toContain("/v1/models");
    expect(capture.headers?.get("x-api-key")).toBe("sk-ant-test");
    expect(capture.headers?.get("anthropic-version")).toBeTruthy();
  });

  it("sends an OAuth Bearer + beta header when the credential source is a bearer", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const adapter = createAnthropicAdapter(
      {
        modelMap,
        credential: async () => ({ kind: "bearer", value: "oauth-token-xyz" }),
        fetchImpl: fakeFetch([{ id: "claude-sonnet-4-5" }], capture),
      },
      async () => "unused",
    );
    await adapter.listModels!();
    expect(capture.headers?.get("authorization")).toBe("Bearer oauth-token-xyz");
    expect(capture.headers?.get("anthropic-beta")).toBeTruthy();
    expect(capture.headers?.get("x-api-key")).toBeNull();
  });

  it("falls back to the curated Claude catalog when the endpoint errors", async () => {
    const adapter = createAnthropicAdapter(
      {
        modelMap,
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
      async () => "sk-ant-test",
    );
    expect(await adapter.listModels!()).toEqual(DEFAULT_ANTHROPIC_MODELS);
  });

  it("falls back to the curated catalog when no credential resolves (never hits the network)", async () => {
    let called = false;
    const adapter = createAnthropicAdapter(
      {
        modelMap,
        fetchImpl: (async () => {
          called = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      },
      async () => "", // no key
    );
    const models = await adapter.listModels!();
    expect(models).toEqual(DEFAULT_ANTHROPIC_MODELS);
    expect(called).toBe(false);
  });

  it("falls back on a non-200 response", async () => {
    const adapter = createAnthropicAdapter(
      {
        modelMap,
        fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
      },
      async () => "sk-ant-test",
    );
    expect(await adapter.listModels!()).toEqual(DEFAULT_ANTHROPIC_MODELS);
  });

  it("the curated fallback catalog is the current Claude 5 generation, not a stale 4.x/3.x snapshot (regression: the model picker showed old model versions)", () => {
    const ids = DEFAULT_ANTHROPIC_MODELS.map((m) => m.id);
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("claude-haiku-4-5-20251001");
    // The stale generation this replaces — must never reappear.
    expect(ids).not.toContain("claude-opus-4-1");
    expect(ids).not.toContain("claude-opus-4-0");
    expect(ids).not.toContain("claude-sonnet-4-5");
    expect(ids).not.toContain("claude-sonnet-4-0");
    expect(ids).not.toContain("claude-3-7-sonnet-latest");
    expect(ids).not.toContain("claude-3-5-haiku-latest");
  });
});

describe("anthropic — listModelsWithSource (provenance)", () => {
  it("tags a genuine live /v1/models result \"provider\"", async () => {
    const adapter = createAnthropicAdapter(
      { modelMap, fetchImpl: fakeFetch([{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }]) },
      async () => "sk-ant-test",
    );
    const result = await adapter.listModelsWithSource!();
    expect(result.source).toBe("provider");
    expect(result.models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("tags the curated fallback \"fallback\" when the endpoint errors", async () => {
    const adapter = createAnthropicAdapter(
      {
        modelMap,
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
      async () => "sk-ant-test",
    );
    const result = await adapter.listModelsWithSource!();
    expect(result.source).toBe("fallback");
    expect(result.models).toEqual(DEFAULT_ANTHROPIC_MODELS);
  });

  it("tags the fallback \"fallback\" when no credential resolves", async () => {
    const adapter = createAnthropicAdapter(
      { modelMap, fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch },
      async () => "",
    );
    const result = await adapter.listModelsWithSource!();
    expect(result.source).toBe("fallback");
  });

  it("tags an empty-but-200 response \"fallback\" too — success alone isn't enough", async () => {
    const adapter = createAnthropicAdapter(
      { modelMap, fetchImpl: fakeFetch([]) },
      async () => "sk-ant-test",
    );
    const result = await adapter.listModelsWithSource!();
    expect(result.source).toBe("fallback");
    expect(result.models).toEqual(DEFAULT_ANTHROPIC_MODELS);
  });

  it("listModels() and listModelsWithSource() share one cache — the endpoint is only actually hit once", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createAnthropicAdapter({ modelMap, fetchImpl }, async () => "sk-ant-test");
    await adapter.listModels!();
    await adapter.listModelsWithSource!();
    expect(calls).toBe(1);
  });
});
