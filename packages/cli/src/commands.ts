/**
 * Command handlers for the `nexus` binary. Every command projects the engine's
 * `StreamChunk` stream into the same `UiEvent` union; the three output modes
 * (text / json / ndjson) are renderers over it. Secrets never touch stdout.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { repoMap, detectLanguage } from "@nexuscode/fileintel";
import { runGit } from "@nexuscode/git";
import {
  createEngine,
  dispatch,
  dispatchAgent,
  dispatchRoute,
  Router,
  userText,
  DEFAULT_RETRY_POLICY,
  type AgentOptions,
  type AssembledContext,
  type Capabilities,
  type ChainStage,
  type ContextAssembler,
  type FailoverEvent,
  type JudgeSpec,
  type Message,
  type OrchestrationOutcome,
  type OrchestrationSpec,
  type ProviderRegistry,
  type RetryPolicy,
  type RouteCandidate,
  type RouteOptimize,
  type RouteRule,
  type RunResult,
  type RunSpec,
  type SamplingParams,
} from "@nexuscode/core";
import { runTui, detectCapabilities, canMountTui, type TurnDispatcher } from "@nexuscode/tui";
import {
  loadConfig,
  McpServerConfig as McpServerConfigSchema,
  nexusPaths,
  redactSecret,
  type NexusConfig,
  type SecretStore,
} from "@nexuscode/config";
import type {
  ProviderAuthRegistry,
  LoginStrategyOptions,
  FetchLike,
} from "@nexuscode/auth";
import { createInterface } from "node:readline";
import {
  ingestInstructionFiles,
  openMemory,
  type MemoryPut,
  type MemoryTier,
} from "@nexuscode/memory";
import {
  CommandHistory,
  PermissionGate,
  ProcessManager,
  ToolRegistry,
  isNodePtyAvailable,
  jobTools,
  registerBuiltins,
  runTool,
  type ApproveFn,
  type PermissionGateOptions,
  type PermissionMode,
} from "@nexuscode/tools";
import {
  Agent,
  createAgentRegistry,
  AGENT_ROLES,
  isAgentMeta,
  type AgentDeps,
  type AgentRunResult,
} from "@nexuscode/agent";
import { openTasks, tasksFile, type Task, type TaskStore } from "@nexuscode/tasks";
import {
  CONTEXT_LANES,
  ContextEngine,
  type ContextSource,
} from "@nexuscode/context";
import { PromptEngine } from "@nexuscode/prompt";
import type { CachedResponse } from "@nexuscode/cache";
import { httpPoolOptions, type ChatRequest } from "@nexuscode/shared";
import type { ParsedArgs } from "./args.js";
import {
  buildPowerSources,
  cacheDir,
  cacheEntryCounts,
  collectIndexableDocs,
  createProviderEmbedder,
  openRagIndex,
  openResponseCache,
  preferAffineProvider,
  ragStorePath,
  sessionAffinity,
} from "./power.js";
import {
  watchAndReindex,
  type Embedder,
  type RagDocument,
  type RagIndex,
  type WatchReindexHandle,
} from "@nexuscode/rag";
import {
  getPath,
  readUserConfig,
  setPath,
  userConfigDir,
  userConfigFile,
  validateUserConfig,
  writeUserConfig,
} from "./config-io.js";
import { historyList, historyShow, openHistory } from "./history.js";
import { buildObservability, loadTraceSpans, type ObservabilityRuntime } from "./observability.js";
import { attachMcpTools, startMcpSession } from "./mcp.js";
import {
  buildRuntime,
  isProviderUsable,
  listModelsForProvider,
  routerMetadataFrom,
  resolveDefaultProvider,
  type Runtime,
} from "./runtime.js";
import {
  authStatusRows,
  buildAuthRegistry,
  formatExpiry,
  resolveAuthSecrets,
} from "./auth.js";
import {
  buildToolGroup,
  groupOfTool,
  registerToolGroups,
  reportToolGroups,
  type ToolGroupReport,
} from "./tool-groups.js";
import { lspTools } from "./lsp-tools.js";
import { LanguageServerRegistry, type ServerSpec } from "@nexuscode/lsp";
import { projectLabeled, type UiEvent } from "./ui.js";
import {
  applyPluginsToRun,
  buildHooks,
  contributionSummary,
  loadPlugins,
} from "./extensions.js";
import {
  buildEnterprise,
  composeInterceptors,
  costPrincipalFor,
  enterpriseStatus,
  enterpriseToolInterceptor,
  estimateRunUsd,
  recordRunSpend,
  resolvePrincipal,
} from "./enterprise.js";
import { actionForToolPermission, parseDowngradeTarget } from "@nexuscode/enterprise";

export type OutputMode = "text" | "json" | "ndjson";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

function parseOutput(args: ParsedArgs): OutputMode {
  const raw = args.flags.get("output") ?? "text";
  if (raw === "json" || raw === "ndjson" || raw === "text") return raw;
  return "text";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  try {
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readPrompt(args: ParsedArgs): Promise<string> {
  const promptArg = args.positionals.join(" ").trim();
  const piped = (await readStdin()).trim();
  return [promptArg, piped].filter((s) => s.length > 0).join("\n\n");
}

async function loadEffectiveConfig(): Promise<NexusConfig> {
  const { config } = await loadConfig({ userConfigDir: userConfigDir() });
  return config;
}

/**
 * Build the runtime with the per-provider {@link ProviderAuthRegistry} wired
 * (Wave 13): credential resolution for a provider that has been logged in goes
 * through its auth strategy — an auto-refreshed OAuth Bearer (Anthropic "login
 * like Claude Code"), an API key, a wrapped-CLI session, or the cloud credential
 * chain — instead of the legacy env/api-key-only path. Fully additive: a
 * provider with no strategy (e.g. `mock`) resolves exactly as before, and the
 * env-var + `keys set` paths keep working (the api-key strategy reads the same
 * env var / SecretStore ref). Shares ONE SecretStore between the auth registry
 * and the runtime so a token stored at login is resolvable here.
 */
async function buildAuthedRuntime(
  config: NexusConfig,
  opts: Parameters<typeof buildRuntime>[1] = {},
): Promise<Runtime> {
  const secrets = opts.secrets ?? resolveAuthSecrets(config);
  const authRegistry = buildAuthRegistry(config, secrets);
  return buildRuntime(config, { ...opts, secrets, authRegistry });
}

function firstModel(registry: ProviderRegistry, providerId: string): string | undefined {
  try {
    return registry.capabilitiesOf(providerId).models[0]?.id;
  } catch {
    return undefined;
  }
}

function resolveModel(registry: ProviderRegistry, providerId: string, config: NexusConfig, explicit?: string): string {
  return explicit ?? config.defaultModel ?? firstModel(registry, providerId) ?? providerId;
}

/** True when `providerId` is a wrapped coding-CLI subprocess provider (claude-code / codex). */
function isSubprocessProvider(runtime: Runtime, providerId: string): boolean {
  return runtime.statuses.find((s) => s.id === providerId)?.kind === "subprocess";
}

/**
 * Resolve the model for a run (`ask` / `chat` / `tui`). Identical to
 * {@link resolveModel} for normal providers, but for a subprocess coding CLI
 * (claude-code / codex) it NEVER invents a bogus `--model <providerId>`: the
 * wrapped vendor CLI owns its own default model tied to the user's signed-in
 * session, so with no explicit `-m`/config default we pass an empty model and
 * let the CLI choose. This is what makes `ask -p claude-code hi` actually run
 * instead of failing with an "invalid model 'claude-code'" from the vendor CLI.
 */
function resolveRunModel(
  runtime: Runtime,
  providerId: string,
  config: NexusConfig,
  explicit?: string,
): string {
  if (isSubprocessProvider(runtime, providerId)) {
    return explicit ?? config.defaultModel ?? "";
  }
  return resolveModel(runtime.registry, providerId, config, explicit);
}

/**
 * Resolve the provider for a command's DEFAULT (no explicit `-p`) path so a
 * first-run user is never dead-ended by an unconfigured `defaultProvider`
 * (bare `nexus` / `nexus tui` / `nexus ask` must always work). Prints a
 * one-line notice to stderr when a fallback actually happens. Returns
 * `undefined` (after printing actionable onboarding guidance) only when
 * literally no provider is usable — should not happen since `mock` is always
 * registered.
 */
function resolveDefaultProviderForRun(runtime: Runtime, config: NexusConfig, io: Io): string | undefined {
  const resolution = resolveDefaultProvider(runtime, config.defaultProvider);
  if (!resolution) {
    io.err(
      "nexus: no provider is available — not even the built-in mock provider. " +
        "Sign in with `nexus login` and try again.\n",
    );
    return undefined;
  }
  if (resolution.fellBack) {
    // Surface the PROPER path first (a real `nexus login`, like Claude Code),
    // then the offline mock escape hatch, so a first-run user is pointed at
    // signing in rather than at pasting an API key.
    io.err(
      `Not logged in — using the offline '${resolution.providerId}' provider. ` +
        `Run \`nexus login\` to sign in (browser OAuth where supported), or ` +
        `\`nexus login ${resolution.requestedId}\` for a specific provider. ` +
        `Use \`-p ${resolution.providerId}\` to stay offline.\n`,
    );
  }
  return resolution.providerId;
}

// ── Orchestration runner shared by `ask` and `compare` ────────────────────────

interface RunTemplate {
  adapterId: string;
  model: string;
  params?: SamplingParams;
}

interface RunOrchestrationOptions {
  kind: "single" | "compare";
  templates: RunTemplate[];
  input: Message[];
  registry: Runtime["registry"];
  pricing: Runtime["pricing"];
  config: NexusConfig;
  output: OutputMode;
  io: Io;
}

async function runOrchestration(opts: RunOrchestrationOptions): Promise<OrchestrationOutcome> {
  const { kind, templates, input, registry, pricing, config, output, io } = opts;
  const single = kind === "single";
  const adapterIds = templates.map((t) => t.adapterId);

  const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
  const store = await openHistory({ enabled: config.history.enabled, dbPath: historyDb });
  const obs = buildObservability(config);

  const engine = createEngine({ registry, pricing, store, ...(obs.emit ? { emit: obs.emit } : {}) });
  const session = await engine.openSession();
  const turn = session.newTurn({ messages: input });

  const runs: RunSpec[] = templates.map((t) => {
    const run: RunSpec = {
      adapterId: t.adapterId,
      model: t.model,
      input: turn.input,
      idempotencyKey: randomUUID(),
    };
    if (t.params) run.params = t.params;
    return run;
  });

  const spec: OrchestrationSpec =
    single && runs[0] ? { kind: "single", run: runs[0] } : { kind: "compare", runs };

  const onSigint = (): void => {
    void turn.scope.cancel("user");
  };
  process.once("SIGINT", onSigint);

  try {
    const handle = dispatch(spec, turn.context());

    // `ndjson` streams every projected event; `text` streams live ONLY for a
    // single lane. Multiple lanes streamed live would interleave into one garbled
    // line, so a `compare` drains silently here and renders each lane as its own
    // labeled block from the settled outcome below.
    if (output === "ndjson" || (output === "text" && single)) {
      for await (const labeled of handle.events()) {
        for (const ev of projectLabeled(labeled, adapterIds, single)) {
          renderStreaming(ev, output, io);
        }
      }
    } else if (output !== "json") {
      for await (const _ of handle.events()) void _;
    }

    const outcome = await handle.outcome();

    if (output === "json") {
      io.out(`${JSON.stringify(single ? toSingleJson(outcome) : toCompareJson(outcome))}\n`);
    } else if (output === "text") {
      if (single) {
        renderTextTrailer(outcome, single, io);
      } else {
        renderLaneBlocks(outcome.runs, io);
        renderLaneSummary(outcome.runs, io);
        io.err(
          dimErr(
            `[usage] in=${outcome.usage.inputTokens} out=${outcome.usage.outputTokens} ` +
              `cost=$${(outcome.usage.costUsd ?? 0).toFixed(6)}\n`,
          ),
        );
      }
      renderMetricsTrailer(obs, io);
    }

    return outcome;
  } finally {
    process.removeListener("SIGINT", onSigint);
    await obs.flush();
    await session.dispose();
    await engine.dispose();
    store.close();
  }
}

/**
 * Print the per-run observability trailer (TTFT + latency) to stderr, derived
 * from the spans the engine emitted this invocation. Silent when observability
 * is off or the run produced no latency sample — so a piped/quiet run is
 * unaffected.
 */
function renderMetricsTrailer(obs: ObservabilityRuntime, io: Io): void {
  if (!obs.enabled) return;
  const snap = obs.metrics();
  const ttft = snap.histograms["nexus.ttft.ms"];
  const latency = snap.histograms["nexus.latency.ms"];
  const parts: string[] = [];
  if (ttft && ttft.count > 0) parts.push(`ttft=${Math.round(ttft.p50)}ms`);
  if (latency && latency.count > 0) parts.push(`latency=${Math.round(latency.p50)}ms`);
  const spans = obs.store
    .traceIds()
    .reduce((n, id) => n + obs.store.getTrace(id).length, 0);
  if (spans > 0) parts.push(`spans=${spans}`);
  if (parts.length > 0) io.err(`[trace] ${parts.join(" ")}\n`);
}

function renderStreaming(ev: UiEvent, output: OutputMode, io: Io): void {
  if (output === "ndjson") {
    io.out(`${JSON.stringify(ev)}\n`);
    return;
  }
  switch (ev.t) {
    case "text":
      io.out(ev.delta);
      break;
    case "reasoning":
      // Reasoning (subprocess coding agents) is diagnostic — keep it off stdout.
      io.err(ev.delta);
      break;
    case "tool_call":
      // Tool activity goes to stderr so it never contaminates the answer on stdout.
      io.err(`\n[tool-call] ${ev.name}\n`);
      break;
    case "tool_result":
      io.err(`[tool-result] ${ev.ok ? "ok" : "error"}\n`);
      break;
    case "diff":
      // A coding-CLI file edit. The patch itself goes to stderr so stdout stays
      // the model's answer; the header names the touched file.
      io.err(`\n[file-edit] ${ev.path}\n${ev.patch}`);
      break;
    case "approval":
      io.err(`\n[approval] ${ev.action}: ${ev.detail}\n`);
      break;
    case "failover":
      io.err(`\n[failover] ${ev.from} → ${ev.to} (${ev.code})\n`);
      break;
    case "error":
      io.err(`\n${humanErrorLine(ev.code, ev.message)}\n`);
      break;
    case "done":
      io.out("\n");
      break;
    default:
      break;
  }
}

function renderTextTrailer(outcome: OrchestrationOutcome, single: boolean, io: Io): void {
  if (single) {
    const w = outcome.winner;
    if (w) {
      io.err(
        dimErr(
          `[usage] ${w.adapterId}:${w.model} in=${w.usage.inputTokens} out=${w.usage.outputTokens} ` +
            `cost=$${(w.usage.costUsd ?? 0).toFixed(6)} finish=${w.finishReason ?? w.status}\n`,
        ),
      );
    }
  } else {
    renderLaneSummary(outcome.runs, io);
  }
}

/**
 * ANSI-dim a string only when stderr is a real interactive terminal — a piped or
 * captured run (tests, `2>file`) gets the plain text, so machine consumers and
 * assertions are unaffected while a human sees a quiet, de-emphasized footer.
 */
function dimErr(s: string): string {
  return process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

/**
 * A short, actionable hint for a provider/tool error code — a human sentence, not
 * a stack trace. Returns `undefined` for an unknown code (the raw message stands
 * on its own).
 */
function errorHint(code: string): string | undefined {
  switch (code) {
    case "auth":
    case "auth_error":
    case "unauthorized":
    case "permission_denied":
      return "check your API key or run `nexus login`";
    case "rate_limit":
    case "rate_limited":
      return "rate-limited — wait a moment, or switch providers with -p";
    case "timeout":
    case "deadline_exceeded":
      return "the provider timed out — retry, or try another provider with -p";
    case "not_available":
    case "unavailable":
    case "provider_unavailable":
      return "that provider isn't configured — try `-p mock` or `nexus providers`";
    case "empty_output":
      return "the provider returned no text — retry, or switch models with -m";
    case "context_length":
    case "context_length_exceeded":
      return "the prompt is too long for this model — shorten it or pick a larger model";
    default:
      return undefined;
  }
}

/** One clear human line for an error: the message, plus a hint when we have one. */
function humanErrorLine(code: string, message: string): string {
  const hint = errorHint(code);
  const msg = message.trim().length > 0 ? message.trim() : code;
  return hint ? `error: ${msg}\n  hint: ${hint}` : `error: ${msg}`;
}

/**
 * Render each provider lane as a SEPARATE, clearly-labeled block for plain
 * (non-TTY / `-o text`) output. This is what makes `compare`/`race`/`consensus`
 * readable: instead of streaming every lane's deltas to stdout live — which
 * interleaves them character-by-character into one garbled line — each lane is
 * taken from its settled `RunResult` and printed as its own header + full text +
 * blank-line block.
 */
function renderLaneBlocks(runs: readonly RunResult[], io: Io): void {
  for (const r of runs) {
    io.out(`── ${r.adapterId}:${r.model} ──\n`);
    const text = r.text.trim();
    io.out(text.length > 0 ? `${text}\n` : "(no output)\n");
    if (r.error) io.out(`${humanErrorLine(r.error.code, r.error.message)}\n`);
    io.out("\n");
  }
}

/**
 * Per-lane summary footer (status / winner / tokens / cost), one line each, dimmed
 * on a TTY and sent to stderr so it never contaminates the answer text on stdout.
 */
function renderLaneSummary(runs: readonly RunResult[], io: Io, winnerRunId?: string): void {
  for (const r of runs) {
    const win = winnerRunId && r.runId === winnerRunId ? " winner" : "";
    io.err(
      dimErr(
        `[lane ${r.adapterId}:${r.model}] status=${r.status}${win} ` +
          `out=${r.usage.outputTokens} cost=$${(r.usage.costUsd ?? 0).toFixed(6)}\n`,
      ),
    );
  }
}

function runJson(r: RunResult): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    provider: r.adapterId,
    model: r.model,
    runId: r.runId,
    status: r.status,
    finishReason: r.finishReason ?? null,
    text: r.text,
    toolCalls: r.toolCalls,
    usage: {
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      costUsd: r.usage.costUsd ?? 0,
    },
  };
  if (r.error) {
    obj.error = { code: r.error.code, message: r.error.message, retryable: r.error.retryable };
  }
  return obj;
}

function toSingleJson(outcome: OrchestrationOutcome): Record<string, unknown> {
  const w = outcome.winner ?? outcome.runs[0];
  return w ? runJson(w) : { status: "error", text: "", error: { code: "empty_output", message: "no run produced" } };
}

function toCompareJson(outcome: OrchestrationOutcome): Record<string, unknown> {
  return {
    kind: "compare",
    partial: outcome.partial,
    runs: outcome.runs.map(runJson),
    usage: {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costUsd: outcome.usage.costUsd ?? 0,
    },
  };
}

function exitFor(outcome: OrchestrationOutcome, single: boolean): number {
  if (single) return outcome.winner && outcome.winner.status === "ok" ? 0 : 1;
  return outcome.partial ? 1 : 0;
}

// ── ask ───────────────────────────────────────────────────────────────────────

export async function cmdAsk(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  // `ask --tools` is the agentic path; `agent` routes here with tools forced on.
  if (args.bools.has("tools")) return cmdAgent(args, io);

  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus ask: no prompt (pass an argument or pipe stdin)\n");
    return 2;
  }

  const config = await loadEffectiveConfig();
  const runtime = await buildAuthedRuntime(config);
  const explicitProvider = args.flags.get("provider");
  let providerId: string;
  if (explicitProvider !== undefined) {
    // An explicitly named provider stays a hard error when unavailable — only
    // the DEFAULT path degrades gracefully.
    if (!isProviderUsable(runtime, explicitProvider)) {
      io.err(`nexus ask: provider "${explicitProvider}" is not available (try -p mock)\n`);
      return 1;
    }
    providerId = explicitProvider;
  } else {
    const resolved = resolveDefaultProviderForRun(runtime, config, io);
    if (!resolved) return 1;
    providerId = resolved;
  }
  const model = resolveRunModel(runtime, providerId, config, args.flags.get("model"));
  const system = args.flags.get("system") ?? defaultSystemPrompt();

  const template: RunTemplate = { adapterId: providerId, model };
  if (system !== undefined) template.params = { system };

  const input = userText(prompt);

  // Response cache (CAG): a hit on an IDENTICAL request short-circuits the whole
  // provider dispatch and books the avoided tokens/cost as savings. Opt-in via
  // `cache.enabled` + `cache.responses` so the default path is unchanged.
  const responseCache = openResponseCache(config);
  const req: ChatRequest = { model, messages: input };
  if (system !== undefined) req.system = system;
  if (responseCache) {
    const cached = await responseCache.get(req);
    if (cached) {
      renderCachedResponse(cached, providerId, output, io);
      const stats = await responseCache.stats();
      io.err(
        `[cache] hit ${providerId}:${model} — saved ${stats.savedTokens} tokens ` +
          `($${stats.estimatedCostSavedUsd.toFixed(6)}), hitRate=${stats.hitRate.toFixed(2)}\n`,
      );
      return 0;
    }
  }

  const outcome = await runOrchestration({
    kind: "single",
    templates: [template],
    input,
    registry: runtime.registry,
    pricing: runtime.pricing,
    config,
    output,
    io,
  });

  // Store the fresh answer under its request signature for the next identical run.
  if (responseCache && outcome.winner && outcome.winner.status === "ok") {
    const w = outcome.winner;
    const value: CachedResponse = { text: w.text, usage: w.usage, model: w.model };
    if (w.finishReason !== undefined) value.finishReason = w.finishReason;
    await responseCache.set(req, value);
  }
  return exitFor(outcome, true);
}

/** Render a cache-hit response in the requested output mode (no provider call). */
function renderCachedResponse(
  cached: CachedResponse,
  providerId: string,
  output: OutputMode,
  io: Io,
): void {
  if (output === "json") {
    io.out(
      `${JSON.stringify({
        provider: providerId,
        model: cached.model,
        status: "ok",
        finishReason: cached.finishReason ?? "stop",
        text: cached.text,
        cached: true,
        usage: {
          inputTokens: cached.usage.inputTokens,
          outputTokens: cached.usage.outputTokens,
          costUsd: cached.usage.costUsd ?? 0,
        },
      })}\n`,
    );
    return;
  }
  if (output === "ndjson") {
    io.out(`${JSON.stringify({ t: "text", delta: cached.text })}\n`);
    io.out(`${JSON.stringify({ t: "cache", hit: true })}\n`);
    io.out(`${JSON.stringify({ t: "done" })}\n`);
    return;
  }
  io.out(cached.text);
  io.out("\n");
}

// ── agent (native tool-execution loop) ────────────────────────────────────────

/** Map the permission flags to a gate mode. Default is the safe `read-only`. */
function resolvePermissionMode(args: ParsedArgs): PermissionMode {
  if (args.bools.has("yolo")) return "full-access";
  if (args.bools.has("approve")) return "workspace-write";
  if (args.bools.has("read-only")) return "read-only";
  return "read-only";
}

/**
 * Build the `PermissionGate` for a tool-executing command: the resolved `mode`,
 * the config's tool allow/deny lists, and — for the write-capable modes — an
 * auto-approver so a `--approve`/`--yolo` run can actually act on `ask`
 * decisions. In `read-only`/`plan` no approver is attached, so a network/write
 * tool is denied outright unless it is on the allowlist.
 */
function buildToolGate(
  mode: PermissionMode,
  config: NexusConfig,
  opts: { approveAskTier?: boolean } = {},
): PermissionGate {
  const gateOpts: PermissionGateOptions = { mode };
  if (config.tools.allow.length > 0) gateOpts.allowlist = [...config.tools.allow];
  if (config.tools.deny.length > 0) gateOpts.denylist = [...config.tools.deny];
  // workspace-write/full-access always get an approver. The "ask" tier
  // (network/MCP tools such as kyp-mem) ALSO gets one in read-only, but ONLY when
  // the caller opts in via `approveAskTier` — the agentic loop does, so the model
  // can actually call MCP tools (matching the TUI). `nexus tools run` does NOT, so
  // a read-only MANUAL invocation still denies network before any socket opens
  // (the escalation-ladder safety). write/exec stay hard-denied regardless.
  if (mode === "workspace-write" || mode === "full-access" || opts.approveAskTier) {
    const approve: ApproveFn = () => true;
    gateOpts.approve = approve;
  }
  return new PermissionGate(gateOpts);
}

/**
 * The default harness system prompt, used whenever the user did not pass an
 * explicit `--system`. A real harness never sends the model a bare prompt: it
 * always establishes the operating environment (cwd, OS, date) and what the model
 * can do (tools, MCP memory). Framed as the *environment* (not a competing
 * identity) so it composes cleanly with a provider that injects its own identity
 * (e.g. the Claude subscription OAuth path prepends "You are Claude Code…").
 * EngineContextAssembler merges this ahead of any assembled project context.
 */
export function defaultSystemPrompt(cwd: string = process.cwd()): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    "You are an AI coding assistant operating inside NexusCode, a universal AI harness, in the user's terminal.",
    `Environment: cwd=${cwd} · os=${process.platform} · date=${date}.`,
    "Available: file tools (read/write/patch/search), shell, and any configured MCP servers (e.g. kyp-mem for durable project memory). Use them to ground answers in the real workspace instead of guessing.",
    "Be concise and direct. Prefer taking action — reading files, calling tools — over asking the user for information you can obtain yourself.",
  ].join("\n");
}

/**
 * Reasoning-effort level → extended-thinking token budget. Anthropic bills/limits
 * reasoning by tokens (so the level must map to a budget), while OpenAI-compatible
 * providers read the `effort` level directly — both are set on the request.
 */
const EFFORT_BUDGET: Record<"low" | "medium" | "high", number> = {
  low: 4000,
  medium: 10000,
  high: 24000,
};

/**
 * Build the LSP server registry from config: the built-in defaults plus any extra
 * `config.lsp.servers` launch recipes. Feature-detection of which servers are
 * installed happens lazily inside the registry.
 */
function buildLspRegistry(config: NexusConfig): LanguageServerRegistry {
  const registry = new LanguageServerRegistry();
  for (const s of config.lsp.servers) {
    const spec: ServerSpec = {
      language: s.language,
      languageId: s.languageId,
      command: s.command,
      args: s.args,
      extensions: s.extensions,
      rootMarkers: s.rootMarkers,
      ...(s.label ? { label: s.label } : {}),
    };
    registry.register(spec);
  }
  return registry;
}

/**
 * Register the LSP-backed code-navigation tools into `toolRegistry` when enabled
 * in config. Fully additive and offline-safe: the tools spawn a server lazily per
 * call and degrade gracefully when none is installed (never a crash), so this is
 * safe to call unconditionally on the agent tool loop.
 */
function registerLspTools(toolRegistry: ToolRegistry, config: NexusConfig): void {
  if (!config.lsp.enabled) return;
  const registry = buildLspRegistry(config);
  for (const t of lspTools({ registry, timeoutMs: config.lsp.timeoutMs })) {
    if (!toolRegistry.has(t.name)) toolRegistry.register(t);
  }
}

/** Concatenated text of the last user message (drives context relevance). */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    let text = "";
    for (const b of msg.content) if (b.type === "text") text += b.text;
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * Adapts a real `ContextEngine` to core's structural `ContextAssembler` seam.
 * The engine's assembled `system`/`messages` replace the raw turn before the
 * first provider dispatch, so a run genuinely goes through context assembly.
 */
export class EngineContextAssembler implements ContextAssembler {
  constructor(
    private readonly engine: ContextEngine,
    private readonly sources: ContextSource[],
    private readonly budgetTokens: number,
  ) {}

  async assemble(
    input: { messages: Message[]; system?: string },
    signal: AbortSignal,
  ): Promise<AssembledContext> {
    const userMessage = lastUserText(input.messages);
    const res = await this.engine.assemble({
      budgetTokens: this.budgetTokens,
      sources: this.sources,
      userMessage,
      signal,
    });
    const systemParts = [input.system, res.system]
      .map((s) => s?.trim())
      .filter((s): s is string => !!s && s.length > 0);
    // Preserve the FULL conversation AND the retrieved context. Two failure modes
    // have to be avoided at once, and fixing either one alone reintroduces the other:
    //
    //   * Returning `res.messages` verbatim drops every prior turn, because the
    //     engine rebuilds ONLY the last user turn from `userMessage` (multi-turn
    //     amnesia).
    //   * Taking `res.messages.slice(0, -1)` drops the retrieved context, because
    //     the engine packs the volatile lanes (memory, RAG) INTO that rebuilt final
    //     turn — so slicing it off silently discarded everything the context engine
    //     had just retrieved, on every single run.
    //
    // So: keep any history-lane preamble, keep the caller's REAL conversation, and
    // splice the volatile context onto the caller's own final user turn. We use
    // `res.volatilePreamble` (the same context WITHOUT the query) rather than the
    // engine's rebuilt turn, because that rebuild is reconstructed from the last
    // user message's TEXT — adopting it would silently drop any non-text content
    // (images, tool results) the caller attached. The query appears exactly once.
    const preamble = res.messages.slice(0, -1);
    const conversation: Message[] = [...input.messages];
    const lastUserIdx = conversation.map((m) => m.role).lastIndexOf("user");
    if (res.volatilePreamble !== undefined && lastUserIdx >= 0) {
      const last = conversation[lastUserIdx]!;
      conversation[lastUserIdx] = {
        ...last,
        content: [{ type: "text", text: res.volatilePreamble }, ...last.content],
      };
    }
    const out: AssembledContext = { messages: [...preamble, ...conversation] };
    if (systemParts.length > 0) out.system = systemParts.join("\n\n");
    return out;
  }
}

export async function cmdAgent(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus agent: no prompt (pass an argument or pipe stdin)\n");
    return 2;
  }

  // `--role <name>` promotes the run from the native tool loop to the full OODA
  // agent framework (Observe→Reason→Plan→Act→Evaluate→Repeat, §5): plan drafting,
  // reflection, retry/self-correction, and dynamic replanning — all riding the
  // same engine bus. Without a role, the fast native tool loop below is used.
  const roleFlag = args.flags.get("role");
  if (roleFlag !== undefined) {
    const res = await runAgentOoda(args, io, roleFlag, prompt);
    if (res.result && output !== "json" && output !== "ndjson") {
      renderAgentTrailer(res.result, io);
    }
    return res.code;
  }

  const config = await loadEffectiveConfig();
  // Enterprise subsystem (§25): off by default. When on, its private-model
  // gateway is applied at registry construction; RBAC/policy authorize each
  // tool call; budgets gate the run; every decision + the run are audited.
  const enterprise = await buildEnterprise(config);
  const runtime = await buildAuthedRuntime(
    config,
    enterprise.enabled ? { gateways: enterprise.gatewaySet } : {},
  );
  const providerId = args.flags.get("provider") ?? config.defaultProvider;
  if (!isProviderUsable(runtime, providerId)) {
    io.err(`nexus agent: provider "${providerId}" is not available (try -p mock -m mock-tools)\n`);
    return 1;
  }
  // A subprocess coding CLI (claude-code / codex) runs its OWN agentic loop and
  // emits file-edit/tool-result/approval chunks directly; it must go through the
  // single-dispatch engine path (NOT the native tool loop, which would try to
  // execute tools locally). Route it to `cmdCode`, which renders those chunks.
  if (runtime.registry.get(providerId).transport === "cli-subprocess") {
    return cmdCode(args, io);
  }

  const model = resolveRunModel(runtime, providerId, config, args.flags.get("model"));
  const system = args.flags.get("system") ?? defaultSystemPrompt();

  // Tool registry (built-in suite) + permission gate.
  const toolRegistry = new ToolRegistry();
  registerBuiltins(toolRegistry);
  // LSP-backed code-navigation tools (goto-def/refs/rename/diagnostics/hover),
  // enabled by config and degrading gracefully when no server is installed.
  registerLspTools(toolRegistry, config);
  // Wave-9 opt-in tool groups (web/browser/db/cloud/containers/ai): registered
  // only when enabled in `config.tools.enabledGroups`. Each keeps its permission
  // class, so the gate treats a network/write tool exactly like any other.
  registerToolGroups(toolRegistry, config);
  // Connect configured MCP servers and register their discovered tools so the
  // native tool loop can call them (gracefully — absent servers are a no-op).
  const mcp = await attachMcpTools(toolRegistry, config, runtime.secrets);
  // Wave-10 plugins (§9): discover + load, then apply their provider/tool
  // contributions into the SAME registries the builtins use — a plugin tool is
  // permission-gated exactly like a first-party one. Sandboxed + version-gated;
  // a bad plugin is isolated as a failure and never crashes the run.
  const plugins = await loadPlugins(config);
  await applyPluginsToRun(plugins, {
    providerRegistry: runtime.registry,
    toolRegistry,
  });
  const mode = resolvePermissionMode(args);
  const gate = buildToolGate(mode, config, { approveAskTier: true });

  // Context Engine over durable memory + the context-power layer (RAG retrieval
  // and the structural repo map, when enabled in config), injected into the engine.
  const cwd = args.flags.get("cwd") ?? process.cwd();
  const assembler = new EngineContextAssembler(
    new ContextEngine(),
    buildPowerSources(config, { cwd }),
    4000,
  );

  const maxTurnsRaw = args.flags.get("max-turns");
  const maxTurns = maxTurnsRaw ? Math.max(1, Number.parseInt(maxTurnsRaw, 10) || 8) : 8;

  const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
  const store = await openHistory({ enabled: config.history.enabled, dbPath: historyDb });
  const obs = buildObservability(config);
  const engine = createEngine({
    registry: runtime.registry,
    pricing: runtime.pricing,
    store,
    contextAssembler: assembler,
    ...(obs.emit ? { emit: obs.emit } : {}),
  });
  const session = await engine.openSession();
  const turn = session.newTurn({ messages: userText(prompt) });

  const run: RunSpec = {
    adapterId: providerId,
    model,
    input: turn.input,
    idempotencyKey: randomUUID(),
  };
  if (system !== undefined) run.params = { system };

  // Wave-10 hooks/webhooks (§24): a HookBus + WebhookDispatcher built from
  // config. Its guarded pre/post-tool interceptor rides the kernel's additive
  // seam so a `pre-tool` hook can veto a tool without ever crashing the run.
  const hooks = buildHooks(config, runtime.secrets);
  const runId = randomUUID();
  const agentOpts: AgentOptions = { tools: toolRegistry, gate, maxTurns, cwd };

  // Enterprise enforcement (§25), only when mode=on. The authorization
  // interceptor consults RBAC+policy before every tool call (fail-closed) and
  // records the decision; it composes AFTER the hooks interceptor so command
  // hooks still run. The acting principal is resolved from --principal / env /
  // config default.
  const principal = resolvePrincipal(enterprise, { id: args.flags.get("principal") });
  const entInterceptor = enterprise.enabled
    ? enterpriseToolInterceptor(enterprise, principal, toolRegistry, session.id)
    : undefined;
  const combined = composeInterceptors(hooks.toolInterceptor, entInterceptor);
  if (combined) agentOpts.toolInterceptor = combined;

  const onSigint = (): void => {
    void turn.scope.cancel("user");
  };
  process.once("SIGINT", onSigint);

  try {
    // Enterprise pre-run budget gate (§25 cost controls): project this run's
    // cost and deny when a governing budget would be exceeded. The decision is
    // audited inside enforceBudget; a deny aborts before any provider dispatch.
    if (enterprise.enabled) {
      enterprise.audit({
        actor: principal.id,
        action: "run.start",
        resource: `run:${runId}`,
        decision: "info",
        sessionId: session.id,
        details: { provider: providerId, model },
        ...(principal.roles[0] !== undefined ? { role: principal.roles[0] } : {}),
      });
      const projectedUsd = estimateRunUsd(config, providerId, model, prompt.length);
      const verdict = enterprise.enforceBudget(costPrincipalFor(principal, runId), projectedUsd, {
        sessionId: session.id,
      });
      if (verdict.decision === "deny") {
        io.err(`nexus agent: run blocked by budget — ${verdict.reason}\n`);
        return 1;
      }
      if (verdict.decision === "downgrade") {
        // §25 cost control: a governing budget with onExceed:"downgrade" reroutes
        // this over-budget run onto the cheaper model BEFORE dispatch. Without a
        // target the enforcer already returns "deny"; treat any target-less
        // downgrade defensively as a deny so spend can never exceed the limit.
        if (verdict.downgradeTo) {
          const target = parseDowngradeTarget(verdict.downgradeTo, providerId);
          run.adapterId = target.providerId;
          run.model = target.modelId;
          io.err(
            `nexus agent: budget downgrade — ${verdict.reason} (now ${target.providerId}/${target.modelId})\n`,
          );
        } else {
          io.err(`nexus agent: run blocked by budget — ${verdict.reason}\n`);
          return 1;
        }
      }
      if (verdict.decision === "warn") {
        io.err(`nexus agent: budget warning — ${verdict.reason}\n`);
      }
    }

    // session-start + pre-run lifecycle hooks. A `pre-run` veto (block) aborts
    // the run before any provider dispatch.
    if (hooks.active) {
      await hooks.emit("session-start", { sessionId: session.id, ts: Date.now() });
      const pre = await hooks.emit("pre-run", {
        sessionId: session.id,
        turnId: turn.context().turnId,
        runId,
        adapterId: providerId,
        model,
      });
      if (pre.blocked) {
        io.err(`nexus agent: run blocked by hook${pre.reason ? `: ${pre.reason}` : ""}\n`);
        return 1;
      }
    }

    const handle = dispatchAgent(run, turn.context(), agentOpts);

    if (output !== "json") {
      for await (const labeled of handle.events()) {
        for (const ev of projectLabeled(labeled, [providerId], true)) {
          renderStreaming(ev, output, io);
        }
      }
    }

    const outcome = await handle.outcome();

    // Enterprise post-run accrual + analytics + audit (§25): price the actual
    // usage against every governing budget and record it for `nexus usage`.
    if (enterprise.enabled && outcome.usage) {
      const pricing = runtime.pricing[model] ?? runtime.pricing[`${providerId}/${model}`];
      if (pricing) {
        recordRunSpend(enterprise, principal, outcome.usage, pricing, {
          provider: providerId,
          model,
          runId,
          sessionId: session.id,
        });
      }
    }

    if (hooks.active) {
      const winner = outcome.winner;
      await hooks.emit("post-run", {
        sessionId: session.id,
        turnId: turn.context().turnId,
        runId,
        status: winner?.status ?? (outcome.partial ? "error" : "ok"),
        ...(winner?.text !== undefined ? { text: winner.text } : {}),
        usage: outcome.usage,
      });
      if (outcome.partial) {
        await hooks.emit("on-error", {
          message: winner?.text ?? "agent run failed",
          where: "agent",
          sessionId: session.id,
        });
      }
    }

    if (output === "json") {
      io.out(`${JSON.stringify(toSingleJson(outcome))}\n`);
    } else if (output === "text") {
      renderTextTrailer(outcome, true, io);
      renderMetricsTrailer(obs, io);
    }
    return exitFor(outcome, true);
  } finally {
    if (hooks.active) {
      await hooks.emit("session-end", { sessionId: session.id, ts: Date.now() });
    }
    hooks.close();
    process.removeListener("SIGINT", onSigint);
    await obs.flush();
    await session.dispose();
    await engine.dispose();
    await mcp.close();
    store.close();
  }
}

/**
 * Run the OODA agent framework (§5) for a specialized role over the engine bus.
 * Wires a role-filtered tool set (built-ins + background-job control), a durable
 * TaskStore for the plan, the Context Engine, and the specialized-agent registry,
 * then streams the run's chunks (plan/reflect/replan/progress on stderr, the final
 * answer on stdout) exactly like every other command. Fully offline-verifiable
 * with `-p mock -m mock-tools`. Shared by `agent --role`, `plan`, and (via role
 * presets) any future role-driven command.
 */
async function runAgentOoda(
  args: ParsedArgs,
  io: Io,
  role: string,
  prompt: string,
  overrides: { maxStepsDefault?: number } = {},
): Promise<{ code: number; result: AgentRunResult | null }> {
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const runtime = await buildAuthedRuntime(config);
  const providerId = args.flags.get("provider") ?? config.defaultProvider;
  if (!isProviderUsable(runtime, providerId)) {
    io.err(`nexus agent: provider "${providerId}" is not available (try -p mock -m mock-tools)\n`);
    return { code: 1, result: null };
  }

  const registry = createAgentRegistry();
  if (!registry.has(role)) {
    io.err(`nexus agent: unknown role "${role}" (roles: ${AGENT_ROLES.join(", ")})\n`);
    return { code: 2, result: null };
  }
  const def = registry.get(role);

  const model = resolveRunModel(runtime, providerId, config, args.flags.get("model"));

  // Role-filtered tool set: the built-in suite plus the background-job control
  // tools, so a coder/tester role can launch and poll long-running commands.
  const toolRegistry = new ToolRegistry();
  registerBuiltins(toolRegistry);
  registerLspTools(toolRegistry, config);
  const processManager = new ProcessManager({ cwd: args.flags.get("cwd") ?? process.cwd() });
  for (const t of jobTools(processManager)) toolRegistry.register(t);
  // Wave-9 opt-in tool groups, gated by config (fully additive; absent groups are a no-op).
  registerToolGroups(toolRegistry, config);
  const mcp = await attachMcpTools(toolRegistry, config, runtime.secrets);
  // Wave-10 plugins (§9): apply provider/tool contributions into the live
  // registries this OODA run draws from (sandboxed, version-gated, isolated).
  const plugins = await loadPlugins(config);
  await applyPluginsToRun(plugins, { providerRegistry: runtime.registry, toolRegistry });

  // Permission gate: an explicit CLI flag wins; otherwise the role's own sandbox
  // class drives it, auto-approving writes/exec so a role can actually act.
  const flagMode: PermissionMode | undefined = args.bools.has("yolo")
    ? "full-access"
    : args.bools.has("approve")
      ? "workspace-write"
      : args.bools.has("read-only")
        ? "read-only"
        : undefined;
  const mode: PermissionMode = flagMode ?? def.permissionMode ?? "read-only";
  const gate = buildToolGate(mode, config, { approveAskTier: true });

  const cwd = args.flags.get("cwd") ?? process.cwd();
  const assembler = new EngineContextAssembler(
    new ContextEngine(),
    buildPowerSources(config, { cwd }),
    4000,
  );

  const maxStepsRaw = args.flags.get("max-steps");
  const maxSteps = maxStepsRaw
    ? Math.max(1, Number.parseInt(maxStepsRaw, 10) || def.maxSteps)
    : (overrides.maxStepsDefault ?? def.maxSteps);
  const maxTurnsRaw = args.flags.get("max-turns");
  const maxTurnsPerStep = maxTurnsRaw ? Math.max(1, Number.parseInt(maxTurnsRaw, 10) || 8) : 8;

  // Wave-10 hooks (§24): the guarded pre/post-tool interceptor threads into every
  // OODA step's native tool loop so a configured hook can veto a tool.
  const hooks = buildHooks(config, runtime.secrets);
  const store = openTasks({ file: ":memory:" });
  const deps: AgentDeps = {
    tools: toolRegistry,
    gate,
    store,
    registry,
    defaultModel: model,
    defaultAdapterId: providerId,
    contextAssembler: assembler,
    maxTurnsPerStep,
    ...(hooks.toolInterceptor ? { toolInterceptor: hooks.toolInterceptor } : {}),
  };

  const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
  const histStore = await openHistory({ enabled: config.history.enabled, dbPath: historyDb });
  const obs = buildObservability(config);
  const engine = createEngine({
    registry: runtime.registry,
    pricing: runtime.pricing,
    store: histStore,
    ...(obs.emit ? { emit: obs.emit } : {}),
  });
  const session = await engine.openSession();
  const turn = session.newTurn({ messages: userText(prompt) });

  const onSigint = (): void => {
    void turn.scope.cancel("user");
  };
  process.once("SIGINT", onSigint);

  try {
    const agent = new Agent(deps);
    const handle = agent.run(turn.context(), def, {
      goal: { objective: prompt },
      maxSteps,
      gate,
    });

    if (output !== "json") {
      for await (const labeled of handle.events()) {
        const chunk = labeled.chunk;
        // OODA coordinator chunks (step-start, plan-updated, reflect, progress,
        // stop) ride the reasoning channel as COMPLETE, self-contained narration
        // lines. Print each on its OWN stderr line — a readable step log —
        // instead of letting `renderStreaming` write the reasoning deltas with
        // no separators, which ran the phases together into one blob
        // ("Step 0…Plan updated…Goal satisfied…Progress: 100%Run finished…").
        if (isAgentMeta((chunk as { raw?: unknown }).raw)) {
          const line = chunk.type === "text-delta" ? chunk.text.trim() : "";
          if (line.length > 0) io.err(`${line}\n`);
          continue;
        }
        for (const ev of projectLabeled(labeled, [providerId], true)) {
          renderStreaming(ev, output, io);
        }
      }
    } else {
      for await (const _ of handle.events()) void _;
    }

    const result = await handle.result();
    if (output === "json") {
      io.out(`${JSON.stringify(agentResultJson(result))}\n`);
    }
    // Exit 0 when the loop terminated cleanly and produced an answer; only a hard
    // provider/framework error (or an empty, answerless run) is a failure.
    const code = result.stopReason === "error" || result.finalText.trim().length === 0 ? 1 : 0;
    return { code, result };
  } finally {
    hooks.close();
    process.removeListener("SIGINT", onSigint);
    await obs.flush();
    await session.dispose();
    await engine.dispose();
    await mcp.close();
    await processManager.killAll();
    histStore.close();
  }
}

/** Serialize an agent run result (role, stop reason, plan, progress) to JSON. */
function agentResultJson(r: AgentRunResult): Record<string, unknown> {
  return {
    role: r.role,
    goal: r.goal,
    stopReason: r.stopReason,
    goalMet: r.goalMet,
    steps: r.steps.length,
    finalText: r.finalText,
    progress: r.progress,
    plan: r.plan.map((t) => ({ id: t.id, title: t.title, status: t.status, parentId: t.parentId ?? null })),
    usage: {
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      costUsd: r.usage.costUsd ?? 0,
    },
  };
}

/** Human-readable trailer for an OODA agent run (stderr; stdout holds the answer). */
function renderAgentTrailer(r: AgentRunResult, io: Io): void {
  io.err(
    `[agent] role=${r.role} steps=${r.steps.length} stop=${r.stopReason} ` +
      `progress=${r.progress.percent}% goalMet=${r.goalMet}\n`,
  );
  io.err(
    `[usage] in=${r.usage.inputTokens} out=${r.usage.outputTokens} ` +
      `cost=$${(r.usage.costUsd ?? 0).toFixed(6)}\n`,
  );
}

// ── plan (planner role: turn an objective into a task plan) ────────────────────

/** Render a task plan as an indented tree (root tasks first, subtasks nested). */
function renderPlanTree(tasks: Task[], io: Io): void {
  const byParent = new Map<string | undefined, Task[]>();
  for (const t of tasks) {
    const key = t.parentId;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }
  const mark: Record<string, string> = {
    todo: "[ ]",
    in_progress: "[~]",
    blocked: "[x]",
    done: "[✓]",
    cancelled: "[-]",
  };
  const walk = (parent: string | undefined, depth: number): void => {
    for (const t of byParent.get(parent) ?? []) {
      io.out(`${"  ".repeat(depth)}${mark[t.status] ?? "[ ]"} ${t.title}\n`);
      walk(t.id, depth + 1);
    }
  };
  walk(undefined, 0);
}

export async function cmdPlan(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus plan: no objective (pass an argument or pipe stdin)\n");
    return 2;
  }
  // The planner role produces a verifiable, dependency-ordered task plan (§5·§15).
  const role = args.flags.get("role") ?? "planner";
  const res = await runAgentOoda(args, io, role, prompt);
  if (!res.result) return res.code;
  if (output === "text") {
    io.out(`plan for: ${prompt}\n\n`);
    if (res.result.plan.length > 0) renderPlanTree(res.result.plan, io);
    else io.out("(no tasks drafted)\n");
    renderAgentTrailer(res.result, io);
  }
  return res.code;
}

// ── task (task management for plans: §15) ──────────────────────────────────────

/** Open the durable task store the CLI persists plans/todos to. */
function openTaskStore(): TaskStore {
  return openTasks({ file: tasksFile() });
}

function taskLine(t: Task): string {
  const deps = t.deps.length > 0 ? ` deps=[${t.deps.join(",")}]` : "";
  const parent = t.parentId ? ` parent=${t.parentId}` : "";
  return `${t.id}  [${t.status}]${parent}${deps}  ${t.title}`;
}

export async function cmdTask(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);
  const store = openTaskStore();

  if (sub === "list") {
    const tasks = store.all();
    if (output === "json") {
      io.out(`${JSON.stringify(tasks)}\n`);
      return 0;
    }
    if (tasks.length === 0) {
      io.out("no tasks\n");
      return 0;
    }
    const p = store.progress();
    for (const t of tasks) io.out(`${taskLine(t)}\n`);
    io.err(`[progress] ${p.done}/${p.total} done (${p.percent}%)\n`);
    return 0;
  }

  if (sub === "add") {
    const title = args.positionals.slice(1).join(" ").trim() || (await readStdin()).trim();
    if (title.length === 0) {
      io.err("nexus task add <title> [--parent <id>] [--deps a,b]\n");
      return 2;
    }
    const input: { title: string; parentId?: string; deps?: string[] } = { title };
    const parent = args.flags.get("parent");
    if (parent) input.parentId = parent;
    const depsRaw = args.flags.get("deps");
    if (depsRaw) {
      const deps = depsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (deps.length > 0) input.deps = deps;
    }
    try {
      const t = store.create(input);
      io.out(output === "json" ? `${JSON.stringify(t)}\n` : `added ${t.id}  ${t.title}\n`);
      return 0;
    } catch (e) {
      io.err(`nexus task add: ${(e as Error).message}\n`);
      return 1;
    }
  }

  if (sub === "done" || sub === "start" || sub === "block" || sub === "cancel") {
    const id = args.positionals[1];
    if (!id) {
      io.err(`nexus task ${sub} <id>\n`);
      return 2;
    }
    if (!store.get(id)) {
      io.err(`no task "${id}"\n`);
      return 1;
    }
    const status = sub === "done" ? "done" : sub === "start" ? "in_progress" : sub === "block" ? "blocked" : "cancelled";
    const t = store.update(id, { status });
    io.out(`${t.id}  [${t.status}]  ${t.title}\n`);
    return 0;
  }

  if (sub === "rm") {
    const id = args.positionals[1];
    if (!id) {
      io.err("nexus task rm <id>\n");
      return 2;
    }
    const removed = store.delete(id);
    io.out(removed ? `removed ${id}\n` : `no task "${id}"\n`);
    return removed ? 0 : 1;
  }

  if (sub === "show") {
    const id = args.positionals[1];
    if (!id) {
      io.err("nexus task show <id>\n");
      return 2;
    }
    const t = store.get(id);
    if (!t) {
      io.err(`no task "${id}"\n`);
      return 1;
    }
    if (output === "json") io.out(`${JSON.stringify(t)}\n`);
    else {
      io.out(`${taskLine(t)}\n`);
      if (t.notes) io.out(`  notes: ${t.notes}\n`);
    }
    return 0;
  }

  if (sub === "clear") {
    for (const t of store.all()) store.delete(t.id);
    io.out("cleared all tasks\n");
    return 0;
  }

  io.err(`nexus task: unknown subcommand "${sub}" (use: list | add | start | done | block | cancel | rm | show | clear)\n`);
  return 2;
}

// ── jobs (terminal integration: background jobs · history · §13) ───────────────

export async function cmdJobs(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);

  if (sub === "list") {
    // Background jobs are tracked per-process by the ProcessManager; a fresh CLI
    // invocation has none. `jobs run` launches one within a single invocation.
    io.out("no background jobs\n");
    return 0;
  }

  if (sub === "run") {
    // Everything after `run` (past an optional `--`) is the argv to launch.
    const argv = args.positionals.slice(1);
    if (argv.length === 0) {
      io.err("nexus jobs run <command> [args...]\n");
      return 2;
    }
    const [command, ...rest] = argv;
    const cwd = args.flags.get("cwd") ?? process.cwd();
    const manager = new ProcessManager({ cwd });
    const history = new CommandHistory();
    const job = manager.spawn({ command: command as string, args: rest, cwd });
    // Stream live output; combined stdout+stderr goes to stdout so it is capturable.
    for await (const chunk of job.stream()) io.out(chunk.data);
    const info = await job.wait();
    history.append({
      command: info.command,
      args: info.args,
      cwd,
      exitCode: info.exitCode,
    });
    if (output === "json") {
      io.out(`${JSON.stringify({ id: info.id, status: info.status, exitCode: info.exitCode, signal: info.signal })}\n`);
    } else {
      io.err(`[job] ${info.status} exit=${info.exitCode ?? "null"}${info.signal ? ` signal=${info.signal}` : ""}\n`);
    }
    return info.status === "exited" && (info.exitCode ?? 1) === 0 ? 0 : 1;
  }

  if (sub === "history") {
    const history = new CommandHistory();
    const entries = history.recent(20);
    if (output === "json") {
      io.out(`${JSON.stringify(entries)}\n`);
      return 0;
    }
    if (entries.length === 0) {
      io.out("no command history\n");
      return 0;
    }
    for (const e of entries) {
      io.out(`${[e.command, ...e.args].join(" ")}  exit=${e.exitCode ?? "?"}\n`);
    }
    return 0;
  }

  if (sub === "pty") {
    // Report the interactive-PTY seam's availability (feature-detected; §13).
    const available = await isNodePtyAvailable();
    io.out(`pty: ${available ? "node-pty available (interactive shell)" : "child_process fallback (no native pty)"}\n`);
    return 0;
  }

  io.err(`nexus jobs: unknown subcommand "${sub}" (use: list | run | history | pty)\n`);
  return 2;
}

// ── tools (Wave-9 tool framework: list + run registered tools) ─────────────────

/** Render one tool's content blocks: text to stdout, non-text summarized. */
function renderToolContent(result: Awaited<ReturnType<typeof runTool>>, io: Io): void {
  for (const block of result.content) {
    if (block.type === "text") {
      io.out(block.text.endsWith("\n") ? block.text : `${block.text}\n`);
    } else if (block.type === "image") {
      const size = typeof block.data === "string" ? `${block.data.length} base64 chars` : block.data.url;
      io.out(`[image ${block.mime} — ${size}]\n`);
    } else {
      io.out(`[${block.type}]\n`);
    }
  }
}

/** A flat, listable row for one registered tool. */
interface ToolListRow {
  name: string;
  permission: string;
  group: string;
  enabled: boolean;
  integrationAvailable: boolean | null;
}

/** Build the per-tool rows for `tools list`, grouped by group with permissions. */
function toolListRows(reports: ToolGroupReport[], config: NexusConfig): ToolListRow[] {
  const rows: ToolListRow[] = [];
  for (const rep of reports) {
    // Building the group is offline + cheap and yields each tool's permission class.
    const perms = new Map<string, string>();
    for (const t of buildToolGroup(rep.group, config)) perms.set(t.name, t.permission);
    // A group "has an integration available" if it declares none (always usable)
    // or at least one declared integration is present.
    const integrationAvailable =
      rep.integrations.length === 0 ? null : rep.integrations.some((i) => i.available);
    for (const name of rep.toolNames) {
      rows.push({
        name,
        permission: perms.get(name) ?? "network",
        group: rep.group,
        enabled: rep.enabled,
        integrationAvailable,
      });
    }
  }
  return rows;
}

export async function cmdTools(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();

  if (sub === "list") {
    const reports = await reportToolGroups(config);
    const rows = toolListRows(reports, config);
    // Wave-10: plugin-contributed tools appear alongside the built-in groups so a
    // plugin's tool is discoverable exactly like a first-party one.
    const plugins = await loadPlugins(config);
    const pluginTools = plugins.loaded.flatMap((p) =>
      p.contributions.tools.map((t) => ({
        plugin: p.manifest.name,
        name: t.name,
        permission: t.permission,
        description: t.description ?? null,
      })),
    );
    if (output === "json") {
      io.out(
        `${JSON.stringify({
          groups: reports.map((r) => ({
            group: r.group,
            description: r.description,
            enabled: r.enabled,
            tools: r.toolNames,
            integrations: r.integrations,
          })),
          tools: rows,
          plugins: pluginTools,
        })}\n`,
      );
      return 0;
    }
    io.out("tool groups (enable per project via config.tools.enabledGroups):\n");
    for (const rep of reports) {
      const perms = new Map<string, string>();
      for (const t of buildToolGroup(rep.group, config)) perms.set(t.name, t.permission);
      const integ =
        rep.integrations.length === 0
          ? "always available (native)"
          : rep.integrations
              .map((i) => `${i.name}:${i.available ? "yes" : "no"}`)
              .join(", ");
      io.out(
        `\n  [${rep.enabled ? "on " : "off"}] ${rep.group} — ${rep.description}\n` +
          `        integrations: ${integ}\n`,
      );
      for (const name of rep.toolNames) {
        io.out(`        ${name}  (${perms.get(name) ?? "network"})\n`);
      }
    }
    if (pluginTools.length > 0) {
      io.out(`\n  [plugin] contributed tools\n`);
      for (const t of pluginTools) {
        io.out(`        ${t.name}  (${t.permission})  — via ${t.plugin}\n`);
      }
    }
    const enabledCount = reports.filter((r) => r.enabled).length;
    io.err(
      `[tools] ${rows.length} tool(s) across ${reports.length} group(s), ${enabledCount} enabled` +
        `${pluginTools.length > 0 ? `, ${pluginTools.length} plugin tool(s)` : ""}\n`,
    );
    return 0;
  }

  if (sub === "run") {
    const toolName = args.positionals[1];
    if (!toolName) {
      io.err("nexus tools run <tool> --args '<json>'\n");
      return 2;
    }

    // A registry the run can resolve from: built-ins + every ENABLED group +
    // plugin-contributed tools. A tool from a disabled group is deliberately
    // absent (opt-in per project).
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    registerToolGroups(registry, config);
    const runPlugins = await loadPlugins(config);
    await applyPluginsToRun(runPlugins, { toolRegistry: registry });

    if (!registry.has(toolName)) {
      const group = groupOfTool(toolName);
      if (group && !config.tools.enabledGroups.includes(group)) {
        io.err(
          `nexus tools run: "${toolName}" is in the "${group}" group, which is not enabled. ` +
            `Add "${group}" to config.tools.enabledGroups (e.g. \`nexus config set tools.enabledGroups '["${group}"]'\`).\n`,
        );
        return 1;
      }
      io.err(`nexus tools run: no registered tool "${toolName}"\n`);
      return 1;
    }
    const tool = registry.get(toolName);

    // Parse the JSON argument object from --args (or piped stdin). `--args` is a
    // repeatable flag in the shared grammar; for `tools run` the JSON is a single
    // token, so the last occurrence wins.
    const multiArgs = args.multi.get("args");
    const rawArgs =
      args.flags.get("args") ??
      (multiArgs && multiArgs.length > 0 ? multiArgs[multiArgs.length - 1] : undefined) ??
      (await readStdin()).trim();
    let input: unknown = {};
    if (rawArgs && rawArgs.length > 0) {
      try {
        input = JSON.parse(rawArgs);
      } catch (e) {
        io.err(`nexus tools run: --args is not valid JSON: ${(e as Error).message}\n`);
        return 2;
      }
    }

    // Ergonomic: `db_*` tools may reference a named connection from config
    // (`{"connection":"mydb", ...}`) instead of inlining the whole object.
    input = resolveNamedDbConnection(input, config);

    const mode = resolvePermissionMode(args);
    // Strict for a MANUAL tool run: read-only denies the network/ask tier (no
    // approveAskTier) so an explicit `nexus tools run` can't open a socket in
    // read-only — the agent loop opts in separately so the model can use MCP.
    const gate = buildToolGate(mode, config);
    const cwd = args.flags.get("cwd") ?? process.cwd();

    // Enforce the PermissionGate before running: a network/write/exec tool is
    // denied (or asks) outside full-access, exactly like the agent loop.
    const decision = await gate.check(tool, input);
    if (!decision.allowed) {
      if (output === "json") {
        io.out(`${JSON.stringify({ tool: toolName, ok: false, denied: true, reason: decision.reason })}\n`);
      } else {
        io.err(`nexus tools run: ${toolName} not permitted — ${decision.reason}\n`);
        io.err(`  hint: re-run with --approve (workspace-write) or --yolo (full-access), or allowlist it in config.tools.allow\n`);
      }
      return 1;
    }

    // Enterprise RBAC/policy authorization (§25), only when mode=on: the acting
    // principal must be granted the tool's action (read/write/exec/network →
    // RBAC verb). Fail-closed + audited. Denies BEFORE the tool runs.
    const enterprise = await buildEnterprise(config);
    if (enterprise.enabled) {
      const principal = resolvePrincipal(enterprise, { id: args.flags.get("principal") });
      const action = actionForToolPermission(tool.permission);
      const authz = enterprise.authorizeAndAudit(principal, action, `tool:${toolName}`, undefined, {
        details: { via: "tools-run" },
      });
      if (!authz.allowed) {
        if (output === "json") {
          io.out(`${JSON.stringify({ tool: toolName, ok: false, denied: true, rbac: true, reason: authz.reason })}\n`);
        } else {
          io.err(`nexus tools run: ${toolName} denied by enterprise policy — ${authz.reason}\n`);
        }
        return 1;
      }
    }

    const ctrl = new AbortController();
    const onSigint = (): void => ctrl.abort();
    process.once("SIGINT", onSigint);
    try {
      const ctx = { signal: ctrl.signal, cwd };
      const timeoutMs = tool.timeoutMs;
      const result = timeoutMs
        ? await withToolTimeout(runTool(tool, input, ctx), timeoutMs, ctrl)
        : await runTool(tool, input, ctx);
      if (output === "json") {
        io.out(
          `${JSON.stringify({
            tool: toolName,
            group: groupOfTool(toolName) ?? null,
            permission: tool.permission,
            ok: !result.isError,
            content: result.content,
          })}\n`,
        );
      } else {
        renderToolContent(result, io);
        io.err(`[tool] ${toolName} (${tool.permission}) — ${result.isError ? "error" : "ok"}\n`);
      }
      return result.isError ? 1 : 0;
    } catch (e) {
      io.err(`nexus tools run: ${toolName} failed — ${(e as Error).message}\n`);
      return 1;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }

  io.err(`nexus tools: unknown subcommand "${sub}" (use: list | run)\n`);
  return 2;
}

/**
 * Substitute a named db connection: when a `db_*` argument object carries
 * `connection` as a STRING, replace it with the matching object from
 * `config.tools.db.connections`. A missing name is left as-is so the tool
 * surfaces a clear validation error.
 */
function resolveNamedDbConnection(input: unknown, config: NexusConfig): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const o = input as Record<string, unknown>;
  if (typeof o.connection !== "string") return input;
  const named = config.tools.db.connections[o.connection];
  if (!named) return input;
  return { ...o, connection: named };
}

/** Race a tool run against its declared timeout, aborting the run on timeout. */
async function withToolTimeout(
  run: Promise<Awaited<ReturnType<typeof runTool>>>,
  timeoutMs: number,
  ctrl: AbortController,
): Promise<Awaited<ReturnType<typeof runTool>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`tool timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── code (subprocess coding-CLI agents: claude-code / codex) ───────────────────

/**
 * Drive a subprocess coding CLI (claude-code / codex) through the SAME engine
 * path as every other provider. The wrapped CLI runs its own agentic loop and
 * streams `file-edit` / `tool-result` / `approval` chunks, which project to the
 * canonical `UiEvent`s and render here (diffs + tool activity on stderr, the
 * answer on stdout). When the CLI is not installed the command degrades with a
 * clear message and exits 1 — it never spawns or crashes.
 */
export async function cmdCode(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus code: no task (pass an argument or pipe stdin)\n");
    return 2;
  }

  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  // `--agent` is the natural flag for `code`; `--provider` also works.
  const providerId = args.flags.get("agent") ?? args.flags.get("provider") ?? "claude-code";
  if (!runtime.registry.has(providerId)) {
    io.err(`nexus code: agent "${providerId}" is not available (try --agent claude-code | codex)\n`);
    return 1;
  }
  // Graceful "not installed": the adapter is registered, but the binary is off
  // PATH — report and exit without spawning.
  const status = runtime.statuses.find((s) => s.id === providerId);
  if (status && !status.available) {
    io.err(`nexus code: ${providerId} — ${status.detail ?? "not installed"}\n`);
    return 1;
  }

  const model = resolveRunModel(runtime, providerId, config, args.flags.get("model"));
  const system = args.flags.get("system");
  const template: RunTemplate = { adapterId: providerId, model };
  if (system !== undefined) template.params = { system };

  const outcome = await runOrchestration({
    kind: "single",
    templates: [template],
    input: userText(prompt),
    registry: runtime.registry,
    pricing: runtime.pricing,
    config,
    output,
    io,
  });
  return exitFor(outcome, true);
}

// ── memory ────────────────────────────────────────────────────────────────────

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function asTier(v: string | undefined): MemoryTier | undefined {
  return v === "short" || v === "long" || v === "knowledge" ? v : undefined;
}

export async function cmdMemory(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);
  const store = openMemory();

  if (sub === "list") {
    const tier = asTier(args.flags.get("tier"));
    const items = store.list(tier ? { tier } : {});
    if (output === "json") {
      io.out(`${JSON.stringify(items)}\n`);
      return 0;
    }
    if (items.length === 0) {
      io.out("no memory items\n");
      return 0;
    }
    for (const it of items) {
      io.out(`${it.id}  ${it.tier}/${it.kind}  ${firstLine(it.text)}\n`);
    }
    return 0;
  }

  if (sub === "add") {
    const inline = args.positionals.slice(1).join(" ").trim();
    const text = inline.length > 0 ? inline : (await readStdin()).trim();
    if (text.length === 0) {
      io.err("nexus memory add <text> [--tier long|knowledge] [--kind note] [--tags a,b]\n");
      return 2;
    }
    const put: MemoryPut = {
      tier: asTier(args.flags.get("tier")) ?? "long",
      kind: args.flags.get("kind") ?? "note",
      text,
    };
    const tags = args.flags.get("tags");
    if (tags) {
      const parsed = tags.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (parsed.length > 0) put.tags = parsed;
    }
    const item = store.put(put);
    io.out(`added ${item.id} (${item.tier}/${item.kind})\n`);
    return 0;
  }

  if (sub === "get") {
    const id = args.positionals[1];
    if (!id) {
      io.err("nexus memory get <id>\n");
      return 2;
    }
    const item = store.get(id);
    if (!item) {
      io.err(`no memory item "${id}"\n`);
      return 1;
    }
    if (output === "json") {
      io.out(`${JSON.stringify(item)}\n`);
    } else {
      io.out(`${item.id}  ${item.tier}/${item.kind}\n${item.text}\n`);
    }
    return 0;
  }

  if (sub === "rm") {
    const id = args.positionals[1];
    if (!id) {
      io.err("nexus memory rm <id>\n");
      return 2;
    }
    const removed = store.delete(id);
    io.out(removed ? `removed ${id}\n` : `no memory item "${id}"\n`);
    return removed ? 0 : 1;
  }

  if (sub === "ingest") {
    const result = ingestInstructionFiles(store, { cwd: process.cwd() });
    if (output === "json") {
      io.out(`${JSON.stringify({ files: result.files, count: result.items.length })}\n`);
      return 0;
    }
    io.out(`ingested ${result.items.length} instruction file(s)\n`);
    for (const f of result.files) io.out(`  ${f}\n`);
    return 0;
  }

  io.err(`nexus memory: unknown subcommand "${sub}"\n`);
  return 2;
}

// ── compare ───────────────────────────────────────────────────────────────────

interface Backend {
  provider: string;
  model?: string;
}

function parseBackends(args: ParsedArgs): Backend[] {
  const raw = args.multi.get("backend") ?? [];
  return raw.map((entry) => {
    const idx = entry.indexOf(":");
    if (idx < 0) return { provider: entry };
    return { provider: entry.slice(0, idx), model: entry.slice(idx + 1) };
  });
}

export async function cmdCompare(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus compare: no prompt\n");
    return 2;
  }

  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  const backends = parseBackends(args);
  if (backends.length < 2) {
    io.err("nexus compare: need at least two -b/--backend providers\n");
    return 2;
  }

  const templates: RunTemplate[] = [];
  for (const b of backends) {
    if (!runtime.registry.has(b.provider)) {
      io.err(`nexus compare: provider "${b.provider}" not available\n`);
      return 1;
    }
    templates.push({
      adapterId: b.provider,
      model: resolveRunModel(runtime, b.provider, config, b.model),
    });
  }

  const outcome = await runOrchestration({
    kind: "compare",
    templates,
    input: userText(prompt),
    registry: runtime.registry,
    pricing: runtime.pricing,
    config,
    output,
    io,
  });
  return exitFor(outcome, false);
}

// ── race / consensus / chain (multi-lane orchestration) ──────────────────────

/** Serialize a settled orchestration outcome (race/consensus/chain) to JSON. */
function toOrchestrationJson(outcome: OrchestrationOutcome): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    kind: outcome.kind,
    partial: outcome.partial,
    winner: outcome.winner ? runJson(outcome.winner) : null,
    runs: outcome.runs.map(runJson),
    usage: {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costUsd: outcome.usage.costUsd ?? 0,
    },
  };
  if (outcome.merged) {
    obj.merged = {
      text: outcome.merged.text ?? null,
      rationale: outcome.merged.rationale,
      pickedFrom: outcome.merged.pickedFrom?.runId ?? null,
      scores: outcome.merged.scores,
    };
  }
  return obj;
}

/** Human-readable trailer for a settled orchestration outcome. */
function renderOrchestrationText(outcome: OrchestrationOutcome, io: Io): void {
  // Each lane as its own labeled block first, so the per-provider answers are
  // readable and never interleaved. Then the settled winner / merged result.
  renderLaneBlocks(outcome.runs, io);

  const w = outcome.winner;
  io.out(
    `${outcome.kind}${w ? ` — winner ${w.adapterId}:${w.model}` : " — no winner"}` +
      `${outcome.partial ? " (partial)" : ""}\n`,
  );
  const answer = outcome.merged?.text ?? w?.text;
  if (answer) io.out(`\n${answer}\n`);

  renderLaneSummary(outcome.runs, io, w?.runId);
  io.err(
    dimErr(
      `[usage] in=${outcome.usage.inputTokens} out=${outcome.usage.outputTokens} ` +
        `cost=$${(outcome.usage.costUsd ?? 0).toFixed(6)}\n`,
    ),
  );
}

interface MultiLaneOptions {
  spec: OrchestrationSpec;
  /** Per-lane display labels (`provider:model`), used to key projected UiEvents. */
  laneLabels: string[];
  registry: Runtime["registry"];
  pricing: Runtime["pricing"];
  config: NexusConfig;
  output: OutputMode;
  io: Io;
}

/**
 * Dispatch a race/consensus/chain spec and render it in the requested mode:
 * `ndjson` streams every projected (lane-keyed) UiEvent; `text`/`json` print a
 * settled trailer. The offline default judge keeps race-best/consensus fully
 * exercisable with the mock provider.
 */
async function runMultiLane(opts: MultiLaneOptions): Promise<OrchestrationOutcome> {
  const { spec, laneLabels, registry, pricing, config, output, io } = opts;
  const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
  const store = await openHistory({ enabled: config.history.enabled, dbPath: historyDb });
  const obs = buildObservability(config);
  const engine = createEngine({ registry, pricing, store, ...(obs.emit ? { emit: obs.emit } : {}) });
  const session = await engine.openSession();
  const turn = session.newTurn({ messages: [] });

  const onSigint = (): void => {
    void turn.scope.cancel("user");
  };
  process.once("SIGINT", onSigint);

  try {
    const handle = dispatch(spec, turn.context());
    if (output === "ndjson") {
      for await (const labeled of handle.events()) {
        for (const ev of projectLabeled(labeled, laneLabels, false)) {
          io.out(`${JSON.stringify(ev)}\n`);
        }
      }
    } else {
      for await (const _ of handle.events()) void _;
    }
    const outcome = await handle.outcome();
    if (output === "json") io.out(`${JSON.stringify(toOrchestrationJson(outcome))}\n`);
    else if (output === "text") {
      renderOrchestrationText(outcome, io);
      renderMetricsTrailer(obs, io);
    }
    return outcome;
  } finally {
    process.removeListener("SIGINT", onSigint);
    await obs.flush();
    await session.dispose();
    await engine.dispose();
    store.close();
  }
}

/**
 * Resolve `-b` backends into RunSpecs + lane labels. On an error the message is
 * printed and the intended exit code is returned as a number (2 = usage error,
 * 1 = provider unavailable); callers `typeof`-check the result.
 */
function backendRuns(
  args: ParsedArgs,
  runtime: Runtime,
  config: NexusConfig,
  prompt: string,
  io: Io,
  command: string,
): { runs: RunSpec[]; laneLabels: string[] } | number {
  const backends = parseBackends(args);
  if (backends.length < 2) {
    io.err(`nexus ${command}: need at least two -b/--backend providers\n`);
    return 2;
  }
  const runs: RunSpec[] = [];
  const laneLabels: string[] = [];
  for (const b of backends) {
    if (!runtime.registry.has(b.provider)) {
      io.err(`nexus ${command}: provider "${b.provider}" not available\n`);
      return 1;
    }
    const model = resolveRunModel(runtime, b.provider, config, b.model);
    runs.push({ adapterId: b.provider, model, input: userText(prompt), idempotencyKey: randomUUID() });
    laneLabels.push(`${b.provider}:${model}`);
  }
  return { runs, laneLabels };
}

export async function cmdRace(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus race: no prompt\n");
    return 2;
  }
  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  const resolved = backendRuns(args, runtime, config, prompt, io, "race");
  if (typeof resolved === "number") return resolved;

  const modeRaw = args.flags.get("mode");
  const mode: "first" | "best" = modeRaw === "best" ? "best" : "first";
  // race best is judged (offline default rubric); race first settles on the winner.
  const spec: OrchestrationSpec =
    mode === "best"
      ? { kind: "race", mode, runs: resolved.runs, judge: { domain: "chat" } }
      : { kind: "race", mode, runs: resolved.runs };

  const outcome = await runMultiLane({
    spec,
    laneLabels: resolved.laneLabels,
    registry: runtime.registry,
    pricing: runtime.pricing,
    config,
    output,
    io,
  });
  return outcome.winner && outcome.winner.status === "ok" ? 0 : 1;
}

export async function cmdConsensus(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus consensus: no prompt\n");
    return 2;
  }
  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  const resolved = backendRuns(args, runtime, config, prompt, io, "consensus");
  if (typeof resolved === "number") return resolved;

  const judgeModel = args.flags.get("judge");
  const strategyRaw = args.flags.get("strategy");
  const strategy: JudgeSpec["strategy"] =
    strategyRaw === "vote" || strategyRaw === "rank" ? strategyRaw : "merge";
  const judge: JudgeSpec = { domain: "chat", strategy, ...(judgeModel ? { model: judgeModel } : {}) };
  const spec: OrchestrationSpec = { kind: "consensus", judge, runs: resolved.runs };

  const outcome = await runMultiLane({
    spec,
    laneLabels: resolved.laneLabels,
    registry: runtime.registry,
    pricing: runtime.pricing,
    config,
    output,
    io,
  });
  // Consensus succeeds when the quorum was met and a merged answer was produced.
  return outcome.merged ? 0 : 1;
}

/** The default offline preset: plan → edit → review, all over one provider. */
const CHAIN_PRESET: ReadonlyArray<{ name: string; mockModel: string }> = [
  { name: "plan", mockModel: "mock-fast" },
  { name: "edit", mockModel: "mock-smart" },
  { name: "review", mockModel: "mock-fast" },
];

export async function cmdChain(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const prompt = await readPrompt(args);
  if (prompt.length === 0) {
    io.err("nexus chain: no prompt\n");
    return 2;
  }
  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  const provider = args.flags.get("provider") ?? "mock";

  const stages: ChainStage[] = [];
  const laneLabels: string[] = [];
  const stagesFlag = args.flags.get("stages");

  if (stagesFlag) {
    // Explicit stage spec: "provider:model,provider:model,…".
    const parts = stagesFlag.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (parts.length === 0) {
      io.err("nexus chain: --stages needs at least one 'provider[:model]' entry\n");
      return 2;
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const idx = part.indexOf(":");
      const prov = idx < 0 ? part : part.slice(0, idx);
      const model = idx < 0 ? undefined : part.slice(idx + 1);
      if (!runtime.registry.has(prov)) {
        io.err(`nexus chain: provider "${prov}" not available\n`);
        return 1;
      }
      const m = resolveRunModel(runtime, prov, config, model);
      stages.push({
        name: `stage${i + 1}`,
        run: { adapterId: prov, model: m, input: i === 0 ? userText(prompt) : [], idempotencyKey: randomUUID() },
      });
      laneLabels.push(`${prov}:${m}`);
    }
  } else {
    // Default plan → edit → review preset over the chosen provider (mock offline).
    if (!runtime.registry.has(provider)) {
      io.err(`nexus chain: provider "${provider}" not available\n`);
      return 1;
    }
    for (let i = 0; i < CHAIN_PRESET.length; i++) {
      const def = CHAIN_PRESET[i]!;
      const m = resolveRunModel(runtime, provider, config, provider === "mock" ? def.mockModel : undefined);
      stages.push({
        name: def.name,
        run: { adapterId: provider, model: m, input: i === 0 ? userText(prompt) : [], idempotencyKey: randomUUID() },
      });
      laneLabels.push(`${provider}:${m}`);
    }
  }

  const spec: OrchestrationSpec = { kind: "chain", stages };
  const outcome = await runMultiLane({
    spec,
    laneLabels,
    registry: runtime.registry,
    pricing: runtime.pricing,
    config,
    output,
    io,
  });
  // A chain "passes" when every stage ran and succeeded (no early stop).
  return outcome.partial ? 1 : 0;
}

// ── route (declarative routing: explain | test) ──────────────────────────────

/** Parse `--optimize` into a valid axis (default `cost`). */
function parseOptimize(raw: string | undefined): RouteOptimize {
  return raw === "latency" || raw === "quality" || raw === "local" || raw === "explicit" || raw === "cost"
    ? raw
    : "cost";
}

/** Build a core RouteRule from the route command's flags. */
function ruleFromArgs(args: ParsedArgs): RouteRule {
  const rule: RouteRule = { optimize: parseOptimize(args.flags.get("optimize")) };
  const allow = args.multi.get("allow");
  if (allow && allow.length > 0) rule.allow = allow;
  const deny = args.multi.get("deny");
  if (deny && deny.length > 0) rule.deny = deny;
  const fallback = args.multi.get("fallback");
  if (fallback && fallback.length > 0) rule.fallback = fallback;
  return rule;
}

/** Map a `--capability` name to a capability predicate (undefined = no filter). */
function capabilityPredicate(cap: string | undefined): ((c: Capabilities) => boolean) | undefined {
  switch (cap) {
    case "vision":
      return (c) => c.vision;
    case "code-edit":
      return (c) => c.fileEdit;
    case "shell":
      return (c) => c.shellExec;
    case "tools":
      return (c) => c.tools;
    case "chat":
      return (c) => c.streaming || c.models.length > 0;
    default:
      return undefined;
  }
}

function candidateLabel(c: RouteCandidate): string {
  return `${c.providerId}/${c.modelId}`;
}

export async function cmdRoute(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "explain";
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  const rule = ruleFromArgs(args);
  const meta = routerMetadataFrom(config);
  const capNeeded = capabilityPredicate(args.flags.get("capability"));

  if (sub === "explain") {
    const router = new Router(meta);
    const candidates = router.select(rule, {
      registry: runtime.registry,
      ...(capNeeded ? { capabilitiesNeeded: capNeeded } : {}),
    });
    const chosen = candidates[0];
    if (output === "json") {
      io.out(
        `${JSON.stringify({
          optimize: rule.optimize,
          chosen: chosen ? { providerId: chosen.providerId, modelId: chosen.modelId, reason: chosen.reason } : null,
          candidates: candidates.map((c) => ({ providerId: c.providerId, modelId: c.modelId, reason: c.reason })),
        })}\n`,
      );
      return chosen ? 0 : 1;
    }
    io.out(`route explain (optimize=${rule.optimize})\n`);
    if (!chosen) {
      io.out("no candidate matches the rule\n");
      return 1;
    }
    io.out(`chosen: ${candidateLabel(chosen)} — ${chosen.reason}\n`);
    io.out("candidates:\n");
    candidates.forEach((c, i) => io.out(`  ${i + 1}. ${candidateLabel(c)} (${c.reason})\n`));
    return 0;
  }

  if (sub === "test") {
    const prompt = (args.positionals.slice(1).join(" ").trim() || (await readStdin()).trim()).trim();
    if (prompt.length === 0) {
      io.err("nexus route test <prompt> [--optimize ..] [--allow ..] [--fallback ..] [--retries n]\n");
      return 2;
    }
    // Preview the candidate order (so `route test` also explains the decision).
    // Cache-affinity hook: reorder to prefer the session's last-used provider so
    // its prompt-cache stays warm — a soft pin that never removes a candidate, so
    // live failover still works (system-spec §17). A session key stable across a
    // repeated invocation lets the pin build up.
    const rawCandidates = new Router(meta).select(rule, {
      registry: runtime.registry,
      ...(capNeeded ? { capabilitiesNeeded: capNeeded } : {}),
    });
    const affinityKey = `route:${config.defaultProvider}`;
    const previewCandidates = preferAffineProvider(config, affinityKey, rawCandidates);
    if (output !== "json" && output !== "ndjson") {
      io.err(`[route] candidates: ${previewCandidates.map(candidateLabel).join(" → ") || "(none)"}\n`);
    }

    const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
    const store = await openHistory({ enabled: config.history.enabled, dbPath: historyDb });
    // Optional retry override (default 3) — `--retries 1` forces cross-provider
    // failover instead of same-provider recovery, useful with mock-flaky.
    const retriesRaw = args.flags.get("retries");
    const retryPolicy: RetryPolicy | undefined =
      retriesRaw !== undefined
        ? { ...DEFAULT_RETRY_POLICY, maxAttempts: Math.max(1, Number.parseInt(retriesRaw, 10) || 1) }
        : undefined;
    const engine = createEngine({
      registry: runtime.registry,
      pricing: runtime.pricing,
      store,
      ...(retryPolicy ? { retryPolicy } : {}),
    });
    const session = await engine.openSession();
    const turn = session.newTurn({ messages: userText(prompt) });

    const failovers: string[] = [];
    const onSigint = (): void => {
      void turn.scope.cancel("user");
    };
    process.once("SIGINT", onSigint);

    try {
      const handle = dispatchRoute(
        {
          rule,
          input: turn.input,
          idempotencyKey: randomUUID(),
          meta,
          ...(capNeeded ? { capabilitiesNeeded: capNeeded } : {}),
        },
        turn.context(),
        {
          // Collect the hand-offs for the JSON/trailer; the visible per-hop line
          // is rendered from the projected `failover` UiEvent (run-start trail).
          onFailover: (e: FailoverEvent) => {
            failovers.push(`${e.from.providerId}→${e.to.providerId}`);
          },
        },
      );

      if (output !== "json") {
        for await (const labeled of handle.events()) {
          for (const ev of projectLabeled(labeled, ["main"], true)) renderStreaming(ev, output, io);
        }
      }
      const outcome = await handle.outcome();
      const w = outcome.winner ?? outcome.runs[0];
      // Re-pin the session to whichever provider actually answered (may have
      // changed via live failover) so the next run prefers its warm prompt-cache.
      if (config.cache.affinity && w && w.status === "ok") {
        sessionAffinity().recordUse(affinityKey, w.adapterId);
      }
      if (output === "json") {
        io.out(
          `${JSON.stringify({
            ...(w ? runJson(w) : { status: "error", text: "" }),
            failovers,
          })}\n`,
        );
      } else if (output === "text") {
        io.err(
          `[route] answered by ${w?.adapterId ?? "?"}:${w?.model ?? "?"}` +
            `${failovers.length > 0 ? ` (failover: ${failovers.join(", ")})` : ""}\n`,
        );
      }
      return w && w.status === "ok" ? 0 : 1;
    } finally {
      process.removeListener("SIGINT", onSigint);
      await session.dispose();
      await engine.dispose();
      store.close();
    }
  }

  io.err(`nexus route: unknown subcommand "${sub}" (use: explain | test)\n`);
  return 2;
}

// ── chat (line REPL, headless-safe) ──────────────────────────────────────────

export async function cmdChat(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const config = await loadEffectiveConfig();
  const runtime = await buildAuthedRuntime(config);
  // Provider resolution mirrors `ask` / `tui` exactly: an explicit `-p` stays a
  // hard error when unavailable, but the DEFAULT path degrades gracefully to an
  // available provider (mock) with a one-line notice — `chat` must never
  // dead-end with "provider anthropic not available" on a fresh machine.
  const explicitProvider = args.flags.get("provider");
  let providerId: string;
  if (explicitProvider !== undefined) {
    if (!isProviderUsable(runtime, explicitProvider)) {
      io.err(`nexus chat: provider "${explicitProvider}" is not available (try -p mock)\n`);
      return 1;
    }
    providerId = explicitProvider;
  } else {
    const resolved = resolveDefaultProviderForRun(runtime, config, io);
    if (!resolved) return 1;
    providerId = resolved;
  }
  const model = resolveRunModel(runtime, providerId, config, args.flags.get("model"));

  const input = (await readStdin()).trim();
  const lines = input.length > 0 ? input.split(/\r?\n/).filter((l) => l.trim().length > 0) : [];
  if (lines.length === 0) {
    io.err("nexus chat: interactive REPL requires a TTY; pipe lines for headless use\n");
    return 0;
  }

  const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
  const store = await openHistory({ enabled: config.history.enabled, dbPath: historyDb });
  const engine = createEngine({ registry: runtime.registry, pricing: runtime.pricing, store });
  const session = await engine.openSession();
  try {
    for (const line of lines) {
      // One session across every line: `turn.input` already carries the prior
      // turns (engine-owned transcript), so line N+1 remembers line N.
      const turn = session.newTurn({ prompt: line });
      const handle = dispatch(
        { kind: "single", run: { adapterId: providerId, model, input: turn.input, idempotencyKey: randomUUID() } },
        turn.context(),
      );
      for await (const labeled of handle.events()) {
        for (const ev of projectLabeled(labeled, [providerId], true)) {
          if (ev.t === "text") io.out(ev.delta);
        }
      }
      turn.record(await handle.outcome());
      io.out("\n");
    }
    return 0;
  } finally {
    await session.dispose();
    await engine.dispose();
    store.close();
  }
}

// ── tui (rich interactive terminal UI) ───────────────────────────────────────

/**
 * Parse `--preset` to a foundation preset id. The DEFAULT is the clean,
 * Claude-Code-style `conversation` surface; the old multi-pane dashboard is opt-in
 * via `--preset dashboard` (and `chat`/`agent`/`compare` remain available).
 */
function parsePreset(
  raw: string | undefined,
): "conversation" | "chat" | "agent" | "compare" | "dashboard" {
  return raw === "chat" || raw === "agent" || raw === "compare" || raw === "dashboard"
    ? raw
    : "conversation";
}

/** Real context window for the provider's model (engine-owned; drives the HUD). */
function contextWindowFor(registry: ProviderRegistry, providerId: string, model: string): number {
  try {
    const caps = registry.capabilitiesOf(providerId);
    const info = caps.models.find((m) => m.id === model) ?? caps.models[0];
    return info?.contextWindow ?? 200_000;
  } catch {
    return 200_000;
  }
}

/**
 * Launch the rich Ink TUI over a live engine. On a non-TTY / `TERM=dumb` /
 * too-narrow terminal `runTui` prints a one-line fallback and returns unmounted —
 * we never crash (hard rule 4). Every submitted turn dispatches through the same
 * engine + provider registry the headless commands use (single dispatch, or the
 * native agentic tool-loop in AGENT/AUTOPILOT mode).
 */
export async function cmdTui(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  // TTY guard first (hard rule 4): on a non-TTY / `TERM=dumb` / too-narrow
  // terminal print the one-line linear-mode fallback and exit 0 — before we
  // touch provider resolution, so an offline default provider never masks the
  // graceful degradation path.
  const caps = detectCapabilities();
  const decision = canMountTui(caps);
  if (!decision.ok) {
    io.out(`${decision.fallback ?? "TUI unavailable — linear mode."}\n`);
    return 0;
  }

  const config = await loadEffectiveConfig();
  const runtime = await buildAuthedRuntime(config);
  const explicitProvider = args.flags.get("provider");
  let providerId: string;
  if (explicitProvider !== undefined) {
    // An explicitly named provider stays a hard error when unavailable — only
    // the DEFAULT path (bare `nexus` / `nexus tui`) degrades gracefully.
    if (!isProviderUsable(runtime, explicitProvider)) {
      io.err(`nexus tui: provider "${explicitProvider}" is not available (try -p mock)\n`);
      return 1;
    }
    providerId = explicitProvider;
  } else {
    const resolved = resolveDefaultProviderForRun(runtime, config, io);
    if (!resolved) return 1;
    providerId = resolved;
  }
  const model = resolveRunModel(runtime, providerId, config, args.flags.get("model"));
  const system = args.flags.get("system") ?? defaultSystemPrompt();
  const themeId = args.flags.get("theme");
  const preset = parsePreset(args.flags.get("preset"));
  const contextMax = contextWindowFor(runtime.registry, providerId, model);

  // Durable run history + context assembly, shared by every turn from the TUI.
  const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
  const store = await openHistory({ enabled: config.history.enabled, dbPath: historyDb });
  const toolRegistry = new ToolRegistry();
  registerBuiltins(toolRegistry);
  // Register configured MCP servers' tools so the TUI's agent loop can call them.
  const mcp = await attachMcpTools(toolRegistry, config, runtime.secrets);
  const assembler = new EngineContextAssembler(
    new ContextEngine(),
    buildPowerSources(config, { cwd: process.cwd() }),
    4000,
  );

  const obs = buildObservability(config);
  const engine = createEngine({
    registry: runtime.registry,
    pricing: runtime.pricing,
    store,
    contextAssembler: assembler,
    ...(obs.emit ? { emit: obs.emit } : {}),
  });

  // Live model/provider selection: `/model` + `/provider` re-point these, so the
  // NEXT turn dispatches against the picked target (the TUI stays a pure renderer;
  // it only signals the switch — the engine dispatch still lives here).
  let activeProvider = providerId;
  let activeModel = model;

  // Static provider→model pairs, used ONLY as the curated fallback pool for the
  // `/model` picker (it scopes them to the active provider). The live path is
  // `listModelsFor` below, which queries the ACTIVE provider's real model list —
  // so the picker never shows the global cross-provider catalog.
  const modelChoices: { provider: string; model: string; hint?: string }[] = [];
  for (const pid of runtime.registry.ids()) {
    try {
      for (const m of runtime.registry.capabilitiesOf(pid).models) {
        modelChoices.push({
          provider: pid,
          model: m.id,
          ...(m.contextWindow ? { hint: `${Math.round(m.contextWindow / 1000)}k ctx` } : {}),
        });
      }
    } catch {
      // A provider that can't report capabilities simply contributes no models.
    }
  }
  const providerChoices = runtime.registry.ids().map((id) => ({ id }));
  const toolChoices = toolRegistry.list().map((t) => ({ name: t.name, description: t.description }));

  // Per-turn dispatch. AGENT/AUTOPILOT run the full tool loop. Plain CHAT ALSO
  // runs the agent tool-loop WHEN tools are available — builtins are always
  // registered and configured MCP servers (e.g. kyp-mem) are attached above, so
  // this is what lets the default conversation actually CALL those tools
  // (kyp-mem search/read/write) and read the workspace, instead of a tool-less
  // single stream where the model can only say "I don't have that tool".
  //
  // Gate policy (read-only maps: read=allow, write=deny, exec=deny, network=ask):
  //   - CHAT/AGENT → read-only + an approver for the "ask" tier, so MCP
  //     ("network") tools run but fs-writes ("write") and shell/destructive
  //     ("exec") stay HARD-denied until the user switches to AUTOPILOT.
  //   - AUTOPILOT → workspace-write + approver (adds file writes).
  // With no tools registered at all, CHAT stays a cheap single dispatch.
  const hasTools = toolRegistry.list().length > 0;
  // Reasoning-effort state for the `/effort` picker; only meaningful when the
  // active provider advertises reasoning (the picker reflects that).
  let activeEffort: "off" | "low" | "medium" | "high" = "off";
  let reasoningSupported = false;
  try {
    reasoningSupported = runtime.registry.capabilitiesOf(providerId).reasoning === true;
  } catch {
    reasoningSupported = false;
  }
  const dispatchTurn: TurnDispatcher = (input, ctx, mode) => {
    const run: RunSpec = { adapterId: activeProvider, model: activeModel, input, idempotencyKey: randomUUID() };
    if (system !== undefined) run.params = { system };
    // Apply the reasoning effort chosen via `/effort`, mapped to a thinking-token
    // budget so it affects providers that price/limit reasoning by tokens.
    if (activeEffort !== "off") {
      run.params = {
        ...(run.params ?? {}),
        reasoning: { enabled: true, effort: activeEffort, budgetTokens: EFFORT_BUDGET[activeEffort] },
      };
    }
    // A cli-subprocess provider (claude-code / codex) runs its OWN internal agent
    // loop and streams back the tool calls it already executed. Wrapping it in our
    // native tool loop would treat those as pending, re-execute them, and re-spawn
    // the CLI every turn (wrong output + repeated real side effects), so a
    // subprocess provider is NEVER routed through dispatchAgent — it dispatches
    // once and its own loop does the agentic work.
    let isSubprocess = false;
    try {
      isSubprocess = runtime.registry.get(activeProvider).transport === "cli-subprocess";
    } catch {
      isSubprocess = false;
    }
    const agentic =
      !isSubprocess && (mode === "AGENT" || mode === "AUTOPILOT" || (mode === "CHAT" && hasTools));
    if (agentic) {
      const gate =
        mode === "AUTOPILOT"
          ? new PermissionGate({ mode: "workspace-write", approve: () => true })
          : new PermissionGate({ mode: "read-only", approve: () => true });
      // A generous turn budget so the model can actually do agentic work (read
      // several files, retry a failed tool, chain MCP calls) before it must
      // answer. The final turn drops tools (see agentStream) so it always ends
      // with a real summary rather than running out of turns mid-exploration.
      const agentOpts: AgentOptions = { tools: toolRegistry, gate, maxTurns: 40, cwd: process.cwd() };
      return dispatchAgent(run, ctx, agentOpts);
    }
    return dispatch({ kind: "single", run }, ctx);
  };

  try {
    const result = await runTui(engine, {
      provider: providerId,
      model,
      preset,
      contextMax,
      sessionName: providerId,
      dispatchTurn,
      models: modelChoices,
      providers: providerChoices,
      tools: toolChoices,
      // Live, provider-scoped model discovery for the `/model` picker: query the
      // ACTIVE provider's real model list (adapter.listModels) with a curated
      // fallback — never the global catalog.
      listModelsFor: (pid: string) => listModelsForProvider(runtime, pid),
      onModelChange: (m, p) => {
        activeModel = m;
        if (p) activeProvider = p;
      },
      onProviderChange: (p) => {
        activeProvider = p;
      },
      // `/effort` picker: apply the chosen reasoning effort to the next turn, and
      // tell the TUI whether the active provider supports reasoning at all.
      onEffortChange: (e: string) => {
        if (e === "off" || e === "low" || e === "medium" || e === "high") activeEffort = e;
      },
      reasoningSupported,
      ...(system !== undefined ? { system } : {}),
      ...(themeId !== undefined ? { themeId } : {}),
    });
    if (!result.mounted) return 0; // graceful fallback already printed by runTui
    if (result.waitUntilExit) await result.waitUntilExit();
    return 0;
  } finally {
    await obs.flush();
    await engine.dispose();
    await mcp.close();
    store.close();
  }
}

// ── providers ─────────────────────────────────────────────────────────────────

export async function cmdProviders(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const config = await loadEffectiveConfig();

  if (sub === "list") {
    const runtime = await buildRuntime(config);
    const output = parseOutput(args);
    if (output === "json") {
      io.out(`${JSON.stringify(runtime.statuses)}\n`);
    } else {
      for (const s of runtime.statuses) {
        const mark = !s.available ? "-- " : s.needsKey ? "key" : "ok ";
        io.out(`${mark} ${s.id} (${s.kind})${s.detail ? ` — ${s.detail}` : ""}\n`);
      }
    }
    return 0;
  }

  if (sub === "add") {
    const id = args.positionals[1];
    const kind = args.flags.get("kind");
    const adapter = args.flags.get("adapter");
    if (!id || !kind || !adapter) {
      io.err("nexus providers add <id> --kind <kind> --adapter <pkg> [--base-url ..] [--api-key-ref ..]\n");
      return 2;
    }
    const current = readUserConfig() as Record<string, unknown>;
    const providers = Array.isArray(current.providers) ? [...(current.providers as unknown[])] : [];
    const entry: Record<string, unknown> = { id, kind, adapter };
    const baseUrl = args.flags.get("base-url");
    if (baseUrl) entry.baseUrl = baseUrl;
    const apiKeyRef = args.flags.get("api-key-ref");
    if (apiKeyRef) entry.apiKeyRef = apiKeyRef;
    const apiKeyEnv = args.flags.get("api-key-env");
    if (apiKeyEnv) entry.apiKeyEnv = apiKeyEnv;
    providers.push(entry);
    const next = { ...current, providers };
    const file = writeUserConfig(next);
    io.out(`added provider "${id}" → ${file}\n`);
    return 0;
  }

  io.err(`nexus providers: unknown subcommand "${sub}"\n`);
  return 2;
}

// ── models ────────────────────────────────────────────────────────────────────

/**
 * `nexus models [provider]` — list the models for ONE provider, scoped exactly
 * like the TUI `/model` picker: the target is the positional `[provider]`, else
 * `-p/--provider`, else `config.defaultProvider` (the ACTIVE provider). The list
 * comes from the SAME live-scoped runtime helper the picker uses
 * ({@link listModelsForProvider}) — the provider's REAL model endpoint via
 * `adapter.listModels()` when reachable, degrading gracefully to its curated
 * `capabilities().models` (no key / offline / no list endpoint). This is NOT the
 * old global cross-provider dump: it never leaks another provider's models. A
 * subprocess coding CLI whose model catalog is delegated to the vendor session
 * advertises no static models — reported honestly rather than invented.
 * `-o json` for scripting.
 */
export async function cmdModels(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  const output = parseOutput(args);

  // Target provider resolution mirrors the run commands:
  //   • an EXPLICIT provider (positional or `-p/--provider`) is a hard error when
  //     unavailable — naming a provider you can't use should fail clearly;
  //   • with NO explicit provider, resolve the ACTIVE default gracefully, falling
  //     back (to the offline `mock`) when the configured default isn't usable, so
  //     `nexus models` always lists SOMETHING instead of dead-ending a first-run
  //     user (same graceful policy as `nexus ask` / `nexus tui`).
  const explicit = args.positionals[0] ?? args.flags.get("provider");
  let target: string;
  if (explicit !== undefined) {
    if (!runtime.registry.has(explicit)) {
      io.err(`nexus models: provider "${explicit}" not available (see \`nexus providers list\`)\n`);
      return 1;
    }
    target = explicit;
  } else {
    const resolution = resolveDefaultProvider(runtime, config.defaultProvider);
    if (!resolution) {
      io.err("nexus models: no provider is available — sign in with `nexus login`.\n");
      return 1;
    }
    target = resolution.providerId;
  }

  const status = runtime.statuses.find((s) => s.id === target);
  const kind = status?.kind ?? "unknown";
  const available = status?.available ?? true;

  // Live, provider-scoped listing (adapter.listModels with curated fallback) —
  // the exact same source the TUI `/model` picker draws from.
  const rows = await listModelsForProvider(runtime, target);

  if (output === "json") {
    io.out(
      `${JSON.stringify({
        provider: target,
        kind,
        available,
        models: rows.map((r) => ({ id: r.model, ...(r.hint ? { hint: r.hint } : {}) })),
      })}\n`,
    );
    return 0;
  }

  const tag = available ? "" : " (unavailable)";
  if (rows.length === 0) {
    io.out(`${target} (${kind}) — no models advertised${tag}\n`);
    return 0;
  }
  io.out(`${target} (${kind})${tag}\n`);
  for (const r of rows) io.out(`  ${r.model}${r.hint ? `  (${r.hint})` : ""}\n`);
  return 0;
}

// ── mcp (declare, list, remove, and discover tools from MCP servers) ──────────

/** Parse repeated `--env K=V` flags into an env map. */
function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx > 0) env[p.slice(0, idx)] = p.slice(idx + 1);
  }
  return env;
}

/** A ready-to-use MCP server template addable by name alone (flags override). */
interface KnownMcpServer {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  description: string;
}

/**
 * Curated example MCP servers so `nexus mcp add <name>` works with zero flags —
 * the template supplies transport/command/args/env and any explicit flag the
 * user passes still overrides it. Defaults are portable (binary resolved on
 * PATH, vault under $HOME) and honor an already-exported env var when present.
 */
function knownMcpServers(): Record<string, KnownMcpServer> {
  return {
    "kyp-mem": {
      transport: "stdio",
      command: "kyp-mem",
      args: ["serve"],
      env: {
        KYP_VAULT:
          process.env.KYP_VAULT ?? join(homedir(), "Documents", "docs_and_memory", "memory"),
      },
      description: "KYP-MEM — Know Your Project persistent memory vault (stdio).",
    },
  };
}

export async function cmdMcp(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);

  if (sub === "add") {
    const name = args.positionals[1];
    if (!name) {
      io.err("nexus mcp add <name> --transport stdio --command <cmd> [--args a]... [--env K=V]...\n");
      io.err("nexus mcp add <name> --transport http|sse --url <url> [--bearer-ref <secret-ref>]\n");
      const known = Object.entries(knownMcpServers());
      if (known.length > 0) {
        io.err("\nknown servers (addable by name alone):\n");
        for (const [n, def] of known) io.err(`  ${n} — ${def.description}\n`);
      }
      return 2;
    }
    // A known server seeds transport/command/args/env; any explicit flag overrides.
    const known = knownMcpServers()[name];
    const transport = args.flags.get("transport") ?? known?.transport ?? "stdio";
    const candidate: Record<string, unknown> = {
      name,
      transport,
      enabled: !args.bools.has("disabled"),
    };
    if (transport === "stdio") {
      const command = args.flags.get("command") ?? known?.command;
      if (command) candidate.command = command;
      const argv = args.multi.get("args");
      const argsResolved = argv && argv.length > 0 ? argv : known?.args;
      if (argsResolved && argsResolved.length > 0) candidate.args = argsResolved;
      const env = { ...(known?.env ?? {}), ...parseEnvPairs(args.multi.get("env") ?? []) };
      if (Object.keys(env).length > 0) candidate.env = env;
    } else {
      const url = args.flags.get("url") ?? known?.url;
      if (url) candidate.url = url;
      const bearerRef = args.flags.get("bearer-ref");
      if (bearerRef) candidate.auth = { bearerRef };
    }

    // Validate against the real MCP schema BEFORE writing — a bad declaration
    // must fail loudly here, not brick every later command that re-parses it.
    const parsed = McpServerConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      io.err(`nexus mcp add: ${detail}\n`);
      return 2;
    }

    const current = readUserConfig() as Record<string, unknown>;
    const servers = Array.isArray(current.mcp) ? [...(current.mcp as unknown[])] : [];
    if (servers.some((s) => (s as { name?: string }).name === name)) {
      io.err(`nexus mcp add: server "${name}" already exists (rm it first)\n`);
      return 2;
    }
    servers.push(candidate);
    const file = writeUserConfig({ ...current, mcp: servers });
    io.out(`added mcp server "${name}" (${transport}) → ${file}\n`);
    return 0;
  }

  if (sub === "list") {
    const config = await loadEffectiveConfig();
    if (output === "json") {
      io.out(`${JSON.stringify(config.mcp)}\n`);
      return 0;
    }
    if (config.mcp.length === 0) {
      io.out("no mcp servers configured (nexus mcp add <name> ...)\n");
      return 0;
    }
    for (const s of config.mcp) {
      const target = s.transport === "stdio" ? `${s.command ?? "?"}${s.args.length ? ` ${s.args.join(" ")}` : ""}` : (s.url ?? "?");
      io.out(`${s.enabled ? "on " : "off"} ${s.name} (${s.transport}) — ${target}\n`);
    }
    return 0;
  }

  if (sub === "rm") {
    const name = args.positionals[1];
    if (!name) {
      io.err("nexus mcp rm <name>\n");
      return 2;
    }
    const current = readUserConfig() as Record<string, unknown>;
    const servers = Array.isArray(current.mcp) ? (current.mcp as unknown[]) : [];
    const next = servers.filter((s) => (s as { name?: string }).name !== name);
    if (next.length === servers.length) {
      io.err(`nexus mcp rm: no server "${name}"\n`);
      return 1;
    }
    const file = writeUserConfig({ ...current, mcp: next });
    io.out(`removed mcp server "${name}" → ${file}\n`);
    return 0;
  }

  if (sub === "tools") {
    const config = await loadEffectiveConfig();
    const runtime = await buildRuntime(config);
    const mcp = await startMcpSession(config, runtime.secrets);
    try {
      if (output === "json") {
        io.out(
          `${JSON.stringify({
            servers: mcp.reports,
            tools: mcp.tools.map((t) => ({
              server: t.server,
              name: t.descriptor.name,
              description: t.descriptor.description ?? null,
            })),
          })}\n`,
        );
        return 0;
      }
      if (mcp.reports.length === 0) {
        io.out("no mcp servers configured (nexus mcp add <name> ...)\n");
        return 0;
      }
      for (const r of mcp.reports) {
        if (r.connected) {
          io.out(`[ok] ${r.name} (${r.transport}) — ${r.toolCount} tool(s)\n`);
        } else {
          io.out(`[--] ${r.name} (${r.transport}) — unreachable${r.error ? `: ${r.error}` : ""}\n`);
        }
      }
      if (mcp.tools.length > 0) {
        io.out("tools:\n");
        for (const t of mcp.tools) {
          io.out(`  ${t.server}__${t.descriptor.name}${t.descriptor.description ? ` — ${t.descriptor.description}` : ""}\n`);
        }
      }
      return 0;
    } finally {
      await mcp.close();
      await runtime.registry.disposeAll();
    }
  }

  if (sub === "call") {
    const server = args.positionals[1];
    const toolName = args.positionals[2];
    if (!server || !toolName) {
      io.err("nexus mcp call <server> <tool> [--json '<args-object>'] [--arg K=V]...\n");
      return 2;
    }
    // Assemble the tool arguments: a whole JSON object via --json, plus/overridden
    // by scalar --arg K=V pairs (numbers/bools/null are coerced, else kept string).
    let toolArgs: Record<string, unknown> = {};
    const jsonFlag = args.flags.get("json");
    if (jsonFlag) {
      try {
        const parsed = JSON.parse(jsonFlag);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          toolArgs = parsed as Record<string, unknown>;
        } else {
          io.err("nexus mcp call: --json must be a JSON object\n");
          return 2;
        }
      } catch (e) {
        io.err(`nexus mcp call: invalid --json (${String((e as Error).message)})\n`);
        return 2;
      }
    }
    for (const pair of args.multi.get("arg") ?? []) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const key = pair.slice(0, idx);
      const raw = pair.slice(idx + 1);
      try {
        toolArgs[key] = JSON.parse(raw);
      } catch {
        toolArgs[key] = raw;
      }
    }

    const config = await loadEffectiveConfig();
    const runtime = await buildRuntime(config);
    const mcp = await startMcpSession(config, runtime.secrets);
    try {
      const report = mcp.reports.find((r) => r.name === server);
      if (!report) {
        io.err(`nexus mcp call: no server "${server}" (add it with: nexus mcp add ${server})\n`);
        return 1;
      }
      if (!report.connected) {
        io.err(`nexus mcp call: server "${server}" unreachable${report.error ? `: ${report.error}` : ""}\n`);
        return 1;
      }
      const dt = mcp.tools.find((t) => t.server === server && t.descriptor.name === toolName);
      if (!dt) {
        io.err(`nexus mcp call: no tool "${toolName}" on "${server}"\n`);
        const names = mcp.tools.filter((t) => t.server === server).map((t) => t.descriptor.name);
        if (names.length > 0) io.err(`  available: ${names.join(", ")}\n`);
        return 1;
      }
      const result = await dt.client.callTool(toolName, toolArgs);
      if (output === "json") {
        io.out(`${JSON.stringify(result)}\n`);
        return result.isError ? 1 : 0;
      }
      const text = (result.content ?? [])
        .map((c) => {
          const block = c as { type?: string; text?: string };
          if (block.type === "text" && typeof block.text === "string") return block.text;
          return JSON.stringify(c);
        })
        .join("\n");
      if (text) io.out(`${text}\n`);
      else if (result.structuredContent !== undefined) io.out(`${JSON.stringify(result.structuredContent)}\n`);
      else io.out("(no content)\n");
      if (result.isError) {
        io.err(`nexus mcp call: "${server}:${toolName}" reported an error\n`);
        return 1;
      }
      return 0;
    } finally {
      await mcp.close();
      await runtime.registry.disposeAll();
    }
  }

  io.err(`nexus mcp: unknown subcommand "${sub}" (use: add | list | rm | tools | call)\n`);
  return 2;
}

// ── plugin (discover / manage engine-extending plugins, §9) ────────────────────

/**
 * `nexus plugin list|add|remove|info` — inspect and manage plugins. `list`/`info`
 * discover + load (sandboxed, version-gated) and report each plugin's manifest +
 * contributions; `add`/`remove` edit the plugin SEARCH DIRECTORIES in user config
 * (`plugins.dirs`) — the immediate subdirectories of each are scanned as plugins.
 */
export async function cmdPlugin(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);

  if (sub === "list") {
    const config = await loadEffectiveConfig();
    const { loaded, failures } = await loadPlugins(config);
    if (output === "json") {
      io.out(
        `${JSON.stringify({
          plugins: loaded.map((p) => ({
            name: p.manifest.name,
            version: p.manifest.version,
            source: p.source,
            description: p.manifest.description ?? null,
            contributions: {
              providers: p.contributions.providers.map((a) => a.id),
              tools: p.contributions.tools.map((t) => t.name),
              commands: p.contributions.commands.map((c) => c.name),
              prompts: p.contributions.prompts.map((pr) => `${pr.id}@${pr.version}`),
              mcpServers: p.contributions.mcpServers.map((s) => s.name),
              uiPanels: p.contributions.uiPanels.map((u) => u.id),
            },
          })),
          failures: failures.map((f) => ({ name: f.name, reason: f.reason, error: f.error })),
        })}\n`,
      );
      return 0;
    }
    if (loaded.length === 0 && failures.length === 0) {
      io.out("no plugins found (add a search dir: `nexus plugin add <dir>`)\n");
      return 0;
    }
    for (const p of loaded) {
      io.out(`[ok] ${p.manifest.name}@${p.manifest.version} (${p.source}) — ${contributionSummary(p)}\n`);
    }
    for (const f of failures) {
      io.out(`[--] ${f.name} — ${f.reason}: ${f.error}\n`);
    }
    io.err(`[plugins] ${loaded.length} loaded, ${failures.length} failed\n`);
    return 0;
  }

  if (sub === "info") {
    const name = args.positionals[1];
    if (!name) {
      io.err("nexus plugin info <name>\n");
      return 2;
    }
    const config = await loadEffectiveConfig();
    const { loaded, failures } = await loadPlugins(config);
    const p = loaded.find((x) => x.manifest.name === name);
    if (!p) {
      const failed = failures.find((f) => f.name === name);
      if (failed) {
        io.err(`nexus plugin info: "${name}" failed to load — ${failed.reason}: ${failed.error}\n`);
        return 1;
      }
      io.err(`nexus plugin info: no plugin "${name}"\n`);
      return 1;
    }
    if (output === "json") {
      io.out(`${JSON.stringify({ manifest: p.manifest, source: p.source, dir: p.dir })}\n`);
      return 0;
    }
    io.out(`${p.manifest.name}@${p.manifest.version}\n`);
    if (p.manifest.description) io.out(`  ${p.manifest.description}\n`);
    io.out(`  source: ${p.source}\n`);
    io.out(`  dir:    ${p.dir}\n`);
    io.out(`  contributes: ${contributionSummary(p)}\n`);
    for (const a of p.contributions.providers) io.out(`    provider: ${a.id}\n`);
    for (const t of p.contributions.tools) io.out(`    tool:     ${t.name} (${t.permission})\n`);
    for (const c of p.contributions.commands) io.out(`    command:  ${c.name}\n`);
    for (const pr of p.contributions.prompts) io.out(`    prompt:   ${pr.id}@${pr.version}\n`);
    for (const s of p.contributions.mcpServers) io.out(`    mcp:      ${s.name}\n`);
    for (const u of p.contributions.uiPanels) io.out(`    ui-panel: ${u.id}\n`);
    return 0;
  }

  if (sub === "add") {
    const dir = args.positionals[1];
    if (!dir) {
      io.err("nexus plugin add <dir>   (a directory whose subdirectories are plugins)\n");
      return 2;
    }
    const abs = resolve(process.cwd(), dir);
    const current = readUserConfig() as Record<string, unknown>;
    const pluginsBlock = (current.plugins ?? {}) as Record<string, unknown>;
    const dirs = Array.isArray(pluginsBlock.dirs) ? [...(pluginsBlock.dirs as unknown[])] : [];
    if (dirs.includes(abs)) {
      io.err(`nexus plugin add: "${abs}" is already a search dir\n`);
      return 1;
    }
    dirs.push(abs);
    const file = writeUserConfig({ ...current, plugins: { ...pluginsBlock, dirs } });
    io.out(`added plugin search dir "${abs}" → ${file}\n`);
    return 0;
  }

  if (sub === "remove" || sub === "rm") {
    const dir = args.positionals[1];
    if (!dir) {
      io.err("nexus plugin remove <dir>\n");
      return 2;
    }
    const abs = resolve(process.cwd(), dir);
    const current = readUserConfig() as Record<string, unknown>;
    const pluginsBlock = (current.plugins ?? {}) as Record<string, unknown>;
    const dirs = Array.isArray(pluginsBlock.dirs) ? (pluginsBlock.dirs as unknown[]) : [];
    const next = dirs.filter((d) => d !== abs && d !== dir);
    if (next.length === dirs.length) {
      io.err(`nexus plugin remove: "${dir}" is not a configured search dir\n`);
      return 1;
    }
    const file = writeUserConfig({ ...current, plugins: { ...pluginsBlock, dirs: next } });
    io.out(`removed plugin search dir "${abs}" → ${file}\n`);
    return 0;
  }

  io.err(`nexus plugin: unknown subcommand "${sub}" (use: list | add | remove | info)\n`);
  return 2;
}

// ── keys (never prints secret values) ─────────────────────────────────────────

/** Read one line from piped stdin (not a TTY). Empty string if nothing is piped. */
async function readStdinLine(): Promise<string> {
  const piped = await readStdin();
  const firstLine = piped.split(/\r?\n/)[0] ?? "";
  return firstLine.trim();
}

/**
 * Minimal structural view of `process.stdin` the hidden-value reader needs —
 * injectable so a test can drive it with a simulated TTY input stream (no
 * real terminal required).
 */
export interface HiddenStdin {
  readonly isTTY?: boolean | undefined;
  isRaw?: boolean | undefined;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: BufferEncoding): void;
  on(event: "data", listener: (chunk: string) => void): void;
  removeListener(event: "data", listener: (chunk: string) => void): void;
}

/**
 * Prompt for a secret on the TTY with echo disabled (raw mode, no keystrokes
 * printed): sets raw mode, accumulates bytes until CR/LF, handles Backspace,
 * then restores the prior raw-mode state and resolves the captured string.
 * Resolves "" if stdin is not a TTY. Ctrl+C aborts the process without ever
 * having buffered a partial secret to stdout.
 */
export async function promptHiddenValue(
  label: string,
  io: Io,
  stdin: HiddenStdin = process.stdin,
): Promise<string> {
  if (!stdin.isTTY) return "";
  return new Promise<string>((resolve) => {
    io.err(label);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          io.err("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C: abort without ever echoing or returning the partial value.
          cleanup();
          io.err("\n");
          process.exit(130);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Resolve the secret value for `keys set`: an explicit positional/`--value`
 * always wins (scripting stays supported and never blocks on a prompt). With
 * no explicit value, `--stdin` reads one line from piped input; otherwise, on
 * a TTY, the value is prompted for interactively with echo disabled so it
 * never touches argv/`ps`/shell history. `stdin` is injectable for tests.
 */
export async function resolveSecretValue(
  args: ParsedArgs,
  io: Io,
  stdin: HiddenStdin = process.stdin,
): Promise<string> {
  const explicit = args.positionals[2] ?? args.flags.get("value");
  if (explicit !== undefined) return explicit;
  if (args.bools.has("stdin")) return readStdinLine();
  return promptHiddenValue("secret value (input hidden): ", io, stdin);
}

export async function cmdKeys(
  args: ParsedArgs,
  io: Io = defaultIo,
  stdin: HiddenStdin = process.stdin,
): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);
  const secrets = runtime.secrets;

  if (sub === "set") {
    const ref = args.positionals[1];
    if (!ref) {
      io.err("nexus keys set <ref> [value] (or --stdin, or prompts interactively on a TTY)\n");
      return 2;
    }
    const value = await resolveSecretValue(args, io, stdin);
    if (!value) {
      io.err("nexus keys set <ref> [value] (or --stdin, or prompts interactively on a TTY)\n");
      return 2;
    }
    await secrets.set(ref, value);
    const src = await secrets.source(ref);
    io.out(`saved key for ${ref} (${src ?? "file"}) — ${redactSecret(value)}\n`);
    return 0;
  }

  if (sub === "list") {
    const refs = new Set<string>();
    for (const p of config.providers) {
      if (p.apiKeyRef) refs.add(p.apiKeyRef);
    }
    // Always include the configured default provider, even before it has been
    // formally added to `config.providers` — the natural first-run flow is
    // `nexus keys set <defaultProvider>` (as the fallback notice suggests)
    // BEFORE the provider is otherwise configured, and a user must be able to
    // confirm via `keys list` that the key they just set actually landed. This
    // also means `refs` is never empty, so there is always at least one line.
    refs.add(config.defaultProvider);
    for (const ref of refs) {
      const src = await secrets.source(ref);
      const val = await secrets.get(ref);
      io.out(`${ref}: ${src ?? "unset"}${val ? ` (${redactSecret(val)})` : ""}\n`);
    }
    // Point users at the PROPER sign-in path: `keys set` stores a raw API key,
    // but `nexus login` runs the real per-provider flow (browser OAuth where the
    // provider supports it, e.g. Anthropic "login like Claude Code"). `auth
    // status` shows who is signed in.
    io.err("tip: `nexus login [provider]` is the recommended sign-in path; `nexus auth status` shows who is signed in.\n");
    return 0;
  }

  if (sub === "test") {
    const providerId = args.positionals[1];
    if (!providerId) {
      io.err("nexus keys test <provider>\n");
      return 2;
    }
    if (!runtime.registry.has(providerId)) {
      io.err(`provider "${providerId}" not available\n`);
      return 1;
    }
    const adapter = runtime.registry.get(providerId);
    if (!adapter.health) {
      io.out(`${providerId}: no health probe (assumed reachable)\n`);
      return 0;
    }
    const ac = new AbortController();
    const status = await adapter.health({
      signal: ac.signal,
      idempotencyKey: `keys-test:${providerId}`,
      traceId: `keys-test:${providerId}`,
      runId: `keys-test:${providerId}`,
    });
    io.out(`${providerId}: ${status.ok ? "ok" : "FAILED"}${status.detail ? ` — ${status.detail}` : ""}\n`);
    return status.ok ? 0 : 1;
  }

  io.err(`nexus keys: unknown subcommand "${sub}"\n`);
  return 2;
}

// ── login / logout / auth status (proper per-provider sign-in) ─────────────────

/**
 * Injectable seams for the auth commands so the OAuth machinery can be tested
 * against the in-process MOCK authorization server — no real browser and no real
 * provider auth server. Production leaves every field unset: a real config +
 * SecretStore, the real browser opener, and the global `fetch` are used.
 */
export interface AuthCommandDeps {
  config?: NexusConfig;
  secrets?: SecretStore;
  /** A fully-built registry (tests inject one wired to the mock AS). */
  registry?: ProviderAuthRegistry;
  /** Browser opener (tests inject a loopback simulator; default the real launcher). */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /** Injected fetch for OAuth flows/refresh (tests → mock AS). */
  fetchImpl?: FetchLike;
  /** Injected clock. */
  now?: () => number;
  /** Injected api-key capture (default: hidden TTY prompt). */
  readKey?: () => Promise<string>;
  /**
   * Injected manual-code capture for a `manualCode` provider (Anthropic
   * "login like Claude Code"): reads the pasted `code#state` string (default:
   * an echoed TTY prompt, or one piped line on a non-TTY).
   */
  readCode?: () => Promise<string>;
}

interface AuthContext {
  config: NexusConfig;
  secrets: SecretStore;
  registry: ProviderAuthRegistry;
  now: () => number;
}

/** Resolve the config + SecretStore + auth registry an auth command operates on. */
async function resolveAuthContext(deps: AuthCommandDeps): Promise<AuthContext> {
  const config = deps.config ?? (await loadEffectiveConfig());
  const secrets = deps.secrets ?? resolveAuthSecrets(config);
  const now = deps.now ?? Date.now;
  const registry =
    deps.registry ??
    buildAuthRegistry(config, secrets, {
      ...(deps.openBrowser ? { openBrowser: deps.openBrowser } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      now,
    });
  return { config, secrets, registry, now };
}

/** Read one echoed line from the TTY (non-secret; e.g. an interactive menu choice). */
function promptLine(label: string, io: Io): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    void io;
  });
}

/**
 * Read the pasted `code#state` string for a manual-code-paste login (Anthropic
 * "login like Claude Code" — see `ANTHROPIC_OAUTH_CONFIG.manualCode`). Not a
 * secret (a one-time authorization code, not a durable credential), so it's
 * echoed like any other interactive answer. On a TTY, prompts and waits for a
 * line; on a piped/non-TTY stdin, reads a single line (resolving "" on
 * immediate EOF, e.g. `</dev/null` — the caller turns that into a clean
 * "no code entered" error rather than hanging or crashing).
 */
function readPastedCode(io: Io, stdin: HiddenStdin): Promise<string> {
  const interactive = stdin.isTTY ?? process.stdin.isTTY ?? false;
  return interactive
    ? promptLine("Paste the code shown in your browser (format: code#state): ", io)
    : readStdinLine();
}

/**
 * Print the `nexus login` / `nexus logout` help: usage lines plus the honest
 * per-provider flow list (oauth / device / api-key / cli-session / cloud-sso).
 * Emitted to stdout so `--help` is a clean, exit-0 informational command.
 */
async function renderAuthFlowHelp(ctx: AuthContext, io: Io, verb: "login" | "logout"): Promise<void> {
  const rows = await authStatusRows(ctx.registry, ctx.now());
  if (verb === "login") {
    io.out("nexus login [provider] [--device] [--api-key] [-o json]\n");
    io.out("Sign in to a provider using its real auth flow. Tokens are stored securely and never printed.\n");
  } else {
    io.out("nexus logout [provider] [--all]\n");
    io.out("Sign out of a provider (clear stored credentials). --all signs out of every provider.\n");
  }
  io.out("\nProviders and their sign-in flows:\n");
  for (const r of rows) {
    const state = r.loggedIn ? `signed in (${r.method})` : r.method;
    io.out(`  ${r.providerId} — ${state}\n`);
  }
  if (verb === "login") {
    // Honest per-registry answer — only a strategy with a REAL device-code
    // endpoint can actually run `--device` (see `AuthStrategy.supportsDeviceMode`).
    // Every other provider rejects `--device` with a clear message and falls
    // back to its browser (loopback) / api-key / cli-delegate / cloud-sso flow.
    const deviceCapable = ctx.registry
      .list()
      .filter((s) => s.supportsDeviceMode)
      .map((s) => s.providerId);
    io.out("\nFlags:\n");
    io.out("  --device    use the headless OAuth device-code flow (RFC 8628) — only supported\n");
    io.out(
      `              by providers with a real device endpoint${deviceCapable.length ? ` (currently: ${deviceCapable.join(", ")})` : ""};\n`,
    );
    io.out("              other providers reject --device and use their normal flow instead\n");
    io.out("              (browser loopback / API key / vendor CLI / cloud SSO).\n");
    io.out("  --api-key   force the guided api-key path (composite providers)\n");
    io.out(
      "  --open      auto-open a browser to the provider's key page during an api-key\n",
    );
    io.out("              login (default: off — the URL is printed for you to open)\n");
    io.out("  -o json     machine-readable output\n");
    io.out(
      "\nAnthropic (Claude) auth: the account OAuth browser flow (`nexus login anthropic`)\n" +
        "is EXPERIMENTAL — Anthropic may change it without notice. The most reliable path:\n" +
        "reuse an existing Claude Code CLI session with `-p claude-code` (no login needed\n" +
        "if `claude` is installed and logged in), or run `nexus login anthropic --api-key`\n" +
        "for a stable API key.\n",
    );
  } else {
    io.out("\nFlags:\n");
    io.out("  --all       sign out of every registered provider\n");
  }
}

/**
 * Interactively pick a provider to log in to. On a TTY: print a numbered menu
 * (with each provider's current sign-in state) and read a choice. Piped: read a
 * single line as the choice. Returns the resolved provider id, or undefined when
 * nothing usable was chosen.
 */
async function pickProvider(ctx: AuthContext, io: Io): Promise<string | undefined> {
  const rows = await authStatusRows(ctx.registry, ctx.now());
  io.err("Select a provider to sign in to:\n");
  rows.forEach((r, i) => {
    const state = r.loggedIn ? `signed in (${r.method})` : r.method;
    io.err(`  ${i + 1}) ${r.providerId} — ${state}\n`);
  });
  const choice = process.stdin.isTTY
    ? await promptLine("provider (number or id): ", io)
    : await readStdinLine();
  if (!choice) return undefined;
  const asNum = Number.parseInt(choice, 10);
  if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= rows.length) {
    return rows[asNum - 1]?.providerId;
  }
  return ctx.registry.has(choice) ? choice : undefined;
}

/**
 * `nexus login [provider] [--device] [--api-key]` — run a provider's REAL auth
 * strategy: an OAuth browser (loopback PKCE) flow, its device-code fallback, a
 * vendor-CLI delegate, a cloud-SSO delegate, or a guided api-key capture. Tokens
 * are NEVER printed. With no provider, prompts to pick one interactively.
 */
export async function cmdLogin(
  args: ParsedArgs,
  io: Io = defaultIo,
  deps: AuthCommandDeps = {},
  stdin: HiddenStdin = process.stdin,
): Promise<number> {
  const output = parseOutput(args);
  const ctx = await resolveAuthContext(deps);

  // `--help`/`-h`: print the honest per-provider flow list and exit cleanly.
  if (args.bools.has("help")) {
    await renderAuthFlowHelp(ctx, io, "login");
    return 0;
  }

  let providerId = args.positionals[0];
  if (!providerId) {
    // The interactive picker needs a real terminal (arrow/number select). On a
    // TTY, run it. On a non-TTY (piped/redirected/CI) a piped line is still
    // accepted as the choice, but with nothing to read we degrade GRACEFULLY:
    // print a clear "specify a provider" message and exit 0 — never crash/exit 2.
    const interactive = stdin.isTTY ?? process.stdin.isTTY ?? false;
    const picked = await pickProvider(ctx, io);
    if (!picked) {
      if (!interactive) {
        io.err(
          "nexus login: run `nexus login <provider>` — the interactive picker needs a terminal.\n",
        );
        io.err(`Available providers: ${ctx.registry.ids().join(", ")}\n`);
        return 0;
      }
      io.err("nexus login <provider> — no provider selected (or pipe a choice / pass a provider id)\n");
      return 2;
    }
    providerId = picked;
  }

  const strategy = ctx.registry.get(providerId);
  if (!strategy) {
    io.err(
      `nexus login: no auth strategy for provider "${providerId}" (known: ${ctx.registry.ids().join(", ")})\n`,
    );
    return 1;
  }

  const override = ctx.config.auth.providers[providerId];
  const loginOpts: LoginStrategyOptions = {};
  // Method: --api-key flag wins, else a config method pin.
  if (args.bools.has("api-key")) loginOpts.method = "api-key";
  else if (override?.method === "api-key") loginOpts.method = "api-key";
  else if (override?.method === "oauth") loginOpts.method = "oauth";
  // OAuth flow mode: --device flag wins, else a config mode pin.
  if (args.bools.has("device")) loginOpts.mode = "device";
  else if (override?.mode) loginOpts.mode = override.mode;
  // Auto-open the browser to an api-key login's key page ONLY on explicit
  // opt-in (--open or a config override) — the default is to just print the
  // URL, since auto-launching a browser to a login-walled key page during a
  // plain api-key login is surprising UX.
  if (args.bools.has("open")) loginOpts.autoOpenBrowser = true;
  else if (override?.openBrowserOnLogin) loginOpts.autoOpenBrowser = true;

  // `--device` was explicitly requested but this provider has NO real
  // device-code endpoint to hit (e.g. Anthropic's OAuth config carries no
  // `deviceEndpoint`), or it doesn't use an OAuth flow at all (api-key /
  // cli-delegate / cloud-sso). Reject with a COMPLETE, honest message and a
  // non-zero exit — never attempt a flow that doesn't exist, and never print
  // a truncated/garbled error while still exiting 0 as if it had worked.
  // (`--api-key` wins over `--device` for a composite provider, matching the
  // method precedence below, so that combination is not rejected here.)
  if (loginOpts.mode === "device" && loginOpts.method !== "api-key" && !strategy.supportsDeviceMode) {
    if (strategy.kind === "api-key") {
      const hint = strategy.apiKeyEnv ? ` (or set ${strategy.apiKeyEnv})` : "";
      io.err(
        `nexus login: '${providerId}' uses an API key, not a login flow — run \`nexus login ${providerId}\`${hint}.\n`,
      );
    } else if (strategy.kind === "cli-delegate") {
      io.err(
        `nexus login: '${providerId}' does not support --device login — it delegates to its own vendor CLI's login. Run \`nexus login ${providerId}\` instead.\n`,
      );
    } else if (strategy.kind === "cloud-sso") {
      io.err(
        `nexus login: '${providerId}' does not support --device login — it delegates to the cloud SSO login. Run \`nexus login ${providerId}\` instead.\n`,
      );
    } else {
      io.err(
        `nexus login: '${providerId}' does not support --device login. Run \`nexus login ${providerId}\` for the browser (loopback) flow.\n`,
      );
    }
    return 2;
  }

  // Surface URLs/codes on stderr so stdout stays clean (never a token).
  loginOpts.onAuthorizeUrl = (url) =>
    io.err(`\nOpen this URL in your browser to authorize:\n  ${url}\n\nWaiting for you to finish signing in…\n`);
  loginOpts.onDevicePrompt = ({ userCode, verificationUri }) =>
    io.err(`\nTo sign in, visit:\n  ${verificationUri}\nand enter the code:  ${userCode}\n\nWaiting for approval…\n`);
  loginOpts.onKeyPage = (url) => io.err(`Get an API key at ${url}, then paste it here:\n`);
  // Guided api-key capture: hidden TTY prompt (never echoed, never to argv).
  loginOpts.readKey =
    deps.readKey ?? (() => promptHiddenValue(`${providerId} API key (input hidden): `, io, stdin));
  // Manual-code-paste capture (Anthropic "login like Claude Code" — no loopback
  // redirect, so there is no automatic callback to wait on: the user copies the
  // code shown on the callback page and pastes it back here).
  loginOpts.readCode = deps.readCode ?? (() => readPastedCode(io, stdin));
  if (deps.openBrowser) loginOpts.openBrowser = deps.openBrowser;

  // The Anthropic account OAuth browser flow ("login like Claude Code") is the
  // one auth surface most exposed to an upstream vendor changing endpoints out
  // from under us — flag it honestly rather than pretend it's as durable as
  // the api-key path, and point at the two more reliable alternatives. Only
  // fires for the actual OAuth attempt (not when `--api-key` was requested).
  if (providerId === "anthropic" && loginOpts.method !== "api-key") {
    io.err(
      "Note: the Claude account OAuth browser flow (`nexus login anthropic`) is EXPERIMENTAL — " +
        "Anthropic may change it without notice. Most reliable Claude auth: reuse an existing " +
        "Claude Code CLI session via `-p claude-code` (no login needed if `claude` is installed " +
        "and logged in), or run `nexus login anthropic --api-key` for a stable API key.\n",
    );
  }

  try {
    const status = await strategy.login(loginOpts);
    const expiresIn = formatExpiry(status.expiresAt, ctx.now());
    if (output === "json") {
      io.out(
        `${JSON.stringify({
          providerId: status.providerId,
          loggedIn: status.loggedIn,
          method: status.method,
          ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
          ...(expiresIn ? { expiresIn } : {}),
        })}\n`,
      );
    } else {
      io.out(
        `signed in to ${status.providerId} via ${status.method}` +
          `${expiresIn ? ` (token expires ${expiresIn})` : ""}\n`,
      );
    }
    return status.loggedIn ? 0 : 1;
  } catch (e) {
    // Print the FULL error message. Strategies already guarantee their thrown
    // messages never contain a captured secret/token value (see the
    // `AuthStrategy`/`OAuthError` contracts) — `redactSecret` is a key-masking
    // helper (`<prefix>…<last4>`) built for an actual secret VALUE, not a
    // sentence. Applying it to a whole message here used to mangle every
    // login error down to an ellipsis + last 4 characters (e.g. "…flow").
    io.err(`nexus login: ${(e as Error).message}\n`);
    return 1;
  }
}

/**
 * `nexus logout [provider] [--all]` — clear a provider's stored credentials
 * (best-effort local revoke via the strategy). `--all` signs out of every
 * registered provider.
 */
export async function cmdLogout(
  args: ParsedArgs,
  io: Io = defaultIo,
  deps: AuthCommandDeps = {},
): Promise<number> {
  const ctx = await resolveAuthContext(deps);

  // `--help`/`-h`: print the flow list and exit cleanly.
  if (args.bools.has("help")) {
    await renderAuthFlowHelp(ctx, io, "logout");
    return 0;
  }

  const all = args.bools.has("all");

  let targets: string[];
  if (all) {
    targets = ctx.registry.ids();
  } else {
    const providerId = args.positionals[0];
    if (!providerId) {
      io.err("nexus logout <provider> (or --all)\n");
      return 2;
    }
    if (!ctx.registry.has(providerId)) {
      io.err(
        `nexus logout: no auth strategy for provider "${providerId}" (known: ${ctx.registry.ids().join(", ")})\n`,
      );
      return 1;
    }
    targets = [providerId];
  }

  let cleared = 0;
  for (const id of targets) {
    const strategy = ctx.registry.get(id);
    if (!strategy) continue;
    let wasLoggedIn = false;
    try {
      wasLoggedIn = (await strategy.status()).loggedIn;
    } catch {
      /* status probe is best-effort — proceed to clear regardless */
    }
    await strategy.logout();
    if (wasLoggedIn) cleared += 1;
    if (!all) {
      io.out(`logged out of ${id}${wasLoggedIn ? "" : " (was not signed in)"}\n`);
    }
  }
  if (all) io.out(`logged out of ${cleared} provider(s)\n`);
  return 0;
}

/**
 * `nexus auth status` — per-provider sign-in state: logged in?, the honest
 * method (oauth / api-key / cli session / cloud-sso), and an OAuth token's
 * relative expiry. Never prints a token. `--output json` for scripting.
 */
export async function cmdAuth(
  args: ParsedArgs,
  io: Io = defaultIo,
  deps: AuthCommandDeps = {},
): Promise<number> {
  const sub = args.positionals[0] ?? "status";
  if (sub !== "status") {
    io.err(`nexus auth: unknown subcommand "${sub}" (use: status)\n`);
    return 2;
  }
  const output = parseOutput(args);
  const ctx = await resolveAuthContext(deps);
  const rows = await authStatusRows(ctx.registry, ctx.now());

  if (output === "json") {
    io.out(`${JSON.stringify(rows)}\n`);
    return 0;
  }
  io.out("auth status:\n");
  for (const r of rows) {
    const mark = r.loggedIn ? "✓ " : "  ";
    const label = r.loggedIn ? r.method : "not signed in";
    const exp = r.expiresIn ? ` (expires ${r.expiresIn})` : "";
    io.out(`  [${mark}] ${r.providerId} — ${label}${exp}${r.detail ? ` — ${r.detail}` : ""}\n`);
  }
  const anyIn = rows.some((r) => r.loggedIn);
  if (!anyIn) io.err("no providers signed in — run `nexus login` to sign in.\n");
  // Anthropic is present: honestly flag its OAuth browser flow as experimental
  // and point at the two more reliable Claude auth paths (see cmdLogin).
  if (rows.some((r) => r.providerId === "anthropic")) {
    io.err(
      "anthropic: the OAuth browser flow (`nexus login anthropic`) is EXPERIMENTAL — Anthropic " +
        "may change it. Most reliable: `-p claude-code` (reuse an existing Claude Code CLI " +
        "session) or `nexus login anthropic --api-key`.\n",
    );
  }
  return 0;
}

// ── config ────────────────────────────────────────────────────────────────────

export async function cmdConfig(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "get";

  if (sub === "path") {
    io.out(`${userConfigFile()}\n`);
    return 0;
  }

  if (sub === "get") {
    const config = await loadEffectiveConfig();
    const key = args.positionals[1];
    const value = key ? getPath(config, key) : config;
    io.out(`${JSON.stringify(value ?? null, null, 2)}\n`);
    return 0;
  }

  if (sub === "set") {
    const key = args.positionals[1];
    const value = args.positionals[2];
    if (!key || value === undefined) {
      io.err("nexus config set <key> <value>\n");
      return 2;
    }
    const current = readUserConfig() as Record<string, unknown>;
    try {
      setPath(current, key, value);
    } catch (e) {
      io.err(`nexus config set: ${(e as Error).message}\n`);
      return 2;
    }
    // Validate against the real schema BEFORE writing — a bad key must fail
    // loudly here instead of bricking every later command that re-parses it.
    const validation = validateUserConfig(current);
    if (!validation.ok) {
      io.err(`nexus config set: ${validation.message}\n`);
      return 2;
    }
    const file = writeUserConfig(current);
    io.out(`set ${key} = ${value} → ${file}\n`);
    return 0;
  }

  io.err(`nexus config: unknown subcommand "${sub}"\n`);
  return 2;
}

// ── doctor ────────────────────────────────────────────────────────────────────

export async function cmdDoctor(_args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const config = await loadEffectiveConfig();
  const runtime = await buildRuntime(config);

  io.out("nexus doctor\n");
  io.out(`config dir: ${userConfigDir()}\n`);
  io.out(`history db: ${config.history.dbPath ?? nexusPaths().historyDb} (enabled=${config.history.enabled})\n`);
  io.out("providers:\n");

  let anyHealthyFailure = false;
  for (const s of runtime.statuses) {
    if (!s.available) {
      io.out(`  [--] ${s.id} (${s.kind})${s.detail ? ` — ${s.detail}` : ""}\n`);
      continue;
    }
    // A default cloud provider with no credential is not a failure — it is shown
    // as "needs key" so `doctor` still exits 0 on a fresh, unconfigured machine.
    if (s.needsKey) {
      io.out(`  [key] ${s.id} (${s.kind})${s.detail ? ` — ${s.detail}` : ""}\n`);
      continue;
    }
    const health = runtime.registry.healthOf(s.id);
    const ok = health ? health.ok : true;
    if (!ok) anyHealthyFailure = true;
    const detail = health?.detail ?? s.detail;
    io.out(`  [${ok ? "ok" : "!!"}] ${s.id} (${s.kind})${detail ? ` — ${detail}` : ""}\n`);
  }

  const refs = new Set<string>();
  for (const p of config.providers) if (p.apiKeyRef) refs.add(p.apiKeyRef);
  if (refs.size > 0) {
    io.out("keys:\n");
    for (const ref of refs) {
      const src = await runtime.secrets.source(ref);
      io.out(`  ${ref}: ${src ?? "unset"}\n`);
    }
  }

  // Wave-13 auth: per-provider sign-in state (logged-in? / method / OAuth token
  // expiry). Pure introspection — no prompting, no browser, no network. Shows the
  // honest method each provider authenticates with; token store hint comes from
  // config.auth.tokenStore. Never prints a token.
  const authRegistry = buildAuthRegistry(config, runtime.secrets);
  const authRows = await authStatusRows(authRegistry);
  io.out(`auth (token store: ${config.auth.tokenStore}):\n`);
  for (const r of authRows) {
    const mark = r.loggedIn ? "ok" : "--";
    const label = r.loggedIn ? r.method : "not signed in";
    const exp = r.expiresIn ? ` (expires ${r.expiresIn})` : "";
    io.out(`  [${mark}] ${r.providerId} — ${label}${exp}${r.detail ? ` — ${r.detail}` : ""}\n`);
  }

  // Wave-1 subsystems: prove each is wired and report what it exposes.
  const toolReg = new ToolRegistry();
  registerBuiltins(toolReg);
  const promptReady = new PromptEngine().usageLog().length === 0;
  const memPath = openMemory().path ?? "(in-memory)";
  io.out("subsystems:\n");
  io.out(`  [ok] context — Context Engine (${CONTEXT_LANES.length} lanes)\n`);
  io.out(`  [ok] memory  — durable store at ${memPath}\n`);
  io.out(`  [${promptReady ? "ok" : "!!"}] prompt  — PromptEngine ready\n`);
  io.out(`  [ok] tools   — ${toolReg.names().length} builtins: ${toolReg.names().join(", ")}\n`);
  io.out(
    `  [ok] agent   — OODA framework (${AGENT_ROLES.length} roles: ${AGENT_ROLES.join(", ")}) + native tool loop\n`,
  );

  // Wave-7 task management (§15): durable plan store + progress tracking.
  const taskStore = openTaskStore();
  const taskProgress = taskStore.progress();
  io.out(
    `  [ok] tasks   — durable store at ${taskStore.path ?? "(in-memory)"} ` +
      `(${taskProgress.total} task(s), ${taskProgress.percent}% done)\n`,
  );

  // Wave-7 terminal integration (§13): background jobs + command history + PTY seam.
  const ptyAvailable = await isNodePtyAvailable();
  const cmdHist = new CommandHistory();
  io.out(
    `  [ok] terminal— background jobs + history (${cmdHist.size} entr(y/ies) @ ${cmdHist.filePath}), ` +
      `pty ${ptyAvailable ? "native" : "child_process fallback"}\n`,
  );

  // Wave-5 context-power layer: RAG retrieval, repo map, and caching.
  const ragFile = ragStorePath(config);
  let ragDetail: string;
  if (existsSync(ragFile)) {
    try {
      const index = openRagIndex(config, { cached: false, load: true });
      ragDetail = `${index.size} chunk(s) @ ${ragFile}`;
    } catch (e) {
      ragDetail = `index unreadable: ${(e as Error).message}`;
    }
  } else {
    ragDetail = "no index (run `nexus index`)";
  }
  io.out(`  [ok] rag     — ${config.rag.enabled ? "enabled" : "disabled"}, ${config.rag.embedder} embedder — ${ragDetail}\n`);
  io.out(`  [ok] repomap — ${config.fileintel.repoMap ? "enabled" : "disabled"} (budget ${config.fileintel.budgetTokens} tokens)\n`);
  const counts = await cacheEntryCounts(config);
  io.out(
    `  [ok] cache   — response ${config.cache.enabled && config.cache.responses ? "on" : "off"} (${counts.responses}), ` +
      `embedding ${config.cache.embeddings ? "on" : "off"} (${counts.embeddings}), affinity ${config.cache.affinity ? "on" : "off"} @ ${cacheDir(config)}\n`,
  );

  // Wave-12 performance (§23): the connection-pool tuning `buildRuntime` applied
  // above, plus the lazy-init state and the `index` background/watch defaults. The
  // pool numbers are read from the live shared agent config, so this proves the
  // config → runtime wiring took effect. `subsystems` lists which heavy subsystems
  // are registered as lazy cells and how many have actually been constructed.
  const pool = httpPoolOptions();
  const perf = config.performance;
  io.out(
    `  [ok] perf    — pool maxSockets=${pool.maxSockets} maxFreeSockets=${pool.maxFreeSockets} ` +
      `keepAlive=${pool.keepAliveMsecs}ms, lazy ${perf.lazy ? "on" : "off"} ` +
      `(${runtime.subsystems.loadedNames().length}/${runtime.subsystems.names().length} subsystems built), ` +
      `index background ${perf.background ? "on" : "off"}, watch debounce=${perf.watch.debounceMs}ms${perf.watch.prune ? " prune" : ""}\n`,
  );

  // Wave-6 observability: exporter + trace file + span count so a run is provably
  // instrumented. Reads the NDJSON span sink offline (no network).
  const obs = buildObservability(config);
  let traceDetail: string;
  if (obs.enabled) {
    const spans = existsSync(obs.filePath) ? loadTraceSpans(obs.filePath).length : 0;
    traceDetail = `exporter=${obs.exporter}, ${spans} span(s) @ ${obs.filePath}`;
  } else {
    traceDetail = "disabled";
  }
  io.out(`  [ok] observ  — ${config.observability.enabled ? "enabled" : "off"} — ${traceDetail}\n`);

  // Wave-6 git intelligence: probe the local `git` binary (execFile, reaped,
  // short timeout via `runGit`) so `doctor` proves the subsystem is usable —
  // never fatal, never hangs, even when git is missing from PATH entirely.
  try {
    const v = await runGit(["--version"], { cwd: process.cwd(), timeoutMs: 3000 });
    if (v.ok && v.stdout.trim()) {
      io.out(`  [ok] git     — ${v.stdout.trim()} on PATH\n`);
    } else {
      io.out(`  [--] git     — git not found\n`);
    }
  } catch {
    io.out(`  [--] git     — git not found\n`);
  }

  // Code Intelligence / LSP (§12): report which language servers are detected on
  // PATH. Feature-detection only (no server is spawned) — an install-less machine
  // shows every language as "not installed" and `doctor` still exits 0.
  const lspRegistry = buildLspRegistry(config);
  const lspLanguages = [...new Set(lspRegistry.all().map((s) => s.language))];
  const detected = lspLanguages.filter((lang) => lspRegistry.isInstalledFor(lang));
  const lspToolNames = config.lsp.enabled ? lspTools().map((t) => t.name) : [];
  io.out(
    `  [ok] lsp     — ${config.lsp.enabled ? "enabled" : "disabled"}, ` +
      `${detected.length}/${lspLanguages.length} language server(s) detected` +
      `${detected.length > 0 ? ` (${detected.join(", ")})` : ""}` +
      `${lspToolNames.length > 0 ? ` — tools: ${lspToolNames.join(", ")}` : ""}\n`,
  );

  // Wave-9 tool groups (§6): report each group's enabled state, tool count, and
  // which optional integration (playwright, pg, docker, …) is detected. Pure
  // feature-detection (dynamic import / PATH probe) — nothing runs, always exit-0.
  const toolReports = await reportToolGroups(config);
  const enabledGroups = toolReports.filter((r) => r.enabled);
  io.out(
    `  [ok] toolgrp — ${enabledGroups.length}/${toolReports.length} group(s) enabled` +
      `${enabledGroups.length > 0 ? ` (${enabledGroups.map((r) => r.group).join(", ")})` : ""}\n`,
  );
  for (const rep of toolReports) {
    const integ =
      rep.integrations.length === 0
        ? "native (always available)"
        : rep.integrations.map((i) => `${i.name} ${i.available ? "✓" : "✗"}`).join(", ");
    io.out(
      `           [${rep.enabled ? "on " : "off"}] ${rep.group} (${rep.toolNames.length} tool(s)) — ${integ}\n`,
    );
  }

  // MCP: connect the declared servers and report connectivity + tool counts.
  // Unreachable servers are shown, never fatal (offline-safe, hard rule 4).
  if (config.mcp.length > 0) {
    const mcp = await startMcpSession(config, runtime.secrets);
    try {
      io.out("mcp servers:\n");
      for (const r of mcp.reports) {
        if (r.connected) {
          io.out(`  [ok] ${r.name} (${r.transport}) — ${r.toolCount} tool(s)\n`);
        } else {
          io.out(`  [--] ${r.name} (${r.transport}) — unreachable${r.error ? `: ${r.error}` : ""}\n`);
        }
      }
    } finally {
      await mcp.close();
    }
  } else {
    io.out("mcp servers: none configured\n");
  }

  // Wave-10 extensibility (§9 + §24): the public SDK + REST daemon, lifecycle
  // hooks + webhooks, and the plugin catalog. Pure introspection — offline, exit-0.
  io.out("extensibility:\n");
  io.out(`  [ok] sdk     — @nexuscode/sdk (embeddable Nexus client)\n`);
  io.out(`  [ok] server  — nexus serve (REST + SSE daemon, bearer-auth, loopback)\n`);
  const cmdHooks = config.hooks.enabled ? config.hooks.hooks : [];
  const hookEvents = [...new Set(cmdHooks.map((h) => h.event))];
  io.out(
    `  [ok] hooks   — ${config.hooks.enabled ? "enabled" : "disabled"}, ${cmdHooks.length} command hook(s)` +
      `${hookEvents.length > 0 ? ` on: ${hookEvents.join(", ")}` : ""}\n`,
  );
  const activeWebhooks = config.webhooks.filter((w) => w.enabled);
  io.out(
    `  [ok] webhooks— ${activeWebhooks.length}/${config.webhooks.length} enabled` +
      `${activeWebhooks.length > 0 ? ` (${activeWebhooks.map((w) => `${w.url} → ${w.events.join("/")}`).join("; ")})` : ""}\n`,
  );
  const { loaded: loadedPlugins, failures: pluginFailures } = await loadPlugins(config);
  io.out(
    `  [${pluginFailures.length > 0 ? "!!" : "ok"}] plugins — ${config.plugins.enabled ? "enabled" : "disabled"}, ` +
      `${loadedPlugins.length} loaded, ${pluginFailures.length} failed\n`,
  );
  for (const p of loadedPlugins) {
    io.out(`           [ok] ${p.manifest.name}@${p.manifest.version} (${p.source}) — ${contributionSummary(p)}\n`);
  }
  for (const f of pluginFailures) {
    io.out(`           [--] ${f.name} — ${f.reason}: ${f.error}\n`);
  }

  // Wave-11 enterprise (§25): RBAC, policy, budgets, gateway, audit. Off by
  // default; when on, shows the configured surface. Pure introspection, exit-0.
  const entStatus = enterpriseStatus(config);
  for (const line of entStatus.lines) io.out(`${line}\n`);
  if (entStatus.enabled) {
    const services = await buildEnterprise(config);
    const chain = services.auditLog.verifyFile();
    io.out(
      `           [${chain.ok ? "ok" : "!!"}] audit chain — ${chain.count} record(s), ${chain.ok ? "intact" : `${chain.tampered.length} tamper finding(s)`}\n`,
    );
  }

  const mockOk = runtime.registry.has("mock") && (runtime.registry.healthOf("mock")?.ok ?? true);
  if (!mockOk) {
    io.err("doctor: mock provider unhealthy — pipeline broken\n");
    return 1;
  }
  return anyHealthyFailure ? 1 : 0;
}

// ── index (build the RAG index + repo map for a project) ──────────────────────

/**
 * Resolve a real provider-backed embedder when `rag.embedder === "provider"` is
 * configured and the named provider actually exposes embeddings; otherwise
 * returns `undefined` so `openRagIndex` falls back to the offline default
 * (`hashing`). Every failure path (no provider id, provider absent, no
 * embeddings capability) degrades to the default with a clear stderr note —
 * `index`/`search` never crash. Only invoked when the provider embedder is
 * requested, so the default offline path never builds a runtime.
 */
async function resolveRagEmbedder(config: NexusConfig, io: Io): Promise<Embedder | undefined> {
  if (config.rag.embedder !== "provider") return undefined;
  const providerId = config.rag.embedderProvider;
  if (!providerId) {
    io.err("nexus rag: rag.embedder=provider but rag.embedderProvider is unset — using the offline hashing embedder\n");
    return undefined;
  }
  // The registry is intentionally left undisposed: the returned embedder holds
  // the resolved adapter and calls `embed()` after this function returns. In a
  // short-lived CLI invocation this leaks nothing meaningful.
  const runtime = await buildRuntime(config);
  if (!runtime.registry.has(providerId)) {
    io.err(`nexus rag: provider "${providerId}" not available — using the offline hashing embedder\n`);
    return undefined;
  }
  const caps = runtime.registry.capabilitiesOf(providerId);
  const adapter = runtime.registry.get(providerId);
  if (!caps.embeddings || typeof adapter.embed !== "function") {
    io.err(`nexus rag: provider "${providerId}" has no embeddings API — using the offline hashing embedder\n`);
    return undefined;
  }
  const opts: { dims: number; model?: string } = { dims: config.rag.dims };
  if (config.rag.embedderModel) opts.model = config.rag.embedderModel;
  return createProviderEmbedder(adapter, opts);
}

/**
 * Minimal structural view of `child_process.spawn` — just what
 * {@link runIndexInBackground} needs. Injectable so a test can assert the
 * detached launch without actually forking a Node process.
 */
export type IndexSpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv },
) => { pid?: number | undefined; unref(): void };

/**
 * Env marker stamped on the detached re-index child by {@link runIndexInBackground}.
 * {@link cmdIndex} treats its presence as a hard "you ARE the background worker —
 * do the real, foreground index work" signal, so neither the `--background` flag
 * NOR `config.performance.background` can re-trigger backgrounding inside the child.
 * Without this guard, `performance.background: true` in config would make every
 * child re-satisfy the background branch and fork again — an unbounded fork bomb.
 */
export const NEXUS_INDEX_CHILD_ENV = "NEXUS_INDEX_CHILD";

/**
 * Launch `nexus index <root>` as a DETACHED background process (system-spec §23:
 * background indexing) and return immediately, so a long re-index never blocks
 * interactive use. The child re-invokes the same CLI entry WITHOUT `--background`
 * (so it does the actual work), is `unref`'d so the parent can exit, and inherits
 * no stdio. Returns 0 once the child is launched.
 */
export function runIndexInBackground(
  root: string,
  output: OutputMode,
  io: Io,
  spawn: IndexSpawnLike = (command, args, options) => nodeSpawn(command, args, options),
): number {
  const entry = process.argv[1];
  if (!entry) {
    io.err("nexus index --background: cannot resolve the CLI entry to re-launch\n");
    return 1;
  }
  const childArgs = [entry, "index", root];
  // Stamp the child with an explicit "you are the background worker" marker so
  // cmdIndex short-circuits to the real (foreground) index work — this, not the
  // absence of `--background`, is the authoritative re-fork guard (config can also
  // enable backgrounding, so a flag-only guard would leave a latent fork bomb).
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [NEXUS_INDEX_CHILD_ENV]: "1" },
  });
  child.unref();
  if (output === "json") {
    io.out(`${JSON.stringify({ background: true, pid: child.pid ?? null, root })}\n`);
  } else {
    io.out(`nexus index: indexing ${root} in the background (pid ${child.pid ?? "?"})\n`);
  }
  return 0;
}

/** Build the RAG documents (id/text/source/lang) for a directory tree. */
async function indexableRagDocs(root: string, config: NexusConfig): Promise<RagDocument[]> {
  const docs = await collectIndexableDocs(root, config);
  return docs.map((d) => {
    const lang = detectLanguage(d.path);
    const doc: RagDocument = { id: d.id, text: d.text, source: d.path };
    if (lang !== "unknown") doc.lang = lang;
    return doc;
  });
}

/**
 * Start incremental watch-mode reindexing for `nexus index --watch` (system-spec
 * §23: incremental updates · watch mode). Does one initial full index, then
 * watches `root` and — after a debounced quiet window — incrementally re-embeds
 * ONLY the documents whose content hash changed ({@link RagIndex.incrementalIndex}),
 * persisting the store after each pass. Returns the live {@link WatchReindexHandle}
 * so the caller (or a test) can `notify`/`flush`/`close` it deterministically; the
 * underlying watcher is injectable via `deps.watch`, so this is fully offline-testable.
 */
export async function startIndexWatch(
  root: string,
  config: NexusConfig,
  io: Io,
  deps: { watch?: typeof watchAndReindex; embedder?: Embedder } = {},
): Promise<{ handle: WatchReindexHandle; index: RagIndex; initial: number }> {
  const embedder = deps.embedder ?? (await resolveRagEmbedder(config, io));
  const index = openRagIndex(config, {
    cached: true,
    load: true,
    ...(embedder ? { embedder } : {}),
  });

  // Initial full index so the watch starts from a complete corpus.
  const initialDocs = await indexableRagDocs(root, config);
  await index.incrementalIndex(initialDocs, { prune: config.performance.watch.prune });
  index.save();

  const watch = deps.watch ?? watchAndReindex;
  const handle = watch(root, {
    index,
    delayMs: config.performance.watch.debounceMs,
    prune: config.performance.watch.prune,
    // Re-collect the whole tree; incrementalIndex hash-diffs so only the changed
    // documents are re-embedded (the cheap incremental path).
    loadDocs: () => indexableRagDocs(root, config),
    onReindex: (result) => {
      index.save();
      io.err(
        `[watch] reindexed: ${result.indexed.length} changed, ` +
          `${result.skipped.length} unchanged, ${result.removed.length} removed\n`,
      );
    },
    onError: (err) => {
      io.err(`[watch] reindex error: ${err instanceof Error ? err.message : String(err)}\n`);
    },
  });

  return { handle, index, initial: initialDocs.length };
}

export async function cmdIndex(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const root = resolve(args.positionals[0] ?? process.cwd());

  // Watch mode (§23): incremental reindex on debounced changes; runs until SIGINT.
  if (args.bools.has("watch")) {
    const { handle, initial } = await startIndexWatch(root, config, io);
    io.out(`nexus index: watching ${root} (indexed ${initial} file(s); Ctrl-C to stop)\n`);
    await new Promise<void>((res) => {
      const stop = (): void => {
        handle.close();
        res();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }

  // Background mode (§23): fire off a detached re-index and return at once. Either
  // an explicit `--background`/`--bg` flag or the `performance.background` default.
  // But if THIS process is already the detached child (env marker set by
  // runIndexInBackground), fall through to the real foreground work below — this
  // guard, not the absence of `--background`, prevents an unbounded fork bomb when
  // `config.performance.background` is enabled (the child inherits that config).
  const isBackgroundChild = process.env[NEXUS_INDEX_CHILD_ENV] === "1";
  if (!isBackgroundChild && (args.bools.has("background") || config.performance.background)) {
    return runIndexInBackground(root, output, io);
  }

  const docs = await collectIndexableDocs(root, config);
  if (docs.length === 0) {
    io.err(`nexus index: no indexable text files under ${root}\n`);
    return 1;
  }

  // Chunk + embed + store every document (cache-wrapped embedder so a re-index is
  // cheap/idempotent). Re-indexing replaces prior chunks for the same doc id.
  // A real provider embedder is used when configured; otherwise the offline default.
  const embedder = await resolveRagEmbedder(config, io);
  const index = openRagIndex(config, { cached: true, load: false, ...(embedder ? { embedder } : {}) });
  const chunks = await index.index(
    docs.map((d) => {
      const lang = detectLanguage(d.path);
      return { id: d.id, text: d.text, source: d.path, ...(lang !== "unknown" ? { lang } : {}) };
    }),
  );
  const file = index.save();

  // Structural repo map (aider-style, PageRank-ranked) over the same tree.
  const map = await repoMap(root, {
    budgetTokens: config.fileintel.budgetTokens,
    extraIgnore: config.fileintel.ignore,
    maxTotalBytes: config.fileintel.maxTotalBytes,
    maxFiles: config.fileintel.maxFiles ?? config.fileintel.maxTotalFiles,
  });

  if (output === "json") {
    io.out(
      `${JSON.stringify({
        root,
        indexFile: file,
        documents: docs.length,
        chunks: chunks.length,
        embedder: config.rag.embedder,
        repoMap: { files: map.files.length, symbols: map.ranked.length, tokens: map.tokens, truncated: map.truncated },
      })}\n`,
    );
    return 0;
  }

  io.out(`indexed ${docs.length} file(s) → ${chunks.length} chunk(s)\n`);
  io.out(`rag index: ${file}\n`);
  io.out(`repo map: ${map.files.length} file(s), ${map.ranked.length} symbol(s) (${map.tokens} tokens${map.truncated ? ", truncated" : ""})\n`);
  return 0;
}

// ── search (query the RAG index; show cited chunks) ───────────────────────────

/** Collapse whitespace and cap a chunk snippet for display. */
function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function cmdSearch(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const output = parseOutput(args);
  const query = (args.positionals.join(" ").trim() || (await readStdin()).trim()).trim();
  if (query.length === 0) {
    io.err("nexus search <query> (or pipe it in)\n");
    return 2;
  }
  const config = await loadEffectiveConfig();
  const file = ragStorePath(config);
  if (!existsSync(file)) {
    io.err("nexus search: no index found (run `nexus index` first)\n");
    return 1;
  }
  const embedder = await resolveRagEmbedder(config, io);
  const index = openRagIndex(config, { cached: true, load: true, ...(embedder ? { embedder } : {}) });
  if (index.size === 0) {
    io.err("nexus search: the index is empty (run `nexus index` first)\n");
    return 1;
  }

  const results = await index.query(query, { topK: config.rag.topK });
  if (output === "json") {
    io.out(
      `${JSON.stringify(
        results.map((r) => ({
          score: r.score,
          semanticScore: r.semanticScore,
          keywordScore: r.keywordScore,
          citation: {
            docId: r.citation.docId,
            source: r.citation.source ?? null,
            span: r.citation.span,
            lang: r.citation.lang ?? null,
          },
          text: r.chunk.text,
        })),
      )}\n`,
    );
    return results.length > 0 ? 0 : 1;
  }

  if (results.length === 0) {
    io.out("no matching chunks\n");
    return 1;
  }
  for (const r of results) {
    const cite = r.citation.source ?? r.citation.docId;
    io.out(`${cite}:${r.citation.span.start}-${r.citation.span.end}  score=${r.score.toFixed(3)}\n`);
    io.out(`  ${snippet(r.chunk.text)}\n`);
  }
  return 0;
}

// ── lsp (code intelligence: definition | references | diagnostics | hover) ────

/**
 * Drive one LSP operation from the CLI over the SAME tools the agent loop uses.
 * Degrades gracefully: an unknown language, an uninstalled server, or an
 * unreadable file all produce a clear message and a clean exit (never a crash).
 * With a real server on PATH it returns live navigation results; offline it just
 * reports that no server is installed.
 */
export async function cmdLsp(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "definition";
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();

  if (!config.lsp.enabled) {
    io.err("nexus lsp: disabled (set lsp.enabled=true)\n");
    return 1;
  }

  const toolBySub: Record<string, string> = {
    definition: "lsp_definition",
    references: "lsp_references",
    diagnostics: "lsp_diagnostics",
    hover: "lsp_hover",
    rename: "lsp_rename",
  };
  const toolName = toolBySub[sub];
  if (!toolName) {
    io.err(`nexus lsp: unknown subcommand "${sub}" (use: definition | references | diagnostics | hover | rename)\n`);
    return 2;
  }

  const file = args.positionals[1];
  if (!file) {
    io.err(`nexus lsp ${sub} <file> [--line L --character C]${sub === "rename" ? " --new-name <name>" : ""}\n`);
    return 2;
  }

  const registry = buildLspRegistry(config);
  const tools = new ToolRegistry();
  for (const t of lspTools({ registry, timeoutMs: config.lsp.timeoutMs })) tools.register(t);
  const tool = tools.get(toolName);

  const input: Record<string, unknown> = { file };
  const line = args.flags.get("line");
  const character = args.flags.get("character");
  if (line !== undefined) input.line = Number.parseInt(line, 10) || 0;
  if (character !== undefined) input.character = Number.parseInt(character, 10) || 0;
  if (sub === "rename") {
    const newName = args.flags.get("name");
    if (!newName) {
      io.err("nexus lsp rename <file> --line L --character C --name <newName>\n");
      return 2;
    }
    input.newName = newName;
  }

  const ac = new AbortController();
  const ctx = {
    signal: ac.signal,
    cwd: args.flags.get("cwd") ?? process.cwd(),
    runId: "lsp",
    traceId: "lsp",
  };
  const result = (await tool.run(input, ctx)) as Awaited<ReturnType<typeof tool.run>>;
  // `run` for the LSP tools always returns a Promise<ToolResult> (never a stream).
  const toolResult = result as { ok: boolean; content: Array<{ type: string; text?: string }> };
  const text = toolResult.content.map((b) => ("text" in b ? b.text ?? "" : "")).join("");

  if (output === "json") {
    io.out(`${JSON.stringify({ op: sub, file, ok: toolResult.ok, output: text })}\n`);
  } else if (toolResult.ok) {
    io.out(`${text}\n`);
  } else {
    // Graceful degradation (no server / unknown language) — informational on stderr.
    io.err(`${text}\n`);
  }
  // A graceful "no server / unknown language" is not a hard failure: exit 0 so
  // scripts can probe availability without treating absence as a crash.
  return 0;
}

// ── cache (stats | clear) ─────────────────────────────────────────────────────

export async function cmdCache(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "stats";
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const dir = cacheDir(config);

  if (sub === "stats") {
    const counts = await cacheEntryCounts(config);
    if (output === "json") {
      io.out(
        `${JSON.stringify({
          dir,
          enabled: config.cache.enabled,
          backend: config.cache.backend,
          responses: counts.responses,
          embeddings: counts.embeddings,
        })}\n`,
      );
      return 0;
    }
    io.out(`cache dir: ${dir}\n`);
    io.out(`response cache: ${config.cache.enabled && config.cache.responses ? "on" : "off"} — ${counts.responses} entr${counts.responses === 1 ? "y" : "ies"}\n`);
    io.out(`embedding cache: ${config.cache.embeddings ? "on" : "off"} — ${counts.embeddings} entr${counts.embeddings === 1 ? "y" : "ies"}\n`);
    io.out(`affinity: ${config.cache.affinity ? "on" : "off"}\n`);
    return 0;
  }

  if (sub === "clear") {
    for (const ns of ["responses", "embeddings"]) {
      const nsDir = join(dir, ns);
      if (existsSync(nsDir)) rmSync(nsDir, { recursive: true, force: true });
    }
    io.out(`cleared cache under ${dir}\n`);
    return 0;
  }

  io.err(`nexus cache: unknown subcommand "${sub}" (use: stats | clear)\n`);
  return 2;
}

// ── history (list | show) ─────────────────────────────────────────────────────

export async function cmdHistory(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const output = parseOutput(args);
  const config = await loadEffectiveConfig();
  const dbPath = config.history.dbPath ?? nexusPaths().historyDb;

  if (sub === "list") {
    const rows = await historyList(dbPath, 20);
    if (output === "json") {
      io.out(`${JSON.stringify(rows)}\n`);
      return 0;
    }
    if (rows.length === 0) {
      io.out("no history yet\n");
      return 0;
    }
    for (const r of rows) {
      const when = new Date(r.created_at).toISOString();
      const cost = (r.cost_usd ?? 0).toFixed(6);
      io.out(
        `${when}  ${r.run_id}  ${r.adapter_id}:${r.model}  ${r.status}  ` +
          `in=${r.input_tokens} out=${r.output_tokens} $${cost}\n`,
      );
    }
    return 0;
  }

  if (sub === "show") {
    const id = args.positionals[1];
    if (!id) {
      io.err("nexus history show <runId|sessionId>\n");
      return 2;
    }
    const events = await historyShow(dbPath, id);
    if (events.length === 0) {
      io.err(`no events for "${id}"\n`);
      return 1;
    }
    if (output === "json") {
      io.out(`${JSON.stringify(events.map((e) => ({ ...e, payload: JSON.parse(e.payload) as unknown })))}\n`);
      return 0;
    }
    for (const e of events) {
      let detail = e.type;
      try {
        const payload = JSON.parse(e.payload) as { text?: string; finishReason?: string };
        if (e.type === "text-delta" && typeof payload.text === "string") {
          detail = `text-delta ${JSON.stringify(payload.text)}`;
        } else if (e.type === "run-end") {
          detail = `run-end finish=${payload.finishReason ?? "?"}`;
        }
      } catch {
        /* leave detail as the raw type */
      }
      io.out(`#${e.seq} ${e.run_id.slice(0, 12)} ${detail}\n`);
    }
    return 0;
  }

  io.err(`nexus history: unknown subcommand "${sub}"\n`);
  return 2;
}
