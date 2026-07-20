/**
 * The BrowserDriver seam. Every browser tool (`browser_navigate`,
 * `browser_click`, `browser_extract`, `browser_screenshot`) talks to a
 * single, stateful `BrowserDriver` — one browser, one page, reused across the
 * whole tool group — never to Playwright directly. That indirection is what
 * makes the tools OFFLINE-VERIFIABLE: production wires in the Playwright-backed
 * driver (a real browser, an OPTIONAL LAZY dependency), while tests wire in the
 * in-memory `FakeBrowserDriver` and never launch a real browser.
 *
 * `launch()` is where the real driver performs its feature-detection: it
 * dynamically `import("playwright")` and, when the package is absent, throws
 * `BrowserUnavailableError`. The tools catch exactly that and return a clean
 * `isError` result ("playwright not installed …") — they NEVER crash.
 */

/** How far navigation waits before resolving (maps onto Playwright's waitUntil). */
export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

/** Result of a navigation: the HTTP status, the final (post-redirect) URL, page title. */
export interface NavResult {
  status: number;
  url: string;
  title: string;
}

/** Options for a navigation. */
export interface NavigateOptions {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
}

/** Options for a click. */
export interface ClickOptions {
  timeoutMs?: number;
}

/** Options for a screenshot. */
export interface ScreenshotOptions {
  /** When set, screenshot only the element matching this selector. */
  selector?: string;
  /** Capture the full scrollable page, not just the viewport. */
  fullPage?: boolean;
  timeoutMs?: number;
}

/** A captured screenshot: an image MIME type and the raw bytes. */
export interface ScreenshotResult {
  mime: string;
  data: Buffer;
}

/**
 * A stateful single-page browser session. Implementations own exactly one
 * browser + one page; the tool group holds one driver instance and drives it
 * call-by-call. All methods MUST honor the injected `AbortSignal` and reject
 * promptly when it aborts.
 */
export interface BrowserDriver {
  /** Human/audit name of the backing driver, e.g. "playwright" or "fake". */
  readonly name: string;
  /**
   * Idempotently open the browser + page. The real driver performs its
   * `import("playwright")` feature-detection here; when Playwright is missing it
   * throws {@link BrowserUnavailableError}.
   */
  launch(signal: AbortSignal): Promise<void>;
  /** Navigate the page to `url`. Implicitly launches if not yet launched. */
  navigate(url: string, opts: NavigateOptions, signal: AbortSignal): Promise<NavResult>;
  /** Click the element matching `selector` on the current page. */
  click(selector: string, opts: ClickOptions, signal: AbortSignal): Promise<void>;
  /** Extract visible text — of `selector` if given, else the whole page. */
  extractText(selector: string | undefined, signal: AbortSignal): Promise<string>;
  /** Extract serialized HTML — of `selector` if given, else the whole document. */
  extractHtml(selector: string | undefined, signal: AbortSignal): Promise<string>;
  /** Capture a PNG screenshot of the page or an element. */
  screenshot(opts: ScreenshotOptions, signal: AbortSignal): Promise<ScreenshotResult>;
  /** The current page URL (empty string before the first navigation). */
  currentUrl(): string;
  /** Close the browser and release all resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Thrown by a driver's `launch()` when its backing library cannot be loaded
 * (e.g. Playwright is not installed). The tools translate this into a graceful
 * `isError` ToolResult rather than propagating a crash.
 */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

/**
 * Thrown by a driver when an operation is attempted before a successful
 * navigation (there is no page to act on yet).
 */
export class NoActivePageError extends Error {
  constructor(message = "no active page — call browser_navigate first") {
    super(message);
    this.name = "NoActivePageError";
  }
}

/** Thrown by a driver when a selector matches no element on the current page. */
export class SelectorNotFoundError extends Error {
  constructor(selector: string) {
    super(`selector not found: ${selector}`);
    this.name = "SelectorNotFoundError";
  }
}
