import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createWebSearchTool,
  createHttpSearchProvider,
  mockSearchProvider,
  resolveDefaultSearchProvider,
  type SearchProvider,
} from "../src/index.js";
import { runTool, type ToolContext } from "@nexuscode/tools";

function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd() };
}

function textOf(content: { type: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("mockSearchProvider", () => {
  it("is deterministic for the same query", async () => {
    const a = await mockSearchProvider.search("rust async", { maxResults: 5 }, ctx());
    const b = await mockSearchProvider.search("rust async", { maxResults: 5 }, ctx());
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    expect(a[0]?.url).toMatch(/^https:\/\//);
    expect(a[0]?.score).toBeGreaterThan(a[4]?.score ?? 1);
  });

  it("varies by query", async () => {
    const a = await mockSearchProvider.search("alpha", { maxResults: 3 }, ctx());
    const b = await mockSearchProvider.search("beta", { maxResults: 3 }, ctx());
    expect(a[0]?.url).not.toEqual(b[0]?.url);
  });

  it("honors maxResults", async () => {
    const r = await mockSearchProvider.search("x", { maxResults: 2 }, ctx());
    expect(r).toHaveLength(2);
  });
});

describe("web_search tool", () => {
  it("has the frozen Tool contract shape (network permission)", () => {
    const tool = createWebSearchTool();
    expect(tool.name).toBe("web_search");
    expect(tool.permission).toBe("network");
    expect(tool.parameters).toMatchObject({ type: "object", required: ["query"] });
  });

  it("renders results from the mock provider", async () => {
    const tool = createWebSearchTool({ provider: mockSearchProvider });
    const r = await runTool(tool, { query: "typescript generics", maxResults: 3 }, ctx());
    expect(r.ok).toBe(true);
    const body = textOf(r.content);
    expect(body).toContain('Search results for "typescript generics"');
    expect(body).toContain("(mock)");
    expect(body.match(/^\d+\. /gm)?.length).toBe(3);
  });

  it("delegates to an injected custom provider", async () => {
    const provider: SearchProvider = {
      name: "custom",
      search: () =>
        Promise.resolve([{ title: "Injected", url: "https://ex.com/1", snippet: "hi" }]),
    };
    const tool = createWebSearchTool({ provider });
    const r = await runTool(tool, { query: "anything" }, ctx());
    const body = textOf(r.content);
    expect(body).toContain("(custom)");
    expect(body).toContain("Injected");
    expect(body).toContain("https://ex.com/1");
  });

  it("reports a provider failure as isError, not a crash", async () => {
    const provider: SearchProvider = {
      name: "broken",
      search: () => Promise.reject(new Error("boom")),
    };
    const tool = createWebSearchTool({ provider });
    const r = await runTool(tool, { query: "q" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toContain("boom");
  });

  it("rejects malformed input (missing query)", async () => {
    const tool = createWebSearchTool();
    await expect(tool.run({}, ctx())).rejects.toThrow(/query/i);
  });
});

describe("resolveDefaultSearchProvider", () => {
  it("returns the mock when no API key is set", () => {
    const p = resolveDefaultSearchProvider({});
    expect(p.name).toBe("mock");
  });

  it("returns a real HTTP provider when a key is present", () => {
    const p = resolveDefaultSearchProvider({ TAVILY_API_KEY: "secret-key" } as NodeJS.ProcessEnv);
    expect(p.name).toBe("http");
  });
});

describe("createHttpSearchProvider (Tavily-compatible, mocked endpoint)", () => {
  let server: Server;
  let endpoint = "";
  let lastBody = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastBody = raw;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              { title: "R1", url: "https://a.example.com", content: "snippet one", score: 0.9 },
              { title: "R2", url: "https://b.example.com", content: "snippet two", score: 0.7 },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${addr.port}/search`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("posts the query + api key and parses results", async () => {
    const provider = createHttpSearchProvider({ apiKey: "k-123", endpoint });
    const results = await provider.search("hello", { maxResults: 2 }, ctx());
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: "R1", url: "https://a.example.com", score: 0.9 });
    const parsed = JSON.parse(lastBody) as { api_key: string; query: string; max_results: number };
    expect(parsed.api_key).toBe("k-123");
    expect(parsed.query).toBe("hello");
    expect(parsed.max_results).toBe(2);
  });
});
