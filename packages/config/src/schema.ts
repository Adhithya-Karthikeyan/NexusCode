/**
 * Config schema (zod) and precedence-merge types. Provider **key values** are
 * never in this cascade — only `apiKeyRef` / `apiKeyEnv` logical references,
 * resolved through the `SecretStore` (see ./secrets).
 */

import { z } from "zod";
import type { Pricing } from "@nexuscode/shared";

export const ProviderKind = z.enum([
  "openai-compat",
  "anthropic",
  "gemini",
  "bedrock",
  "vertex",
  "subprocess",
  "mock",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ProviderConfig = z
  .object({
    id: z.string().min(1),
    kind: ProviderKind,
    /** e.g. "@nexuscode/provider-openai". */
    adapter: z.string().min(1),
    /** compat reuse: grok, ollama, mistral, … */
    baseUrl: z.string().url().optional(),
    /** logical name → SecretStore. */
    apiKeyRef: z.string().optional(),
    /** e.g. "XAI_API_KEY". */
    apiKeyEnv: z.string().optional(),
    /** logical alias → native model id. */
    modelMap: z.record(z.string(), z.string()).default({}),
    /** probed/refreshed at runtime. */
    models: z.array(z.string()).default([]),
    /** subprocess: "claude", "codex". */
    command: z.string().optional(),
    /** probed flag map, not hardcoded. */
    flags: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().default(120_000),
    maxRetries: z.number().int().min(0).default(2),
    concurrency: z.number().int().positive().default(4),
  })
  .strict();
export type ProviderConfigInput = z.input<typeof ProviderConfig>;
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const RouteRule = z
  .object({
    when: z.object({
      capability: z.enum(["chat", "code-edit", "shell", "vision", "embed"]).optional(),
      tag: z.string().optional(),
    }),
    /** "anthropic/claude-sonnet" | "claude-code" */
    use: z.string().min(1),
    fallback: z.array(z.string()).default([]),
    optimize: z.enum(["quality", "cost", "latency", "local"]).default("quality"),
  })
  .strict();
export type RouteRule = z.infer<typeof RouteRule>;

/**
 * MCP server declaration embedded in the NexusConfig cascade (system-spec §7).
 * The shape mirrors `@nexuscode/mcp`'s `McpServerConfig` exactly so a validated
 * entry is structurally accepted by `McpClientManager.add()` — it is duplicated
 * here (rather than importing `@nexuscode/mcp`) to keep the low-level `config`
 * package free of the MCP SDK dependency. Auth material is NEVER inlined: remote
 * transports carry logical `bearerRef` / `headerRefs` resolved through the
 * `SecretStore` at connect time.
 */
export const McpTransportKind = z.enum(["stdio", "sse", "http"]);
export type McpTransportKind = z.infer<typeof McpTransportKind>;

export const McpAuthConfig = z
  .object({
    /** SecretStore ref → `Authorization: Bearer <resolved>`. */
    bearerRef: z.string().min(1).optional(),
    /** Header name → SecretStore ref (resolved and attached per request). */
    headerRefs: z.record(z.string(), z.string()).default({}),
    /** Static, non-secret headers merged into every request. */
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type McpAuthConfig = z.infer<typeof McpAuthConfig>;

export const McpServerConfig = z
  .object({
    /** Stable, unique server id; also the discovered-tool namespace. */
    name: z.string().min(1),
    /** Transport family. */
    transport: McpTransportKind,
    /** Disable without deleting the declaration. */
    enabled: z.boolean().default(true),
    /**
     * Trust this server's tool annotations (`readOnlyHint`) enough to let them
     * auto-downgrade a tool's permission classification to `"read"`. MCP
     * annotations are advisory/self-declared by the server (untrusted per the
     * MCP spec) — default false. Only set true for servers you actually trust.
     */
    trustAnnotations: z.boolean().default(false),
    // stdio
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    // sse / http
    url: z.string().url().optional(),
    auth: McpAuthConfig.optional(),
    /** Per-request timeout override (ms). */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "stdio") {
      if (!cfg.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `mcp server "${cfg.name}": stdio transport requires "command"`,
          path: ["command"],
        });
      }
    } else if (!cfg.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mcp server "${cfg.name}": ${cfg.transport} transport requires "url"`,
        path: ["url"],
      });
    }
  });
export type McpServerConfigInput = z.input<typeof McpServerConfig>;
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const PricingEntry = z
  .object({
    inputPer1M: z.number().nonnegative(),
    outputPer1M: z.number().nonnegative(),
    cacheReadPer1M: z.number().nonnegative().optional(),
    cacheWritePer1M: z.number().nonnegative().optional(),
    reasoningPer1M: z.number().nonnegative().optional(),
  })
  .strict();
export type PricingEntry = z.infer<typeof PricingEntry>;

export const TuiConfig = z
  .object({
    theme: z.enum(["dark", "light", "auto"]).default("auto"),
    panes: z.number().int().min(1).max(6).default(3),
  })
  .strict();

/**
 * RAG subsystem settings (system-spec §16). All optional/defaulted so an
 * existing config keeps parsing. The default `hashing` embedder is the
 * deterministic offline vectorizer — no network — so `index`/`search` work
 * fully offline; `ollama`/`openai` are the remote seams for production.
 */
export const EmbedderKind = z.enum(["hashing", "ollama", "openai", "provider"]);
export type EmbedderKind = z.infer<typeof EmbedderKind>;

export const RagConfig = z
  .object({
    /**
     * Allow the RagSource into the Context Engine (retrieval into assembled
     * context). OFF by default, deliberately: the persisted index is stored in a
     * GLOBAL data dir (`ragStoreFile` → `ragDataDir`), not per-project. It is
     * therefore not "this project's index" — enabling it by default retrieves
     * chunks indexed from OTHER repositories into this repository's prompt.
     * That is a correctness/leakage problem, not a tuning preference, and it is
     * also expensive: a real-world index here was 81MB / 7914 items, parsed on
     * every run (~200ms) to contribute ~1000 tokens of possibly-foreign code.
     *
     * Turn it on per-project once the index is scoped to the project (e.g. via
     * `storeFile`). When on, it stays a PERMISSION rather than a promise: the
     * source is only constructed if a non-empty index actually exists, so "no
     * index ⇒ contribute nothing" still holds (see `buildPowerSources`).
     */
    enabled: z.boolean().default(false),
    /** Which embedder to use. `hashing` is deterministic + offline (tests/default). */
    embedder: EmbedderKind.default("hashing"),
    /** Model id for the remote embedders (ollama/openai/provider); ignored by `hashing`. */
    embedderModel: z.string().optional(),
    /**
     * Provider id whose native embeddings API backs the `provider` embedder
     * (a registered adapter with `capabilities().embeddings === true` and an
     * `embed()` method — e.g. `openai`). Ignored by every other embedder kind;
     * when unset (or the provider has no embeddings) the offline `hashing`
     * embedder is used instead, so `index`/`search` never crash.
     */
    embedderProvider: z.string().optional(),
    /** Vector dimensionality (hashing embedder). */
    dims: z.number().int().positive().default(512),
    /** How many chunks the RagSource retrieves per query. */
    topK: z.number().int().positive().default(5),
    /** Override the persisted index file (default: data-dir `rag-index.json`). */
    storeFile: z.string().optional(),
    /** Target chunk size in characters. */
    chunkSize: z.number().int().positive().default(800),
    /** Character overlap carried between consecutive chunks. */
    overlap: z.number().int().min(0).default(100),
    /** Extra gitignore-style globs to skip when indexing a project. */
    ignore: z.array(z.string()).default([]),
    /**
     * Redact detected secrets (token prefixes, PEM private keys, `KEY=value`
     * credential lines) from chunk text before it is embedded, stored, or
     * persisted. On by default — enforces the "no secret persisted into the
     * index/cache" invariant and blocks exfiltration through a remote embedder.
     * A built-in secret-FILE denylist (`.env`, `*.pem`, `id_rsa`, …) is always
     * applied by the walker regardless of this flag.
     */
    secretScan: z.boolean().default(true),
    /**
     * Aggregate byte budget across every document `nexus index` reads into
     * memory for a single indexing run (guards the aggregate-memory DoS where
     * per-file caps alone don't bound the sum across a large/malicious repo).
     * Once exceeded, collection stops early and a truncation notice is written
     * to stderr — never silently.
     */
    maxTotalBytes: z.number().int().positive().default(128 * 1024 * 1024),
    /**
     * Aggregate cap on the (estimated) number of chunks produced by a single
     * indexing run. Once exceeded, document collection stops early and a
     * truncation notice is written to stderr — never silently.
     */
    maxTotalChunks: z.number().int().positive().default(100_000),
    /**
     * How many chunks are embedded per batch in {@link RagIndex.index}
     * (default 128). Bounds peak memory: at most one batch's worth of chunk
     * text + vectors is held at a time instead of the whole corpus.
     */
    embedBatchSize: z.number().int().positive().default(128),
  })
  .strict();
export type RagConfig = z.infer<typeof RagConfig>;

/**
 * Caching subsystem settings (system-spec §17 — CAG). Response caching is
 * opt-in (`enabled`); embedding caching and the router cache-affinity hook
 * default on but are inert until their consumers run.
 */
export const CacheConfig = z
  .object({
    /** Master switch for the response cache short-circuit on identical runs. */
    enabled: z.boolean().default(false),
    /** Cache directory (default: the platform cache dir / `NEXUS_CACHE_DIR`). */
    dir: z.string().optional(),
    /** TTL (ms) for cached entries; omit for no expiry. */
    ttlMs: z.number().int().positive().optional(),
    /** Backend for persisted caches. `disk` survives restarts; `memory` is per-process. */
    backend: z.enum(["memory", "disk"]).default("disk"),
    /** Cache model responses for identical requests. */
    responses: z.boolean().default(true),
    /** Memoize embedding vectors keyed by (model, text). */
    embeddings: z.boolean().default(true),
    /** Prefer a session's last provider so its prompt-cache stays warm (still fails over). */
    affinity: z.boolean().default(true),
  })
  .strict();
export type CacheConfig = z.infer<typeof CacheConfig>;

/**
 * File Intelligence settings (system-spec §11). Enables the structural
 * RepoMapSource and bounds the repo map's token budget / walk.
 */
export const FileIntelConfig = z
  .object({
    /**
     * Enable the RepoMapSource in the Context Engine (structural context). On by
     * default: a coding harness that cannot see the shape of the repo answers
     * from generic priors instead of this project. Cost is bounded by
     * `budgetTokens` below, and the map lands in the cache-stable static prefix
     * so repeat turns hit the provider prompt-cache rather than re-paying.
     */
    repoMap: z.boolean().default(true),
    /**
     * Token budget for the rendered repo map — the hard cap on its context cost,
     * enforced inside `repoMap()` before the Context Engine even packs. Kept
     * deliberately modest: prompt caching is NOT currently wired on the provider
     * path (`anthropicPrefixBlocks` in cli/src/power.ts is defined but never
     * called), so this is re-paid in full on EVERY turn of an agent loop rather
     * than being served from a cached prefix. Raise it once caching is wired.
     */
    budgetTokens: z.number().int().positive().default(768),
    /** Hard cap on the number of files the walker returns. */
    maxFiles: z.number().int().positive().optional(),
    /** Extra gitignore-style globs to skip when mapping a project. */
    ignore: z.array(z.string()).default([]),
    /**
     * Aggregate cap on the number of files an indexing walk returns, applied
     * when `maxFiles` above isn't explicitly set (guards the aggregate-memory
     * DoS alongside `maxTotalBytes`). Truncation is always logged to stderr,
     * never silent.
     */
    maxTotalFiles: z.number().int().positive().default(20_000),
    /**
     * Aggregate byte budget summed across every file an indexing walk returns
     * (distinct from any per-file size guard). Once exceeded, the walk stops
     * early and a truncation notice is written to stderr.
     */
    maxTotalBytes: z.number().int().positive().default(128 * 1024 * 1024),
  })
  .strict();
export type FileIntelConfig = z.infer<typeof FileIntelConfig>;

/**
 * Context Engine settings (system-spec §3) for the project-context sources that
 * are assembled on every request. These decide what a fresh install sends, so
 * each default is chosen to be BOUNDED: the conventions files are byte-capped
 * and the git lane is capped per section, and both degrade to contributing
 * nothing when absent (no instruction files / not a repo) rather than failing.
 */
export const ContextConfig = z
  .object({
    /**
     * Ingest the project's instruction files (CLAUDE.md / AGENTS.md, walking
     * cwd→root plus the home dir) into the static `conventions` lane. On by
     * default — these are the conventional "rules of this repo" files, and
     * before this they were only reachable via `nexus memory ingest`.
     */
    conventions: z.boolean().default(true),
    /**
     * Per-file byte cap for instruction files (truncated past this). With
     * `conventionsMaxFiles` this bounds the worst case at ~8KB ≈ 2k tokens —
     * the nearest (project) rules survive, distant/global ones are what get cut.
     */
    conventionsMaxBytes: z.number().int().positive().default(4096),
    /** Cap on how many instruction files are emitted, nearest scope first. */
    conventionsMaxFiles: z.number().int().positive().default(2),
    /**
     * Include working-tree `git status` + `git diff` in the volatile `git` lane.
     * On by default: knowing what is currently modified is the difference
     * between a harness and a chatbot. Volatile, so it sits behind the cacheable
     * prefix and is trimmed first when the budget is tight.
     */
    git: z.boolean().default(true),
    /**
     * Include the full `git diff` body, not just the status summary. OFF by
     * default: the diff is the expensive half of the git lane and it changes
     * every turn, so it is never cacheable and is re-sent in full on each turn
     * of an agent loop. Status alone tells the model what is in flight for a
     * fraction of the tokens, and an agent with tools can read the diff on
     * demand. Turn on for review-style workflows where the diff IS the subject.
     */
    gitDiff: z.boolean().default(false),
    /** Byte cap applied to EACH git section (status, diff) before estimation. */
    gitMaxBytes: z.number().int().positive().default(2048),
    /**
     * Environment variables to expose on the static `env` lane. Empty by default
     * — env is opt-in to avoid leaking anything; secret-looking keys are masked
     * even when listed.
     */
    envKeys: z.array(z.string()).default([]),
  })
  .strict();
export type ContextConfig = z.infer<typeof ContextConfig>;

export const HistoryConfig = z
  .object({
    enabled: z.boolean().default(true),
    dbPath: z.string().optional(),
  })
  .strict();

/**
 * Observability settings (system-spec §19). Controls whether the engine is
 * instrumented (spans through `CallContext.emit`), where finished spans are
 * exported, and the OTLP seam endpoint. All optional/defaulted so an existing
 * config keeps parsing. `file` is the offline default (NDJSON, no network);
 * `memory` keeps spans in-process only; `otlp` posts to a collector; `none`
 * disables export while still aggregating in-process metrics.
 */
export const ObservabilityExporter = z.enum(["file", "memory", "otlp", "none"]);
export type ObservabilityExporter = z.infer<typeof ObservabilityExporter>;

export const ObservabilityConfig = z
  .object({
    /** Instrument the engine (create spans + metrics). On by default. */
    enabled: z.boolean().default(true),
    /** Where finished spans go. `file` (NDJSON) is the offline default. */
    exporter: ObservabilityExporter.default("file"),
    /** Override the NDJSON span file (default: data-dir `traces.ndjson`). */
    filePath: z.string().optional(),
    /** OTLP/HTTP traces endpoint for the `otlp` exporter. */
    otlpEndpoint: z.string().url().optional(),
  })
  .strict();
export type ObservabilityConfig = z.infer<typeof ObservabilityConfig>;

/**
 * Agent framework settings (system-spec §5). Bounds the OODA loop and picks the
 * default specialized role. All optional/defaulted so an existing config keeps
 * parsing; the mock provider drives the loop fully offline.
 */
export const AgentRoleName = z.enum([
  "coordinator",
  "planner",
  "coder",
  "reviewer",
  "tester",
  "researcher",
  "architect",
  "doc-writer",
  "security-reviewer",
]);
export type AgentRoleName = z.infer<typeof AgentRoleName>;

export const AgentConfig = z
  .object({
    /** Default specialized role when `--role` is omitted. */
    defaultRole: AgentRoleName.default("coordinator"),
    /** Hard cap on OODA iterations per run when `--max-steps` is omitted. */
    maxSteps: z.number().int().positive().default(12),
    /** Retry budget for self-correction on a failed step. */
    maxRetries: z.number().int().min(0).default(2),
    /** Max provider re-invocations inside one step's native tool loop. */
    maxTurnsPerStep: z.number().int().positive().default(8),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfig>;

/**
 * Task-management settings (system-spec §15). Controls where the durable plan
 * store lives; an explicit `file` overrides the data-dir default.
 */
export const TasksConfig = z
  .object({
    /** Persist the plan/task DAG to disk (off ⇒ in-memory only). */
    persist: z.boolean().default(true),
    /** Override the durable tasks file (default: data-dir `tasks.json`). */
    file: z.string().optional(),
  })
  .strict();
export type TasksConfig = z.infer<typeof TasksConfig>;

/**
 * Terminal-integration settings (system-spec §13). Bounds background jobs and
 * selects the interactive-shell backend. `auto` prefers node-pty when present
 * and degrades to the always-available child_process seam otherwise.
 */
export const TerminalConfig = z
  .object({
    /** Default interactive shell for `nexus shell` (default: `$SHELL` or `/bin/sh`). */
    shell: z.string().optional(),
    /** PTY backend preference. `auto` = node-pty if available, else child_process. */
    pty: z.enum(["auto", "child_process", "node-pty"]).default("auto"),
    /** Combined stdout+stderr byte cap for a background job before it is killed. */
    maxOutputBytes: z.number().int().positive().default(8 * 1024 * 1024),
    /** Retained command-history entries. */
    historySize: z.number().int().positive().default(1000),
    /**
     * Ceiling on LIVE (running) background jobs a single ProcessManager tracks
     * at once. `job_spawn` refuses past it (resource-exhaustion / fork-bomb
     * guard); completed/killed jobs free a slot.
     */
    maxConcurrentJobs: z.number().int().positive().default(8),
    /**
     * Per-job wall-clock timeout (ms). A job that outruns it is SIGTERMed
     * (escalating to SIGKILL) and reaped instead of running forever.
     */
    maxJobRuntimeMs: z.number().int().positive().default(10 * 60 * 1000),
  })
  .strict();
export type TerminalConfig = z.infer<typeof TerminalConfig>;

/**
 * Native cloud-model providers (system-spec §2: Gemini / Bedrock / Vertex). Each
 * is registered in the default catalog so `providers list` / `doctor` see it with
 * zero config; "health" is purely whether a credential / creds are present (never
 * a network call). All optional/defaulted so an existing config keeps parsing;
 * `enabled:false` drops the provider from the catalog.
 */
export const GeminiProviderConfig = z
  .object({
    /** Register the Gemini Developer API provider in the default catalog. */
    enabled: z.boolean().default(true),
    /** Env var read for the API key (falls back to the SecretStore under `gemini`). */
    apiKeyEnv: z.string().default("GEMINI_API_KEY"),
    /** Logical alias → native Gemini model id. */
    modelMap: z.record(z.string(), z.string()).default({
      "gemini-flash": "gemini-2.0-flash",
      "gemini-pro": "gemini-1.5-pro",
    }),
  })
  .strict();
export type GeminiProviderConfig = z.infer<typeof GeminiProviderConfig>;

export const BedrockProviderConfig = z
  .object({
    /** Register the Amazon Bedrock provider in the default catalog. */
    enabled: z.boolean().default(true),
    /** AWS region (else the SDK's default resolution chain applies at call time). */
    region: z.string().optional(),
    /** Logical alias → native Bedrock model / inference-profile id. */
    modelMap: z.record(z.string(), z.string()).default({
      "bedrock-sonnet": "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "bedrock-nova": "amazon.nova-pro-v1:0",
    }),
  })
  .strict();
export type BedrockProviderConfig = z.infer<typeof BedrockProviderConfig>;

export const VertexProviderConfig = z
  .object({
    /** Register the Google Vertex AI provider in the default catalog. */
    enabled: z.boolean().default(true),
    /** GCP project id (else resolved from ADC / `GOOGLE_CLOUD_PROJECT`). */
    project: z.string().optional(),
    /** Vertex location/region. */
    location: z.string().default("us-central1"),
    /** Logical alias → native Vertex model id. */
    modelMap: z.record(z.string(), z.string()).default({
      "vertex-flash": "gemini-2.0-flash",
      "vertex-pro": "gemini-1.5-pro",
    }),
  })
  .strict();
export type VertexProviderConfig = z.infer<typeof VertexProviderConfig>;

/**
 * Code-Intelligence / LSP settings (system-spec §12). Drives the LSP-backed agent
 * tools (`lsp_definition`/`references`/`rename`/`diagnostics`/`hover`) and the
 * `nexus lsp` command. The built-in server registry is feature-detected at
 * runtime; `servers` registers extra launch recipes in addition to the defaults.
 * Everything degrades gracefully when no server is installed — never a crash.
 */
export const LspServerSpecConfig = z
  .object({
    /** NexusCode language key, e.g. `"typescript"`. */
    language: z.string().min(1),
    /** LSP `languageId` sent in `didOpen`. */
    languageId: z.string().min(1),
    /** Executable to spawn (resolved against PATH). */
    command: z.string().min(1),
    /** Arguments (usually a stdio flag like `--stdio`). */
    args: z.array(z.string()).default([]),
    /** File extensions this server handles (reverse lookup), e.g. `[".ts"]`. */
    extensions: z.array(z.string()).default([]),
    /** Root markers used to locate the workspace root. */
    rootMarkers: z.array(z.string()).default([]),
    /** Human label for diagnostics / HUD. */
    label: z.string().optional(),
  })
  .strict();
export type LspServerSpecConfig = z.infer<typeof LspServerSpecConfig>;

export const LspConfig = z
  .object({
    /** Enable the LSP-backed code-navigation tools + `nexus lsp`. */
    enabled: z.boolean().default(true),
    /** Extra server launch recipes registered alongside the built-in defaults. */
    servers: z.array(LspServerSpecConfig).default([]),
    /** Wall-clock budget (ms) for an LSP request (definition/references/diagnostics). */
    timeoutMs: z.number().int().positive().default(5000),
  })
  .strict();
export type LspConfig = z.infer<typeof LspConfig>;

/**
 * Extended tool-framework settings (system-spec §6, Wave 9). The six new tool
 * GROUPS (web/browser/db/cloud/containers/ai) are OPT-IN per project: nothing is
 * registered into the agent tool-loop unless its group name appears in
 * `enabledGroups`. `allow` / `deny` are tool-name glob patterns handed straight
 * to the `PermissionGate` (deny wins; allow pre-approves a tool, skipping the
 * mode's ask). The real client libraries backing these tools are OPTIONAL LAZY
 * dependencies — never inlined here; only logical references + non-secret knobs.
 */
export const ToolGroupName = z.enum(["web", "browser", "db", "cloud", "containers", "ai"]);
export type ToolGroupName = z.infer<typeof ToolGroupName>;

/** `web_search` provider selection + the `web_fetch`/`web_crawl` SSRF allowlist. */
export const ToolsWebConfig = z
  .object({
    /** Backend for `web_search`. `mock` is the deterministic offline provider. */
    searchProvider: z.enum(["mock", "http"]).default("mock"),
    /** Env var read for the `http` search provider's API key (never the value). */
    searchApiKeyEnv: z.string().optional(),
    /** SecretStore ref for the `http` search provider's API key (never the value). */
    searchApiKeyRef: z.string().optional(),
    /** Extra hostnames allowed past the SSRF guard (private/loopback stay blocked otherwise). */
    ssrfAllowlist: z.array(z.string()).default([]),
    /** Default max results for `web_search` when the caller omits it. */
    defaultMaxResults: z.number().int().positive().optional(),
  })
  .strict();
export type ToolsWebConfig = z.infer<typeof ToolsWebConfig>;

/**
 * A named database connection for the `db_*` tools. Mirrors the tool's
 * `connection` argument shape so a `tools run` invocation can reference a
 * connection by name instead of inlining the whole object. Secret values
 * (`password`) should be supplied via the environment / SecretStore rather than
 * committed here — this cascade is precedence-merged and may be shared.
 */
export const ToolsDbConnectionConfig = z
  .object({
    driver: z.enum(["sqlite", "postgres", "mysql", "snowflake", "bigquery"]),
    file: z.string().optional(),
    readonly: z.boolean().optional(),
    connectionString: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    database: z.string().optional(),
    ssl: z.boolean().optional(),
    account: z.string().optional(),
    warehouse: z.string().optional(),
    role: z.string().optional(),
    schema: z.string().optional(),
    projectId: z.string().optional(),
    keyFilename: z.string().optional(),
    location: z.string().optional(),
  })
  .strict();
export type ToolsDbConnectionConfig = z.infer<typeof ToolsDbConnectionConfig>;

export const ToolsDbConfig = z
  .object({
    /** Named connections usable by `tools run db_query --connection <name>`. */
    connections: z.record(z.string(), ToolsDbConnectionConfig).default({}),
  })
  .strict();
export type ToolsDbConfig = z.infer<typeof ToolsDbConfig>;

export const ToolsConfig = z
  .object({
    /** Tool groups registered into the agent tool-loop. Opt-in; empty by default. */
    enabledGroups: z.array(ToolGroupName).default([]),
    /** Tool-name glob patterns always allowed (pre-approved) by the PermissionGate. */
    allow: z.array(z.string()).default([]),
    /** Tool-name glob patterns always denied by the PermissionGate (wins over allow). */
    deny: z.array(z.string()).default([]),
    /** Web tool group settings (search provider + SSRF allowlist). */
    web: ToolsWebConfig.default({}),
    /** Database tool group settings (named connections). */
    db: ToolsDbConfig.default({}),
  })
  .strict();
export type ToolsConfig = z.infer<typeof ToolsConfig>;

/**
 * Extensibility — lifecycle hooks + outbound webhooks (system-spec §24). The
 * ten lifecycle events the `HookBus`/`WebhookDispatcher` in `@nexuscode/hooks`
 * fire on. Duplicated here (rather than importing `@nexuscode/hooks`) so the
 * low-level `config` package stays dependency-free; the two must stay in sync
 * (additive-only).
 */
export const HookEventName = z.enum([
  "session-start",
  "session-end",
  "pre-run",
  "post-run",
  "pre-tool",
  "post-tool",
  "pre-agent-step",
  "post-agent-step",
  "on-error",
  "on-approval",
]);
export type HookEventName = z.infer<typeof HookEventName>;

/**
 * A COMMAND hook (Claude-Code-style): a shell command run on `event`, handed the
 * JSON payload on stdin, whose stdout (`{block,reason,modify}`) or non-zero exit
 * may veto/modify a `pre-*` operation. In-process hooks aren't in the cascade —
 * a function can't be serialized — they're registered on the `HookBus` directly.
 * Never inline secrets here: the cascade is precedence-merged and may be shared.
 */
export const CommandHookConfig = z
  .object({
    /** Lifecycle event this hook fires on. */
    event: HookEventName,
    /** Executable to spawn (resolved against PATH). */
    command: z.string().min(1),
    /** Arguments passed to the command. */
    args: z.array(z.string()).default([]),
    /** Tool-name glob (`*` wildcard) scoping `pre-tool`/`post-tool` hooks. */
    matcher: z.string().optional(),
    /** Wall-clock budget (ms); an overrunning child is killed and treated as a block. */
    timeoutMs: z.number().int().positive().default(5000),
    /** Extra, non-secret env vars merged into the child's environment. */
    env: z.record(z.string(), z.string()).default({}),
    /**
     * On a VETO-CAPABLE event (`pre-run`/`pre-tool`/`pre-agent-step`/`on-approval`),
     * a hook whose child process fails to spawn/execute is, by default, treated as
     * a DENY (fail-closed) — an attacker who can make the hook crash must not
     * thereby bypass the control it enforces. Set `true` to restore the old
     * fail-open behavior for this hook. Observe-only events (`post-*`/`on-error`)
     * are unaffected either way (they can't veto).
     */
    failOpen: z.boolean().default(false),
  })
  .strict();
export type CommandHookConfigInput = z.input<typeof CommandHookConfig>;
export type CommandHookConfig = z.infer<typeof CommandHookConfig>;

export const HooksConfig = z
  .object({
    /** Master switch: when false, no command hooks are registered. */
    enabled: z.boolean().default(true),
    /** Declared command hooks. */
    hooks: z.array(CommandHookConfig).default([]),
  })
  .strict();
export type HooksConfigInput = z.input<typeof HooksConfig>;
export type HooksConfig = z.infer<typeof HooksConfig>;

/**
 * An outbound webhook: POST a signed, secret-redacted JSON envelope to `url` on
 * each subscribed event. The HMAC shared secret is a logical `secretRef`
 * resolved through the `SecretStore` at send time (never the value). By default
 * the target is SSRF-guarded exactly like the fetch tools — private/loopback
 * hosts are refused unless `allowPrivate` or an exact `ssrfAllowlist` entry
 * opts them in (e.g. a local receiver in tests / an internal collector).
 */
export const WebhookConfig = z
  .object({
    /** Destination URL (http/https). */
    url: z.string().url(),
    /** Lifecycle events that trigger a POST to this URL. */
    events: z.array(HookEventName).min(1),
    /** SecretStore ref for the HMAC signing secret (never the value). */
    secretRef: z.string().optional(),
    /** Disable without deleting the declaration. */
    enabled: z.boolean().default(true),
    /** Per-attempt wall-clock timeout (ms). */
    timeoutMs: z.number().int().positive().default(5000),
    /** Additional retry attempts on transient failure (network / non-2xx). */
    maxRetries: z.number().int().min(0).default(2),
    /** Exact hostnames/IP-literals allowed past the SSRF private/loopback block. */
    ssrfAllowlist: z.array(z.string()).default([]),
    /** Permit private/loopback targets outright (local receiver / internal use). */
    allowPrivate: z.boolean().default(false),
  })
  .strict();
export type WebhookConfigInput = z.input<typeof WebhookConfig>;
export type WebhookConfig = z.infer<typeof WebhookConfig>;

/**
 * Plugin system settings (system-spec §9). Discovery scans the built-in data-dir
 * `plugins/` directory plus any extra `dirs`, and (unless disabled) installed
 * `nexuscode-plugin-*` npm packages. Loading is sandboxed + version-gated in
 * `@nexuscode/plugins`; a plugin's contributions land in the SAME engine
 * registries the builtins use. All optional/defaulted so an existing config
 * keeps parsing.
 */
export const PluginsConfig = z
  .object({
    /** Master switch: when false, no plugins are discovered or loaded. */
    enabled: z.boolean().default(true),
    /** Extra directories whose immediate subdirectories are each a plugin. */
    dirs: z.array(z.string()).default([]),
    /** Also scan installed `nexuscode-plugin-*` npm packages under node_modules. */
    scanNodeModules: z.boolean().default(true),
  })
  .strict();
export type PluginsConfigInput = z.input<typeof PluginsConfig>;
export type PluginsConfig = z.infer<typeof PluginsConfig>;

/**
 * Enterprise subsystem settings (system-spec §25). RBAC, a declarative policy
 * engine, per-principal/role/org cost budgets, private model gateways, a
 * tamper-evident audit log, and usage analytics. FAIL-CLOSED + OFF BY DEFAULT:
 * `mode:"off"` (the default) leaves single-user behavior entirely unchanged — no
 * authorization check, no budget gate, no audit. Set `mode:"on"` to enforce. The
 * shape mirrors `@nexuscode/enterprise`'s `EnterpriseWireConfig` exactly so a
 * validated section is structurally accepted by `buildEnterpriseServices()`;
 * bearer tokens on principals are the ONLY secret-ish material and (like every
 * other credential) should be supplied via a shared/overridden layer, never
 * committed to a public cascade.
 */
export const EnterpriseGrant = z
  .object({
    actions: z.array(z.string()).default([]),
    resources: z.array(z.string()).default([]),
  })
  .strict();
export type EnterpriseGrant = z.infer<typeof EnterpriseGrant>;

export const EnterpriseRole = z
  .object({
    name: z.string().min(1),
    grants: z.array(EnterpriseGrant).default([]),
    inherits: z.array(z.string()).optional(),
  })
  .strict();
export type EnterpriseRole = z.infer<typeof EnterpriseRole>;

export const EnterprisePrincipalConfig = z
  .object({
    id: z.string().min(1),
    roles: z.array(z.string()).default([]),
    /** Bearer token authenticating this principal to the REST daemon (never logged). */
    token: z.string().optional(),
  })
  .strict();
export type EnterprisePrincipalConfig = z.infer<typeof EnterprisePrincipalConfig>;

export const EnterprisePolicyConditions = z
  .object({
    maxCostUsd: z.number().nonnegative().optional(),
    timeWindow: z.object({ start: z.string(), end: z.string() }).strict().optional(),
    dataClass: z.array(z.string()).optional(),
  })
  .strict();

export const EnterprisePolicyRule = z
  .object({
    id: z.string().optional(),
    effect: z.enum(["allow", "deny"]),
    subjects: z
      .object({
        roles: z.array(z.string()).optional(),
        principals: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    actions: z.array(z.string()).optional(),
    resources: z.array(z.string()).optional(),
    conditions: EnterprisePolicyConditions.optional(),
    description: z.string().optional(),
  })
  .strict();
export type EnterprisePolicyRule = z.infer<typeof EnterprisePolicyRule>;

export const EnterpriseBudget = z
  .object({
    id: z.string().min(1),
    scope: z.enum(["principal", "role", "org"]),
    key: z.string().min(1),
    limitUsd: z.number().nonnegative(),
    window: z.enum(["run", "day", "month"]),
    warnThreshold: z.number().min(0).max(1).optional(),
    onExceed: z.enum(["deny", "downgrade"]).optional(),
    downgradeTo: z.string().optional(),
  })
  .strict();
export type EnterpriseBudget = z.infer<typeof EnterpriseBudget>;

export const EnterpriseGateway = z
  .object({
    baseUrl: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    overrideProviderHeaders: z.boolean().optional(),
    egressAllowlist: z.array(z.string()).optional(),
  })
  .strict();
export type EnterpriseGateway = z.infer<typeof EnterpriseGateway>;

export const EnterpriseConfig = z
  .object({
    /** Master switch. `"off"` (default) ⇒ no enforcement — single-user behavior. */
    mode: z.enum(["off", "on"]).default("off"),
    /** Role for a principal that names no known role. */
    defaultRole: z.string().default("default"),
    /** Custom roles merged over the built-ins (admin/developer/viewer/default). */
    roles: z.array(EnterpriseRole).default([]),
    /** Principal directory (id → roles, optional bearer token). */
    principals: z.array(EnterprisePrincipalConfig).default([]),
    /** Declarative deny-overrides policy rules layered on top of RBAC. */
    policies: z.array(EnterprisePolicyRule).default([]),
    /** Spend budgets per principal/role/org. */
    budgets: z.array(EnterpriseBudget).default([]),
    /** Private model gateways: a global default plus per-provider overrides. */
    gateways: z
      .object({
        global: EnterpriseGateway.optional(),
        byProvider: z.record(z.string(), EnterpriseGateway).optional(),
      })
      .strict()
      .optional(),
    /** Audit-log persistence (append-only, redacted, hash-chained NDJSON). */
    audit: z.object({ file: z.string().optional() }).strict().optional(),
    /** Principal a CLI run is attributed to when none is given on the command line. */
    defaultPrincipal: z.string().optional(),
  })
  .strict();
export type EnterpriseConfigInput = z.input<typeof EnterpriseConfig>;
export type EnterpriseConfig = z.infer<typeof EnterpriseConfig>;

/**
 * Performance settings (system-spec §23). Groups the four perf knobs that Wave-12
 * wires end-to-end: the keep-alive HTTP connection pool (shared across every
 * HTTP provider adapter), lazy subsystem initialization in the runtime bootstrap,
 * and the `nexus index` background/watch defaults. All optional/defaulted so an
 * existing config keeps parsing, and every default reproduces the pre-Wave-12
 * behavior exactly (pool sizes mirror `@nexuscode/shared`'s `DEFAULT_*`).
 */
export const HttpPoolConfig = z
  .object({
    /** Max concurrent sockets per host (the pool size). Bounds fan-out. */
    maxSockets: z.number().int().positive().default(64),
    /** Max idle sockets kept warm per host for reuse. */
    maxFreeSockets: z.number().int().positive().default(16),
    /** How long (ms) an idle keep-alive socket lingers before TCP keep-alive probes. */
    keepAliveMsecs: z.number().int().positive().default(1000),
  })
  .strict();
export type HttpPoolConfig = z.infer<typeof HttpPoolConfig>;

export const WatchConfig = z
  .object({
    /** Debounce window (ms) before a watch-mode reindex fires after a change. */
    debounceMs: z.number().int().positive().default(150),
    /** Remove documents whose files vanished on each incremental watch reindex. */
    prune: z.boolean().default(false),
  })
  .strict();
export type WatchConfig = z.infer<typeof WatchConfig>;

export const PerformanceConfig = z
  .object({
    /** Keep-alive HTTP connection pool applied process-wide at runtime bootstrap. */
    pool: HttpPoolConfig.default({}),
    /**
     * Defer heavy subsystem construction to first use (the runtime's lazy cells).
     * On by default — startup and one-shot `ask` stay fast. When false, the
     * runtime eagerly constructs every registered lazy subsystem at bootstrap.
     */
    lazy: z.boolean().default(true),
    /** Default `nexus index` to a detached background re-index when no flag is given. */
    background: z.boolean().default(false),
    /** Watch-mode (`nexus index --watch`) incremental-reindex defaults. */
    watch: WatchConfig.default({}),
  })
  .strict();
export type PerformanceConfig = z.infer<typeof PerformanceConfig>;

/**
 * Per-provider authentication override (§2 auth, §18 security, Wave 13). Lets a
 * user pin which honest method a provider logs in with (`oauth` "login like
 * Claude Code" / guided `api-key` / vendor `cli-delegate` / `cloud-sso`) and,
 * for OAuth, override the public client/endpoints so an enterprise or
 * self-hosted authorization server can be used instead of the vendor default.
 * Every field is optional and additive — omit the section and the built-in
 * honest defaults apply unchanged. No secret is ever stored here (tokens live
 * only in the SecretStore).
 */
export const AuthProviderOverride = z
  .object({
    /** Force the login method for this provider (else the strategy's own default). */
    method: z.enum(["oauth", "api-key", "cli-delegate", "cloud-sso"]).optional(),
    /** OAuth flow mode override: browser loopback, device code, or auto-detect. */
    mode: z.enum(["browser", "device", "auto"]).optional(),
    /** Override the OAuth client id (enterprise/self-host public client). */
    clientId: z.string().min(1).optional(),
    /** Override the authorize endpoint (self-hosted / enterprise IdP). */
    authorizeUrl: z.string().url().optional(),
    /** Override the token endpoint (code→token, refresh, device polling). */
    tokenEndpoint: z.string().url().optional(),
    /** Override the device-authorization endpoint (RFC 8628 headless flow). */
    deviceEndpoint: z.string().url().optional(),
    /** Override the requested scopes. */
    scopes: z.array(z.string()).optional(),
    /**
     * Opt in to auto-opening a browser to the provider's key page during a
     * guided api-key login. Default `false` (unset) — the URL is printed for
     * the user to open themselves; equivalent to passing `--open` on
     * `nexus login`.
     */
    openBrowserOnLogin: z.boolean().optional(),
  })
  .strict();
export type AuthProviderOverride = z.infer<typeof AuthProviderOverride>;

/**
 * Authentication settings (Wave 13). `providers` carries optional per-provider
 * method/endpoint overrides; `tokenStore` hints where OAuth tokens are persisted
 * through the SecretStore chain — `auto` (default) prefers the OS keychain but
 * degrades to the encrypted file when a keychain prompt would block a headless
 * context, `file` forces the encrypted-file backend, `keychain` forces the OS
 * keychain. Fully additive: an absent section keeps the honest built-in defaults.
 */
export const AuthConfig = z
  .object({
    providers: z.record(z.string(), AuthProviderOverride).default({}),
    tokenStore: z.enum(["auto", "keychain", "file"]).default("auto"),
  })
  .strict();
export type AuthConfig = z.infer<typeof AuthConfig>;

export const NexusConfig = z
  .object({
    defaultProvider: z.string().default("anthropic"),
    defaultModel: z.string().optional(),
    providers: z.array(ProviderConfig).default([]),
    /** Declared MCP servers (system-spec §7). Connected + tool-discovered at session startup. */
    mcp: z.array(McpServerConfig).default([]),
    routing: z.array(RouteRule).default([]),
    approval: z.enum(["auto", "confirm", "dry-run"]).default("confirm"),
    tui: TuiConfig.default({}),
    history: HistoryConfig.default({}),
    /** Observability settings (tracing exporter, metrics). */
    observability: ObservabilityConfig.default({}),
    /** RAG subsystem settings (embedder choice, chunking, retrieval). */
    rag: RagConfig.default({}),
    /** Caching subsystem settings (response/embedding cache, affinity). */
    cache: CacheConfig.default({}),
    /** File Intelligence settings (repo map). */
    fileintel: FileIntelConfig.default({}),
    /** Context Engine settings (project conventions, git lane, env lane). */
    context: ContextConfig.default({}),
    /** Agent framework settings (OODA loop bounds, default role). */
    agent: AgentConfig.default({}),
    /** Task-management settings (durable plan store). */
    tasks: TasksConfig.default({}),
    /** Terminal-integration settings (background jobs, PTY seam, history). */
    terminal: TerminalConfig.default({}),
    /** Native Gemini (Developer API) provider settings (default catalog). */
    gemini: GeminiProviderConfig.default({}),
    /** Native Amazon Bedrock provider settings (default catalog). */
    bedrock: BedrockProviderConfig.default({}),
    /** Native Google Vertex AI provider settings (default catalog). */
    vertex: VertexProviderConfig.default({}),
    /** Code-Intelligence / LSP settings (agent tools + `nexus lsp`). */
    lsp: LspConfig.default({}),
    /** Extended tool-framework settings (opt-in tool groups, allow/deny, web/db). */
    tools: ToolsConfig.default({}),
    /** Lifecycle command hooks (§24 Extensibility; in-process hooks register on the HookBus). */
    hooks: HooksConfig.default({}),
    /** Outbound webhooks (§24 Extensibility): signed, redacted, SSRF-guarded POSTs on events. */
    webhooks: z.array(WebhookConfig).default([]),
    /** Plugin system (§9): discovery/load of engine-extending plugins. */
    plugins: PluginsConfig.default({}),
    /** Enterprise subsystem (§25): RBAC/policy/budgets/gateways/audit. Off by default. */
    enterprise: EnterpriseConfig.default({}),
    /** Performance settings (§23): connection pool, lazy init, index background/watch defaults. */
    performance: PerformanceConfig.default({}),
    /** Authentication settings (§2·§18, Wave 13): per-provider method/endpoint overrides + token store hint. */
    auth: AuthConfig.default({}),
    /** logical model id → pricing (USD per 1M tokens). */
    pricing: z.record(z.string(), PricingEntry).default({}),
    /** model / provider / "provider/model" id → estimated latency ms (routing `optimize:"latency"`). */
    latency: z.record(z.string(), z.number().nonnegative()).default({}),
    /** Quality ranking, best-first, of model/provider/"provider/model" ids (routing `optimize:"quality"`). */
    quality: z.array(z.string()).default([]),
  })
  .strict();

/** Loosely-typed input accepted before validation/merge. */
export type NexusConfigInput = z.input<typeof NexusConfig>;
/** Fully-defaulted, validated config. */
export type NexusConfig = z.infer<typeof NexusConfig>;

/** Map a config pricing entry to the runtime `Pricing` struct (per-MTok). */
export function toPricing(entry: PricingEntry): Pricing {
  const p: Pricing = {
    inputPerMTok: entry.inputPer1M,
    outputPerMTok: entry.outputPer1M,
  };
  if (entry.cacheReadPer1M !== undefined) p.cacheReadPerMTok = entry.cacheReadPer1M;
  if (entry.cacheWritePer1M !== undefined) p.cacheWritePerMTok = entry.cacheWritePer1M;
  if (entry.reasoningPer1M !== undefined) p.reasoningPerMTok = entry.reasoningPer1M;
  return p;
}

/**
 * Built-in per-MTok USD pricing for common Anthropic models so cost accounting
 * works out of the box — a real harness ships prices; users should not have to
 * configure them. Keyed by the logical/undated model ids the router uses;
 * `config.pricing` overrides any entry. An unknown model id simply falls through
 * to $0 (as before) — never a wrong number. Verify/extend against current
 * Anthropic pricing as models change.
 */
export const DEFAULT_PRICING: Record<string, Pricing> = {
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  "claude-opus-4-0": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-sonnet-4-0": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-3-5-sonnet": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 },
  "claude-3-haiku": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};

/** Build a `model id → Pricing` table: built-in defaults, overridden by config. */
export function pricingTable(config: NexusConfig): Record<string, Pricing> {
  const out: Record<string, Pricing> = { ...DEFAULT_PRICING };
  for (const [model, entry] of Object.entries(config.pricing)) out[model] = toPricing(entry);
  return out;
}
