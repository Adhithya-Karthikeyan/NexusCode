/**
 * Session export renderers: JSON, Markdown, and a self-contained HTML page.
 * Everything here is a pure function of an already-loaded `SessionBundle`, so
 * export never touches the network or the filesystem itself — the caller decides
 * where (if anywhere) the string is written. HTML output escapes every dynamic
 * value and inlines all CSS (no external assets), so an exported page is a single
 * portable file.
 */

import { redactArgs, redactSecrets } from "@nexuscode/tools";
import type { UiEvent } from "@nexuscode/core";
import { escapeHtml, htmlDocument, renderDiff } from "./html.js";
import type { EventRow, RunSummaryRow, SessionMeta } from "./types.js";

/** Everything needed to render a session, loaded once by the store. */
export interface SessionBundle {
  meta: SessionMeta;
  events: EventRow[];
  runs: RunSummaryRow[];
  timeline: UiEvent[];
}

export type ExportFormat = "json" | "markdown" | "html";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Redact a single timeline event's dynamic text/content fields before it is
 * serialized. Structural fields (ids, lane, ts, codes, numeric counters) are
 * left untouched — only free-text content that could carry a leaked secret
 * (deltas, tool names/inputs, tool-result content, diff paths/patches, error
 * and failover messages) is scrubbed, mirroring what the Markdown/HTML
 * renderers already do per-field.
 */
function redactTimelineEvent(ev: UiEvent): UiEvent {
  switch (ev.t) {
    case "failover":
      return { ...ev, message: redactSecrets(ev.message) };
    case "text":
      return { ...ev, delta: redactSecrets(ev.delta) };
    case "reasoning":
      return { ...ev, delta: redactSecrets(ev.delta) };
    case "tool_call":
      return { ...ev, name: redactSecrets(ev.name), args: redactArgs(ev.args) };
    case "tool_result":
      return { ...ev, result: redactArgs(ev.result) };
    case "diff":
      return { ...ev, path: redactSecrets(ev.path), patch: redactSecrets(ev.patch) };
    case "approval":
      return { ...ev, detail: redactSecrets(ev.detail) };
    case "error":
      return { ...ev, message: redactSecrets(ev.message) };
    default:
      return ev;
  }
}

/** Redact a run-summary row's free-text field before it is serialized. */
function redactRunSummary(r: RunSummaryRow): RunSummaryRow {
  return { ...r, text: redactSecrets(r.text) };
}

/** Serialize the full bundle to pretty JSON (payloads redacted as strings). */
export function toJson(bundle: SessionBundle): string {
  const m = bundle.meta;
  return JSON.stringify(
    {
      session: m.name ? { ...m, name: redactSecrets(m.name) } : m,
      runs: bundle.runs.map(redactRunSummary),
      timeline: bundle.timeline.map(redactTimelineEvent),
      events: bundle.events.map((e) => ({
        seq: e.seq,
        type: e.type,
        turnId: e.turn_id,
        runId: e.run_id,
        ts: e.ts,
      })),
    },
    null,
    2,
  );
}

/** Render one timeline event as a Markdown line (dynamic text is redacted). */
function timelineLineMd(ev: UiEvent): string | null {
  switch (ev.t) {
    case "session":
      return `- **session** \`${ev.id}\` — ${ev.provider}/${ev.model}`;
    case "text":
      return ev.delta.trim() ? `- ${redactSecrets(ev.delta.trim())}` : null;
    case "reasoning":
      return null;
    case "tool_call":
      return `- **tool** \`${redactSecrets(ev.name)}\``;
    case "tool_result":
      return `- **tool result** (${ev.ok ? "ok" : "error"})`;
    case "diff":
      return `- **edit** \`${redactSecrets(ev.path)}\``;
    case "usage":
      return `- **usage** in=${ev.inputTokens} out=${ev.outputTokens} $${ev.costUsd.toFixed(6)}`;
    case "error":
      return `- **error** ${ev.code}: ${redactSecrets(ev.message)}`;
    case "done":
      return `- **done** (${ev.finishReason})`;
    default:
      return null;
  }
}

/** Render the session to Markdown. */
export function toMarkdown(bundle: SessionBundle): string {
  const m = bundle.meta;
  const lines: string[] = [];
  lines.push(`# Session ${m.name ? redactSecrets(m.name) : m.sessionId}`);
  lines.push("");
  lines.push(`- **Id:** \`${m.sessionId}\``);
  lines.push(`- **Created:** ${iso(m.createdAt)}`);
  lines.push(`- **Provider/Model:** ${m.provider ?? "-"} / ${m.model ?? "-"}`);
  lines.push(`- **Turns:** ${m.turnCount}  **Runs:** ${m.runCount}`);
  lines.push(
    `- **Tokens:** ${m.inputTokens} in / ${m.outputTokens} out  **Cost:** $${m.costUsd.toFixed(6)}`,
  );
  lines.push("");
  lines.push("## Timeline");
  lines.push("");
  for (const ev of bundle.timeline) {
    const line = timelineLineMd(ev);
    if (line) lines.push(line);
  }
  lines.push("");
  // Diffs get their own fenced sections so they stay copy-pasteable.
  const diffs = bundle.timeline.filter((e): e is Extract<UiEvent, { t: "diff" }> => e.t === "diff");
  if (diffs.length) {
    lines.push("## File changes");
    lines.push("");
    for (const d of diffs) {
      lines.push(`### ${redactSecrets(d.path)}`);
      lines.push("");
      lines.push("```diff");
      lines.push(redactSecrets(d.patch));
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

const EXPORT_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  line-height: 1.5; color: #1a1a1a; background: #fff; padding: 2rem; max-width: 60rem; margin-inline: auto; }
@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111; } }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
.meta { color: #666; font-size: .85rem; margin-bottom: 1.5rem; }
@media (prefers-color-scheme: dark) { .meta { color: #999; } }
.ev { padding: .35rem .6rem; border-left: 3px solid #ddd; margin: .3rem 0; font-size: .9rem; }
.ev.text { border-color: #4a90d9; }
.ev.tool { border-color: #b07cd0; }
.ev.err { border-color: #d95c5c; }
.ev.done { border-color: #4caf7d; }
.label { font-weight: 600; text-transform: uppercase; font-size: .7rem; letter-spacing: .04em; color: #888; margin-right: .5rem; }
pre.diff { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: .75rem 1rem;
  overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; line-height: 1.45; }
@media (prefers-color-scheme: dark) { pre.diff { background: #161b22; border-color: #30363d; } }
.diff .ln { display: block; white-space: pre; }
.diff .add { background: rgba(46,160,67,.15); }
.diff .del { background: rgba(248,81,73,.15); }
.diff .hunk { color: #8250df; }
.diff .meta { color: #888; }
h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid rgba(128,128,128,.25); padding-bottom: .3rem; }
`;

function timelineHtml(ev: UiEvent): string | null {
  switch (ev.t) {
    case "session":
      return `<div class="ev"><span class="label">session</span>${escapeHtml(
        redactSecrets(`${ev.provider}/${ev.model}`),
      )}</div>`;
    case "text":
      return ev.delta.trim()
        ? `<div class="ev text"><span class="label">text</span>${escapeHtml(redactSecrets(ev.delta.trim()))}</div>`
        : null;
    case "tool_call":
      return `<div class="ev tool"><span class="label">tool</span>${escapeHtml(redactSecrets(ev.name))}</div>`;
    case "tool_result":
      return `<div class="ev tool"><span class="label">tool result</span>${ev.ok ? "ok" : "error"}</div>`;
    case "diff":
      return `<div class="ev"><span class="label">edit</span>${escapeHtml(redactSecrets(ev.path))}</div>${renderDiff(
        redactSecrets(ev.patch),
      )}`;
    case "usage":
      return `<div class="ev"><span class="label">usage</span>${ev.inputTokens} in / ${ev.outputTokens} out · $${ev.costUsd.toFixed(
        6,
      )}</div>`;
    case "error":
      return `<div class="ev err"><span class="label">error</span>${escapeHtml(redactSecrets(`${ev.code}: ${ev.message}`))}</div>`;
    case "done":
      return `<div class="ev done"><span class="label">done</span>${escapeHtml(ev.finishReason)}</div>`;
    default:
      return null;
  }
}

/** Render the session to a self-contained HTML page. */
export function toHtml(bundle: SessionBundle): string {
  const m = bundle.meta;
  const title = m.name ? redactSecrets(m.name) : `Session ${m.sessionId}`;
  const rows = bundle.timeline
    .map(timelineHtml)
    .filter((s): s is string => s !== null)
    .join("\n");
  const body = `
<h1>${escapeHtml(title)}</h1>
<div class="meta">
  <code>${escapeHtml(m.sessionId)}</code> · ${escapeHtml(iso(m.createdAt))} ·
  ${escapeHtml(redactSecrets(`${m.provider ?? "-"}/${m.model ?? "-"}`))} ·
  ${m.turnCount} turns · $${m.costUsd.toFixed(6)}
</div>
<h2>Timeline</h2>
${rows || '<div class="ev">(no events)</div>'}
`;
  return htmlDocument({ title, style: EXPORT_STYLE, body });
}

/** Render `bundle` in the requested format. */
export function renderExport(bundle: SessionBundle, format: ExportFormat): string {
  switch (format) {
    case "json":
      return toJson(bundle);
    case "markdown":
      return toMarkdown(bundle);
    case "html":
      return toHtml(bundle);
    default:
      return toJson(bundle);
  }
}
