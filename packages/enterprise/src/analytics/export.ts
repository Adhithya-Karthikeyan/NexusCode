/**
 * Report exporters. `toJson` is the report verbatim; `toCsv` flattens the
 * per-row grain (one line per bucket × principal × role × provider × model) with
 * a stable header, RFC-4180 quoting, and fixed-precision cost.
 */

import type { UsageReport } from "./types.js";

const CSV_COLUMNS = [
  "bucket",
  "principal",
  "role",
  "provider",
  "model",
  "count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
] as const;

/** Pretty JSON of the whole report. */
export function toJson(report: UsageReport, pretty = true): string {
  return JSON.stringify(report, null, pretty ? 2 : 0);
}

/** CSV of the report's row grain. */
export function toCsv(report: UsageReport): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const r of report.rows) {
    const t = r.totals;
    const cells = [
      r.bucket,
      r.principal,
      r.role,
      r.provider,
      r.model,
      String(t.count),
      String(t.inputTokens),
      String(t.outputTokens),
      String(t.cacheReadTokens),
      String(t.cacheWriteTokens),
      String(t.reasoningTokens),
      t.costUsd.toFixed(6),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Quote a CSV cell when it contains a comma, quote, or newline (RFC 4180). */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
