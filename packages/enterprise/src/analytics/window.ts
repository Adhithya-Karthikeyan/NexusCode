/**
 * Time-window bucketing (UTC). A timestamp maps to a stable, sortable bucket
 * label: `YYYY-MM-DD` for day, ISO-week `YYYY-Www` for week, `YYYY-MM` for month.
 * All boundaries are UTC so aggregation is deterministic regardless of host tz.
 */

import type { TimeWindow } from "./types.js";

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Map a ms timestamp to its bucket label for the given window. */
export function bucketOf(ts: number, window: TimeWindow): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (window === "month") return `${y}-${pad(m)}`;
  if (window === "week") return isoWeekLabel(d);
  return `${y}-${pad(m)}-${pad(day)}`;
}

/** ISO-8601 week label (`YYYY-Www`) computed in UTC. */
function isoWeekLabel(date: Date): string {
  // Copy to a UTC-midnight date at the given day.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO week day: Monday=1 … Sunday=7.
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Shift to the Thursday of this week — the year of that Thursday is the ISO year.
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}
