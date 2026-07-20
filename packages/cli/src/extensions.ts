/**
 * Wave-10 extensibility wiring (system-spec §9 + §24): the CLI-side glue that
 * turns declarative config into a live `HookBus` + `WebhookDispatcher` and loads
 * plugins into the SAME engine registries the builtins use.
 *
 * The kernel stays the single source of truth — nothing here re-implements the
 * engine. Hooks fire AROUND the run through the kernel's additive
 * `ToolInterceptor` seam (guarded, so no hook can break a run); plugins are
 * discovered/version-gated/sandboxed by `@nexuscode/plugins` and their
 * contributions applied to the runtime's provider/tool registries.
 */

import { delimiter, join } from "node:path";
import { nexusPaths, type NexusConfig } from "@nexuscode/config";
import type { SecretStore } from "@nexuscode/config";
import type { WebhookConfig } from "@nexuscode/hooks";
import {
  createHookBus,
  createWebhookDispatcher,
  registerCommandHooks,
  HookBus,
  WebhookDispatcher,
  type HookEvent,
  type HookOutcome,
  type HookPayloads,
} from "@nexuscode/hooks";
import {
  PluginHost,
  type LoadedPlugin,
  type LoadFailure,
  type RegisterResult,
  type RegisterTargets,
} from "@nexuscode/plugins";
import type { ProviderRegistry, ToolInterceptor } from "@nexuscode/core";
import type { ToolRegistry } from "@nexuscode/tools";
import type { PromptEngine } from "@nexuscode/prompt";

/**
 * The host version plugins' `engines.nexuscode` ranges are checked against. The
 * `nexus` binary reports 0.0.0 during development; extensions use a stable
 * product version so a real plugin declaring `>=1.0.0` still loads.
 */
export const NEXUS_HOST_VERSION = "1.0.0";

// ── Hooks + webhooks ──────────────────────────────────────────────────────────

/** A live hooks runtime built from a validated config. */
export interface HooksRuntime {
  bus: HookBus;
  dispatcher: WebhookDispatcher | undefined;
  webhooks: WebhookConfig[];
  /** True when any lifecycle command hook or webhook is configured. */
  active: boolean;
  /** Fire an event through the bus AND the subscribed webhooks (guarded). */
  emit<E extends HookEvent>(event: E, payload: HookPayloads[E]): Promise<HookOutcome<HookPayloads[E]>>;
  /** Pre/post-tool interception bridge for the native tool loop (or undefined). */
  toolInterceptor: ToolInterceptor | undefined;
  /** Unregister command hooks. */
  close(): void;
}

/** Does any command hook or webhook subscribe to a pre/post-tool event? */
function hasToolHooks(config: NexusConfig): boolean {
  const toolEvents = new Set<HookEvent>(["pre-tool", "post-tool"]);
  if (config.hooks.enabled && config.hooks.hooks.some((h) => toolEvents.has(h.event))) return true;
  return config.webhooks.some((w) => w.enabled && w.events.some((e) => toolEvents.has(e)));
}

/**
 * Build the hooks/webhooks runtime from config. Registers every declared command
 * hook on a fresh `HookBus`, wires a `WebhookDispatcher` (secret-resolving,
 * SSRF-guarded) when webhooks are declared, and — when any tool-scoped hook or
 * webhook exists — exposes a guarded {@link ToolInterceptor} that bridges the
 * native tool loop into `pre-tool`/`post-tool` emits. Always safe to call: with
 * no hooks/webhooks configured it returns an inert, empty runtime.
 */
export function buildHooks(config: NexusConfig, secrets: SecretStore): HooksRuntime {
  const bus = createHookBus();
  const off = registerCommandHooks(bus, config.hooks);
  const webhooks = [...config.webhooks].filter((w) => w.enabled);
  const dispatcher =
    webhooks.length > 0 ? createWebhookDispatcher({ secretStore: secrets }) : undefined;
  const active = (config.hooks.enabled && config.hooks.hooks.length > 0) || webhooks.length > 0;

  const emit = async <E extends HookEvent>(
    event: E,
    payload: HookPayloads[E],
  ): Promise<HookOutcome<HookPayloads[E]>> => {
    // The bus already isolates a throwing handler; wrap defensively anyway so a
    // catastrophic bus failure can never break the run.
    let outcome: HookOutcome<HookPayloads[E]>;
    try {
      outcome = await bus.emit(event, payload);
    } catch {
      outcome = { blocked: false, payload, errors: [] };
    }
    // Webhook delivery is fire-and-forget from the run's perspective: a failed
    // POST (network, non-2xx, SSRF-blocked) never affects run control flow.
    if (dispatcher && webhooks.some((w) => w.events.includes(event))) {
      try {
        await dispatcher.dispatch(event, outcome.payload, webhooks);
      } catch {
        /* isolated: a webhook failure never breaks a run */
      }
    }
    return outcome;
  };

  const toolInterceptor: ToolInterceptor | undefined = hasToolHooks(config)
    ? {
        async preTool(req) {
          const outcome = await emit("pre-tool", { toolName: req.name, input: req.input });
          if (outcome.blocked) {
            return outcome.reason !== undefined
              ? { block: true, reason: outcome.reason }
              : { block: true };
          }
          const modified = (outcome.payload as { input?: unknown }).input;
          if (modified !== undefined && modified !== req.input) return { input: modified };
          return;
        },
        async postTool(res) {
          await emit("post-tool", { toolName: res.name, ok: res.ok, output: res.output });
        },
      }
    : undefined;

  return { bus, dispatcher, webhooks, active, emit, toolInterceptor, close: off };
}

// ── Plugins ───────────────────────────────────────────────────────────────────

/** A loaded set of plugins plus the host that produced them. */
export interface PluginRuntime {
  host: PluginHost;
  loaded: LoadedPlugin[];
  failures: LoadFailure[];
}

/**
 * Environment opt-in that marks the CURRENT working directory as a trusted
 * workspace. Discovering plugins from the cwd (its `node_modules`) means
 * `import()`-ing modules that ship inside a cloned repo — arbitrary code
 * execution with the invoking user's full privileges, BEFORE any capability gate.
 * That is the classic workspace-trust RCE, so the cwd is scanned ONLY when the
 * user explicitly opts the workspace in. A repo cannot set an env var, so this
 * signal can never come from the untrusted project itself.
 */
export const TRUST_WORKSPACE_ENV = "NEXUS_TRUST_WORKSPACE";

/** Is the current workspace explicitly trusted for local (cwd) plugin scanning? */
export function isWorkspaceTrusted(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[TRUST_WORKSPACE_ENV];
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Resolve the directories plugin discovery scans: the built-in data-dir
 * `plugins/` directory, any `config.plugins.dirs` (honored only from the trusted
 * user/global layer — see `stripUntrustedSpawnFields`), and the
 * `NEXUS_PLUGINS_DIR` env override (path-delimited — the explicit test/sandbox
 * seam). None of these point at the cwd by default; the untrusted workspace's
 * own `node_modules` is scanned only under an explicit trust opt-in (see
 * {@link loadPlugins}).
 */
export function pluginDirs(config: NexusConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  const dataDir = env.NEXUS_DATA_DIR ?? nexusPaths().data;
  dirs.push(join(dataDir, "plugins"));
  for (const d of config.plugins.dirs) dirs.push(d);
  const fromEnv = env.NEXUS_PLUGINS_DIR;
  if (fromEnv) for (const d of fromEnv.split(delimiter)) if (d.length > 0) dirs.push(d);
  return dirs;
}

/**
 * Discover + load every configured plugin (sandboxed, version-gated). Never
 * throws — a bad plugin becomes a `failure`, not an exception. Returns an inert
 * empty runtime when plugins are disabled.
 */
export async function loadPlugins(
  config: NexusConfig,
  opts: { logger?: (message: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<PluginRuntime> {
  const env = opts.env ?? process.env;
  const hostOpts: ConstructorParameters<typeof PluginHost>[0] = {
    pluginDirs: pluginDirs(config, env),
    hostVersion: NEXUS_HOST_VERSION,
  };
  if (opts.logger) hostOpts.logger = opts.logger;
  // Scanning the cwd's `node_modules` for `nexuscode-plugin-*` packages imports
  // (executes) modules that ship inside the working directory — a cloned repo can
  // therefore run code the moment ANY `nexus` command is invoked in it. Gate that
  // scan behind an explicit workspace-trust opt-in (`NEXUS_TRUST_WORKSPACE`); the
  // repo cannot set env vars, so an untrusted workspace is never auto-scanned even
  // though `scanNodeModules` defaults on for trusted use.
  if (config.plugins.scanNodeModules && isWorkspaceTrusted(env)) {
    hostOpts.nodeModulesDirs = [join(process.cwd(), "node_modules")];
  }
  const host = new PluginHost(hostOpts);
  if (!config.plugins.enabled) {
    return { host, loaded: [], failures: [] };
  }
  const { loaded, failures } = await host.loadAll();
  return { host, loaded, failures };
}

/**
 * Apply loaded plugins' contributions into the given engine surfaces (the SAME
 * registries the builtins use, so a plugin provider is routed and a plugin tool
 * is permission-gated identically). Returns the applied/skipped audit.
 */
export async function applyPlugins(
  runtime: PluginRuntime,
  targets: RegisterTargets,
): Promise<RegisterResult> {
  return runtime.host.register(runtime.loaded, targets);
}

/**
 * Convenience for the common CLI case: apply plugin providers + tools (and
 * optionally prompts) onto the live registries used by a run. Returns the audit.
 */
export async function applyPluginsToRun(
  runtime: PluginRuntime,
  opts: { providerRegistry?: ProviderRegistry; toolRegistry?: ToolRegistry; promptEngine?: PromptEngine },
): Promise<RegisterResult> {
  const targets: RegisterTargets = {};
  if (opts.providerRegistry) targets.providerRegistry = opts.providerRegistry;
  if (opts.toolRegistry) targets.toolRegistry = opts.toolRegistry;
  if (opts.promptEngine) targets.promptEngine = opts.promptEngine;
  return applyPlugins(runtime, targets);
}

/** Flatten a plugin's declared contribution counts for a human summary line. */
export function contributionSummary(p: LoadedPlugin): string {
  const c = p.contributions;
  const parts: string[] = [];
  if (c.providers.length) parts.push(`${c.providers.length} provider(s)`);
  if (c.tools.length) parts.push(`${c.tools.length} tool(s)`);
  if (c.commands.length) parts.push(`${c.commands.length} command(s)`);
  if (c.prompts.length) parts.push(`${c.prompts.length} prompt(s)`);
  if (c.mcpServers.length) parts.push(`${c.mcpServers.length} mcp-server(s)`);
  if (c.uiPanels.length) parts.push(`${c.uiPanels.length} ui-panel(s)`);
  return parts.length > 0 ? parts.join(", ") : "no contributions";
}
