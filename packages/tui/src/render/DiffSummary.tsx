/**
 * `<DiffSummary>` — a collapsed, one-line file-edit summary for the conversation
 * view (`  ↳ edit src/x.ts  +3 −1`), expandable to the full unified diff. Collapsed
 * by default so an agentic turn with many edits stays scannable; the full
 * {@link ../components/DiffView.DiffView} renders below when `expanded`. Counts +/−
 * via the shared {@link ../components/DiffView.parseUnifiedDiff} so the summary never
 * drifts from the body. Color is never load-bearing: the `+`/`−` glyphs carry meaning.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { DiffView, parseUnifiedDiff } from "../components/DiffView.js";
import type { TurnDiff } from "../store/viewState.js";

export interface DiffSummaryProps {
  diff: TurnDiff;
  /** Expand to the full unified diff (default: collapsed summary only). */
  expanded?: boolean;
  width?: number;
}

/** Count additions / removals in a unified patch. */
export function countDiff(patch: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const l of parseUnifiedDiff(patch)) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  return { adds, dels };
}

export function DiffSummary({ diff, expanded = false }: DiffSummaryProps): React.JSX.Element {
  const caps = useCaps();
  const arrowStyle = useTextStyle("text.muted");
  const verbStyle = useTextStyle("text.secondary");
  const pathStyle = useTextStyle("text.muted");
  const addStyle = useTextStyle("diff.added.fg");
  const delStyle = useTextStyle("diff.removed.fg");
  const hintStyle = useTextStyle("text.muted");

  const { adds, dels } = countDiff(diff.patch);
  const arrow = caps.unicode ? "↳" : "->";
  const minus = caps.unicode ? "−" : "-";

  return (
    <Box flexDirection="column">
      <Box>
        <Text {...arrowStyle}>{"  "}{arrow} </Text>
        <Text {...verbStyle}>Edit </Text>
        <Text {...pathStyle}>{diff.path}</Text>
        <Text {...addStyle}> +{adds}</Text>
        <Text {...delStyle}> {minus}{dels}</Text>
        {!expanded ? <Text {...hintStyle}>  ({glyph(caps, "chevronRight")} expand)</Text> : null}
      </Box>
      {expanded ? (
        <Box marginLeft={4} flexDirection="column">
          <DiffView patch={diff.patch} showHeader={false} />
        </Box>
      ) : null}
    </Box>
  );
}
