/**
 * @nexuscode/tui — the rich terminal UI (TUI design spec). A **pure renderer**
 * over the engine's normalized `UiEvent` stream: no panel owns state, every view
 * is a selector over one immutable event log, and the engine stays the single
 * source of truth (§10.4-1). The only TUI-local truth is the input draft.
 *
 * WAVE 2 foundation (§1, §2, §3, §10): the event-log store, the pane-tree model
 * + `<Workspace>`, both render modes (scrollback default / viewport), the
 * persistent chrome (HeaderMark / StatusHud / CommandBar / InputBox), the
 * ThemeProvider, and the non-TTY mount guard.
 */

// Store — event union, reducer, selectors, imperative store.
export * from "./store/index.js";

// Capabilities + non-TTY guard.
export {
  detectCapabilities,
  toResolveCaps,
  canMountTui,
  MIN_TUI_COLS,
  type Capabilities,
  type MountDecision,
} from "./caps/capabilities.js";
export { CapabilityProvider, useCaps } from "./caps/CapabilityProvider.js";
export { glyph, type GlyphName } from "./caps/glyphs.js";

// Theme integration.
export {
  ThemeProvider,
  useTheme,
  useToken,
  useTextStyle,
  useColor,
  attrsToInk,
  type InkTextStyle,
} from "./theme/ThemeProvider.js";
export { providerToken, providerLetter } from "./theme/providerToken.js";

// Layout — pane tree, breakpoints, focus ring, presets, viewport, components.
export * from "./layout/tree.js";
export {
  classifyWidth,
  forcesCompactHud,
  isShort,
  selectResponsiveTree,
} from "./layout/breakpoints.js";
export { deriveFocusRing, nextFocus, prevFocus, reconcileFocus } from "./layout/focusRing.js";
export { buildPreset, FOUNDATION_PRESETS } from "./layout/presets.js";
export { computeLineWindow, scrollThumb, type LineWindow, type ScrollThumb } from "./layout/viewport.js";
export {
  distribute,
  layoutTree,
  isVisible,
  rectFor,
  truncate,
  PANE_GAP,
  MIN_PANE_WIDTH,
  PANE_CHROME_X,
  PANE_CHROME_Y,
  type Rect,
  type LayoutMap,
} from "./layout/measure.js";
export { useViewport, FALLBACK_VIEWPORT } from "./layout/useViewport.js";
export { PaneFrame, type PaneFrameProps } from "./layout/PaneFrame.js";
export { Splitter, type SplitterProps } from "./layout/Splitter.js";
export { PaneSplit } from "./layout/PaneSplit.js";
export { PaneStack } from "./layout/PaneStack.js";
export { PaneRenderer, type PaneRenderContext } from "./layout/PaneRenderer.js";
export { Workspace, type WorkspaceProps } from "./layout/Workspace.js";

// Chrome.
export { HeaderMark, type HeaderMarkProps } from "./chrome/HeaderMark.js";
export { StatusHud, formatTokens, buildBar, type StatusHudProps } from "./chrome/StatusHud.js";
export { CommandBar, type CommandBarProps } from "./chrome/CommandBar.js";
export { InputBox, type InputBoxProps } from "./chrome/InputBox.js";
export { MODE_RING, nextMode, prevMode, type UiMode } from "./chrome/mode.js";

// Input model (headless-testable).
export * as buffer from "./input/buffer.js";
export {
  classifyInput,
  looksLikePaste,
  initialPasteState,
  PASTE_BURST_MS,
  type PasteState,
} from "./input/paste.js";
export {
  createHistory,
  push as pushHistory,
  older,
  newer,
  type History,
} from "./input/history.js";

// Interrupt ladder.
export {
  classifyEsc,
  classifyCtrlC,
  ESC_ESC_WINDOW_MS,
  CTRL_C_WINDOW_MS,
  type InterruptMode,
} from "./interrupt/interrupt.js";

// Render modes.
export { ScrollbackView, type ScrollbackViewProps } from "./render/ScrollbackView.js";
export { ViewportView, type ViewportViewProps } from "./render/ViewportView.js";
export { CompareView, type CompareViewProps } from "./render/CompareView.js";

// Conversation-first surface (the DEFAULT, Claude-Code style).
export { ConversationView, type ConversationViewProps } from "./render/ConversationView.js";
export { MessageView, type MessageViewProps } from "./render/MessageView.js";
export { ToolLine, summarizeTool, type ToolLineProps } from "./render/ToolLine.js";
export { DiffSummary, countDiff, type DiffSummaryProps } from "./render/DiffSummary.js";
export { StatusBar, type StatusBarProps } from "./render/StatusBar.js";
export { UserPrompt, type UserPromptProps } from "./render/UserPrompt.js";
export { ConversationInput, type ConversationInputProps } from "./chrome/ConversationInput.js";
export {
  SlashMenu,
  slashMatches,
  SLASH_COMMANDS,
  type SlashMenuProps,
  type SlashCommand,
} from "./chrome/SlashMenu.js";
// Slash-command registry + generic picker (interactive menu + pick-lists).
export {
  buildSlashCommands,
  matchCommands,
  encodeModelValue,
  decodeModelValue,
  type PickerItem,
  type SlashCommandSpec,
  type SlashCommandDeps,
} from "./chrome/commands.js";
export { Picker, filterItems, type PickerProps } from "./chrome/Picker.js";
export { CommandMenu, type CommandMenuProps } from "./chrome/CommandMenu.js";
export { Conversation, type ConversationProps } from "./app/Conversation.js";

// Brand.
export { StrandRow, type StrandRowProps } from "./brand/StrandRow.js";

// Panels (selector helpers + bodies).
export { panelTitle, panelRailSummary, PanelBody, isEssentialPanel } from "./panels/panels.js";

// Components (Wave 2b) — CommandPalette, Toast/NotificationCenter, provider/model/
// metering chips, and the width-probing Icon resolver (each in its own file, §3).
// Explicit names (never `export *`) so this never collides with the store's
// `ToolActivity` under two star re-exports.
export {
  Icon,
  ICONS,
  resolveIcon,
  stringWidth,
  ProviderHealthDot,
  staleness,
  ModelBadge,
  CostMeter,
  costTier,
  ContextGauge,
  gaugeTier,
  Toast,
  NotificationCenter,
  notificationLevel,
  CommandPalette,
  fuzzyScore,
  filterActions,
  type IconName,
  type IconProps,
  type ProviderHealthDotProps,
  type ModelBadgeProps,
  type CostMeterProps,
  type CostTier,
  type ContextGaugeProps,
  type GaugeTier,
  type ToastProps,
  type ToastLevel,
  type NotificationCenterProps,
  type CommandPaletteProps,
  type PaletteAction,
  type FuzzyMatch,
} from "./components/index.js";

// Rich component library (ToolActivity, DiffView, PlanTree/TodoList, …).
// Explicit re-export: the component value `ToolActivity` intentionally shadows
// the store's `ToolActivity` *type* (same name, different meaning) so the barrel
// is unambiguous; the store type stays importable from "./store/index.js".
export {
  ToolActivity,
  DiffView,
  parseUnifiedDiff,
  PlanTree,
  TodoList,
  planProgress,
  type ToolActivityProps,
  type ToolActivityEntry,
  type ToolStatus,
  type DiffViewProps,
  type DiffLine,
  type PlanTreeProps,
  type TodoListProps,
  type PlanItem,
  type TaskStatus,
} from "./components/index.js";

// App + mount guard.
export { TuiApp, type TuiAppProps } from "./app/TuiApp.js";
export { App, type AppProps, type ModelChoice } from "./app/App.js";
export { Onboarding, type OnboardingProps, type OnboardingThemeChoice } from "./app/Onboarding.js";
export { mountTui, type MountOptions, type MountResult } from "./app/mount.js";

// Engine bridge — the live `runTui(engine, opts)` entry + its projection.
export {
  runTui,
  runTurn,
  singleDispatch,
  streamTurnIntoStore,
  type RunTuiOptions,
  type RunTuiResult,
  type TurnDispatcher,
} from "./bridge/runTui.js";
export { chunkToUiEvents, projectLabeled, laneKey } from "./bridge/project.js";
export { useEventStore } from "./bridge/useEventStore.js";
