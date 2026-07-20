/**
 * `<Workspace>` — the TUI root (design spec §2.1). Owns `{cols,rows}` (via
 * `useStdout` + resize), the active preset + render mode, and the focus ring.
 * It reserves fixed rows for chrome (HeaderMark / StatusHud / CommandBar) and
 * hands the rest to the pane tree; Yoga resolves the geometry. Switching preset
 * or resizing only swaps the responsive `PaneNode` — components stay identity-
 * stable, so streaming never resets (§10.4-7). Pure renderer: the derived
 * `ViewState` is the only data source (§10.4-1).
 */

import { Box, useInput, useStdin, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandBar } from "../chrome/CommandBar.js";
import { HeaderMark } from "../chrome/HeaderMark.js";
import { nextMode, prevMode, type UiMode } from "../chrome/mode.js";
import { StatusHud } from "../chrome/StatusHud.js";
import type { InterruptMode } from "../interrupt/interrupt.js";
import { reduceEvents, type ViewState } from "../store/viewState.js";
import type { UiEvent } from "../store/events.js";
import { ScrollbackView } from "../render/ScrollbackView.js";
import { ViewportView } from "../render/ViewportView.js";
import { CompareView } from "../render/CompareView.js";
import { forcesCompactHud, isShort, selectResponsiveTree } from "./breakpoints.js";
import { deriveFocusRing, nextFocus, reconcileFocus } from "./focusRing.js";
import type { PaneRenderContext } from "./PaneRenderer.js";
import { buildPreset } from "./presets.js";
import type { LayoutPreset, PresetId } from "./tree.js";

export interface WorkspaceProps {
  /** The event log (pure-renderer input). Ignored if `view` is supplied. */
  events?: readonly UiEvent[];
  /** A pre-derived view (when the caller owns the store). Wins over `events`. */
  view?: ViewState;
  /** Layout preset (id or full object). Defaults to `chat` (Mode A). */
  preset?: PresetId | LayoutPreset;
  /** Interaction mode; controlled if `onModeChange` is provided. */
  mode?: UiMode;
  onModeChange?: (mode: UiMode) => void;
  /** Session title shown in the identity strip / header. */
  sessionName?: string;
  /** Real context window for the HUD gauge (engine-owned). */
  contextMax?: number;
  /** Explicit dimensions (tests / forced size). Falls back to `useStdout`. */
  viewport?: { cols: number; rows: number };
  /** Deliberate submit — carries the active interaction mode (drives dispatch). */
  onSubmit?: (text: string, mode: UiMode) => void;
  onInterrupt?: (mode: InterruptMode) => void;
  /** Seed input history. */
  history?: readonly string[];
  /** Injected clock for deterministic input tests. */
  now?: () => number;
  /** Whether the input bar captures keys (false when an overlay owns them). */
  inputActive?: boolean;
}

export function Workspace({
  events,
  view: viewProp,
  preset = "chat",
  mode: modeProp,
  onModeChange,
  sessionName,
  contextMax,
  viewport,
  onSubmit,
  onInterrupt,
  history,
  now,
  inputActive = true,
}: WorkspaceProps): React.JSX.Element {
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();

  // --- Dimensions: explicit override → stdout → safe default (§2.1).
  const [dims, setDims] = useState<{ cols: number; rows: number }>(() => ({
    cols: viewport?.cols ?? stdout?.columns ?? 80,
    rows: viewport?.rows ?? stdout?.rows ?? 24,
  }));
  useEffect(() => {
    if (viewport) {
      setDims({ cols: viewport.cols, rows: viewport.rows });
      return;
    }
    if (!stdout) return;
    const onResize = (): void => setDims({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [viewport, stdout]);

  // --- Derived view (single source of truth).
  const view = useMemo<ViewState>(
    () => viewProp ?? reduceEvents(events ?? []),
    [viewProp, events],
  );

  // --- Preset: build once (stable node ids), pick responsive tree by width.
  const layout = useMemo<LayoutPreset>(
    () => (typeof preset === "string" ? buildPreset(preset) : preset),
    [preset],
  );
  const tree = useMemo(() => selectResponsiveTree(layout, dims.cols), [layout, dims.cols]);

  // --- Focus ring, reconciled across resizes.
  const ring = useMemo(() => deriveFocusRing(tree), [tree]);
  const [focusedId, setFocusedId] = useState<string | null>(() => ring[0] ?? null);
  useEffect(() => {
    setFocusedId((cur) => reconcileFocus(ring, cur));
  }, [ring]);

  // --- Interaction mode (uncontrolled unless onModeChange is given).
  const [internalMode, setInternalMode] = useState<UiMode>(modeProp ?? "CHAT");
  const mode = modeProp ?? internalMode;
  const setMode = (m: UiMode): void => {
    if (onModeChange) onModeChange(m);
    else setInternalMode(m);
  };

  const collapsedRef = useRef<ReadonlySet<string>>(new Set());

  // Compare-lane focus (`1`–`4`); scroll/promote act on the focused lane (§2.9.3).
  const [focusedLane, setFocusedLane] = useState(0);

  // Composing state, bubbled up from the composer (§6.1). The input-scoped keys
  // (`Tab` panel-traverse, `1`–`4` lane-jump) belong to an outer scope ONLY while
  // the draft is empty; once composing, the input bar owns those keys (§2.7, §6.4).
  const [inputEmpty, setInputEmpty] = useState(true);

  // --- Workspace-level chords (focus/mode/lane). This is the panel + global scope
  // of the §6.1 resolver; the composer is the more-specific input scope. Active
  // only on a real TTY (headless never needs raw mode) AND only while `inputActive`
  // — so an open overlay (palette) swallows every key at the highest scope.
  useInput(
    (input, key) => {
      // Shift+Tab cycles the interaction mode from any scope (global, §6.10).
      if (key.tab && key.shift) {
        setMode(key.meta ? prevMode(mode) : nextMode(mode));
        return;
      }
      // Plain Tab traverses panels only when the input is empty + a panel is the
      // focus target (§2.7). While composing, Tab is the input scope's — not ours.
      if (key.tab) {
        if (inputEmpty) setFocusedId((cur) => nextFocus(ring, cur));
        return;
      }
      // Compare-lane jump (`1`–`4`, §2.9.3/§6.4). Reserved by this scope only while
      // the draft is empty; a digit typed mid-message stays with the composer.
      if (
        layout.id === "compare" &&
        inputEmpty &&
        !key.ctrl &&
        !key.meta &&
        /^[1-4]$/.test(input)
      ) {
        const idx = Number.parseInt(input, 10) - 1;
        if (idx >= 0 && idx < view.laneOrder.length) setFocusedLane(idx);
      }
    },
    // `=== true`: Ink treats an `undefined` `isActive` (real non-TTY) as active,
    // which would enable raw mode and throw; the strict compare keeps it inert.
    { isActive: isRawModeSupported === true && inputActive },
  );

  const renderMode = layout.renderMode;
  const short = isShort(dims.rows);
  const forceCompactHud = forcesCompactHud(
    dims.cols < 60 ? "xnarrow" : dims.cols < 100 ? "narrow" : "medium",
  ) || short;

  const ctx: PaneRenderContext = {
    view,
    focusedId,
    collapsedIds: collapsedRef.current,
    mode: renderMode,
  };

  const model = view.session?.model;
  const provider = view.session?.provider;
  const isCompare = layout.id === "compare";
  const laneCount = view.laneOrder.length;
  const headerProps = {
    mode,
    streaming: view.streaming,
    costUsd: view.totals.costUsd,
    ...(sessionName ? { session: sessionName } : {}),
    // COMPARE is a layout, not a ring mode (§6.3) — surface it in the badge and
    // show the live lane count so the header matches the §2.9.3 mockup.
    ...(isCompare ? { badgeLabel: "COMPARE" } : {}),
    ...(isCompare && laneCount > 0 ? { detail: `${laneCount} ${laneCount === 1 ? "lane" : "lanes"}` } : {}),
    // In compare each lane owns its own provider dot; the single-provider model
    // segment would be misleading, so it is omitted there.
    ...(!isCompare && model ? { model } : {}),
    ...(!isCompare && provider ? { provider } : {}),
  };

  return (
    <Box flexDirection="column" width={dims.cols} minHeight={dims.rows}>
      {renderMode === "viewport" ? (
        <>
          <HeaderMark {...headerProps} showWordmark />
          {layout.id === "compare" ? (
            <CompareView view={view} focusedLane={focusedLane} rows={dims.rows - 4} cols={dims.cols} />
          ) : (
            <ViewportView tree={tree} ctx={ctx} rows={dims.rows - 4} />
          )}
        </>
      ) : (
        <>
          <ScrollbackView view={view} tree={tree} ctx={ctx} />
          <HeaderMark {...headerProps} />
        </>
      )}
      <StatusHud view={view} cols={dims.cols} forceCompact={forceCompactHud} {...(contextMax !== undefined ? { contextMax } : {})} />
      <CommandBar
        mode={mode}
        view={view}
        isActive={inputActive}
        onComposingChange={(composing) => setInputEmpty(!composing)}
        reserveDigitsWhenEmpty={layout.id === "compare"}
        {...(onSubmit ? { onSubmit: (text: string) => onSubmit(text, mode) } : {})}
        {...(onInterrupt ? { onInterrupt } : {})}
        {...(history ? { history } : {})}
        {...(now ? { now } : {})}
      />
    </Box>
  );
}
