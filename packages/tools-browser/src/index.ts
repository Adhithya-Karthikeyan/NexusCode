/**
 * @nexuscode/tools-browser — browser automation as Tools (system-spec §6, Browser).
 *
 * Four tools — `browser_navigate`, `browser_click`, `browser_extract`,
 * `browser_screenshot` — each implementing the frozen `@nexuscode/tools` `Tool`
 * contract, all sharing one stateful `BrowserDriver` (one browser, one page).
 *
 * The driver is a seam. Production wires the Playwright-backed driver
 * (`createPlaywrightDriver`), where Playwright is an OPTIONAL LAZY dependency
 * loaded via a dynamic `import()` and feature-detected at call time: absent ⇒ a
 * clean isError ToolResult ("playwright not installed …"), never a crash. Tests
 * wire the in-memory `FakeBrowserDriver` and never launch a real browser.
 *
 * Register the group with `createBrowserTools()`, which returns the four
 * `Tool[]`. Permission class is `network`; `browser_screenshot` confines any
 * output path to the workspace via `resolveInWorkspace`.
 */

export type {
  BrowserDriver,
  NavResult,
  NavigateOptions,
  ClickOptions,
  ScreenshotOptions,
  ScreenshotResult,
  WaitUntil,
} from "./driver.js";
export {
  BrowserUnavailableError,
  NoActivePageError,
  SelectorNotFoundError,
} from "./driver.js";

export { FakeBrowserDriver } from "./fake-driver.js";
export type { FakePage, FakeBrowserDriverOptions, FakeInteraction } from "./fake-driver.js";

export { PlaywrightDriver, createPlaywrightDriver } from "./playwright-driver.js";
export type { PlaywrightDriverOptions, PlaywrightEngine } from "./playwright-driver.js";

export {
  createBrowserTools,
  getSession,
  BrowserSession,
  DEFAULT_NAVIGATE_TIMEOUT_MS,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
  DEFAULT_MAX_EXTRACT_BYTES,
  DEFAULT_MAX_SCREENSHOT_BYTES,
} from "./tools.js";
export type { CreateBrowserToolsOptions } from "./tools.js";

// Re-exported from `@nexuscode/tools` (the shared SSRF guard both this package
// and `@nexuscode/tools-web` reuse) so a caller configuring
// `createBrowserTools({ ssrf: … })` can import the option type from here too.
export { assertAllowedUrl, BlockedUrlError } from "@nexuscode/tools";
export type { SsrfOptions } from "@nexuscode/tools";
