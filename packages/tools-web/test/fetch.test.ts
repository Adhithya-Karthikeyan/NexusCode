import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { webFetchTool, type FetchedPage, fetchPage, BlockedUrlError, MAX_REDIRECTS } from "../src/index.js";
import { runTool, type ToolContext } from "@nexuscode/tools";

const HTML_PAGE = `<!doctype html>
<html>
<head><title>Sample &amp; Title</title><style>.x{color:red}</style></head>
<body>
  <nav>skip me</nav>
  <script>console.log("secret")</script>
  <main>
    <h1>Hello World</h1>
    <p>First paragraph with &lt;entities&gt; &amp; text.</p>
    <p>Second paragraph.</p>
    <a href="/next">next link</a>
    <a href="https://other.example.com/x">offsite</a>
  </main>
</body>
</html>`;

let server: Server;
let base = "";

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
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(100_000));
    } else if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    } else if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      }, 500);
    } else if (req.url === "/notfound") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    } else if (req.url === "/redirect") {
      // A legitimate same-host redirect the guard should follow.
      res.writeHead(302, { location: "/page" });
      res.end("redirecting");
    } else if (req.url === "/redirect-scheme") {
      // 30x pointing at a non-http(s) scheme — must be rejected on the hop even
      // when allowPrivate is set (scheme block precedes the allowPrivate opt-in).
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end("redirecting");
    } else if (req.url === "/redirect-loop") {
      // Endless redirect chain — must trip the MAX_REDIRECTS cap.
      res.writeHead(302, { location: "/redirect-loop" });
      res.end("looping");
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><p>fallback</p></body></html>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("web_fetch", () => {
  it("has the frozen Tool contract shape (network permission)", () => {
    expect(webFetchTool.name).toBe("web_fetch");
    expect(webFetchTool.permission).toBe("network");
    expect(webFetchTool.timeoutMs).toBeGreaterThan(0);
    expect(webFetchTool.parameters).toMatchObject({ type: "object", required: ["url"] });
  });

  it("extracts readable text and the title from an HTML page", async () => {
    const r = await runTool(webFetchTool, { url: `${base}/page`, allowPrivateHosts: true }, ctx());
    expect(r.ok).toBe(true);
    const body = textOf(r.content);
    expect(body).toContain("Title: Sample & Title");
    expect(body).toContain("Hello World");
    expect(body).toContain("First paragraph with <entities> & text.");
    expect(body).toContain("Second paragraph.");
    // script/style/nav content is stripped
    expect(body).not.toContain("secret");
    expect(body).not.toContain("color:red");
  });

  it("blocks a loopback URL by default (SSRF guard)", async () => {
    const r = await runTool(webFetchTool, { url: `${base}/page` }, ctx());
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/blocked/i);
  });

  it("enforces the response byte cap and marks truncation", async () => {
    const page: FetchedPage = await fetchPage(
      `${base}/big`,
      { allowPrivate: true, maxBytes: 1000 },
      new AbortController().signal,
    );
    expect(page.truncated).toBe(true);
    expect(page.bytes).toBe(1000);
    expect(page.text.length).toBe(1000);
  });

  it("returns raw text for non-HTML content types", async () => {
    const page = await fetchPage(`${base}/json`, { allowPrivate: true }, new AbortController().signal);
    expect(page.text).toContain('"hello"');
    expect(page.title).toBeUndefined();
  });

  it("surfaces an HTTP error status as isError but does not crash", async () => {
    const r = await runTool(webFetchTool, { url: `${base}/notfound`, allowPrivateHosts: true }, ctx());
    expect(r.ok).toBe(false);
    expect(textOf(r.content)).toContain("Status: 404");
  });

  it("follows a legitimate redirect and reports the final URL", async () => {
    const page = await fetchPage(
      `${base}/redirect`,
      { allowPrivate: true },
      new AbortController().signal,
    );
    expect(page.ok).toBe(true);
    expect(page.finalUrl).toMatch(/\/page$/);
    expect(page.text).toContain("Hello World");
  });

  it("re-applies the SSRF guard on each redirect hop (blocks a non-http target)", async () => {
    // Even with allowPrivate, a redirect to a file: scheme must be rejected —
    // proving the guard runs on the hop rather than being delegated to undici.
    await expect(
      fetchPage(`${base}/redirect-scheme`, { allowPrivate: true }, new AbortController().signal),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("caps the redirect chain at MAX_REDIRECTS", async () => {
    await expect(
      fetchPage(`${base}/redirect-loop`, { allowPrivate: true }, new AbortController().signal),
    ).rejects.toThrowError(new RegExp(`too many redirects`, "i"));
    expect(MAX_REDIRECTS).toBeGreaterThan(0);
  });

  it("aborts a slow request past its timeout", async () => {
    const r = await runTool(
      webFetchTool,
      { url: `${base}/slow`, allowPrivateHosts: true, timeoutMs: 50 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/failed|cancelled/i);
  });

  it("rejects malformed input (missing url) with an argument error", async () => {
    await expect(webFetchTool.run({}, ctx())).rejects.toThrow(/url/i);
  });
});
