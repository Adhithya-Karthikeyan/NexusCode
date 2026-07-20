/**
 * The browser tool group: `browser_navigate`, `browser_click`,
 * `browser_extract`, `browser_screenshot`. Each implements the frozen
 * `@nexuscode/tools` `Tool` contract (name, description, JSON-Schema
 * parameters, coarse permission class, timeout, `run` → `ToolResult`).
 *
 * All four share ONE stateful `BrowserDriver` (one browser, one page) resolved
 * lazily by a `BrowserSession`. In production that driver is the
 * Playwright-backed one (an OPTIONAL LAZY dependency); in tests it is the
 * in-memory fake. When the driver cannot launch (Playwright absent) the tools
 * return a clean `isError` result — they NEVER crash.
 *
 * Permission class is `network` for the whole group (they all drive a networked
 * browser). `browser_screenshot` may additionally persist bytes to a
 * workspace-confined path via `resolveInWorkspace`; every path is confined to
 * the workspace root, so a screenshot can never be written outside it.
 *
 * `browser_navigate`'s tool-initiated target URL is SSRF-guarded via the SAME
 * `assertAllowedUrl` guard `@nexuscode/tools-web` uses (shared from
 * `@nexuscode/tools`), blocking loopback/private/link-local/cloud-metadata
 * addresses by default — otherwise an agent (or attacker-controlled page
 * content steering it) could point the browser at `http://169.254.169.254/`
 * (IMDS) or an internal service. This guards ONLY the URL we ourselves ask the
 * driver to open; an in-page client-side redirect or fetch that a real browser
 * follows afterward is the browser's own responsibility, not something this
 * Node-side guard can observe.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { NexusError } from "@nexuscode/shared";
import {
  assertAllowedUrl,
  BlockedUrlError,
  errText,
  okText,
  resolveInWorkspace,
  textBlock,
  type SsrfOptions,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@nexuscode/tools";
import {
  BrowserUnavailableError,
  NoActivePageError,
  SelectorNotFoundError,
  type BrowserDriver,
  type NavigateOptions,
  type ScreenshotOptions,
  type WaitUntil,
} from "./driver.js";
import { createPlaywrightDriver } from "./playwright-driver.js";

// ---------------------------------------------------------------------------
// Defaults & caps
// ---------------------------------------------------------------------------

export const DEFAULT_NAVIGATE_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 30_000;

/** Max bytes of extracted text/HTML returned to the model (defends context + memory). */
export const DEFAULT_MAX_EXTRACT_BYTES = 512 * 1024;
/** Hard ceiling on a screenshot payload; larger captures are refused. */
export const DEFAULT_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const WAIT_UNTIL_VALUES: readonly WaitUntil[] = ["load", "domcontentloaded", "networkidle", "commit"];

// ---------------------------------------------------------------------------
// Tiny local validators (mirror the built-in tools' throw-NexusError style)
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new NexusError("invalid_argument", msg);
}
function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("expected an object argument");
  return input as Record<string, unknown>;
}
function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) fail(`"${key}" must be a non-empty string`);
  return v;
}
function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") fail(`"${key}" must be a string`);
  return v;
}
function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`"${key}" must be a non-negative finite number`);
  return v;
}
function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") fail(`"${key}" must be a boolean`);
  return v;
}
function optEnum<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) fail(`"${key}" must be one of: ${allowed.join(", ")}`);
  return v as T;
}

// ---------------------------------------------------------------------------
// Deadline / cancellation
// ---------------------------------------------------------------------------

function reasonError(signal: AbortSignal, fallback: Error): Error {
  const r = signal.reason;
  return r instanceof Error ? r : fallback;
}

/**
 * Run `fn` under a combined deadline: it is handed a child `AbortSignal` that
 * aborts when either the parent (`ctx.signal`) aborts or `timeoutMs` elapses,
 * and the whole race rejects on that abort even if `fn` ignores the signal.
 */
async function runWithDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  const timeoutErr = new Error(`browser operation timed out after ${timeoutMs}ms`);
  const onParentAbort = () => ctrl.abort(reasonError(parent, new Error("aborted")));
  if (parent.aborted) ctrl.abort(reasonError(parent, new Error("aborted")));
  else parent.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(timeoutErr), timeoutMs);
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) => {
        if (ctrl.signal.aborted) reject(reasonError(ctrl.signal, timeoutErr));
        else ctrl.signal.addEventListener("abort", () => reject(reasonError(ctrl.signal, timeoutErr)), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParentAbort);
  }
}

// ---------------------------------------------------------------------------
// Session: one lazily-resolved, lazily-launched driver shared by the group
// ---------------------------------------------------------------------------

/** Resolves + caches the single `BrowserDriver` instance the tool group drives. */
export class BrowserSession {
  private driver: BrowserDriver | undefined;
  private resolving: Promise<BrowserDriver> | undefined;

  constructor(private readonly factory: () => BrowserDriver | Promise<BrowserDriver>) {}

  /** Resolve the driver (once) and ensure it is launched. Idempotent. */
  async ensure(signal: AbortSignal): Promise<BrowserDriver> {
    if (!this.driver) {
      this.resolving ??= Promise.resolve(this.factory());
      this.driver = await this.resolving;
    }
    await this.driver.launch(signal);
    return this.driver;
  }

  /** The resolved driver, if any (without forcing resolution). */
  peek(): BrowserDriver | undefined {
    return this.driver;
  }

  /** Close and drop the driver. */
  async close(): Promise<void> {
    const d = this.driver;
    this.driver = undefined;
    this.resolving = undefined;
    if (d) await d.close();
  }
}

/** Translate a driver-layer error into a graceful `isError` ToolResult. */
function toErrorResult(toolName: string, err: unknown): ToolResult {
  if (err instanceof BrowserUnavailableError) return errText(err.message);
  if (err instanceof NoActivePageError) return errText(err.message);
  if (err instanceof SelectorNotFoundError) return errText(err.message);
  if (err instanceof NexusError) throw err; // invalid_argument — let the loop surface it
  const msg = err instanceof Error ? err.message : String(err);
  return errText(`${toolName} failed: ${msg}`);
}

/** Truncate `text` to `maxBytes` UTF-8 bytes, appending a marker when cut. */
function capText(text: string, maxBytes: number): { text: string; truncated: boolean; total: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false, total: buf.length };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true, total: buf.length };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface CreateBrowserToolsOptions {
  /** A ready driver instance to use (highest precedence — used by tests with the fake). */
  driver?: BrowserDriver;
  /** A factory that produces the driver on first use. */
  driverFactory?: () => BrowserDriver | Promise<BrowserDriver>;
  /** Override the shared session (advanced; e.g. to share one driver across groups). */
  session?: BrowserSession;
  /** Cap on extracted text/HTML bytes. Default 512 KiB. */
  maxExtractBytes?: number;
  /** Cap on a screenshot payload in bytes. Default 8 MiB. */
  maxScreenshotBytes?: number;
  /**
   * SSRF policy applied to `browser_navigate`'s target URL (see
   * `@nexuscode/tools`'s `assertAllowedUrl`/`SsrfOptions`). Defaults to
   * blocking private/loopback/link-local/metadata targets; set `allowlist` to
   * permit specific internal hosts an operator intentionally wants reachable,
   * or `allowPrivate: true` to disable the guard entirely (not recommended).
   */
  ssrf?: SsrfOptions;
}

/**
 * Build the browser tool group. Returns the four `Tool`s so integration can
 * register them in a `ToolRegistry`. All four share one `BrowserSession`; when
 * no driver is supplied, the default is a lazy Playwright driver (which yields a
 * graceful "playwright not installed" result if the package is absent).
 *
 * The created `BrowserSession` is attached to the returned array as a
 * non-enumerable `session` property so a caller can `close()` the browser.
 */
export function createBrowserTools(opts: CreateBrowserToolsOptions = {}): Tool[] {
  const session =
    opts.session ??
    new BrowserSession(
      opts.driver ? () => opts.driver as BrowserDriver : (opts.driverFactory ?? (() => createPlaywrightDriver())),
    );
  const maxExtractBytes = opts.maxExtractBytes ?? DEFAULT_MAX_EXTRACT_BYTES;
  const maxScreenshotBytes = opts.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES;
  const ssrfOptions: SsrfOptions = opts.ssrf ?? {};

  const browserNavigate: Tool = {
    name: "browser_navigate",
    description:
      "Open a URL in the shared headless browser and report the HTTP status, final URL, and page title. " +
      "SSRF-guarded (loopback/private/link-local/cloud-metadata hosts blocked by default).",
    permission: "network",
    timeoutMs: DEFAULT_NAVIGATE_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to navigate to (http/https)." },
        waitUntil: {
          type: "string",
          enum: WAIT_UNTIL_VALUES as unknown as string[],
          description: "When to consider navigation done. Default 'load'.",
        },
        timeoutMs: { type: "number", description: `Navigation timeout in ms (default ${DEFAULT_NAVIGATE_TIMEOUT_MS}).` },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const url = reqString(o, "url");
      const waitUntil = optEnum(o, "waitUntil", WAIT_UNTIL_VALUES);
      const timeoutMs = optNumber(o, "timeoutMs") ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
      const navOpts: NavigateOptions = { timeoutMs };
      if (waitUntil !== undefined) navOpts.waitUntil = waitUntil;
      // SSRF guard on the tool-initiated navigation target — enforced BEFORE the
      // driver is even resolved/launched, so a blocked URL never reaches it. See
      // the module doc for the residual (in-page redirects are unguarded here).
      try {
        await assertAllowedUrl(url, ssrfOptions);
      } catch (err) {
        const msg = err instanceof BlockedUrlError ? err.message : err instanceof Error ? err.message : String(err);
        return errText(`browser_navigate blocked: ${msg}`);
      }
      try {
        const driver = await session.ensure(ctx.signal);
        const res = await runWithDeadline((s) => driver.navigate(url, navOpts, s), timeoutMs, ctx.signal);
        const ok = res.status === 0 || (res.status >= 200 && res.status < 400);
        const summary = `navigated to ${res.url} (status ${res.status}${res.title ? `, title: ${res.title}` : ""})`;
        return ok ? okText(summary) : { ok: false, content: [textBlock(summary)], isError: true };
      } catch (err) {
        return toErrorResult("browser_navigate", err);
      }
    },
  };

  const browserClick: Tool = {
    name: "browser_click",
    description: "Click the element matching a CSS selector on the current page, then report the resulting URL.",
    permission: "network",
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click." },
        timeoutMs: { type: "number", description: `Click timeout in ms (default ${DEFAULT_ACTION_TIMEOUT_MS}).` },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const selector = reqString(o, "selector");
      const timeoutMs = optNumber(o, "timeoutMs") ?? DEFAULT_ACTION_TIMEOUT_MS;
      try {
        const driver = await session.ensure(ctx.signal);
        await runWithDeadline((s) => driver.click(selector, { timeoutMs }, s), timeoutMs, ctx.signal);
        return okText(`clicked ${selector} (now at ${driver.currentUrl() || "unknown URL"})`);
      } catch (err) {
        return toErrorResult("browser_click", err);
      }
    },
  };

  const browserExtract: Tool = {
    name: "browser_extract",
    description: "Extract visible text or serialized HTML/DOM from the current page (optionally scoped to a selector).",
    permission: "network",
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["text", "html"], description: "What to extract. Default 'text'." },
        selector: { type: "string", description: "Optional CSS selector to scope extraction to one element." },
        maxBytes: { type: "number", description: `Cap on returned bytes (default ${DEFAULT_MAX_EXTRACT_BYTES}).` },
      },
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const format = optEnum(o, "format", ["text", "html"] as const) ?? "text";
      const selector = optString(o, "selector");
      const maxBytes = optNumber(o, "maxBytes") ?? maxExtractBytes;
      try {
        const driver = await session.ensure(ctx.signal);
        const raw = await runWithDeadline(
          (s) => (format === "html" ? driver.extractHtml(selector, s) : driver.extractText(selector, s)),
          DEFAULT_ACTION_TIMEOUT_MS,
          ctx.signal,
        );
        const capped = capText(raw, maxBytes);
        if (!capped.truncated) return okText(capped.text);
        return {
          ok: true,
          content: [
            textBlock(capped.text),
            textBlock(`\n[truncated: ${capped.total} bytes total, showed ${maxBytes}]`),
          ],
        };
      } catch (err) {
        return toErrorResult("browser_extract", err);
      }
    },
  };

  const browserScreenshot: Tool = {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the current page (or a selector). Returns the image inline; optionally saves it to a workspace-relative path.",
    permission: "network",
    timeoutMs: DEFAULT_SCREENSHOT_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional CSS selector to screenshot just that element." },
        fullPage: { type: "boolean", description: "Capture the full scrollable page. Default false." },
        path: { type: "string", description: "Optional workspace-relative path to save the PNG to." },
        timeoutMs: { type: "number", description: `Screenshot timeout in ms (default ${DEFAULT_SCREENSHOT_TIMEOUT_MS}).` },
      },
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const selector = optString(o, "selector");
      const fullPage = optBool(o, "fullPage");
      const savePath = optString(o, "path");
      const timeoutMs = optNumber(o, "timeoutMs") ?? DEFAULT_SCREENSHOT_TIMEOUT_MS;
      const shotOpts: ScreenshotOptions = { timeoutMs };
      if (selector !== undefined) shotOpts.selector = selector;
      if (fullPage !== undefined) shotOpts.fullPage = fullPage;
      try {
        const driver = await session.ensure(ctx.signal);
        const shot = await runWithDeadline((s) => driver.screenshot(shotOpts, s), timeoutMs, ctx.signal);
        if (shot.data.length > maxScreenshotBytes) {
          return errText(
            `screenshot too large: ${shot.data.length} bytes exceeds cap of ${maxScreenshotBytes}`,
          );
        }
        const content = [] as ToolResult["content"];
        if (savePath !== undefined) {
          const abs = await resolveInWorkspace(ctx.cwd, savePath);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, shot.data);
          content.push(textBlock(`saved screenshot to ${savePath} (${shot.data.length} bytes)`));
        }
        content.push({ type: "image", mime: shot.mime, data: shot.data.toString("base64") });
        return { ok: true, content };
      } catch (err) {
        return toErrorResult("browser_screenshot", err);
      }
    },
  };

  const tools = [browserNavigate, browserClick, browserExtract, browserScreenshot];
  // Attach the session non-enumerably so callers can close the browser without
  // it polluting the tool array's iteration.
  Object.defineProperty(tools, "session", { value: session, enumerable: false });
  return tools;
}

/** The `BrowserSession` attached to a `createBrowserTools(...)` result, if present. */
export function getSession(tools: Tool[]): BrowserSession | undefined {
  const s = (tools as Tool[] & { session?: unknown }).session;
  return s instanceof BrowserSession ? s : undefined;
}
