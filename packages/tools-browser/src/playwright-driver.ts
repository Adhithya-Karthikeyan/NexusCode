/**
 * Playwright-backed BrowserDriver — the REAL driver for production.
 *
 * Playwright is an OPTIONAL LAZY dependency: it is NOT a hard dependency of this
 * package, so `npm install` stays lean and the build never fails on it. We load
 * it with a dynamic `import()` inside `launch()` and FEATURE-DETECT at call
 * time; when the package (or a browser binary) is absent, `launch()` throws
 * `BrowserUnavailableError`, which the tools turn into a clean isError result.
 *
 * The dynamic specifier is held in a variable so the TypeScript compiler does
 * not try to statically resolve `"playwright"` (which is intentionally not
 * installed here) — that keeps this package type-checking and building without
 * the heavy dependency present.
 */

import {
  BrowserUnavailableError,
  NoActivePageError,
  type BrowserDriver,
  type ClickOptions,
  type NavigateOptions,
  type NavResult,
  type ScreenshotOptions,
  type ScreenshotResult,
} from "./driver.js";

/** The minimal slice of Playwright's surface this driver actually uses. */
interface PwLocator {
  innerText(opts?: { timeout?: number }): Promise<string>;
  innerHTML(opts?: { timeout?: number }): Promise<string>;
  click(opts?: { timeout?: number }): Promise<void>;
  screenshot(opts?: { timeout?: number }): Promise<Buffer | Uint8Array>;
}
interface PwResponse {
  status(): number;
}
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<PwResponse | null>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  innerText(selector: string, opts?: { timeout?: number }): Promise<string>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  locator(selector: string): PwLocator;
  screenshot(opts?: { fullPage?: boolean; timeout?: number }): Promise<Buffer | Uint8Array>;
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowserType {
  launch(opts?: { headless?: boolean }): Promise<PwBrowser>;
}
interface PwModule {
  chromium: PwBrowserType;
}

/** Which Playwright browser engine to launch. */
export type PlaywrightEngine = "chromium" | "firefox" | "webkit";

export interface PlaywrightDriverOptions {
  /** Browser engine to launch. Default "chromium". */
  engine?: PlaywrightEngine;
  /** Launch headless. Default true. */
  headless?: boolean;
}

/** Coerce Playwright's `Buffer | Uint8Array` screenshot return into a Node Buffer. */
function toBuffer(bytes: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

export class PlaywrightDriver implements BrowserDriver {
  readonly name = "playwright";

  private readonly engine: PlaywrightEngine;
  private readonly headless: boolean;
  private browser: PwBrowser | undefined;
  private page: PwPage | undefined;

  constructor(opts: PlaywrightDriverOptions = {}) {
    this.engine = opts.engine ?? "chromium";
    this.headless = opts.headless ?? true;
  }

  async launch(_signal: AbortSignal): Promise<void> {
    if (this.page) return;
    // Variable specifier: keeps the compiler from statically resolving the
    // (intentionally uninstalled) optional dependency.
    const specifier = "playwright";
    let mod: PwModule;
    try {
      mod = (await import(specifier)) as unknown as PwModule;
    } catch {
      throw new BrowserUnavailableError(
        "playwright not installed — run `npm i playwright` (and `npx playwright install`) to enable browser tools",
      );
    }
    const engine = (mod as unknown as Record<string, PwBrowserType | undefined>)[this.engine];
    if (!engine || typeof engine.launch !== "function") {
      throw new BrowserUnavailableError(
        `playwright engine "${this.engine}" unavailable — run \`npx playwright install ${this.engine}\``,
      );
    }
    try {
      this.browser = await engine.launch({ headless: this.headless });
      this.page = await this.browser.newPage();
    } catch (err) {
      throw new BrowserUnavailableError(
        `playwright failed to launch a browser (is a browser binary installed? run \`npx playwright install\`): ${(err as Error).message}`,
      );
    }
  }

  private requirePage(): PwPage {
    if (!this.page) throw new NoActivePageError();
    return this.page;
  }

  async navigate(url: string, opts: NavigateOptions, signal: AbortSignal): Promise<NavResult> {
    await this.launch(signal);
    const page = this.requirePage();
    const gotoOpts: { waitUntil?: string; timeout?: number } = {};
    if (opts.waitUntil !== undefined) gotoOpts.waitUntil = opts.waitUntil;
    if (opts.timeoutMs !== undefined) gotoOpts.timeout = opts.timeoutMs;
    const resp = await page.goto(url, gotoOpts);
    return {
      status: resp ? resp.status() : 0,
      url: page.url(),
      title: await page.title(),
    };
  }

  async click(selector: string, opts: ClickOptions, _signal: AbortSignal): Promise<void> {
    const page = this.requirePage();
    const clickOpts: { timeout?: number } = {};
    if (opts.timeoutMs !== undefined) clickOpts.timeout = opts.timeoutMs;
    await page.click(selector, clickOpts);
  }

  async extractText(selector: string | undefined, _signal: AbortSignal): Promise<string> {
    const page = this.requirePage();
    if (selector !== undefined) return page.locator(selector).innerText();
    return page.innerText("body");
  }

  async extractHtml(selector: string | undefined, _signal: AbortSignal): Promise<string> {
    const page = this.requirePage();
    if (selector !== undefined) return page.locator(selector).innerHTML();
    return page.content();
  }

  async screenshot(opts: ScreenshotOptions, _signal: AbortSignal): Promise<ScreenshotResult> {
    const page = this.requirePage();
    if (opts.selector !== undefined) {
      const shotOpts: { timeout?: number } = {};
      if (opts.timeoutMs !== undefined) shotOpts.timeout = opts.timeoutMs;
      const data = await page.locator(opts.selector).screenshot(shotOpts);
      return { mime: "image/png", data: toBuffer(data) };
    }
    const shotOpts: { fullPage?: boolean; timeout?: number } = {};
    if (opts.fullPage !== undefined) shotOpts.fullPage = opts.fullPage;
    if (opts.timeoutMs !== undefined) shotOpts.timeout = opts.timeoutMs;
    const data = await page.screenshot(shotOpts);
    return { mime: "image/png", data: toBuffer(data) };
  }

  currentUrl(): string {
    return this.page ? this.page.url() : "";
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.page = undefined;
    this.browser = undefined;
    if (browser) await browser.close();
  }
}

/** Construct a lazy Playwright driver. The dynamic import happens on `launch()`. */
export function createPlaywrightDriver(opts?: PlaywrightDriverOptions): BrowserDriver {
  return new PlaywrightDriver(opts);
}
