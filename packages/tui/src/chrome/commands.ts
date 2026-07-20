/**
 * Slash-command registry (task A). A single, declarative source of truth for the
 * commands the conversation shell exposes. Each command is `{ name, description,
 * optionsProvider?, action? }`: when `optionsProvider` is present, choosing the
 * command opens the generic `<Picker>` over those items and `action(value)` runs
 * with the picked value; otherwise `action()` runs immediately. The registry is
 * built from REAL data (the theme list, the provider registry's models/providers,
 * the tool registry) injected by the shell — the TUI stays a pure renderer and
 * these actions only touch TUI-local/session state (theme/model/provider) or
 * dispatch the same client intents the keymap already exposes.
 */

/** One selectable row in the generic picker. */
export interface PickerItem {
  /** Primary label shown in the list. */
  label: string;
  /** Opaque value handed back to `action` when this row is chosen. */
  value: string;
  /** Optional dim right-hand detail (e.g. context window, provider). */
  hint?: string;
  /** Optional group header this row sorts under (e.g. the provider name). */
  group?: string;
  /** Optional hex color for a small preview swatch (theme accent). */
  swatch?: string;
  /** Marks the currently-active value (highlighted with a `●`). */
  current?: boolean;
}

/** A declarative slash command. */
export interface SlashCommandSpec {
  /** Command token including the leading slash (e.g. `/model`). */
  name: string;
  /** One-line description shown in the menu. */
  description: string;
  /**
   * Supplies the pick-list when this command carries options. Its presence is
   * what makes a command open the `<Picker>`; async is allowed (the shell awaits).
   */
  optionsProvider?: () => PickerItem[] | Promise<PickerItem[]>;
  /** Runs with the chosen value (option commands) or `undefined` (plain commands). */
  action?: (value?: string) => void;
  /** Title shown atop the picker (defaults to the command name). */
  pickerTitle?: string;
  /** Subtle one-line hint shown at the foot of the picker (e.g. a related command). */
  pickerFooter?: string;
}

/** Encode/decode a `provider␁model` picker value so a model row is unambiguous. */
const MODEL_SEP = "\u0001";
export function encodeModelValue(provider: string, model: string): string {
  return `${provider}${MODEL_SEP}${model}`;
}
export function decodeModelValue(value: string): { provider: string; model: string } {
  const i = value.indexOf(MODEL_SEP);
  if (i < 0) return { provider: "", model: value };
  return { provider: value.slice(0, i), model: value.slice(i + 1) };
}

/** Real data + callbacks the shell injects to build the registry. */
export interface SlashCommandDeps {
  /** All installed themes (id/name/mode + accent swatch), for `/theme`. */
  themes: { id: string; name: string; mode: "dark" | "light"; swatch?: string }[];
  currentThemeId: string;
  onPickTheme: (id: string) => void;

  /**
   * Static provider→model pairs (the curated fallback pool). The `/model` picker
   * scopes these to the ACTIVE provider — it never dumps the global catalog.
   */
  models: { provider: string; model: string; hint?: string }[];
  currentModel?: string;
  currentProvider?: string;
  onPickModel: (model: string, provider: string) => void;
  /**
   * Live model discovery for ONE provider (the active one). When present, `/model`
   * queries the provider's REAL model list through this callback (an
   * `adapter.listModels()`-backed runtime helper) and only falls back to the
   * static `models` pool when it returns nothing or fails. Additive: omit to keep
   * the static-only behavior. The result is already scoped to `providerId`.
   */
  listModelsForProvider?: (providerId: string) => Promise<{ model: string; hint?: string }[]>;

  /** Installed providers, for `/provider`. */
  providers: { id: string; hint?: string }[];
  onPickProvider: (id: string) => void;

  /** Registered tools, for `/tools` (read-only list). */
  tools: { name: string; description?: string }[];

  /** Interaction roles, for `/agent`. */
  roles?: { id: string; hint?: string }[];
  currentRole?: string;
  onPickRole?: (id: string) => void;
  /** Current reasoning effort ("off" | "low" | "medium" | "high"), for `/effort`. */
  currentEffort?: string;
  /** Whether the ACTIVE provider supports reasoning effort (from its Capabilities). */
  reasoningSupported?: boolean;
  /** Apply a picked reasoning effort to the next turn. */
  onPickEffort?: (effort: string) => void;

  /** Live session facts surfaced by the read-only info commands. */
  info?: {
    contextUsed?: number;
    contextMax?: number;
    sessionCost?: number;
    runCost?: number;
    mcpServers?: { name: string; hint?: string }[];
  };

  onClear: () => void;
  onNewSession: () => void;
  onQuit: () => void;
}

/** Build the full slash-command registry from injected real data. */
export function buildSlashCommands(deps: SlashCommandDeps): SlashCommandSpec[] {
  const info = deps.info ?? {};
  const commands: SlashCommandSpec[] = [
    {
      name: "/model",
      description: "switch the active model",
      // Header names the provider being listed so it is unambiguous which
      // provider's models the picker is scoped to.
      pickerTitle: deps.currentProvider ? `Select model · ${deps.currentProvider}` : "Select model",
      pickerFooter: "/provider to switch provider",
      optionsProvider: async () => {
        const active = deps.currentProvider ?? "";
        // No active provider known: show NOTHING rather than falling through
        // to an unfiltered pool — that would resurrect the global cross-
        // provider catalog bug (every provider's models listed at once).
        if (!active) return [];
        // Curated fallback: the static pool scoped to the ACTIVE provider only
        // (never the global cross-provider catalog).
        const staticRows = deps.models
          .filter((m) => m.provider === active)
          .map((m) => ({ model: m.model, ...(m.hint ? { hint: m.hint } : {}) }));
        let rows = staticRows;
        // Prefer the provider's REAL model list when a live loader is wired.
        if (deps.listModelsForProvider && active) {
          try {
            const live = await deps.listModelsForProvider(active);
            if (live.length > 0) rows = live;
          } catch {
            // Graceful degradation: keep the curated static rows.
          }
        }
        // No `group` header — a single provider's flat list, kept clean.
        return rows.map((m) => ({
          label: m.model,
          value: encodeModelValue(active, m.model),
          ...(m.hint ? { hint: m.hint } : {}),
          current: m.model === deps.currentModel,
        }));
      },
      action: (value) => {
        if (!value) return;
        const { provider, model } = decodeModelValue(value);
        deps.onPickModel(model, provider || deps.currentProvider || "");
      },
    },
    {
      name: "/theme",
      description: "change the color theme",
      pickerTitle: "Select theme",
      optionsProvider: () =>
        deps.themes.map((t) => ({
          label: t.name,
          value: t.id,
          hint: t.mode,
          ...(t.swatch ? { swatch: t.swatch } : {}),
          current: t.id === deps.currentThemeId,
        })),
      action: (value) => {
        if (value) deps.onPickTheme(value);
      },
    },
    {
      name: "/provider",
      description: "switch the active provider",
      pickerTitle: "Select provider",
      optionsProvider: () =>
        deps.providers.map((p) => ({
          label: p.id,
          value: p.id,
          ...(p.hint ? { hint: p.hint } : {}),
          current: p.id === deps.currentProvider,
        })),
      action: (value) => {
        if (value) deps.onPickProvider(value);
      },
    },
    {
      name: "/agent",
      description: "set the interaction role",
      pickerTitle: "Select role",
      optionsProvider: () =>
        (deps.roles ?? [
          { id: "CHAT", hint: "plain chat" },
          { id: "AGENT", hint: "read-only tools" },
          { id: "AUTOPILOT", hint: "autonomous tools" },
        ]).map((r) => ({
          label: r.id,
          value: r.id,
          ...(r.hint ? { hint: r.hint } : {}),
          current: r.id === deps.currentRole,
        })),
      action: (value) => {
        if (value) deps.onPickRole?.(value);
      },
    },
    {
      name: "/effort",
      description: "set reasoning effort",
      pickerTitle: "Reasoning effort",
      // Scoped to what the ACTIVE provider actually supports: if it has no
      // reasoning capability, say so instead of offering inert levels.
      optionsProvider: () => {
        if (deps.reasoningSupported === false) {
          return [{ label: "this provider has no reasoning mode", value: "" }];
        }
        const cur = deps.currentEffort ?? "off";
        return [
          { id: "off", hint: "no extended thinking" },
          { id: "low", hint: "brief thinking" },
          { id: "medium", hint: "balanced thinking" },
          { id: "high", hint: "deep reasoning" },
        ].map((e) => ({ label: e.id, value: e.id, hint: e.hint, current: e.id === cur }));
      },
      action: (value) => {
        if (value) deps.onPickEffort?.(value);
      },
    },
    {
      name: "/tools",
      description: "list available tools",
      pickerTitle: "Tools",
      optionsProvider: () =>
        deps.tools.map((t) => ({
          label: t.name,
          value: t.name,
          ...(t.description ? { hint: t.description } : {}),
        })),
    },
    {
      name: "/mcp",
      description: "list MCP servers",
      pickerTitle: "MCP servers",
      optionsProvider: () => {
        const servers = info.mcpServers ?? [];
        return servers.length > 0
          ? servers.map((s) => ({ label: s.name, value: s.name, ...(s.hint ? { hint: s.hint } : {}) }))
          : [{ label: "no MCP servers configured", value: "" }];
      },
    },
    {
      name: "/context",
      description: "show context window usage",
      pickerTitle: "Context",
      optionsProvider: () => [
        {
          label: "context window",
          value: "context",
          hint: `${fmt(info.contextUsed)} / ${fmt(info.contextMax)} tokens`,
        },
      ],
    },
    {
      name: "/cost",
      description: "show session + run cost",
      pickerTitle: "Cost",
      optionsProvider: () => [
        { label: "session", value: "session", hint: `$${(info.sessionCost ?? 0).toFixed(2)}` },
        { label: "last run", value: "run", hint: `$${(info.runCost ?? 0).toFixed(2)}` },
      ],
    },
    {
      name: "/trace",
      description: "open the run trace",
      pickerTitle: "Trace",
      optionsProvider: () => [{ label: "trace unavailable in this build", value: "" }],
    },
    {
      name: "/help",
      description: "list all commands",
      pickerTitle: "Commands",
      optionsProvider: () => commands.map((c) => ({ label: c.name, value: c.name, hint: c.description })),
    },
    {
      name: "/clear",
      description: "clear the conversation",
      action: () => deps.onClear(),
    },
    {
      name: "/new",
      description: "start a new session",
      action: () => deps.onNewSession(),
    },
    {
      name: "/quit",
      description: "exit NexusCode",
      action: () => deps.onQuit(),
    },
  ];
  return commands;
}

function fmt(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Match a draft against the registry: only when the draft is a bare `/token`
 * (no space yet — once an argument is typed the menu closes). Prefix match on
 * the command name, case-insensitive.
 */
export function matchCommands(commands: readonly SlashCommandSpec[], draft: string): SlashCommandSpec[] {
  if (!draft.startsWith("/")) return [];
  if (draft.includes(" ")) return [];
  const q = draft.toLowerCase();
  return commands.filter((c) => c.name.startsWith(q));
}
