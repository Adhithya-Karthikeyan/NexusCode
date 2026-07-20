/**
 * The Code Receipt — NexusCode's flagship growth artifact (master plan: the
 * "private-by-default, redaction-safe, prompt → diff → passing-tests" hook). It
 * renders one coding session into a single self-contained HTML file: an OG-style
 * branded header, the originating prompt, the file diffs, and — only when a real
 * test result was observed — a "tests passed" badge.
 *
 * Two invariants are enforced structurally here:
 *   1. PRIVATE / LOCAL. `renderReceipt` produces a string; `writeReceipt` writes
 *      it to a local path and returns that path. There is no upload, publish, or
 *      any network call anywhere in this module — the file never leaves the box.
 *   2. SAFE. Every field (prompt, path, diff, test summary, model …) is run
 *      through secret redaction and then HTML-escaped, so a leaked API key in a
 *      prompt is masked and a `<script>` in a diff is inert.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "@nexuscode/tools";
import { escapeHtml, htmlDocument, renderDiff } from "./html.js";
import type { SessionMeta } from "./types.js";

/** A real, observed test/CI result. Its presence is what enables the badge. */
export interface ReceiptTestResult {
  passed: boolean;
  /** Human summary, e.g. "693 passed, 0 failed". */
  summary: string;
  /** The command that produced it, e.g. "npm test". */
  command?: string;
}

/** Everything the receipt renderer needs, already gathered from the session. */
export interface ReceiptData {
  meta: SessionMeta;
  /** The user's coding request that started the session. */
  prompt: string;
  /** File changes, newest edit per path. */
  diffs: { path: string; patch: string }[];
  /** Present only when a real test result was observed. */
  testResult?: ReceiptTestResult;
  /** Branding line for the header (default "NexusCode"). */
  brand?: string;
  /** Page/header title (default derives from the session). */
  title?: string;
}

const RECEIPT_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0d1117; color: #e6edf3; }
.wrap { max-width: 52rem; margin-inline: auto; padding: 0 1.25rem 3rem; }
.og { background: linear-gradient(135deg, #4a2fd0 0%, #7c3aed 45%, #2563eb 100%);
  color: #fff; padding: 2.5rem 2rem; border-radius: 0 0 18px 18px; margin-bottom: 2rem; }
.og .brand { font-size: .8rem; letter-spacing: .18em; text-transform: uppercase; opacity: .85; }
.og h1 { font-size: 1.9rem; margin: .4rem 0 .8rem; line-height: 1.2; }
.og .stats { display: flex; flex-wrap: wrap; gap: 1.25rem; font-size: .85rem; opacity: .95; }
.og .stats b { font-size: 1.05rem; display: block; }
.badge { display: inline-flex; align-items: center; gap: .4rem; font-weight: 700;
  padding: .35rem .8rem; border-radius: 999px; font-size: .85rem; margin-top: 1rem; }
.badge.pass { background: #1a7f37; color: #fff; }
.badge.fail { background: #b62324; color: #fff; }
section { margin: 2rem 0; }
h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; margin-bottom: .6rem; }
.prompt { background: #161b22; border: 1px solid #30363d; border-left: 3px solid #7c3aed;
  border-radius: 8px; padding: 1rem 1.25rem; white-space: pre-wrap; word-break: break-word; }
.file { margin-bottom: 1.5rem; }
.file .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem;
  background: #161b22; border: 1px solid #30363d; border-bottom: none; border-radius: 8px 8px 0 0;
  padding: .5rem .9rem; color: #58a6ff; }
pre.diff { background: #161b22; border: 1px solid #30363d; border-radius: 0 0 8px 8px; padding: .75rem 1rem;
  overflow-x: auto; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .8rem; line-height: 1.45; }
.diff .ln { display: block; white-space: pre; }
.diff .add { background: rgba(46,160,67,.18); color: #aff5b4; }
.diff .del { background: rgba(248,81,73,.18); color: #ffdcd7; }
.diff .hunk { color: #d2a8ff; }
.diff .meta { color: #8b949e; }
.testbox { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.25rem; }
.testbox .cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #8b949e; font-size: .8rem; }
.footer { color: #8b949e; font-size: .75rem; margin-top: 2.5rem; text-align: center; }
`;

function testBadge(result: ReceiptTestResult | undefined): string {
  // The badge appears ONLY when a real test result is present.
  if (!result) return "";
  const cls = result.passed ? "pass" : "fail";
  const icon = result.passed ? "✓" : "✗";
  const label = result.passed ? "Tests passed" : "Tests failed";
  return `<div class="badge ${cls}">${icon} ${escapeHtml(label)}</div>`;
}

/** Render a `ReceiptData` to a self-contained HTML string (no external assets). */
export function renderReceipt(data: ReceiptData): string {
  const brand = escapeHtml(redactSecrets(data.brand ?? "NexusCode"));
  const title = data.title ?? (data.meta.name ? redactSecrets(data.meta.name) : "Code Receipt");
  const safeTitle = escapeHtml(redactSecrets(title));
  const model = escapeHtml(redactSecrets(`${data.meta.provider ?? "-"} · ${data.meta.model ?? "-"}`));
  const created = escapeHtml(new Date(data.meta.createdAt).toISOString());

  const filesHtml = data.diffs.length
    ? data.diffs
        .map(
          (d) => `<div class="file">
  <div class="path">${escapeHtml(redactSecrets(d.path))}</div>
  ${renderDiff(redactSecrets(d.patch))}
</div>`,
        )
        .join("\n")
    : '<p style="color:#8b949e">No file changes recorded.</p>';

  const testSection = data.testResult
    ? `<section>
  <h2>Test result</h2>
  <div class="testbox">
    ${testBadge(data.testResult)}
    <div>${escapeHtml(redactSecrets(data.testResult.summary))}</div>
    ${data.testResult.command ? `<div class="cmd">$ ${escapeHtml(redactSecrets(data.testResult.command))}</div>` : ""}
  </div>
</section>`
    : "";

  const body = `<div class="og">
  <div class="brand">${brand} · Code Receipt</div>
  <h1>${safeTitle}</h1>
  <div class="stats">
    <div><b>${data.diffs.length}</b> file${data.diffs.length === 1 ? "" : "s"} changed</div>
    <div><b>${data.meta.turnCount}</b> turn${data.meta.turnCount === 1 ? "" : "s"}</div>
    <div><b>$${data.meta.costUsd.toFixed(4)}</b> cost</div>
    <div><b>${model}</b><span style="opacity:.7">${created}</span></div>
  </div>
  ${testBadge(data.testResult)}
</div>
<div class="wrap">
  <section>
    <h2>Prompt</h2>
    <div class="prompt">${escapeHtml(redactSecrets(data.prompt)) || "<em>(no prompt recorded)</em>"}</div>
  </section>
  <section>
    <h2>Changes</h2>
    ${filesHtml}
  </section>
  ${testSection}
  <div class="footer">Generated locally by ${brand}. Private by default — this file was not uploaded or shared.</div>
</div>`;

  return htmlDocument({ title: safeTitle, style: RECEIPT_STYLE, body });
}

/** Slugify a string into a safe filename fragment. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session"
  );
}

/**
 * Render and write a Code Receipt to a LOCAL file. Returns the absolute path and
 * the HTML string. No network, no upload — the receipt is private by default and
 * the caller is free to open the returned path. `outDir` defaults to the OS temp
 * dir; the wrapping `.wrap` around the header is applied inside `renderReceipt`.
 */
export function writeReceipt(
  data: ReceiptData,
  opts: { outDir?: string; fileName?: string } = {},
): { path: string; html: string } {
  const html = renderReceipt(data);
  const dir = opts.outDir ?? join(tmpdir(), "nexuscode-receipts");
  mkdirSync(dir, { recursive: true });
  const name = opts.fileName ?? `receipt-${slug(data.meta.name ?? data.meta.sessionId)}-${Date.now()}.html`;
  const path = join(dir, name);
  writeFileSync(path, html, { encoding: "utf8", mode: 0o600 });
  return { path, html };
}
