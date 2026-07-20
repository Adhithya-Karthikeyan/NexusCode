import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { webCrawlTool } from "../src/index.js";
import { runTool, type ToolContext } from "@nexuscode/tools";

/**
 * A tiny site graph:
 *   /       -> links to /a, /b, and an OFFSITE absolute URL
 *   /a      -> links to /c
 *   /b      -> links to /c
 *   /c      -> leaf
 * plus /loop -> links back to / (cycle guard).
 */
let server: Server;
let base = "";

function page(title: string, links: string[]): string {
  // Anchor TEXT is generic ("go") so link URLs never leak into extracted text —
  // the crawl summary's URL lines come from the record, not the page body.
  const as = links.map((h) => `<a href="${h}">go</a>`).join("\n");
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>body of ${title}</p>${as}</main></body></html>`;
}

function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd() };
}

function textOf(content: { type: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    switch (req.url) {
      case "/":
        res.end(page("Home", ["/a", "/b", "https://offsite.example.com/x"]));
        break;
      case "/a":
        res.end(page("A", ["/c"]));
        break;
      case "/b":
        res.end(page("B", ["/c"]));
        break;
      case "/c":
        res.end(page("C", []));
        break;
      case "/loop":
        res.end(page("Loop", ["/", "/loop"]));
        break;
      default:
        res.end(page("Other", []));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("web_crawl", () => {
  it("has the frozen Tool contract shape (network permission)", () => {
    expect(webCrawlTool.name).toBe("web_crawl");
    expect(webCrawlTool.permission).toBe("network");
    expect(webCrawlTool.parameters).toMatchObject({ type: "object", required: ["url"] });
  });

  it("crawls the full same-origin graph within bounds", async () => {
    const r = await runTool(
      webCrawlTool,
      { url: `${base}/`, maxPages: 10, maxDepth: 3, allowPrivateHosts: true },
      ctx(),
    );
    expect(r.ok).toBe(true);
    const body = textOf(r.content);
    for (const p of ["/", "/a", "/b", "/c"]) {
      expect(body).toContain(`${base}${p === "/" ? "/" : p}`);
    }
    // C is reached exactly once despite two inbound links (cycle/dedupe guard).
    const cOccurrences = body.split(`${base}/c`).length - 1;
    expect(cOccurrences).toBe(1);
  });

  it("respects maxPages", async () => {
    const r = await runTool(
      webCrawlTool,
      { url: `${base}/`, maxPages: 2, maxDepth: 5, allowPrivateHosts: true },
      ctx(),
    );
    const body = textOf(r.content);
    expect(body).toContain("Crawled 2 page(s)");
    // With maxPages=2 only the seed and one of its children are fetched.
    const depthLines = body.match(/\[depth \d+\]/g) ?? [];
    expect(depthLines.length).toBe(2);
  });

  it("respects maxDepth (0 = seed only)", async () => {
    const r = await runTool(
      webCrawlTool,
      { url: `${base}/`, maxPages: 10, maxDepth: 0, allowPrivateHosts: true },
      ctx(),
    );
    const body = textOf(r.content);
    expect(body).toContain("Crawled 1 page(s)");
    expect(body).toContain(`${base}/`);
    expect(body).not.toContain(`${base}/a`);
  });

  it("stays same-origin by default (offsite links not followed)", async () => {
    const r = await runTool(
      webCrawlTool,
      { url: `${base}/`, maxPages: 10, maxDepth: 3, allowPrivateHosts: true },
      ctx(),
    );
    const body = textOf(r.content);
    expect(body).not.toContain("offsite.example.com");
  });

  it("does not loop forever on a cyclic graph", async () => {
    const r = await runTool(
      webCrawlTool,
      { url: `${base}/loop`, maxPages: 10, maxDepth: 5, allowPrivateHosts: true },
      ctx(),
    );
    expect(r.ok).toBe(true);
    // /loop -> / -> /a,/b -> /c  ==> 5 unique pages, terminates.
    const depthLines = textOf(r.content).match(/\[depth \d+\]/g) ?? [];
    expect(depthLines.length).toBeLessThanOrEqual(10);
    expect(depthLines.length).toBeGreaterThanOrEqual(2);
  });

  it("blocks the seed by default without allowPrivateHosts (SSRF guard)", async () => {
    const r = await runTool(webCrawlTool, { url: `${base}/`, maxPages: 5 }, ctx());
    expect(r.ok).toBe(false);
    expect(textOf(r.content)).toMatch(/blocked/i);
  });
});
