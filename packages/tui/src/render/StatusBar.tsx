/**
 * `<StatusBar>` — the slim, one-line status strip for the conversation view. A
 * single row that spans the full width and never wraps: the left cluster carries
 * identity + model + context + cost (`◆ NexusCode · ●A model · ctx · $cost`); the
 * right cluster carries the live health/streaming state, pushed to the right edge
 * with a flex spacer so the two never collide. To keep that promise at any width
 * (down to `MIN_TUI_COLS`):
 *  - every fixed segment (brand, provider dot, context, cost, health) sits inside
 *    its own `flexShrink={0}` box, so Ink can never silently shrink/mangle it —
 *    Ink's `<Text>` hard-codes `flexShrink: 1` on every node, so without this
 *    guard a long model id shrinks *every sibling* instead of just itself, which
 *    is what clipped the brand to "NexuCod" in the original bug.
 *  - the model id is the *only* element allowed to shrink: it's smart-shortened
 *    (strips a leading `vendor.` prefix and trailing date/version noise), hard
 *    capped (see {@link MAX_MODEL_CHARS}), and truncates (`wrap="truncate-end"`)
 *    into whatever space remains, instead of wrapping the row.
 *  - under real narrowness, the least-important segments drop whole (never
 *    partially) so brand + model + the health cluster stay intact — priority
 *    order: brand + model > cost > context > health.
 * The detailed HUD lives behind the slash commands (`/context`, `/cost`). Pure
 * selector over `ViewState`, with an optional client model/provider override (a
 * live `/model` switch) layered on top.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { selectContext, selectCost, selectModel } from "../store/selectors.js";
import type { ViewState } from "../store/viewState.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { formatTokens } from "../chrome/StatusHud.js";

export interface StatusBarProps {
  view: ViewState;
  /** Real context window (engine-owned); the bar never invents it. */
  contextMax?: number;
  /** Overall width; the bar spans it and pins the health cluster right. */
  width?: number;
  /** Client-selected model (live `/model` switch) — wins over the session model. */
  modelOverride?: string;
  /** Client-selected provider (live `/provider` switch). */
  providerOverride?: string;
  /** Model shown before the first session event (the CLI's launch model). */
  fallbackModel?: string;
  /** Provider shown before the first session event. */
  fallbackProvider?: string;
}

/** Hard cap on the visible model id so a long id can never dominate the bar. */
const MAX_MODEL_CHARS = 24;

/** Blank columns guaranteed between the left cluster and the right-hand health
 * state, so they can never render flush against each other. */
const HEALTH_GUTTER = 2;

/** A sliver reserved for the model id before optional segments (cost, context)
 * are allowed to claim space — keeps "brand + model" the top layout priority
 * even under narrowness; the model itself may still shrink further once Ink
 * lays out the row with whatever width actually remains. */
const MODEL_MIN_RESERVE = 4;

/** A leading vendor/provider prefix, e.g. `anthropic.` or `us.anthropic.`. */
const VENDOR_PREFIX_RE = /^(?:[a-z0-9]+\.)+(?=[a-z])/i;

/** Trailing date/version noise, e.g. `-20250219-v1:0-extended-thinking`. Matches
 * the first date (`-YYYYMMDD`) or version marker (`-v1`, `-v1:0`) so it (and
 * everything after it) can be dropped — rarely meaningful in a one-line bar. */
const TRAILING_NOISE_RE = /-(?:\d{8}|v\d+(?::\d+)?)\b/i;

/** Shorten a fully-qualified model id to its meaningful short name, e.g.
 * `anthropic.claude-3-7-sonnet-20250219-v1:0-extended-thinking` → `claude-3-7-sonnet`. */
function shortenModelId(model: string): string {
  const withoutPrefix = model.replace(VENDOR_PREFIX_RE, "");
  const noise = withoutPrefix.match(TRAILING_NOISE_RE);
  return noise && noise.index! > 0 ? withoutPrefix.slice(0, noise.index) : withoutPrefix;
}

/** Shorten + clip a model id to {@link MAX_MODEL_CHARS}, appending an ellipsis
 * glyph whenever content was dropped (by shortening or by the hard cap). */
function clampModel(model: string, unicode: boolean): string {
  const ell = unicode ? "…" : "...";
  const short = shortenModelId(model);
  if (short.length <= MAX_MODEL_CHARS) {
    return short === model ? short : `${short}${ell}`;
  }
  return short.slice(0, MAX_MODEL_CHARS - ell.length) + ell;
}

export function StatusBar({
  view,
  contextMax = 200000,
  width,
  modelOverride,
  providerOverride,
  fallbackModel,
  fallbackProvider,
}: StatusBarProps): React.JSX.Element {
  const caps = useCaps();
  const node = useTextStyle("accent.default");
  const brandPrimary = useTextStyle("text.primary");
  const brandAccent = useTextStyle("accent.default");
  const muted = useTextStyle("text.muted");
  const ctxStyle = useTextStyle("accent.default");
  const costStyle = useTextStyle("cost.ok");
  const streamStyle = useTextStyle("stream.cursor");

  const selected = selectModel(view);
  // Precedence: a live `/model` override → the session model (once known) → the
  // CLI's launch model → the em-dash placeholder.
  const model = modelOverride ?? (selected.model !== "—" ? selected.model : fallbackModel ?? "—");
  const provider =
    providerOverride ?? (selected.provider !== "—" ? selected.provider : fallbackProvider ?? "—");
  const providerStyle = useTextStyle(providerToken(provider === "—" ? "custom" : provider));
  const ctx = selectContext(view, contextMax);
  const { sessionUsd } = selectCost(view);
  const sep = ` ${caps.unicode ? "·" : "-"} `;

  const nodeGlyph = glyph(caps, "node");
  const shownModel = clampModel(model, caps.unicode);
  const providerLabel = provider !== "—" ? `${glyph(caps, "dotFilled")}${providerLetter(provider)} ` : "";
  const ctxLabel = `${formatTokens(ctx.used)}/${formatTokens(ctx.max)}`;
  const costLabel = `$${sessionUsd.toFixed(2)}`;
  const healthLabel = view.streaming ? `${glyph(caps, "streaming")} streaming` : `${glyph(caps, "ok")} ready`;

  // Plain-text lengths for the fixed segments, used only to decide which
  // optional segments fit — never to size what Ink actually renders (that's
  // still a real flex layout, computed below).
  const fixedLeftLen = nodeGlyph.length + 1 + "NexusCode".length + sep.length + providerLabel.length;
  const contextSegLen = sep.length + ctxLabel.length;
  const costSegLen = sep.length + costLabel.length;
  const healthSegLen = 1 + healthLabel.length;

  // Priority order: brand + model > cost > context > health (design spec). Brand
  // and model are never dropped; the optional segments drop whole — never
  // partially truncated — starting with the least important, until what's left
  // fits. Skipped entirely when no width budget is given (unconstrained render).
  //
  // `HEALTH_GUTTER` is the fix for the audit's 60-column frame, which rendered
  // `…$0.53⟳ streaming` — the right cluster is flex-end justified, so when the
  // left cluster happened to fill the row exactly the two clusters butted
  // together with no space and read as one broken word. Budgeting a mandatory
  // blank column makes the separation structural rather than incidental.
  let showContext = true;
  let showCost = true;
  let showHealth = true;
  if (width !== undefined) {
    const total = () =>
      fixedLeftLen +
      MODEL_MIN_RESERVE +
      (showContext ? contextSegLen : 0) +
      (showCost ? costSegLen : 0) +
      (showHealth ? healthSegLen + HEALTH_GUTTER : 0);
    if (total() > width) showContext = false;
    if (total() > width) showCost = false;
    if (total() > width) showHealth = false;
  }

  // The left cluster shrinks (minWidth:0) so a long model id can never push the
  // health cluster off the row. Every fixed segment sits in its own
  // `flexShrink={0}` box — Ink hard-codes `flexShrink: 1` on `<Text>`, so without
  // this guard the brand/context/cost would shrink (and corrupt) right alongside
  // the model. Only the model box (flexShrink:1, minWidth:0) gives up space, and
  // it truncates rather than wraps. The right cluster stays fixed (flexShrink:0).
  return (
    <Box {...(width ? { width } : {})}>
      <Box flexShrink={1} minWidth={0}>
        <Box flexShrink={0}>
          <Text {...node} wrap="truncate-end">
            {nodeGlyph}{" "}
          </Text>
          <Text {...brandPrimary} wrap="truncate-end">
            Nexus
          </Text>
          <Text {...brandAccent} wrap="truncate-end">
            Code
          </Text>
          <Text {...muted} wrap="truncate-end">
            {sep}
          </Text>
          {provider !== "—" ? (
            <Text {...providerStyle} wrap="truncate-end">
              {providerLabel}
            </Text>
          ) : null}
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text {...brandPrimary} wrap="truncate-end">
            {shownModel}
          </Text>
        </Box>
        {showContext ? (
          <Box flexShrink={0}>
            <Text {...muted} wrap="truncate-end">
              {sep}
            </Text>
            <Text {...ctxStyle} wrap="truncate-end">
              {ctxLabel}
            </Text>
          </Box>
        ) : null}
        {showCost ? (
          <Box flexShrink={0}>
            <Text {...muted} wrap="truncate-end">
              {sep}
            </Text>
            <Text {...costStyle} wrap="truncate-end">
              {costLabel}
            </Text>
          </Box>
        ) : null}
      </Box>
      {showHealth ? (
        <Box flexGrow={1} flexShrink={0} justifyContent="flex-end" paddingLeft={HEALTH_GUTTER}>
          {view.streaming ? (
            <Text {...streamStyle} wrap="truncate-end">
              {glyph(caps, "streaming")} streaming
            </Text>
          ) : (
            <Text {...muted} wrap="truncate-end">
              {glyph(caps, "ok")} ready
            </Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
}
