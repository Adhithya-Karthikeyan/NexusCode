import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusError } from "@nexuscode/shared";
import { PermissionGate, type Tool, type ToolContext, type ToolResult } from "@nexuscode/tools";
import {
  createBrowserTools,
  getSession,
  FakeBrowserDriver,
  BrowserSession,
  createPlaywrightDriver,
  type FakePage,
} from "@nexuscode/tools-browser";

/**
 * Every test drives the in-memory FakeBrowserDriver — no real browser, no
 * network, no Playwright. The fake models a tiny world of pages so we can assert
 * navigate/click/extract/screenshot behavior deterministically and offline.
 */

const PAGES: Record<string, FakePage> = {
  "https://example.com/": {
    status: 200,
    title: "Example Domain",
    text: "Example Domain. This domain is for use in illustrative examples.",
    html: "<html><body><h1>Example Domain</h1><a id='more' href='/more'>More</a></body></html>",
    clicks: { "#more": "https://example.com/more", "#noop": null },
    selectorText: { "h1": "Example Domain" },
    selectorHtml: { "h1": "<h1>Example Domain</h1>" },
  },
  "https://example.com/more": {
    status: 200,
    title: "More",
    text: "More info here.",
    html: "<html><body><p>More info here.</p></body></html>",
    clicks: {},
  },
  "https://example.com/boom": {
    status: 500,
    title: "Error",
    text: "server error",
  },
};

let workspace: string;

function ctx(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, cwd: workspace };
}

function tool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function run(t: Tool, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const out = await t.run(input, ctx(signal));
  // These tools are all batch (Promise<ToolResult>), never streaming.
  return out as ToolResult;
}

function firstText(res: ToolResult): string {
  const b = res.content.find((c) => c.type === "text");
  return b && b.type === "text" ? b.text : "";
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "nexus-browser-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("@nexuscode/tools-browser — factory & contract", () => {
  it("exposes exactly the four tools with the network permission class", () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver() });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "browser_click",
      "browser_extract",
      "browser_navigate",
      "browser_screenshot",
    ]);
    for (const t of tools) {
      expect(t.permission).toBe("network");
      expect(typeof t.timeoutMs).toBe("number");
      expect(t.parameters).toMatchObject({ type: "object" });
      expect(typeof t.description).toBe("string");
    }
  });

  it("attaches the shared BrowserSession to the returned array", () => {
    const driver = new FakeBrowserDriver();
    const tools = createBrowserTools({ driver });
    const session = getSession(tools);
    expect(session).toBeInstanceOf(BrowserSession);
  });
});

describe("browser_navigate", () => {
  it("navigates to a known page and reports status/title", async () => {
    const driver = new FakeBrowserDriver({ pages: PAGES });
    const tools = createBrowserTools({ driver });
    const res = await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    expect(res.ok).toBe(true);
    expect(firstText(res)).toContain("status 200");
    expect(firstText(res)).toContain("Example Domain");
    expect(driver.currentUrl()).toBe("https://example.com/");
    expect(driver.interactions.some((i) => i.kind === "launch")).toBe(true);
  });

  it("marks a 5xx navigation as an error result", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    const res = await run(tool(tools, "browser_navigate"), { url: "https://example.com/boom" });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("status 500");
  });

  it("rejects malformed input by throwing NexusError(invalid_argument)", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    await expect(run(tool(tools, "browser_navigate"), {})).rejects.toBeInstanceOf(NexusError);
    await expect(run(tool(tools, "browser_navigate"), { url: 42 })).rejects.toBeInstanceOf(NexusError);
    await expect(
      run(tool(tools, "browser_navigate"), { url: "https://x/", waitUntil: "whenever" }),
    ).rejects.toBeInstanceOf(NexusError);
  });
});

describe("browser_navigate — SSRF guard", () => {
  it("blocks loopback 127.0.0.1 and never reaches the driver", async () => {
    const driver = new FakeBrowserDriver({ pages: PAGES });
    const tools = createBrowserTools({ driver });
    const res = await run(tool(tools, "browser_navigate"), { url: "http://127.0.0.1/" });
    expect(res.isError).toBe(true);
    expect(firstText(res).toLowerCase()).toContain("blocked");
    // The guard rejects before the session ever resolves/launches the driver.
    expect(driver.interactions).toEqual([]);
  });

  it("blocks the cloud metadata address 169.254.169.254 and never reaches the driver", async () => {
    const driver = new FakeBrowserDriver({ pages: PAGES });
    const tools = createBrowserTools({ driver });
    const res = await run(tool(tools, "browser_navigate"), {
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(res.isError).toBe(true);
    expect(firstText(res).toLowerCase()).toContain("blocked");
    expect(driver.interactions).toEqual([]);
  });

  it("passes a normal public URL through the guard and reaches the fake driver", async () => {
    const driver = new FakeBrowserDriver({ pages: PAGES });
    const tools = createBrowserTools({ driver });
    const res = await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    expect(res.ok).toBe(true);
    expect(driver.interactions.some((i) => i.kind === "navigate" && i.detail === "https://example.com/")).toBe(
      true,
    );
  });

  it("permits an allowlisted internal host when configured", async () => {
    const driver = new FakeBrowserDriver({
      pages: { "http://127.0.0.1:9999/internal": { status: 200, title: "internal" } },
    });
    const tools = createBrowserTools({ driver, ssrf: { allowlist: ["127.0.0.1"] } });
    const res = await run(tool(tools, "browser_navigate"), { url: "http://127.0.0.1:9999/internal" });
    expect(res.ok).toBe(true);
    expect(
      driver.interactions.some((i) => i.kind === "navigate" && i.detail === "http://127.0.0.1:9999/internal"),
    ).toBe(true);
  });
});

describe("browser_click", () => {
  it("clicks a link and follows the resulting navigation", async () => {
    const driver = new FakeBrowserDriver({ pages: PAGES });
    const tools = createBrowserTools({ driver });
    await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    const res = await run(tool(tools, "browser_click"), { selector: "#more" });
    expect(res.ok).toBe(true);
    expect(driver.currentUrl()).toBe("https://example.com/more");
    expect(firstText(res)).toContain("https://example.com/more");
  });

  it("returns a graceful error when the selector is not found", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    const res = await run(tool(tools, "browser_click"), { selector: "#ghost" });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("selector not found");
  });

  it("returns a graceful error when clicking before any navigation", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    const res = await run(tool(tools, "browser_click"), { selector: "#more" });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("browser_navigate first");
  });
});

describe("browser_extract", () => {
  it("extracts whole-page text by default", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    const res = await run(tool(tools, "browser_extract"), {});
    expect(res.ok).toBe(true);
    expect(firstText(res)).toContain("illustrative examples");
  });

  it("extracts HTML for a selector", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    const res = await run(tool(tools, "browser_extract"), { format: "html", selector: "h1" });
    expect(res.ok).toBe(true);
    expect(firstText(res)).toBe("<h1>Example Domain</h1>");
  });

  it("truncates output past maxBytes and marks it", async () => {
    const big = "x".repeat(5000);
    // A public IP literal (Google public DNS) rather than a fictional hostname:
    // the SSRF guard classifies IP literals synchronously with no DNS lookup, so
    // this test fixture stays fully offline/deterministic.
    const tools = createBrowserTools({
      driver: new FakeBrowserDriver({ pages: { "https://8.8.8.8/": { text: big } } }),
    });
    await run(tool(tools, "browser_navigate"), { url: "https://8.8.8.8/" });
    const res = await run(tool(tools, "browser_extract"), { maxBytes: 100 });
    expect(res.ok).toBe(true);
    expect(firstText(res).length).toBe(100);
    expect(res.content.some((c) => c.type === "text" && c.text.includes("truncated"))).toBe(true);
  });
});

describe("browser_screenshot", () => {
  it("returns a PNG image block inline", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    const res = await run(tool(tools, "browser_screenshot"), {});
    expect(res.ok).toBe(true);
    const img = res.content.find((c) => c.type === "image");
    expect(img && img.type === "image" ? img.mime : "").toBe("image/png");
    expect(img && img.type === "image" && typeof img.data === "string" ? img.data.length : 0).toBeGreaterThan(0);
  });

  it("saves the screenshot to a workspace-confined path", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    // A public IP literal — see the maxBytes test above for why (SSRF guard
    // skips DNS for IP literals, keeping this fully offline/deterministic).
    const tools = createBrowserTools({
      driver: new FakeBrowserDriver({ pages: { "https://8.8.4.4/": { screenshot: png } } }),
    });
    await run(tool(tools, "browser_navigate"), { url: "https://8.8.4.4/" });
    const res = await run(tool(tools, "browser_screenshot"), { path: "shots/page.png" });
    expect(res.ok).toBe(true);
    const saved = await readFile(join(workspace, "shots/page.png"));
    expect(saved.equals(png)).toBe(true);
  });

  it("refuses to write a screenshot outside the workspace", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    await expect(
      run(tool(tools, "browser_screenshot"), { path: "../escape.png" }),
    ).rejects.toBeInstanceOf(NexusError);
  });

  it("refuses a screenshot larger than the byte cap", async () => {
    const huge = Buffer.alloc(2048, 1);
    // A public IP literal — see the maxBytes test above for why (SSRF guard
    // skips DNS for IP literals, keeping this fully offline/deterministic).
    const tools = createBrowserTools({
      driver: new FakeBrowserDriver({ pages: { "https://1.1.1.1/": { screenshot: huge } } }),
      maxScreenshotBytes: 1024,
    });
    await run(tool(tools, "browser_navigate"), { url: "https://1.1.1.1/" });
    const res = await run(tool(tools, "browser_screenshot"), {});
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("too large");
  });
});

describe("graceful degradation — Playwright not installed", () => {
  it("returns a clean isError result (never crashes) when the driver is unavailable", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ unavailable: true }) });
    const res = await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("playwright not installed");
  });

  it("the real Playwright driver factory is lazy and reports absence gracefully", async () => {
    // Playwright is NOT a dependency here, so the default driver's launch() must
    // surface BrowserUnavailableError, which the tool turns into an isError result.
    const tools = createBrowserTools({ driverFactory: () => createPlaywrightDriver() });
    const res = await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    expect(res.isError).toBe(true);
    expect(firstText(res).toLowerCase()).toContain("playwright");
  });
});

describe("cancellation & timeout", () => {
  it("aborts when the context signal is already aborted", async () => {
    // A driver whose navigate hangs forever, so only the abort can settle it.
    const hanging = new FakeBrowserDriver({ pages: PAGES });
    hanging.navigate = () => new Promise(() => {});
    const tools = createBrowserTools({ driver: hanging });
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    const res = await run(tool(tools, "browser_navigate"), { url: "https://example.com/" }, ac.signal);
    expect(res.isError).toBe(true);
  });

  it("times out a hanging operation via timeoutMs", async () => {
    const hanging = new FakeBrowserDriver({ pages: PAGES });
    hanging.navigate = () => new Promise(() => {});
    const tools = createBrowserTools({ driver: hanging });
    const res = await run(tool(tools, "browser_navigate"), { url: "https://example.com/", timeoutMs: 20 });
    expect(res.isError).toBe(true);
    expect(firstText(res).toLowerCase()).toContain("timed out");
  });
});

describe("PermissionGate integration", () => {
  it("plan mode denies the network browser tools; full-access allows", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    const nav = tool(tools, "browser_navigate");

    const plan = new PermissionGate({ mode: "plan" });
    const denied = await plan.check(nav, { url: "https://example.com/" });
    expect(denied.allowed).toBe(false);

    const full = new PermissionGate({ mode: "full-access" });
    const allowed = await full.check(nav, { url: "https://example.com/" });
    expect(allowed.allowed).toBe(true);
  });

  it("workspace-write mode asks for network, honoring the approver", async () => {
    const tools = createBrowserTools({ driver: new FakeBrowserDriver({ pages: PAGES }) });
    const nav = tool(tools, "browser_navigate");
    const gate = new PermissionGate({ mode: "workspace-write", approve: async () => true });
    const d = await gate.check(nav, { url: "https://example.com/" });
    expect(d.allowed).toBe(true);
    expect(d.viaApproval).toBe(true);
  });
});

describe("session lifecycle", () => {
  it("close() closes the underlying driver", async () => {
    const driver = new FakeBrowserDriver({ pages: PAGES });
    const tools = createBrowserTools({ driver });
    await run(tool(tools, "browser_navigate"), { url: "https://example.com/" });
    await getSession(tools)!.close();
    expect(driver.isClosed()).toBe(true);
  });
});
