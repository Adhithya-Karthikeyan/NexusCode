/**
 * In-memory FAKE BrowserDriver — the offline test double for the browser tools.
 *
 * It models a tiny world of pages keyed by URL. Navigation looks a URL up in the
 * fixture map (unknown URLs resolve to a synthetic 404); clicks either follow a
 * declared link (changing the current URL) or record the interaction; text/HTML
 * extraction and screenshots read back the current page's fixture. Nothing here
 * touches the real network, the filesystem, or a real browser — so the whole
 * browser-tool surface can be exercised deterministically and offline.
 *
 * It can also simulate the "Playwright not installed" path: set
 * `unavailable` and `launch()` throws `BrowserUnavailableError`, letting tests
 * assert the graceful degradation the real driver produces.
 */

import {
  BrowserUnavailableError,
  NoActivePageError,
  SelectorNotFoundError,
  type BrowserDriver,
  type ClickOptions,
  type NavigateOptions,
  type NavResult,
  type ScreenshotOptions,
  type ScreenshotResult,
} from "./driver.js";

/** A single fixture page in the fake world. */
export interface FakePage {
  /** HTTP status navigation to this URL should report. Default 200. */
  status?: number;
  /** Document title. Default "". */
  title?: string;
  /** Serialized HTML returned by `extractHtml()` (whole-document form). */
  html?: string;
  /** Visible text returned by `extractText()` (whole-page form). */
  text?: string;
  /**
   * Selector → outcome map used by `click()`. A string value is a URL the click
   * navigates to; `null` means the selector exists but the click is a no-op
   * (stays on the page). Selectors absent from this map are treated as
   * "not found" and make `click()` throw `SelectorNotFoundError`.
   */
  clicks?: Record<string, string | null>;
  /**
   * Per-selector text, consulted by `extractText(selector)`. Falls back to
   * `text` when the selector is not listed here.
   */
  selectorText?: Record<string, string>;
  /**
   * Per-selector HTML, consulted by `extractHtml(selector)`. Falls back to
   * `html` when the selector is not listed here.
   */
  selectorHtml?: Record<string, string>;
  /** Raw PNG bytes returned by `screenshot()`. Defaults to a 1×1 transparent PNG. */
  screenshot?: Buffer;
}

export interface FakeBrowserDriverOptions {
  /** URL → page fixture. */
  pages?: Record<string, FakePage>;
  /** When true, `launch()` throws `BrowserUnavailableError` (simulates missing Playwright). */
  unavailable?: boolean;
}

/** A 1×1 fully-transparent PNG — the default fake screenshot payload. */
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A record of one interaction the fake observed — asserted on in tests. */
export interface FakeInteraction {
  kind: "launch" | "navigate" | "click" | "extractText" | "extractHtml" | "screenshot" | "close";
  detail?: string;
}

export class FakeBrowserDriver implements BrowserDriver {
  readonly name = "fake";

  private readonly pages: Map<string, FakePage>;
  private readonly unavailable: boolean;
  private launched = false;
  private closed = false;
  private current: string | undefined;

  /** Ordered log of every interaction, for test assertions. */
  readonly interactions: FakeInteraction[] = [];

  constructor(opts: FakeBrowserDriverOptions = {}) {
    this.pages = new Map(Object.entries(opts.pages ?? {}));
    this.unavailable = opts.unavailable ?? false;
  }

  async launch(_signal: AbortSignal): Promise<void> {
    if (this.unavailable) {
      throw new BrowserUnavailableError(
        "playwright not installed — run `npm i playwright` to enable browser tools",
      );
    }
    this.launched = true;
    this.interactions.push({ kind: "launch" });
  }

  private ensureLaunched(): void {
    if (!this.launched) this.launched = true;
  }

  /** Record an interaction, omitting `detail` when it is undefined (exactOptional-safe). */
  private record(kind: FakeInteraction["kind"], detail?: string): void {
    this.interactions.push(detail === undefined ? { kind } : { kind, detail });
  }

  private page(): FakePage {
    if (this.current === undefined) throw new NoActivePageError();
    return this.pages.get(this.current) ?? {};
  }

  async navigate(url: string, _opts: NavigateOptions, _signal: AbortSignal): Promise<NavResult> {
    this.ensureLaunched();
    this.interactions.push({ kind: "navigate", detail: url });
    const fixture = this.pages.get(url);
    this.current = url;
    if (!fixture) {
      return { status: 404, url, title: "" };
    }
    return {
      status: fixture.status ?? 200,
      url,
      title: fixture.title ?? "",
    };
  }

  async click(selector: string, _opts: ClickOptions, _signal: AbortSignal): Promise<void> {
    const page = this.page();
    this.interactions.push({ kind: "click", detail: selector });
    const target = page.clicks?.[selector];
    if (target === undefined) {
      throw new SelectorNotFoundError(selector);
    }
    if (target !== null) {
      // Clicking a link navigates the page.
      this.current = target;
    }
  }

  async extractText(selector: string | undefined, _signal: AbortSignal): Promise<string> {
    const page = this.page();
    this.record("extractText", selector);
    if (selector !== undefined) {
      const v = page.selectorText?.[selector];
      if (v === undefined) throw new SelectorNotFoundError(selector);
      return v;
    }
    return page.text ?? "";
  }

  async extractHtml(selector: string | undefined, _signal: AbortSignal): Promise<string> {
    const page = this.page();
    this.record("extractHtml", selector);
    if (selector !== undefined) {
      const v = page.selectorHtml?.[selector];
      if (v === undefined) throw new SelectorNotFoundError(selector);
      return v;
    }
    return page.html ?? "";
  }

  async screenshot(opts: ScreenshotOptions, _signal: AbortSignal): Promise<ScreenshotResult> {
    const page = this.page();
    this.record("screenshot", opts.selector);
    if (opts.selector !== undefined && page.clicks?.[opts.selector] === undefined && page.selectorHtml?.[opts.selector] === undefined) {
      // Only enforce selector existence when the fixture declares selectors at all.
      if (page.clicks || page.selectorHtml) throw new SelectorNotFoundError(opts.selector);
    }
    return { mime: "image/png", data: page.screenshot ?? BLANK_PNG };
  }

  currentUrl(): string {
    return this.current ?? "";
  }

  async close(): Promise<void> {
    this.closed = true;
    this.launched = false;
    this.interactions.push({ kind: "close" });
  }

  /** Test helper: has the driver been closed? */
  isClosed(): boolean {
    return this.closed;
  }
}
