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
import { useTextStyle } from "../theme/ThemeProvider.js";
import type { PanelId, RenderMode } from "../layout/tree.js";

/** Dynamic panel title (with live counts, §2.2). */
export function panelTitle(panel: PanelId, v: ViewState): string {
  switch (panel) {
    case "conversation":
      return "Conversation";
    case "explorer":
      return "Files";
    case "tool_activity":
      return "Tool Activity";
    case "plan":
      return "Plan";
    case "git_diff":
      return "Git Diff";
    case "logs":
      return `Logs · ${selectErrorCount(v)} err`;
    case "tasks":
      return "Running Tasks";
    case "notifications":
      return "Notifications";
    case "model_info":
      return "Model";
    case "hud":
      return "HUD";
  }
}

/** 1-line rail summary shown when a panel is collapsed (§2.2 "Collapsed rail"). */
export function panelRailSummary(panel: PanelId, v: ViewState): string {
  switch (panel) {
    case "conversation":
      return `${selectMessageCount(v)} msgs`;
    case "tool_activity":
      return `${selectRunningToolCount(v)} running`;
    case "logs":
      return `${selectErrorCount(v)} err`;
    case "notifications":
      return `${selectNotifications(v).length} notes`;
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

function ConversationBody({ v, mode }: { v: ViewState; mode: RenderMode }): React.JSX.Element {
  const caps = useCaps();
  const textStyle = useTextStyle("stream.text");
  const thinking = useTextStyle("stream.thinking");
  const cursor = useTextStyle("stream.cursor");
  const live = selectLiveTurn(v);
  // Mode A: only the in-flight tail lives here (finalized turns go to <Static>).
  // Mode B: the viewport owns everything, so show finalized turns too.
  const finalized = mode === "viewport" ? selectAllFinalizedTurns(v) : [];

  if (finalized.length === 0 && !live) return <ConversationEmpty />;

  return (
    <Box flexDirection="column">
      {finalized.map((t) => (
        <Text key={t.id} {...textStyle}>
          {t.text || t.reasoning}
        </Text>
      ))}
      {live ? (
        <Box flexDirection="column">
          {live.reasoning ? <Text {...thinking}>⋯ {live.reasoning}</Text> : null}
          <Text {...textStyle}>
            {live.text}
            <Text {...cursor}>{glyph(caps, "streaming")}</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function ToolActivityBody({ v }: { v: ViewState }): React.JSX.Element {
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
          <Text key={t.id} {...style}>
            {mark} {t.name}
          </Text>
        );
      })}
    </Box>
  );
}

function NotificationsBody({ v }: { v: ViewState }): React.JSX.Element {
  const caps = useCaps();
  const warn = useTextStyle("warning.fg");
  const err = useTextStyle("error.fg");
  const notes = selectNotifications(v);
  if (notes.length === 0) return <Empty label="all clear" />;
  return (
    <Box flexDirection="column">
      {notes.slice(-4).map((n, i) => (
        <Text key={`${n.ts}-${i}`} {...(n.kind === "error" ? err : warn)}>
          {n.kind === "error" ? glyph(caps, "error") : glyph(caps, "warn")} {n.title}
        </Text>
      ))}
    </Box>
  );
}

function ModelBody({ v }: { v: ViewState }): React.JSX.Element {
  const caps = useCaps();
  const primary = useTextStyle("text.primary");
  const muted = useTextStyle("text.muted");
  const { model, provider } = selectModel(v);
  return (
    <Box flexDirection="column">
      <Text {...primary}>
        {glyph(caps, "dotFilled")} {model}
      </Text>
      <Text {...muted}>{provider}</Text>
    </Box>
  );
}

/** Render a panel body from the view. Pure selector → ReactNode (§2.2). */
export function PanelBody({
  panel,
  v,
  mode,
}: {
  panel: PanelId;
  v: ViewState;
  mode: RenderMode;
}): React.JSX.Element {
  switch (panel) {
    case "conversation":
      return <ConversationBody v={v} mode={mode} />;
    case "tool_activity":
      return <ToolActivityBody v={v} />;
    case "notifications":
      return <NotificationsBody v={v} />;
    case "model_info":
      return <ModelBody v={v} />;
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
