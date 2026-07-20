/**
 * Panel titles, rail summaries, and bodies (design spec §2.2). Each panel is a
 * **pure selector** over `ViewState` — it never holds state or calls the engine.
 * The foundation renders compact, real selector-driven bodies; the rich panel
 * components (DiffView, FileTree, PlanTree…) layer on in later waves without
 * changing this contract.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { StrandRow } from "../brand/StrandRow.js";
import type { Capabilities } from "../caps/capabilities.js";
import {
  selectAllFinalizedTurns,
  selectErrorCount,
  selectLiveTurn,
  selectMessageCount,
  selectModel,
  selectNotifications,
  selectRunningToolCount,
  selectToolActivity,
} from "../store/selectors.js";
import type { ViewState } from "../store/viewState.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { truncate } from "../layout/measure.js";
import { MessageView } from "../render/MessageView.js";
import type { PanelId, RenderMode } from "../layout/tree.js";

/**
 * Panel title (§2.2). Deliberately a **stable noun with no live count baked in**:
 * titles double as tab labels, and `Logs · 2 err` inside a tab strip read as two
 * separate tabs. Counts live in {@link panelRailSummary} and are rendered as a
 * dim badge beside the strip instead.
 */
export function panelTitle(panel: PanelId, _v: ViewState): string {
  switch (panel) {
    case "conversation":
      return "Conversation";
    case "explorer":
      return "Files";
    case "tool_activity":
      return "Tools";
    case "plan":
      return "Plan";
    case "git_diff":
      return "Diff";
    case "logs":
      return "Logs";
    case "tasks":
      return "Tasks";
    case "notifications":
      return "Alerts";
    case "model_info":
      return "Model";
    case "hud":
      return "HUD";
  }
}

/**
 * 1-line rail summary — shown when a panel is collapsed (§2.2 "Collapsed rail")
 * and as the dim count badge beside a dock's tab strip.
 *
 * A zero is deliberately rendered as *nothing*: a permanent `0 err` / `0 notes`
 * is noise that trains the eye to ignore the very field that matters when it
 * finally becomes non-zero.
 */
export function panelRailSummary(panel: PanelId, v: ViewState): string {
  const plural = (n: number, one: string, many = `${one}s`): string =>
    n === 0 ? "" : `${n} ${n === 1 ? one : many}`;
  switch (panel) {
    case "conversation":
      return plural(selectMessageCount(v), "msg");
    case "tool_activity":
      return selectRunningToolCount(v) > 0 ? `${selectRunningToolCount(v)} running` : "";
    case "logs":
      return plural(selectErrorCount(v), "err", "err");
    case "notifications":
      return plural(selectNotifications(v).length, "note");
    case "model_info":
      return selectModel(v).model;
    default:
      return "";
  }
}

function Empty({ label }: { label: string }): React.JSX.Element {
  const style = useTextStyle("text.muted");
  const caps = useCaps();
  return (
    <Text {...style}>
      {glyph(caps, "dotHollow")} {label}
    </Text>
  );
}

/**
 * The conversation empty / first-run state (§2.2 "every panel ships empty state",
 * §8). Not a blank void and not a lone dim line: the brand strand, a calm
 * "Ready." tagline, and two example prompts so a first-run user knows what to do.
 */
function ConversationEmpty(): React.JSX.Element {
  const caps = useCaps();
  const node = useTextStyle("accent.default");
  const primary = useTextStyle("text.primary");
  const muted = useTextStyle("text.muted");
  const prompt = useTextStyle("accent.default");
  return (
    <Box flexDirection="column" paddingY={1}>
      <StrandRow />
      <Box marginTop={1}>
        <Text {...node}>{glyph(caps, "node")} </Text>
        <Text {...primary}>Ready.</Text>
        <Text {...muted}> Ask anything, or try one of these:</Text>
      </Box>
      <Text {...prompt}>  {glyph(caps, "prompt")} explain this repo</Text>
      <Text {...prompt}>  {glyph(caps, "prompt")} /plan add authentication</Text>
      <Text {...prompt}>  {glyph(caps, "prompt")} @file to attach context</Text>
    </Box>
  );
}

/**
 * The conversation panel body. It renders through the SAME `<MessageView>` the
 * conversation-first surface uses, so an answer looks identical whichever preset
 * you are in: real Markdown (headings, lists, fenced code), the provider marker
 * in the gutter, tool lines and diff summaries. Previously this printed
 * `turn.text` into a bare `<Text>`, which is why `## What changed` and raw
 * ``` fences showed up literally in every pane preset.
 */
function ConversationBody({
  v,
  mode,
  width,
}: {
  v: ViewState;
  mode: RenderMode;
  width?: number;
}): React.JSX.Element {
  const live = selectLiveTurn(v);
  const provider = v.session?.provider ?? "custom";
  // Mode A: only the in-flight tail lives here (finalized turns go to <Static>).
  // Mode B: the viewport owns everything, so show finalized turns too.
  const finalized = mode === "viewport" ? selectAllFinalizedTurns(v) : [];

  if (finalized.length === 0 && !live) return <ConversationEmpty />;

  return (
    <Box flexDirection="column">
      {finalized.map((t) => (
        <MessageView key={t.id} turn={t} provider={provider} {...(width ? { width } : {})} />
      ))}
      {live ? (
        <MessageView turn={live} provider={provider} streaming {...(width ? { width } : {})} />
      ) : null}
    </Box>
  );
}

function ToolActivityBody({ v, width }: { v: ViewState; width?: number }): React.JSX.Element {
  const caps = useCaps();
  const ok = useTextStyle("success.fg");
  const err = useTextStyle("error.fg");
  const run = useTextStyle("accent.default");
  const tools = selectToolActivity(v);
  if (tools.length === 0) return <Empty label="no tool calls" />;
  return (
    <Box flexDirection="column">
      {tools.slice(-6).map((t) => {
        const style = t.status === "ok" ? ok : t.status === "error" ? err : run;
        const mark =
          t.status === "ok" ? glyph(caps, "ok") : t.status === "error" ? glyph(caps, "error") : glyph(caps, "running");
        return (
          <Text key={t.id} {...style} wrap="truncate-end">
            {mark} {width ? truncate(t.name, width - 2, caps.unicode) : t.name}
          </Text>
        );
      })}
    </Box>
  );
}

function NotificationsBody({ v, width }: { v: ViewState; width?: number }): React.JSX.Element {
  const caps = useCaps();
  const warn = useTextStyle("warning.fg");
  const err = useTextStyle("error.fg");
  const notes = selectNotifications(v);
  if (notes.length === 0) return <Empty label="all clear" />;
  return (
    <Box flexDirection="column">
      {notes.slice(-4).map((n, i) => (
        <Text key={`${n.ts}-${i}`} {...(n.kind === "error" ? err : warn)} wrap="truncate-end">
          {n.kind === "error" ? glyph(caps, "error") : glyph(caps, "warn")}{" "}
          {width ? truncate(n.title, width - 2, caps.unicode) : n.title}
        </Text>
      ))}
    </Box>
  );
}

function ModelBody({ v, width }: { v: ViewState; width?: number }): React.JSX.Element {
  const caps = useCaps();
  const primary = useTextStyle("text.primary");
  const muted = useTextStyle("text.muted");
  const providerStyle = useTextStyle(providerToken(selectModel(v).provider));
  const { model, provider } = selectModel(v);
  return (
    <Box flexDirection="column">
      <Text {...primary} wrap="truncate-end">
        {width ? truncate(model, width, caps.unicode) : model}
      </Text>
      <Text wrap="truncate-end">
        <Text {...providerStyle}>
          {glyph(caps, "dotFilled")}
          {providerLetter(provider)}
        </Text>
        <Text {...muted}> {provider}</Text>
      </Text>
    </Box>
  );
}

/**
 * Render a panel body from the view. Pure selector → ReactNode (§2.2).
 * `width` is the pane's usable text column (border + padding already removed);
 * bodies wrap and truncate against it so nothing widens its own frame.
 */
export function PanelBody({
  panel,
  v,
  mode,
  width,
}: {
  panel: PanelId;
  v: ViewState;
  mode: RenderMode;
  width?: number;
}): React.JSX.Element {
  switch (panel) {
    case "conversation":
      return <ConversationBody v={v} mode={mode} {...(width ? { width } : {})} />;
    case "tool_activity":
      return <ToolActivityBody v={v} {...(width ? { width } : {})} />;
    case "notifications":
      return <NotificationsBody v={v} {...(width ? { width } : {})} />;
    case "model_info":
      return <ModelBody v={v} {...(width ? { width } : {})} />;
    case "explorer":
      return <Empty label="no files tracked" />;
    case "plan":
      return <Empty label="no plan" />;
    case "git_diff":
      return <Empty label="no changes" />;
    case "logs":
      return <Empty label="no logs" />;
    case "tasks":
      return <Empty label="no tasks" />;
    case "hud":
      return <Empty label="hud" />;
  }
}

/** Whether a panel is essential (never auto-collapses under pressure, §2.6). */
export function isEssentialPanel(panel: PanelId, _caps: Capabilities): boolean {
  return panel === "conversation" || panel === "hud";
}
