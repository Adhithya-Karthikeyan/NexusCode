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
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { initialViewState, reduceEvents, type ViewState } from "../store/viewState.js";
import { useEventStore } from "../bridge/useEventStore.js";
import { buildSlashCommands, type SlashCommandSpec } from "../chrome/commands.js";
import { Conversation } from "./Conversation.js";
import { Onboarding } from "./Onboarding.js";
import type { ProviderSelectionResult } from "../bridge/runTui.js";

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
  /** Current session id, accepted by `nexus trace <id>`. */
  traceTarget?: string;
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
  onModelChange?: (model: string, provider: string) => ProviderSelectionResult | void;
  /** Live `/provider` switch. */
  onProviderChange?: (provider: string) => ProviderSelectionResult | void;
  /** Live `/effort` switch — apply the picked reasoning effort. */
  onEffortChange?: (effort: string) => void;
  /** Whether the active provider supports reasoning (drives the `/effort` picker). */
  reasoningSupported?: boolean;
  /**
   * Live, provider-scoped reasoning-effort levels for the ACTIVE provider —
   * see `SlashCommandDeps.listEffortLevelsForProvider`'s doc. Falls back to
   * the generic `low/medium/high` names when absent.
   */
  listEffortLevelsFor?: (providerId: string) => Promise<readonly { id: string; hint?: string }[]>;
  /** `/clear` + `/new` — reset the transcript / start a new session. */
  onClearConversation?: () => void;
  onNewSession?: () => void;
  /** `/quit` — exit the TUI (defaults to Ink's app exit). */
  onQuit?: () => void;

  /**
   * Initial interaction role for `/agent`. The role is what every submitted turn
   * is dispatched with, so it decides whether the host runs a plain chat, a
   * read-only tool loop, or the autonomous (workspace-write) loop.
   */
  initialRole?: UiMode;
  /** Fully controlled role (tests); overrides internal state. */
  role?: UiMode;
  /** Notified when `/agent` changes the role. */
  onRoleChange?: (role: UiMode) => void;
}

/** The roles `/agent` offers — exactly the ones a host dispatch understands. */
const ROLE_CHOICES: readonly { id: UiMode; hint: string }[] = [
  { id: "CHAT", hint: "plain chat" },
  { id: "AGENT", hint: "read-only tools" },
  { id: "AUTOPILOT", hint: "autonomous tools (can write files)" },
];

function isRole(value: string): value is UiMode {
  return ROLE_CHOICES.some((r) => r.id === value);
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
    traceTarget,
    activeModel,
    activeProvider,
    listModelsFor,
    listEffortLevelsFor,
    onModelChange,
    onProviderChange,
    onEffortChange,
    reasoningSupported,
    onClearConversation,
    onNewSession,
    onQuit,
    initialRole,
    role: controlledRole,
    onRoleChange,
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
  const [contextMaxOverride, setContextMaxOverride] = useState<number | undefined>(undefined);
  const [reasoningOverride, setReasoningOverride] = useState<boolean | undefined>(undefined);
  const [effortOverride, setEffortOverride] = useState<string>("off");
  // The outcome of the last `/model` / `/provider` / `/effort` switch. Switch
  // receipts and rejections used to go only into `view.notifications`, which the
  // DEFAULT conversation surface never renders (the notification rail exists only
  // in the multi-pane presets) — so a rejected switch closed the picker and did
  // nothing at all, with no message anywhere. This is TUI-local view state, like
  // the theme and the overrides beside it, and it renders above the status bar.
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | undefined>(
    undefined,
  );

  const [roleState, setRoleState] = useState<UiMode>(initialRole ?? "CHAT");

  const themeId = controlledThemeId ?? themeState;
  const preset = controlledPreset ?? presetState;
  const paletteOpen = controlledPalette ?? paletteState;
  const role = controlledRole ?? roleState;

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
  const currentContextMax = contextMaxOverride ?? contextMax;
  const currentReasoningSupported = reasoningOverride ?? reasoningSupported;
  const staticView = useMemo(
    () => view ?? (events ? reduceEvents(events) : initialViewState),
    [view, events],
  );
  const getStaticView = useCallback(() => staticView, [staticView]);
  const subscribeStatic = useCallback(() => () => {}, []);
  // Keep the slash-command facts on the same live projection as the HUD. This
  // makes /context and /cost update after every usage event rather than staying
  // at their initial empty values.
  const projectedView = useSyncExternalStore(
    store?.subscribe ?? subscribeStatic,
    store?.getView ?? getStaticView,
    store?.getView ?? getStaticView,
  );
  const applyProviderSelection = (
    selection: ProviderSelectionResult | void,
    fallbackProvider: string,
    fallbackModel?: string,
  ): boolean => {
    if (selection?.accepted === false) {
      // Visible where the user is looking (above the composer) AND recorded in the
      // event log for the presets that show the notification rail.
      setNotice({ kind: "error", text: selection.reason });
      store?.append({
        t: "error",
        lane: MAIN_LANE,
        code: "switch_rejected",
        message: selection.reason,
        retryable: false,
      });
      return false;
    }
    const provider = selection?.accepted === true ? selection.provider : fallbackProvider;
    const model = selection?.accepted === true ? selection.model : fallbackModel;
    setProviderOverride(provider);
    setModelOverride(model);
    if (selection?.accepted === true) {
      setContextMaxOverride(selection.contextMax);
      setReasoningOverride(selection.reasoningSupported);
      setNotice({
        kind: "info",
        text: selection.receipt ?? `switched to ${provider}/${selection.model}`,
      });
      // NOTE: no `failover` event here. A deliberate user switch is not a
      // failure — emitting one marked the provider the user just left as
      // "degraded" in the health projection and filed the receipt under an error
      // notification. The `session` event below is the real record of the switch.
      store?.append({
        t: "session",
        id: `switch:${provider}:${selection.model}`,
        provider,
        model: selection.model,
        ts: Date.now(),
      });
    } else {
      // No host callback (static/test mounts): still tell the user what changed.
      setNotice({ kind: "info", text: model ? `switched to ${provider}/${model}` : `switched to ${provider}` });
    }
    return true;
  };
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
          const targetProvider = provider || currentProvider || "";
          try {
            const selection = onModelChange?.(model, targetProvider);
            applyProviderSelection(selection, targetProvider, model);
          } catch (error) {
            applyProviderSelection(
              {
                accepted: false,
                provider: targetProvider,
                reason: error instanceof Error ? error.message : String(error),
              },
              targetProvider,
              model,
            );
          }
        },
        providers: (providers ?? []).map((p) => ({ ...p })),
        onPickProvider: (id) => {
          try {
            const selection = onProviderChange?.(id);
            applyProviderSelection(selection, id);
          } catch (error) {
            applyProviderSelection(
              {
                accepted: false,
                provider: id,
                reason: error instanceof Error ? error.message : String(error),
              },
              id,
            );
          }
        },
        // `/agent` used to be inert: the registry supplied a default role list but
        // the shell passed no `onPickRole`, so the chosen role was discarded — and
        // every submit hard-coded "CHAT" anyway, making AGENT/AUTOPILOT
        // unreachable from this surface even though the host dispatch supports
        // them. The role now drives `onSubmit`.
        roles: ROLE_CHOICES.map((r) => ({ id: r.id, hint: r.hint })),
        currentRole: role,
        onPickRole: (id) => {
          if (!isRole(id)) return;
          setRoleState(id);
          onRoleChange?.(id);
          setNotice({
            kind: "info",
            text:
              id === "AUTOPILOT"
                ? "role: AUTOPILOT — tools may write files in this workspace"
                : `role: ${id}`,
          });
        },
        currentEffort: effortOverride,
        ...(currentReasoningSupported !== undefined
          ? { reasoningSupported: currentReasoningSupported }
          : {}),
        ...(listEffortLevelsFor
          ? {
              listEffortLevelsForProvider: (pid: string) =>
                Promise.resolve(listEffortLevelsFor(pid)).then((r) => r.map((l) => ({ ...l }))),
            }
          : {}),
        onPickEffort: (effort) => {
          setEffortOverride(effort);
          onEffortChange?.(effort);
          setNotice({ kind: "info", text: `reasoning effort: ${effort}` });
        },
        tools: (tools ?? []).map((t) => ({ ...t })),
        info: {
          contextUsed:
            projectedView.lastUsage.inputTokens + projectedView.lastUsage.outputTokens,
          ...(currentContextMax !== undefined ? { contextMax: currentContextMax } : {}),
          sessionCost: projectedView.totals.costUsd,
          runCost: projectedView.runUsd,
          ...(traceTarget ? { traceTarget } : {}),
          ...(mcpServers ? { mcpServers: mcpServers.map((s) => ({ ...s })) } : {}),
        },
        onClear: () => (onClearConversation ? onClearConversation() : resetConversation()),
        onNewSession: () => (onNewSession ? onNewSession() : resetConversation()),
        onQuit: () => (onQuit ? onQuit() : exit()),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      themeId,
      models,
      providers,
      tools,
      mcpServers,
      traceTarget,
      currentModel,
      currentProvider,
      currentContextMax,
      listModelsFor,
      listEffortLevelsFor,
      effortOverride,
      currentReasoningSupported,
      projectedView,
      role,
    ],
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
    ...(currentContextMax !== undefined ? { contextMax: currentContextMax } : {}),
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
    // The switch notice describes the state the NEXT turn will run under; once
    // that turn is submitted it has served its purpose.
    setNotice(undefined);
    if (store) {
      store.append({ t: "prompt", lane: MAIN_LANE, id: `p${promptSeq.current++}`, text });
    } else {
      setPrompts((p) => [...p, text]);
    }
    onSubmit?.(text, role);
  };
  const conversationProps = {
    // In store mode the prompt lives on the turn (marker); pass no positional
    // array so it is never double-echoed. In static mode the array drives echo.
    prompts: store ? [] : prompts,
    commands: slashCommands,
    ...(viewport ? { viewport } : {}),
    ...(currentContextMax !== undefined ? { contextMax: currentContextMax } : {}),
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(providerOverride !== undefined ? { providerOverride } : {}),
    ...(activeModel !== undefined ? { fallbackModel: activeModel } : {}),
    ...(activeProvider !== undefined ? { fallbackProvider: activeProvider } : {}),
    ...(notice ? { notice } : {}),
    // An elevated role changes what a turn is ALLOWED to do (AUTOPILOT can write
    // files), so it stays on the status bar rather than only in a transient
    // notice. CHAT is the default and adds no chrome.
    ...(role !== "CHAT" ? { role } : {}),
    ...(onSubmit ? { onSubmit: handleConversationSubmit } : {}),
    ...(onInterrupt ? { onInterrupt } : {}),
    ...(history ? { history } : {}),
    ...(now ? { now } : {}),
    inputActive: !paletteOpen,
  };

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
          <Conversation view={staticView} {...conversationProps} />
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
