/**
 * `@nexuscode/sdk` — the public, embeddable facade (system-spec §24). One
 * import gives a third party the entire harness: `ask` / `compare` / `race` /
 * `consensus` / `chain` primitives, an agentic `agent` loop, provider + tool
 * registration, an async event stream, and session open/resume — all driven
 * through the SAME engine the CLI uses.
 *
 * The facade is a thin CLIENT of the kernel: it builds the runtime with the
 * shared `@nexuscode/runtime` bootstrap (never re-implementing provider
 * assembly), constructs one `Engine`, and dispatches the frozen orchestration
 * specs. No `process.exit`, no CLI/TUI coupling, no stdout writes — everything
 * is returned as values, streams, and events.
 */

import {
  createSecretStore,
  loadConfig,
  NexusConfig,
  type NexusConfigInput,
  type SecretStore,
} from "@nexuscode/config";
import { buildRuntime, type Runtime } from "@nexuscode/runtime";
import {
  createEngine,
  dispatch,
  dispatchAgent,
  userText,
  type ChainStage,
  type ContextAssembler,
  type Engine,
  type EventStore,
  type JudgeSpec,
  type Labeled,
  type Message,
  type OrchestrationSpec,
  type ProviderAdapter,
  type ProviderRegistry,
  type RunContext,
  type RunResult,
  type RunSpec,
  type SamplingParams,
  type Session,
  type StreamChunk,
  type TraceEvent,
  type UiEvent,
} from "@nexuscode/core";
import { randomUUID } from "node:crypto";
import {
  PermissionGate,
  ToolRegistry,
  type PermissionMode,
  type Tool,
} from "@nexuscode/tools";
import { Emitter, type Unsubscribe } from "./emitter.js";
import { NexusRun, type RunSink } from "./run.js";

/** A provider+model target for a lane. `"id"` or `"id/model"` or an object. */
export type Backend = string | { provider: string; model?: string };

/** The channels a `Nexus` publishes; subscribe with `on(...)` / `stream(...)`. */
export interface NexusEvents {
  /** Every raw labeled engine chunk, across every run. */
  chunk: Labeled<StreamChunk>;
  /** Normalized UI events (session/text/tool_call/usage/done/…), every run. */
  ui: UiEvent;
  /** Engine trace spans (run/tool spans, store errors, …). */
  trace: TraceEvent;
}

/** Options for {@link createNexus}. Everything is optional — zero-config works. */
export interface NexusOptions {
  /** A full or partial config object; defaulted + validated via the schema. */
  config?: NexusConfigInput;
  /**
   * Also merge on-disk config (user + project layers). When set, disk config is
   * the base and the inline `config` object is applied on top.
   */
  loadFromDisk?: boolean;
  /** Working directory for disk config discovery + the default tool workspace. */
  cwd?: string;
  /** Inject a SecretStore (defaults to the env→keychain→file chain). */
  secrets?: SecretStore;
  /** Append-only history/event store the engine persists chunks to. */
  store?: EventStore;
  /** Trace sink; receives every engine span in addition to the `trace` channel. */
  emit?: (event: TraceEvent) => void;
  /** Context Engine run before the first provider dispatch of every run. */
  contextAssembler?: ContextAssembler;
  /** Extra provider adapters registered on top of the config catalog. */
  providers?: ProviderAdapter[];
  /** Tools made available to `agent(...)` runs. */
  tools?: Tool[];
  /** Default permission mode for agentic runs (default `"read-only"`). */
  permissionMode?: PermissionMode;
  /** Default permission gate for agentic runs (overrides `permissionMode`). */
  gate?: PermissionGate;
  /** Bounds capability probing during provider registration. */
  signal?: AbortSignal;
}

/** Sampling knobs shared by the chat primitives. */
export interface SamplingOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: SamplingParams["reasoning"];
}

/** Options for {@link Nexus.ask}. */
export interface AskOptions extends SamplingOptions {
  provider?: string;
  model?: string;
  /** Run inside a specific session (defaults to the shared session). */
  session?: NexusSession;
}

/** Options for the multi-lane primitives (`compare`/`race`/`consensus`). */
export interface MultiLaneOptions extends SamplingOptions {
  session?: NexusSession;
}

/** Options for {@link Nexus.race}. */
export interface RaceOptions extends MultiLaneOptions {
  /** `"first"` returns the earliest lane; `"best"` judges settled lanes. */
  mode?: "first" | "best";
  /** Judge spec for `mode:"best"` (defaults to a chat rank judge). */
  judge?: JudgeSpec;
  /** Upper bound before still-running lanes are cancelled (`mode:"best"`). */
  bestTimeoutMs?: number;
}

/** Options for {@link Nexus.consensus}. */
export interface ConsensusOptions extends MultiLaneOptions {
  /** Judge spec (defaults to a chat vote judge). */
  judge?: JudgeSpec;
}

/** One stage of a {@link Nexus.chain}. */
export interface ChainStageSpec {
  name: string;
  provider?: string;
  model?: string;
  /** Seed input for this stage (required on stage 0; optional afterwards). */
  prompt?: string;
  system?: string;
  optional?: boolean;
  /** `"confirm"` gates the stage behind the `confirm` callback. */
  gate?: "auto" | "confirm";
}

/** Options for {@link Nexus.chain}. */
export interface ChainOptions extends SamplingOptions {
  provider?: string;
  model?: string;
  session?: NexusSession;
  /** Approval callback for stages with `gate:"confirm"` (default: allow). */
  confirm?: (stage: ChainStage, prev: RunResult | undefined) => boolean | Promise<boolean>;
}

/** Options for {@link Nexus.agent}. */
export interface AgentRunOptions extends SamplingOptions {
  provider?: string;
  model?: string;
  /** Tools for this run (added to the tools registered on the Nexus). */
  tools?: Tool[];
  /** Permission gate for this run (else the Nexus default gate). */
  gate?: PermissionGate;
  /** Permission mode for this run (builds a gate when no `gate` is given). */
  permissionMode?: PermissionMode;
  /** Hard cap on provider re-invocations (default 8). */
  maxTurns?: number;
  /** Workspace root handed to filesystem tools (default the Nexus `cwd`). */
  cwd?: string;
  session?: NexusSession;
}

/** Descriptor returned by {@link Nexus.listProviders}. */
export interface ProviderInfo {
  id: string;
  models: string[];
  transport?: string;
  available?: boolean;
  detail?: string;
  needsKey?: boolean;
}

/** Descriptor returned by {@link Nexus.listTools}. */
export interface ToolInfo {
  name: string;
  description?: string;
  permission: Tool["permission"];
  parameters: Tool["parameters"];
}

/** Options for {@link Nexus.registerProvider}. */
export interface RegisterProviderOptions {
  /** Skip the adapter's health probe (offline / custom in-process adapters). */
  skipHealth?: boolean;
  signal?: AbortSignal;
}

interface ParsedBackend {
  provider: string;
  model?: string;
}

function parseBackend(backend: Backend): ParsedBackend {
  if (typeof backend !== "string") {
    return backend.model !== undefined ? { provider: backend.provider, model: backend.model } : { provider: backend.provider };
  }
  const slash = backend.indexOf("/");
  if (slash > 0) {
    return { provider: backend.slice(0, slash), model: backend.slice(slash + 1) };
  }
  return { provider: backend };
}

/**
 * A session-scoped view of the facade: `ask` / `agent` bound to one durable,
 * resumable `Session`, plus its id and disposal. Turns opened here thread their
 * history through the same session container the engine persists.
 */
export class NexusSession {
  constructor(
    private readonly nexus: Nexus,
    /** The underlying engine session. */
    readonly raw: Session,
  ) {}

  get id(): string {
    return this.raw.id;
  }

  ask(prompt: string, opts: Omit<AskOptions, "session"> = {}): NexusRun {
    return this.nexus.ask(prompt, { ...opts, session: this });
  }

  agent(goal: string, opts: Omit<AgentRunOptions, "session"> = {}): NexusRun {
    return this.nexus.agent(goal, { ...opts, session: this });
  }

  /** Cancel every in-flight turn under this session. */
  async dispose(): Promise<void> {
    await this.raw.dispose();
  }
}

/**
 * The embeddable NexusCode client. Build one with {@link createNexus}, then
 * drive the harness through its methods. Holds a single `Engine` over the
 * runtime's provider registry; every primitive dispatches a frozen
 * orchestration spec and returns a {@link NexusRun}.
 */
export class Nexus {
  private disposed = false;
  private readonly sink: RunSink;
  private defaultSession!: NexusSession;

  private constructor(
    private readonly engineRef: Engine,
    private readonly runtime: Runtime,
    private readonly cfg: NexusConfig,
    private readonly toolRegistry: ToolRegistry,
    private readonly defaultGate: PermissionGate,
    private readonly cwd: string,
    private readonly emitter: Emitter<NexusEvents>,
  ) {
    this.sink = {
      chunk: (labeled) => this.emitter.emit("chunk", labeled),
      ui: (event) => this.emitter.emit("ui", event),
    };
  }

  /** @internal — used by {@link createNexus}. */
  static async _create(options: NexusOptions): Promise<Nexus> {
    const cwd = options.cwd ?? process.cwd();

    // Resolve the effective config. Disk layers (when requested) form the base;
    // the inline object is applied on top, then everything is schema-validated.
    let base: unknown = {};
    if (options.loadFromDisk) {
      const loaded = await loadConfig({ cwd });
      base = loaded.config;
    }
    const merged = options.config ? { ...(base as object), ...options.config } : base;
    const cfg = NexusConfig.parse(merged);

    const secrets = options.secrets ?? createSecretStore();
    const runtime = await buildRuntime(cfg, {
      secrets,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    // Register any caller-supplied adapters on top of the config catalog.
    for (const adapter of options.providers ?? []) {
      if (!runtime.registry.has(adapter.id)) {
        await runtime.registry.register(adapter, { skipHealth: true });
      }
    }

    const toolRegistry = new ToolRegistry();
    for (const tool of options.tools ?? []) toolRegistry.register(tool);

    const defaultGate =
      options.gate ?? new PermissionGate({ mode: options.permissionMode ?? "read-only" });

    // One engine over the runtime registry. The `emit` sink fans trace spans to
    // the `trace` channel and to the caller's optional sink.
    const emitter = new Emitter<NexusEvents>();
    const emitSpan = (event: TraceEvent): void => {
      emitter.emit("trace", event);
      options.emit?.(event);
    };

    const engine = createEngine({
      registry: runtime.registry,
      pricing: runtime.pricing,
      emit: emitSpan,
      ...(options.store ? { store: options.store } : {}),
      ...(options.contextAssembler ? { contextAssembler: options.contextAssembler } : {}),
    });

    const nexus = new Nexus(engine, runtime, cfg, toolRegistry, defaultGate, cwd, emitter);
    const rawSession = await engine.openSession();
    nexus.defaultSession = new NexusSession(nexus, rawSession);
    return nexus;
  }

  /** The live engine (advanced use — most callers need only the methods below). */
  get engine(): Engine {
    return this.engineRef;
  }

  /** The provider registry (advanced use). */
  get registry(): ProviderRegistry {
    return this.runtime.registry;
  }

  /** The effective, fully-defaulted config in use. */
  get config(): NexusConfig {
    return this.cfg;
  }

  /** The tool registry `agent(...)` draws from. */
  get tools(): ToolRegistry {
    return this.toolRegistry;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error("nexus: instance has been disposed");
  }

  private firstModel(providerId: string): string | undefined {
    try {
      return this.runtime.registry.capabilitiesOf(providerId).models[0]?.id;
    } catch {
      return undefined;
    }
  }

  private resolveModel(providerId: string, explicit?: string): string {
    return explicit ?? this.cfg.defaultModel ?? this.firstModel(providerId) ?? providerId;
  }

  private requireProvider(providerId: string): void {
    if (!this.runtime.registry.has(providerId)) {
      throw new Error(`nexus: provider "${providerId}" is not available`);
    }
  }

  private buildParams(opts: SamplingOptions): SamplingParams | undefined {
    const params: SamplingParams = {};
    if (opts.system !== undefined) params.system = opts.system;
    if (opts.maxTokens !== undefined) params.maxTokens = opts.maxTokens;
    if (opts.temperature !== undefined) params.temperature = opts.temperature;
    if (opts.reasoning !== undefined) params.reasoning = opts.reasoning;
    return Object.keys(params).length > 0 ? params : undefined;
  }

  private makeRunSpec(providerId: string, model: string, input: Message[], params?: SamplingParams): RunSpec {
    const spec: RunSpec = {
      adapterId: providerId,
      model,
      input,
      idempotencyKey: randomUUID(),
    };
    if (params) spec.params = params;
    return spec;
  }

  private sessionOf(opts: { session?: NexusSession }): Session {
    return (opts.session ?? this.defaultSession).raw;
  }

  // ── Primitives ──────────────────────────────────────────────────────────────

  /** Single-provider chat. Streams text and settles into one result. */
  ask(prompt: string, opts: AskOptions = {}): NexusRun {
    this.ensureLive();
    const providerId = opts.provider ?? this.cfg.defaultProvider;
    this.requireProvider(providerId);
    const model = this.resolveModel(providerId, opts.model);
    const params = this.buildParams(opts);

    const session = this.sessionOf(opts);
    const turn = session.newTurn({ messages: userText(prompt) });
    const run = this.makeRunSpec(providerId, model, turn.input, params);
    const handle = dispatch({ kind: "single", run }, turn.context());
    return new NexusRun(handle, { adapterIds: [providerId], single: true }, this.sink);
  }

  /** Fan the same prompt across N backends; every lane settles independently. */
  compare(prompt: string, backends: Backend[], opts: MultiLaneOptions = {}): NexusRun {
    this.ensureLive();
    const { runs, providerIds, ctx } = this.laneDispatch(prompt, backends, opts);
    const handle = dispatch({ kind: "compare", runs }, ctx);
    return new NexusRun(handle, { adapterIds: providerIds, single: false }, this.sink);
  }

  /** Race backends: `"first"` returns the earliest, `"best"` judges the field. */
  race(prompt: string, backends: Backend[], opts: RaceOptions = {}): NexusRun {
    this.ensureLive();
    const { runs, providerIds, ctx } = this.laneDispatch(prompt, backends, opts);
    const mode = opts.mode ?? "first";
    const spec: OrchestrationSpec =
      mode === "best"
        ? { kind: "race", runs, mode, judge: opts.judge ?? { domain: "chat", strategy: "rank" } }
        : { kind: "race", runs, mode };
    const handle = dispatch(
      spec,
      ctx,
      opts.bestTimeoutMs !== undefined ? { bestTimeoutMs: opts.bestTimeoutMs } : {},
    );
    return new NexusRun(handle, { adapterIds: providerIds, single: false }, this.sink);
  }

  /** Consensus: run N lanes, then reduce to one answer with a judge. */
  consensus(prompt: string, backends: Backend[], opts: ConsensusOptions = {}): NexusRun {
    this.ensureLive();
    const { runs, providerIds, ctx } = this.laneDispatch(prompt, backends, opts);
    const judge: JudgeSpec = opts.judge ?? { domain: "chat", strategy: "vote" };
    const handle = dispatch({ kind: "consensus", runs, judge }, ctx);
    return new NexusRun(handle, { adapterIds: providerIds, single: false }, this.sink);
  }

  /** Staged hand-off pipeline: each stage's result feeds the next. */
  chain(stages: ChainStageSpec[], opts: ChainOptions = {}): NexusRun {
    this.ensureLive();
    if (stages.length === 0) throw new Error("nexus: chain requires at least one stage");
    const session = this.sessionOf(opts);
    const providerIds: string[] = [];

    const chainStages: ChainStage[] = stages.map((s, i) => {
      const providerId = s.provider ?? opts.provider ?? this.cfg.defaultProvider;
      this.requireProvider(providerId);
      const model = this.resolveModel(providerId, s.model ?? opts.model);
      providerIds.push(providerId);
      const stageOpts: SamplingOptions = {
        ...opts,
        ...(s.system !== undefined ? { system: s.system } : {}),
      };
      const params = this.buildParams(stageOpts);
      const input = s.prompt !== undefined ? userText(s.prompt) : [];
      if (i === 0 && input.length === 0) {
        throw new Error("nexus: chain stage 0 requires a `prompt`");
      }
      const stage: ChainStage = {
        name: s.name,
        run: this.makeRunSpec(providerId, model, input, params),
      };
      if (s.optional !== undefined) stage.optional = s.optional;
      if (s.gate !== undefined) stage.gate = s.gate;
      return stage;
    });

    const turn = session.newTurn({ messages: chainStages[0]?.run.input ?? [] });
    const handle = dispatch(
      { kind: "chain", stages: chainStages },
      turn.context(),
      opts.confirm ? { confirm: opts.confirm } : {},
    );
    return new NexusRun(handle, { adapterIds: providerIds, single: false }, this.sink);
  }

  /** Agentic run: the native tool-execution loop, gated by the PermissionGate. */
  agent(goal: string, opts: AgentRunOptions = {}): NexusRun {
    this.ensureLive();
    const providerId = opts.provider ?? this.cfg.defaultProvider;
    this.requireProvider(providerId);
    const model = this.resolveModel(providerId, opts.model);
    const params = this.buildParams(opts);

    // Per-run tool view: the Nexus-registered tools plus any run-scoped tools.
    const tools = new ToolRegistry();
    tools.registerAll(this.toolRegistry.list());
    for (const t of opts.tools ?? []) if (!tools.has(t.name)) tools.register(t);

    const gate =
      opts.gate ??
      (opts.permissionMode ? new PermissionGate({ mode: opts.permissionMode }) : this.defaultGate);

    const session = this.sessionOf(opts);
    const turn = session.newTurn({ messages: userText(goal) });
    const run = this.makeRunSpec(providerId, model, turn.input, params);
    const handle = dispatchAgent(run, turn.context(), {
      tools,
      gate,
      maxTurns: opts.maxTurns ?? 8,
      cwd: opts.cwd ?? this.cwd,
    });
    return new NexusRun(handle, { adapterIds: [providerId], single: true }, this.sink);
  }

  // ── Registration + introspection ──────────────────────────────────────────

  /** Register a provider adapter on the live registry. */
  async registerProvider(adapter: ProviderAdapter, opts: RegisterProviderOptions = {}): Promise<void> {
    this.ensureLive();
    const registerOpts: { signal?: AbortSignal; skipHealth?: boolean } = {};
    if (opts.skipHealth !== undefined) registerOpts.skipHealth = opts.skipHealth;
    if (opts.signal) registerOpts.signal = opts.signal;
    await this.runtime.registry.register(adapter, registerOpts);
  }

  /** Register a tool available to future `agent(...)` runs. Throws on duplicate. */
  registerTool(tool: Tool): void {
    this.ensureLive();
    this.toolRegistry.register(tool);
  }

  /** Every registered provider with its models + reachability status. */
  listProviders(): ProviderInfo[] {
    this.ensureLive();
    return this.runtime.registry.ids().map((id) => {
      const info: ProviderInfo = { id, models: [] };
      try {
        info.models = this.runtime.registry.capabilitiesOf(id).models.map((m) => m.id);
      } catch {
        info.models = [];
      }
      try {
        const transport = this.runtime.registry.get(id).transport;
        if (transport) info.transport = transport;
      } catch {
        /* ignore */
      }
      const status = this.runtime.statuses.find((s) => s.id === id);
      if (status) {
        info.available = status.available;
        if (status.detail !== undefined) info.detail = status.detail;
        if (status.needsKey !== undefined) info.needsKey = status.needsKey;
      }
      return info;
    });
  }

  /** Every registered tool with its permission class + parameter schema. */
  listTools(): ToolInfo[] {
    this.ensureLive();
    return this.toolRegistry.list().map((t) => {
      const info: ToolInfo = { name: t.name, permission: t.permission, parameters: t.parameters };
      if (t.description !== undefined) info.description = t.description;
      return info;
    });
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  /** Subscribe to a channel. Returns an unsubscribe function. */
  on<K extends keyof NexusEvents>(event: K, handler: (payload: NexusEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  /** Async-iterable view of a channel (ends on `dispose()` or `signal` abort). */
  stream<K extends keyof NexusEvents>(event: K, signal?: AbortSignal): AsyncIterable<NexusEvents[K]> {
    return this.emitter.stream(event, signal);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** Open a fresh durable session. */
  async openSession(id?: string): Promise<NexusSession> {
    this.ensureLive();
    const raw = await this.engineRef.openSession(id !== undefined ? { id } : {});
    return new NexusSession(this, raw);
  }

  /** Resume an existing session by id (history replay lands with the store). */
  async resumeSession(id: string): Promise<NexusSession> {
    this.ensureLive();
    const raw = await this.engineRef.openSession({ resume: id });
    return new NexusSession(this, raw);
  }

  /** The always-present default session `ask` / `agent` use when none is given. */
  get session(): NexusSession {
    return this.defaultSession;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Cancel in-flight work, dispose providers, and drop all subscribers. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.defaultSession.dispose().catch(() => {});
    await this.engineRef.dispose();
    this.emitter.close();
  }

  // ── Internal lane helpers ────────────────────────────────────────────────────

  private laneDispatch(
    prompt: string,
    backends: Backend[],
    opts: SamplingOptions & { session?: NexusSession },
  ): { runs: RunSpec[]; providerIds: string[]; ctx: RunContext } {
    if (backends.length === 0) throw new Error("nexus: at least one backend is required");
    const session = this.sessionOf(opts);
    const turn = session.newTurn({ messages: userText(prompt) });
    const runs: RunSpec[] = [];
    const providerIds: string[] = [];
    for (const backend of backends) {
      const { provider, model: explicitModel } = parseBackend(backend);
      this.requireProvider(provider);
      const model = this.resolveModel(provider, explicitModel);
      providerIds.push(provider);
      const params = this.buildParams(opts);
      runs.push(this.makeRunSpec(provider, model, turn.input, params));
    }
    return { runs, providerIds, ctx: turn.context() };
  }
}

/** Build and initialize an embeddable {@link Nexus} client. */
export async function createNexus(options: NexusOptions = {}): Promise<Nexus> {
  return Nexus._create(options);
}
