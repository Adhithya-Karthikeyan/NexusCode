# NexusCode feature inventory and verification audit

**Audit date:** 2026-07-26  
**Audited revision:** current working tree  
**Result:** no known failures in the exercised offline/local test environment after the fixes listed below.

This document is the implementation-backed inventory of NexusCode. It separates
features that were exercised end to end from integrations that require the
operator's own provider credentials, cloud account, local binary, or optional
SDK.

## Provider and context continuity

Provider switching uses NexusCode's provider-neutral state, not a vendor's
private session format:

- A live engine session retains the user/assistant transcript when the active
  provider changes. The next provider receives the prior conversation.
- Every dispatch path now goes through the same context assembler: `ask`,
  `chat`, `code`, native agents, OODA agents, `compare`, `race`, `consensus`,
  `chain`, routed runs, failover, and the TUI.
- Project instructions (`AGENTS.md`, `CLAUDE.md`), repo map, durable memory,
  RAG results, selected environment context, and working-tree state are
  reassembled for the next provider under one token budget.
- Routed failover reuses one assembled request, so candidates see identical
  input. The result and cost are attributed to the provider/model that actually
  answered.
- Explicit switches and failovers add a bounded, secret-redacted, canonically
  serialized handoff capsule. Its HMAC-SHA-256 authentication covers the goal,
  provider transition, context manifest, constraints, partial state, and
  do-not-repeat action ids.
- Provider/account/model availability is persisted across processes. Known
  quota/auth blocks are ranked behind healthy candidates, expose their reset
  time through provider status, and admit only one cross-process half-open recovery probe.
- `chat --resume <session>` and `chat --continue` restore a transcript in a new
  process. Secret-redacted transcript rows are AES-256-GCM encrypted by default;
  `history.storePrompts: false` remains the explicit non-resumable opt-out.
- Claude Code and Codex native thread identifiers are stored in independent
  provider slots and resumed when returning to that provider. They supplement,
  but never replace, the portable Nexus transcript and handoff state.
- Direct runs and native agent turns use the same capability/cost/context-aware
  fallback planner as routed runs. The deterministic mock is never selected as
  a silent production fallback.
- ZLCTS captures normalized provider output, execution events, tool progress,
  and turn boundaries for ordinary and agentic runs. Raw payload blobs use
  AES-256-GCM at rest, with a per-install key from the SecretStore or a private
  `0600` fallback key file.
- Session-scoped Lamport allocation keeps transfer events ordered across
  concurrent lanes and provider changes.

The portable contract covers the transcript, assembled project context,
normalized events, tool results, files, and signed handoff capsule. It cannot
expose a provider's undocumented hidden reasoning or migrate a vendor-private
internal process snapshot; subprocess providers such as Claude Code and Codex
keep owning their own internal tool loop. Mid-stream continuation is opt-in and
conservative: read-only/text work can continue with overlap deduplication,
completed mutations require explicit action-id approval, and uncertain
mutations are rejected.

## Complete feature inventory

### Providers and authentication

- Native/provider adapters: OpenAI, Anthropic, Gemini, Vertex AI, Amazon
  Bedrock, Azure OpenAI, and Ollama.
- Coding CLI adapters: Claude Code and Codex through a normalized subprocess
  stream.
- Generic OpenAI-compatible transport for Grok, Groq, Together, DeepSeek,
  Mistral, OpenRouter, NVIDIA, LM Studio, vLLM, and compatible self-hosted
  endpoints.
- Deterministic offline `mock`, `mock-flaky`, and `mock-slow` variants for
  functional testing.
- Capability discovery, live model discovery with curated fallbacks, provider
  health, connection pooling, timeouts, retries, cancellation, and normalized
  error codes.
- OAuth 2.0 authorization-code + PKCE, device-code login, API-key capture,
  vendor-CLI delegation, and cloud credential/SSO chains.
- Environment → OS keychain → encrypted local vault secret resolution; secret
  values are masked in CLI output.

### Execution and orchestration

- Single completion, multi-turn chat, coding-subprocess execution, native
  tool-loop agents, planner runs, and OODA agents.
- Compare fan-out, first/best race, ranked/voted/merged consensus, and staged
  chains with hand-offs and optional approval gates.
- Declarative routing by quality, cost, latency, locality, capability, tags, or
  explicit order.
- Same-provider retry followed by cross-provider failover for eligible failures.
- Hierarchical cancellation from engine → session → turn → lane.
- One normalized stream for text, reasoning, tool calls/results, file edits,
  approvals, usage, terminal state, and errors.
- Per-run token/cost accounting, aggregate multi-lane usage, prompt-cache
  affinity, and response caching. Response-cache signatures include the fully
  assembled project context, preventing stale hits after project changes.

### Context, memory, and code intelligence

- Eleven ordered context lanes with deterministic cache-stable static prefixes
  and volatile-tail trimming under a configurable token ceiling.
- Automatic project conventions from `AGENTS.md` and `CLAUDE.md`.
- Ignore-aware file walking, language detection, symbols, dependencies,
  cross-references, PageRank repo map, and incremental updates.
- RAG indexing, overlapping cited chunks, hashing/provider embeddings, hybrid
  BM25 + cosine search, optional reranking, secret scanning, watch mode, and
  background indexing.
- Durable short/long/knowledge memory tiers.
- Git status/diff context and git flows for review, explanation, Conventional
  Commit messages, and PR descriptions.
- LSP definitions, references, diagnostics, hover, rename, formatting, symbols,
  and code actions, with clean degradation when a server is unavailable.

### Tools and agent safety

- Built-in file read/write/patch/search and shell execution.
- Web search, fetch, and bounded crawl with SSRF protection.
- Browser navigation, click, extraction, and screenshots through Playwright.
- SQLite plus optional PostgreSQL, MySQL, Snowflake, and BigQuery query/schema
  tools.
- Read-oriented AWS, Azure, GCP, Docker, Kubernetes, and OpenShift inspection.
- Vision, OCR, image generation, text-to-speech, and speech-to-text seams.
- Plan, read-only, workspace-write, and full-access permission modes;
  allow/deny lists; approval callbacks; secret-redacted arguments; delegation
  that can only narrow permissions.
- Tool timeouts, output caps, background jobs, command history, and PTY fallback.

### Sessions, storage, observability, and UI

- SQLite append-only event history, run summaries, session list/show/rename/
  branch/delete/export, replay, and redaction-safe local Code Receipts.
- Provider-neutral encrypted transfer capture, WAL folding, snapshots,
  integrity checks, crash recovery, and tool-progress capture.
- In-memory/file/OTLP OpenTelemetry-shaped spans and TTFT, latency, token, cost,
  tool, and error metrics; trace timeline/Gantt rendering.
- Ink/React TUI with live provider/model/effort/theme selection, 16 themes, five
  presets, conversation and pane layouts, and non-TTY fallback.
- Response, embedding, file, and prompt-prefix caching with memory/disk
  backends, TTL, accounting, and provider affinity.

### Extensibility, serving, and enterprise controls

- Embeddable TypeScript SDK and local REST + SSE daemon.
- MCP client, MCP server, and tool bridge.
- Sandboxed plugins with manifests, discovery, versioning, and tool/prompt/
  provider contributions.
- Ordered error-isolated lifecycle hooks, command hooks, and HMAC-signed
  SSRF-guarded webhooks.
- Durable task DAG with dependencies, lifecycle state, progress, and blockers.
- RBAC, deny-overrides policy rules, principal resolution, gateway enforcement,
  budgets with deny/downgrade behavior, usage analytics, and a hash-chained
  tamper-evident audit log.

## CLI surface

All 44 registered commands expose a working help path:

| Area | Commands |
| --- | --- |
| Run | `tui`, `ask`, `agent`, `chat`, `code`, `plan` |
| Orchestrate | `compare`, `race`, `consensus`, `chain`, `route` |
| Providers/auth | `providers`, `models`, `login`, `logout`, `auth`, `keys` |
| Code/git | `commit`, `review`, `explain`, `pr`, `lsp` |
| Context | `index`, `search`, `memory`, `cache` |
| Tools/extensions | `tools`, `mcp`, `plugin`, `jobs` |
| Tasks | `task` |
| Sessions/observability | `session`, `history`, `replay`, `receipt`, `trace`, `doctor` |
| Configuration/serving | `config`, `serve` |
| Enterprise | `rbac`, `policy`, `audit`, `budget`, `usage` |

See [COMMANDS.md](COMMANDS.md) for every flag, subcommand, example, and exit
code.

## Verification matrix

| Check | Scope | Result |
| --- | --- | --- |
| Dependency graph | `npm ls --all --depth=0` across 45 workspaces | Pass |
| Clean production build | All 45 packages in dependency order | Pass |
| Static typecheck | Every workspace | Pass |
| Automated suite | 2,049 tests across 209 executed test files | Pass |
| CLI help contract | 44/44 registered commands | Pass |
| Top-level activation matrix | 44/44 commands, including stateful mutation lifecycles | Pass |
| Optional tool activation | All six groups enabled; web/SQLite live, dependency/credential gaps actionable | Pass |
| Installed application | Global launcher, JSON ask, real PTY turn, live `/trace` picker | Pass |
| Orchestration | compare, race, consensus, chain, route, live failover | Pass |
| In-process provider switch | Transcript + project context + transfer capture | Pass |
| Cross-process provider switch | Provider A → resume → provider B, asserted on the HTTP wire | Pass |
| Signed live failover handoff | Primary quota 429 → fallback request contains validated capsule | Pass |
| Persistent circuit recovery | Seed → skip/diagnose → status → reset → successful dispatch | Pass |
| Partial recovery | Safe suffix continuation + overlap dedup; unsafe mutation refusal | Pass |
| Stream chaos contract | Lifecycle/run-id/tool-order/post-terminal violations | Pass |
| Ordinary transfer wiring | Built `ask` binary → encrypted ZLCTS rows/blobs | Pass |
| Cache invalidation | Same prompt before/after `AGENTS.md` change | Pass |
| Subprocess integration | Fake Claude Code/Codex-compatible binaries and abort/reaping paths | Pass |
| REST/SSE, sessions, export, hooks, MCP, RBAC | Local integration suites | Pass |

The activation matrix invoked every registered top-level command. It also ran
stateful add/list/get/update/remove flows for providers, MCP, plugins, tasks,
memory, jobs, budgets, sessions, history, exports, replay, receipts, and traces.
All six optional tool groups were enabled in an isolated profile: deterministic
web search and real local SQLite succeeded; browser SSRF, missing cloud
credentials, and absent container binaries produced bounded actionable errors;
AI vision completed through the selected provider.

## Issues found and fixed in this audit

1. Plain runs and multi-provider primitives bypassed project context assembly.
   Context assembly now lives in the kernel dispatch path and covers every
   ordinary/routed lane.
2. `transfer.enabled` existed in config but created no production transfer
   handle. The CLI now creates one encrypted run-local handle for every run
   surface.
3. Verbatim transfer blobs were plaintext. Production writes are now
   AES-256-GCM encrypted and legacy plaintext blobs are upgraded on write.
4. Per-run Lamport clocks could collide inside one session. Production now
   shares a monotonic session clock initialized from durable WAL state.
5. Response-cache keys omitted assembled project context. They now sign the
   exact request sent to the provider.
6. Routed failover could price the abandoned model instead of the winner. Cost
   is now recomputed for the model that answered.
7. Agent transfer boundaries did not close intermediate tool-using turns.
   Completed provider turns now have paired start/end markers.
8. The root build invoked two workspaces twice. The dependency-ordered build
   list now builds each workspace once.
9. Documentation and status counts were stale; they have been reconciled with
   the audited implementation.
10. Provider quota exhaustion, terminal/empty stream anomalies, wrapped-CLI
    stderr failures, and surface-specific silent errors could appear as blank
    replies. They now use a provider-neutral `quota_exhausted`/terminal error
    path with live failover, inline TUI/CLI diagnostics, SDK/server propagation,
    and failed-turn transcript rollback. See
    [EDGE-CASE-AUDIT.md](EDGE-CASE-AUDIT.md).
11. Provider exhaustion was remembered only inside the failing request. A
    persistent scoped circuit breaker now preserves quota/auth/model/transient
    cooldowns, honors provider reset hints, permits one half-open probe, and
    exposes `providers status` / `providers reset`.
12. Provider switching depended on implicit transcript continuity. Every live
    explicit switch and routed failover now sends a bounded signed handoff
    capsule with goal, context manifest, constraints, provider transition, and
    action retry guards.
13. A failure after partial text could only terminate. Safe partial continuation
    is now available by explicit config or `route test --recover-partial`, with
    action-state safety checks, untrusted-data envelopes, audit metadata, and
    overlap deduplication.
14. Malformed adapter streams and unbounded subprocess lines could violate the
    kernel contract or exhaust memory. The runtime now validates lifecycle and
    tool-call ordering, stops post-terminal output, and caps NDJSON line size.
15. Provider/model switching in the TUI updated only the provider id, leaving a
    stale model/context/reasoning state. Selection is now an atomic preflighted
    transaction with an inline rejection or switch receipt.
16. Half-open circuit probes and persisted writes could race across Nexus
    processes. File-backed operations are transaction-locked, probe leases are
    shared, and credential-reference fingerprints isolate account-wide limits.
17. Handoff action guards were live-process only. Authenticated capsules and
    workspace/action guards are now restored from encrypted storage after a
    restart.
18. The offline mock echoed the injected project-context preamble, making a
    simple prompt flood CLI/TUI output. It now identifies the actual final user
    prompt and bounds exceptionally large echoes.
19. First-winner races rendered a cancelled lane as `error: aborted` and could
    print the winning answer twice. Expected loser cancellation is now explicit
    and a winner/merge is printed only when it adds distinct content.
20. Several documented `-o json` mutations emitted prose or mixed child output
    with JSON. Task, memory, jobs, provider, MCP, plugin, session, budget, and
    circuit mutations now each emit one parseable JSON document.
21. `providers add --kind openai` and structured `config set` examples were
    documented but rejected. OpenAI-compatible aliases are normalized, duplicate
    provider ids are rejected, and valid JSON arrays/objects are coerced before
    schema validation.
22. TUI `/context` and `/cost` captured initial empty values, while `/trace`
    was a placeholder. All three now subscribe to the live session projection;
    `/trace` exposes the current id and exact `nexus trace <id>` command.
23. CLI-created AI tools did not receive the active provider adapter, leaving
    vision/OCR inert even when a provider was selected. Native agents, OODA
    agents, and manual `tools run ... -p/-m` calls now bind the selected
    provider/model.
24. History JSON leaked internal SQLite `snake_case` names, so a listed run id
    could not be fed back using the public camelCase convention. List/show now
    share a stable camelCase contract and preserve malformed legacy payloads
    without crashing.

## External validation boundary

No paid-provider credentials or cloud accounts were used during this audit.
The provider adapters are covered by conversion, streaming, capability,
authentication, error, model-list, and cancellation tests; OpenAI-compatible
behavior was also exercised against a real local HTTP/SSE server, and coding
CLI behavior against controlled subprocess binaries. A deployment should still
run `nexus doctor` and one credentialed smoke request for each provider/account
it intends to use, because account permissions, quotas, regions, installed
vendor CLI versions, and remote service availability are external state.

Remote behavior can still differ from the local contract suite, so keep one
credentialed canary per deployed provider/version. Private provider reasoning
and vendor-owned process snapshots remain outside the portable handoff
contract.
