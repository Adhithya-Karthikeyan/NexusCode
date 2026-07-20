/**
 * `<App>` — the interactive TUI shell (task A). It composes the pure-renderer
 * `<Workspace>` with the runtime affordances the foundation left to the app layer:
 *
 *  - a **theme switcher** — cycle/select the 6 signature palettes at runtime
 *    (`Ctrl+T` cycles; the palette selects by name). Theme state lives here, above
 *    `<ThemeProvider>`, so a swap is a client-only re-render (§4.1).
 *  - the **command palette** overlay (`Ctrl+P`) — the discoverability spine; its
 *    actions are the same theme/preset intents the keys expose (no orphan features).
 *  - **layout-preset switching** (`Ctrl+L`) across chat / agent / compare / dashboard.
 *  - the **first-run onboarding** wizard (§8) gating the workspace on first launch.
 *
 * The engine stays the single source of truth: `<App>` holds only *client* view
 * state (theme id, active preset, palette open, onboarding step) — never engine
 * state. A live `store` (from `runTui`) or a static `events`/`view` (tests) feeds
 * the renderer. Every piece of runtime state is also controllable via props so the
 * whole shell is headless-testable without raw-mode keystrokes.
 */

import { Box, useApp, useInput, useStdin } from "ink";
import { useMemo, useRef, useState } from "react";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_LIST,
  DEFAULT_THEME_ID,
  nexusNoir,
  type NexusTheme,
} from "@nexuscode/theme";
import { CapabilityProvider } from "../caps/CapabilityProvider.js";
import type { Capabilities } from "../caps/capabilities.js";
import type { InterruptMode } from "../interrupt/interrupt.js";
import type { UiMode } from "../chrome/mode.js";
import { CommandPalette, type PaletteAction } from "../components/CommandPalette.js";
import { FOUNDATION_PRESETS } from "../layout/presets.js";
import type { PresetId } from "../layout/tree.js";
import { Workspace } from "../layout/Workspace.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import type { EventStore } from "../store/store.js";
import { MAIN_LANE, type UiEvent } from "../store/events.js";
import { reduceEvents, type ViewState } from "../store/viewState.js";
import { useEventStore } from "../bridge/useEventStore.js";
import { buildSlashCommands, type SlashCommandSpec } from "../chrome/commands.js";
import { Conversation } from "./Conversation.js";
import { Onboarding } from "./Onboarding.js";

/** A provider→model pair for the `/model` picker (real registry data). */
export interface ModelChoice {
  provider: string;
  model: string;
  hint?: string;
}

export interface AppProps {
  /** Live event store (from `runTui`); wins over `events`/`view`. */
  store?: EventStore;
  /** Static event log (tests). */
  events?: readonly UiEvent[];
  /** Pre-derived view (tests). */
  view?: ViewState;

  caps?: Partial<Capabilities>;
  viewport?: { cols: number; rows: number };
  sessionName?: string;
  contextMax?: number;
  onSubmit?: (text: string, mode: UiMode) => void;
  onInterrupt?: (mode: InterruptMode) => void;
  history?: readonly string[];
  now?: () => number;

  // --- Theme (client-only, §4.1).
  initialThemeId?: string;
  /** Fully controlled theme id (tests); overrides internal state. */
  themeId?: string;
  onThemeChange?: (id: string) => void;

  // --- Layout preset.
  initialPreset?: PresetId;
  /** Fully controlled preset (tests). */
  preset?: PresetId;

  // --- Command palette overlay.
  /** Fully controlled open state (tests). */
  paletteOpen?: boolean;

  // --- Onboarding.
  /** Show the first-run wizard. Controlled; default false (workspace shown). */
  showOnboarding?: boolean;
  onOnboardingComplete?: (firstPrompt?: string) => void;

  // --- Slash-command registry data (real provider/tool data, engine-owned).
  /** Every provider→model pair for the `/model` picker. */
  models?: readonly ModelChoice[];
  /** Installed providers for the `/provider` picker. */
  providers?: readonly { id: string; hint?: string }[];
  /** Registered tools for the `/tools` list. */
  tools?: readonly { name: string; description?: string }[];
  /** Configured MCP servers for the `/mcp` list. */
  mcpServers?: readonly { name: string; hint?: string }[];
  /** Active model/provider (defaults derived from the session). */
  activeModel?: string;
  activeProvider?: string;
  /**
   * Live model discovery for ONE provider. When present, the `/model` picker
   * queries the ACTIVE provider's REAL model list through this callback (an
   * `adapter.listModels()`-backed runtime helper), falling back to the static
   * `models` pool. Keeps the picker scoped to the active provider, never the
   * global catalog.
   */
  listModelsFor?: (providerId: string) => Promise<readonly { model: string; hint?: string }[]>;
  /** Live `/model` switch — the CLI re-points its dispatch at the new model. */
  onModelChange?: (model: string, provider: string) => void;
  /** Live `/provider` switch. */
  onProviderChange?: (provider: string) => void;
  /** Live `/effort` switch — apply the picked reasoning effort. */
  onEffortChange?: (effort: string) => void;
  /** Whether the active provider supports reasoning (drives the `/effort` picker). */
  reasoningSupported?: boolean;
  /** `/clear` + `/new` — reset the transcript / start a new session. */
  onClearConversation?: () => void;
  onNewSession?: () => void;
  /** `/quit` — exit the TUI (defaults to Ink's app exit). */
  onQuit?: () => void;
}

/** Presets the `Ctrl+L` ring cycles through (and the palette lists). */
const PRESET_RING: readonly PresetId[] = FOUNDATION_PRESETS;

function resolveTheme(id: string): NexusTheme {
  return BUILTIN_THEMES[id] ?? nexusNoir;
}

/** Subscribe a live store into the tree, then render the workspace. */
function StoreWorkspace({
  store,
  ...rest
}: { store: EventStore } & Omit<React.ComponentProps<typeof Workspace>, "view" | "events">): React.JSX.Element {
  const view = useEventStore(store);
  return <Workspace view={view} {...rest} />;
}

/** Subscribe a live store into the tree, then render the conversation shell. */
function StoreConversation({
  store,
  ...rest
}: { store: EventStore } & Omit<React.ComponentProps<typeof Conversation>, "view">): React.JSX.Element {
  const view = useEventStore(store);
  return <Conversation view={view} {...rest} />;
}

export function App(props: AppProps): React.JSX.Element {
  const {
    store,
    events,
    view,
    caps,
    viewport,
    sessionName,
    contextMax,
    onSubmit,
    onInterrupt,
    history,
    now,
    initialThemeId,
    themeId: controlledThemeId,
    onThemeChange,
    initialPreset,
    preset: controlledPreset,
    paletteOpen: controlledPalette,
    showOnboarding = false,
    onOnboardingComplete,
    models,
    providers,
    tools,
    mcpServers,
    activeModel,
    activeProvider,
    listModelsFor,
    onModelChange,
    onProviderChange,
    onEffortChange,
    reasoningSupported,
    onClearConversation,
    onNewSession,
    onQuit,
  } = props;

  const { exit } = useApp();

  const [themeState, setThemeState] = useState(initialThemeId ?? DEFAULT_THEME_ID);
  const [presetState, setPresetState] = useState<PresetId>(initialPreset ?? "conversation");
  const [paletteState, setPaletteState] = useState(false);
  // Client-tracked user prompts (the engine UiEvent stream carries only the
  // assistant side); the conversation shell echoes these above each turn.
  const [prompts, setPrompts] = useState<readonly string[]>([]);
  // Live model/provider overrides from `/model` + `/provider` (client-only view
  // state; the CLI mirrors the switch into its dispatch via `onModelChange`).
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [providerOverride, setProviderOverride] = useState<string | undefined>(undefined);
  const [effortOverride, setEffortOverride] = useState<string>("off");

  const themeId = controlledThemeId ?? themeState;
  const preset = controlledPreset ?? presetState;
  const paletteOpen = controlledPalette ?? paletteState;

  const theme = useMemo(() => resolveTheme(themeId), [themeId]);

  const setTheme = (id: string): void => {
    setThemeState(id);
    onThemeChange?.(id);
  };
  const cycleTheme = (): void => {
    const i = BUILTIN_THEME_LIST.findIndex((t) => t.meta.id === themeId);
    const next = BUILTIN_THEME_LIST[(i + 1) % BUILTIN_THEME_LIST.length]!;
    setTheme(next.meta.id);
  };
  const cyclePreset = (): void => {
    const i = PRESET_RING.indexOf(preset);
    setPresetState(PRESET_RING[(i + 1) % PRESET_RING.length]!);
  };

  // Palette actions: the same theme/preset intents the keys expose (§6.5).
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const themes = BUILTIN_THEME_LIST.map((t) => ({
      id: `theme:${t.meta.id}`,
      title: `theme: ${t.meta.name}`,
      subtitle: t.meta.mode === "light" ? "light" : "dark",
      group: "theme",
      keywords: [t.meta.id, "palette", "color"],
      run: () => setTheme(t.meta.id),
    }));
    const presets = PRESET_RING.map((p) => ({
      id: `layout:${p}`,
      title: `layout: ${p}`,
      subtitle: "switch preset",
      group: "layout",
      keywords: ["preset", "pane"],
      run: () => setPresetState(p),
    }));
    return [...presets, ...themes];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId]);

  // Reset intents shared by `/clear` and `/new`: drop the live store + client echo.
  const resetConversation = (): void => {
    store?.reset();
    setPrompts([]);
    promptSeq.current = 0;
  };

  // The slash-command registry, built from REAL data (theme list + injected
  // provider/tool data). Its actions only touch TUI-local/session state or emit
  // the same client intents the keymap already exposes (the engine stays SoT).
  const currentModel = modelOverride ?? activeModel;
  const currentProvider = providerOverride ?? activeProvider;
  const slashCommands = useMemo<SlashCommandSpec[]>(
    () =>
      buildSlashCommands({
        themes: BUILTIN_THEME_LIST.map((t) => {
          const swatch = BUILTIN_THEMES[t.meta.id]?.tokens["accent.default"];
          return {
            id: t.meta.id,
            name: t.meta.name,
            mode: t.meta.mode,
            ...(typeof swatch === "string" ? { swatch } : {}),
          };
        }),
        currentThemeId: themeId,
        onPickTheme: setTheme,
        models: (models ?? []).map((m) => ({ ...m })),
        ...(currentModel !== undefined ? { currentModel } : {}),
        ...(currentProvider !== undefined ? { currentProvider } : {}),
        ...(listModelsFor
          ? { listModelsForProvider: (pid: string) => Promise.resolve(listModelsFor(pid)).then((r) => r.map((m) => ({ ...m }))) }
          : {}),
        onPickModel: (model, provider) => {
          setModelOverride(model);
          if (provider) setProviderOverride(provider);
          onModelChange?.(model, provider);
        },
        providers: (providers ?? []).map((p) => ({ ...p })),
        onPickProvider: (id) => {
          setProviderOverride(id);
          onProviderChange?.(id);
        },
        currentEffort: effortOverride,
        ...(reasoningSupported !== undefined ? { reasoningSupported } : {}),
        onPickEffort: (effort) => {
          setEffortOverride(effort);
          onEffortChange?.(effort);
        },
        tools: (tools ?? []).map((t) => ({ ...t })),
        ...(mcpServers ? { info: { mcpServers: mcpServers.map((s) => ({ ...s })) } } : {}),
        onClear: () => (onClearConversation ? onClearConversation() : resetConversation()),
        onNewSession: () => (onNewSession ? onNewSession() : resetConversation()),
        onQuit: () => (onQuit ? onQuit() : exit()),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeId, models, providers, tools, mcpServers, currentModel, currentProvider, listModelsFor, effortOverride, reasoningSupported],
  );

  // Coerce to a strict boolean: on a real non-TTY `isRawModeSupported` is
  // `undefined`, and Ink's `useInput` treats an `undefined` `isActive` as TRUE —
  // which would try to enable raw mode and throw. `=== true` keeps it inert.
  const { isRawModeSupported } = useStdin();
  const rawMode = isRawModeSupported === true;
  useInput(
    (input, key) => {
      if (key.ctrl && input === "p") {
        setPaletteState((o) => !o);
        return;
      }
      if (key.ctrl && input === "t") {
        cycleTheme();
        return;
      }
      if (key.ctrl && input === "l") {
        cyclePreset();
        return;
      }
    },
    { isActive: rawMode && !paletteOpen },
  );

  const workspaceProps = {
    preset,
    ...(viewport ? { viewport } : {}),
    ...(sessionName !== undefined ? { sessionName } : {}),
    ...(contextMax !== undefined ? { contextMax } : {}),
    ...(onSubmit ? { onSubmit } : {}),
    ...(onInterrupt ? { onInterrupt } : {}),
    ...(history ? { history } : {}),
    ...(now ? { now } : {}),
    // The input bar yields key capture to the palette overlay while it is open.
    inputActive: !paletteOpen,
  };

  // The conversation shell is the default surface. It forwards the submit to the
  // engine dispatch (§10.4-1: the engine still owns the assistant side) and makes
  // the user's prompt visible. With a live `store` we inject a `prompt` marker
  // into the SAME log BEFORE dispatch so the prompt interleaves with the assistant
  // stream and each turn carries the prompt that started it (drift-proof pairing).
  // Without a store (static-view tests) we fall back to the client-tracked
  // positional echo array.
  const isConversation = preset === "conversation";
  const promptSeq = useRef(0);
  const handleConversationSubmit = (text: string): void => {
    if (store) {
      store.append({ t: "prompt", lane: MAIN_LANE, id: `p${promptSeq.current++}`, text });
    } else {
      setPrompts((p) => [...p, text]);
    }
    onSubmit?.(text, "CHAT");
  };
  const conversationProps = {
    // In store mode the prompt lives on the turn (marker); pass no positional
    // array so it is never double-echoed. In static mode the array drives echo.
    prompts: store ? [] : prompts,
    commands: slashCommands,
    ...(viewport ? { viewport } : {}),
    ...(contextMax !== undefined ? { contextMax } : {}),
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(providerOverride !== undefined ? { providerOverride } : {}),
    ...(activeModel !== undefined ? { fallbackModel: activeModel } : {}),
    ...(activeProvider !== undefined ? { fallbackProvider: activeProvider } : {}),
    ...(onSubmit ? { onSubmit: handleConversationSubmit } : {}),
    ...(onInterrupt ? { onInterrupt } : {}),
    ...(history ? { history } : {}),
    ...(now ? { now } : {}),
    inputActive: !paletteOpen,
  };

  const staticView: ViewState | undefined = view ?? (events ? reduceEvents(events) : undefined);

  const body = showOnboarding ? (
    <Onboarding
      themes={BUILTIN_THEME_LIST.map((t) => ({ id: t.meta.id, name: t.meta.name }))}
      themeId={themeId}
      onPickTheme={setTheme}
      onComplete={(firstPrompt) => onOnboardingComplete?.(firstPrompt)}
    />
  ) : (
    <Box flexDirection="column">
      {paletteOpen ? (
        <CommandPalette
          actions={paletteActions}
          onClose={() => setPaletteState(false)}
          isActive={rawMode}
        />
      ) : null}
      {isConversation ? (
        store ? (
          <StoreConversation store={store} {...conversationProps} />
        ) : (
          <Conversation view={staticView ?? reduceEvents([])} {...conversationProps} />
        )
      ) : store ? (
        <StoreWorkspace store={store} {...workspaceProps} />
      ) : (
        <Workspace {...workspaceProps} {...(view ? { view } : {})} {...(events ? { events } : {})} />
      )}
    </Box>
  );

  return (
    <CapabilityProvider {...(caps ? { caps } : {})}>
      <ThemeProvider theme={theme}>{body}</ThemeProvider>
    </CapabilityProvider>
  );
}
