/**
 * `<Conversation>` — the conversation-first shell (the DEFAULT surface, Claude-Code
 * style). Three stacked regions: the scrolling `<ConversationView>` transcript
 * (Static finalized turns + live streaming turn), the slim one-line `<StatusBar>`,
 * and the pinned `<ConversationInput>` composer with slash autocomplete. Pure
 * renderer over `ViewState` + client-tracked prompts; the engine stays the single
 * source of truth (§10.4-1). The old multi-pane dashboard survives as `<Workspace>`
 * under `--preset dashboard` (and agent/compare/chat) — this is not a replacement of
 * that machinery, just a cleaner default.
 */

import { Box, Text } from "ink";
import type { InterruptMode } from "../interrupt/interrupt.js";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { ConversationInput } from "../chrome/ConversationInput.js";
import type { SlashCommandSpec } from "../chrome/commands.js";
import { ConversationView } from "../render/ConversationView.js";
import { StatusBar } from "../render/StatusBar.js";
import type { ViewState } from "../store/viewState.js";

/** A thin full-width rule separating the transcript from the pinned chrome. */
function Divider({ width }: { width: number }): React.JSX.Element {
  const caps = useCaps();
  const style = useTextStyle("chrome.divider");
  const ch = caps.unicode ? "─" : "-";
  return (
    <Box width={width}>
      <Text {...style}>{ch.repeat(Math.max(0, width))}</Text>
    </Box>
  );
}

export interface ConversationProps {
  view: ViewState;
  /** Client-tracked user prompts (echoed above each turn). */
  prompts?: readonly string[];
  contextMax?: number;
  viewport?: { cols: number; rows: number };
  onSubmit?: (text: string) => void;
  onInterrupt?: (mode: InterruptMode) => void;
  history?: readonly string[];
  now?: () => number;
  /** Whether the composer captures keys (false when an overlay owns them). */
  inputActive?: boolean;
  /** Fallback notice for the empty state (e.g. mock-provider fallback). */
  fallbackNotice?: string;
  /** Slash-command registry (real data); enables the interactive menu + pickers. */
  commands?: readonly SlashCommandSpec[];
  /** Client-selected model override (live `/model` switch) shown in the status bar. */
  modelOverride?: string;
  /** Client-selected provider override (live `/provider` switch). */
  providerOverride?: string;
  /** Launch model/provider shown before the first session event. */
  fallbackModel?: string;
  fallbackProvider?: string;
}

export function Conversation({
  view,
  prompts,
  contextMax,
  viewport,
  onSubmit,
  onInterrupt,
  history,
  now,
  inputActive = true,
  fallbackNotice,
  commands,
  modelOverride,
  providerOverride,
  fallbackModel,
  fallbackProvider,
}: ConversationProps): React.JSX.Element {
  const cols = viewport?.cols ?? 80;
  return (
    <Box flexDirection="column" width={cols}>
      <ConversationView
        view={view}
        width={cols}
        {...(prompts ? { prompts } : {})}
        {...(fallbackNotice ? { fallbackNotice } : {})}
      />
      <Divider width={cols} />
      <StatusBar
        view={view}
        width={cols}
        {...(contextMax !== undefined ? { contextMax } : {})}
        {...(modelOverride !== undefined ? { modelOverride } : {})}
        {...(providerOverride !== undefined ? { providerOverride } : {})}
        {...(fallbackModel !== undefined ? { fallbackModel } : {})}
        {...(fallbackProvider !== undefined ? { fallbackProvider } : {})}
      />
      <ConversationInput
        isActive={inputActive}
        width={cols}
        {...(commands ? { commands } : {})}
        {...(onSubmit ? { onSubmit } : {})}
        {...(onInterrupt ? { onInterrupt } : {})}
        {...(history ? { history } : {})}
        {...(now ? { now } : {})}
      />
    </Box>
  );
}
