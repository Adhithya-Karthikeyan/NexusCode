/**
 * `useViewport` — the terminal's live `{cols, rows}`.
 *
 * This exists because the conversation surface (the DEFAULT one, the one a real
 * user actually lands on) had no dimensions at all: it fell back to a hard-coded
 * 80 columns and never subscribed to `resize`. On a 120-column terminal the
 * transcript wrapped at 80 and the status divider drew an 80-cell rule across a
 * 120-cell screen; on a 70-column terminal every full-width row overflowed and
 * wrapped. `<Workspace>` had this logic inline and correct — it is lifted here so
 * one implementation serves both surfaces.
 *
 * Precedence: an explicit override (tests / forced size) → the real stdout →
 * the classic 80×24 floor.
 */

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface Viewport {
  cols: number;
  rows: number;
}

export const FALLBACK_VIEWPORT: Viewport = { cols: 80, rows: 24 };

export function useViewport(override?: Viewport): Viewport {
  const { stdout } = useStdout();
  const [dims, setDims] = useState<Viewport>(() => ({
    cols: override?.cols ?? stdout?.columns ?? FALLBACK_VIEWPORT.cols,
    rows: override?.rows ?? stdout?.rows ?? FALLBACK_VIEWPORT.rows,
  }));

  const overrideCols = override?.cols;
  const overrideRows = override?.rows;

  useEffect(() => {
    if (overrideCols !== undefined && overrideRows !== undefined) {
      setDims({ cols: overrideCols, rows: overrideRows });
      return;
    }
    if (!stdout) return;
    const onResize = (): void =>
      setDims({
        cols: stdout.columns ?? FALLBACK_VIEWPORT.cols,
        rows: stdout.rows ?? FALLBACK_VIEWPORT.rows,
      });
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [overrideCols, overrideRows, stdout]);

  return dims;
}
