/**
 * `@nexuscode/tui` component library (design spec §3). Rich, self-contained
 * **pure renderers** — each in its own file, each `(props, theme, caps) →
 * ReactNode` over the engine's `UiEvent`-derived state. No component owns engine
 * state or fetches; the engine stays the single source of truth.
 */

export {
  ToolActivity,
  type ToolActivityProps,
  type ToolActivityEntry,
  type ToolStatus,
} from "./ToolActivity.js";

export {
  DiffView,
  parseUnifiedDiff,
  type DiffViewProps,
  type DiffLine,
} from "./DiffView.js";

export {
  PlanTree,
  TodoList,
  planProgress,
  type PlanTreeProps,
  type TodoListProps,
  type PlanItem,
  type TaskStatus,
} from "./PlanTree.js";

// --- Wave 2b: overlays, feedback, metering chips, and the Icon resolver. ---

// Glyph resolver (width-probe + ASCII downgrade).
export {
  Icon,
  ICONS,
  resolveIcon,
  stringWidth,
  type IconName,
  type IconProps,
} from "./Icon.js";

// Provider / model / metering chips.
export {
  ProviderHealthDot,
  staleness,
  type ProviderHealthDotProps,
} from "./ProviderHealthDot.js";
export { ModelBadge, type ModelBadgeProps } from "./ModelBadge.js";
export { CostMeter, costTier, type CostMeterProps, type CostTier } from "./CostMeter.js";
export {
  ContextGauge,
  gaugeTier,
  type ContextGaugeProps,
  type GaugeTier,
} from "./ContextGauge.js";

// Feedback surfaces.
export { Toast, type ToastProps, type ToastLevel } from "./Toast.js";
export {
  NotificationCenter,
  notificationLevel,
  type NotificationCenterProps,
} from "./NotificationCenter.js";

// Command palette (discoverability spine).
export {
  CommandPalette,
  fuzzyScore,
  filterActions,
  type CommandPaletteProps,
  type PaletteAction,
  type FuzzyMatch,
} from "./CommandPalette.js";

// ── Conversation content surface (StreamPane / MessageBubble / Markdown …) ──

export { motionTier, animates, useMotionTier, type MotionTier, type MotionCaps } from "./motion.js";

export { StreamingCursor, type StreamingCursorProps } from "./StreamingCursor.js";

export { TypingIndicator, type TypingIndicatorProps } from "./TypingIndicator.js";

export {
  CodeBlock,
  tokenizeLine,
  type CodeBlockProps,
  type Span,
  type SyntaxKind,
} from "./CodeBlock.js";

export {
  Markdown,
  parseMarkdown,
  parseInline,
  type MarkdownProps,
} from "./Markdown.js";

export {
  MessageBubble,
  type MessageBubbleProps,
  type MessageRole,
  type MessageTone,
} from "./MessageBubble.js";

export { StreamPane, type StreamPaneProps } from "./StreamPane.js";
