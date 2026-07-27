# NexusCode — Authoritative Capability Inventory

**Status of this document:** derived from the code in `packages/` and `apps/nexus-mac`, not from
`docs/`. Where the existing docs disagree with the code, the code is recorded here and the
disagreement is listed under **CONTRADICTIONS**.

**Every capability below is `UNVERIFIED`.** Nothing here has been executed. A later pass tests and
promotes statuses. "Expected behaviour" states what the code *says* should happen — reading the
source, not observing a run.

## How to read a section

| Field | Meaning |
| --- | --- |
| **What** | One plain-words line. |
| **Surface** | The exact `nexus` command / flags / config keys, with `file:line` for the implementation. |
| **Inputs** | Flags, positionals, stdin, config keys, env vars. |
| **Outputs** | stdout per `-o text\|json\|ndjson`, stderr, exit codes, `UiEvent`s emitted. |
| **Expected behaviour** | The important field. Includes failure, cancel, timeout, provider-unavailable, resume, and mid-conversation switch. |
| **macOS app** | Where the app surfaces it (`file:line`), or `NOT SURFACED`. |
| **Status** | `UNVERIFIED` for everything. |

Line numbers are from the working tree at the time of writing.

---

# Part I — The command surface

## 1. Command registration and routing

- **What:** The `nexus` binary (alias `nx`) is a clipanion CLI; every verb is a thin shell that
  proxies its remaining argv to a shared parser and a handler function.
- **Surface:**
  - Binary + registration: `packages/cli/src/index.ts:994-1049` (`cli.register(...)` × 48).
  - Base class capturing argv: `packages/cli/src/index.ts:270-286` (`HandlerCommand`, `Option.Proxy()`).
  - The full registered verb list (with aliases):
    `tui`, `ask`(`run`,`q`), `agent`, `plan`, `roles`, `task`(`tasks`), `jobs`, `tools`, `code`,
    `chat`, `mcp`, `compare`, `race`, `consensus`, `chain`, `route`, `memory`, `providers`,
    `models`, `login`, `logout`, `auth`, `keys`, `config`, `history`, `doctor`, `serve`,
    `plugin`(`plugins`), `index`, `search`, `lsp`, `cache`, `session`, `replay`, `receipt`,
    `trace`, `commit`, `review`, `explain`, `pr`, `rbac`, `policy`, `usage`, `audit`,
    `budget`(`budgets`), plus clipanion's `Builtins.HelpCommand` and `Builtins.VersionCommand`
    and the `DefaultCommand`.
- **Inputs:** `process.argv.slice(2)` (`index.ts:1049`).
- **Outputs:** Whatever the handler writes; the process exit code is the handler's return value.
- **Expected behaviour:**
  - `-h`/`--help` *after* a verb is intercepted in `HandlerCommand.execute`
    (`index.ts:280-283`) and prints that command's clipanion usage, exit `0` — it must never fall
    through to the handler and spend tokens.
  - Because every command uses `Option.Proxy()`, clipanion performs no per-command flag validation;
    all flag semantics come from `parseArgs` (§2).
  - An unknown verb reaches `DefaultCommand` (§6) and is rejected there.
- **macOS app:** The app never registers commands; it composes argv strings
  (`apps/nexus-mac/Sources/NexusKit/NexusClient.swift:40-117`). Composition is the only coupling.
- **Status:** `UNVERIFIED`

## 2. The shared flag grammar

- **What:** One flag spec shared by every command; commands read what they care about and ignore the rest.
- **Surface:** `FLAG_SPEC` at `packages/cli/src/index.ts:68-171`; parser at `packages/cli/src/args.ts:106-189`.
  - **Value flags** (`index.ts:69-131`): `provider`(`-p`), `model`(`-m`), `output`(`-o`),
    `system`(`-s`,`--system-prompt`), `kind`, `adapter`, `base-url`, `api-key-ref`, `api-key-env`,
    `value`, `tier`, `tags`, `max-turns`, `max-steps`, `role`(`-r`), `parent`, `deps`, `cwd`,
    `theme`, `preset`, `mode`, `judge`, `strategy`, `optimize`, `capability`(`--cap`), `stages`,
    `retries`, `agent`(`-a`), `transport`, `command`, `url`, `bearer-ref`, `json`, `format`(`-f`),
    `name`, `prompt`, `title`, `base`, `line`, `character`, `port`, `host`, `principal`, `action`,
    `resource`, `cost`, `window`, `from`, `to`, `limit`, `scope`, `key`, `id`, `on-exceed`,
    `downgrade-to`, `warn-threshold`, `decision`, `actor`, `resume`.
  - **Repeatable flags** (`index.ts:132-140`): `backend`(`-b`), `allow`, `deny`, `fallback`, `args`,
    `env`, `arg`.
  - **Boolean flags** (`index.ts:141-170`): `help`(`-h`), `tui`, `stdin`, `tools`(`-t`), `yolo`,
    `approve`, `read-only`, `ask`, `disabled`, `verify`, `background`(`--bg`), `watch`(`-w`),
    `device`, `api-key`, `all`, `open`, `continue`(`-c`), `persistent`, `recover-partial`.
- **Inputs:** `--flag value`, `--flag=value`, `-f value`, repeated flags accumulate, `--` ends flag
  parsing (`args.ts:141-144`).
- **Outputs:** `ParsedArgs { positionals, flags, multi, bools, unknown }` (`args.ts:7-23`).
- **Expected behaviour:**
  - An unrecognised `-`/`--` token is **not** an error. It is recorded as a boolean switch and
    pushed to `unknown` (`args.ts:168-177`), and one `warning: unknown flag(s) ignored: …` line is
    written to stderr (`args.ts:184-186`) with a Damerau-style "did you mean" suggestion within
    edit distance 2 (`args.ts:52-89`).
  - A value flag with no following token gets `""` (`args.ts:159`), not an error.
  - `multi` flags append; `flags` (single) are last-wins (`args.ts:160-167`).
- **macOS app:** The app builds argv arrays and relies on this grammar implicitly
  (`AppState.swift:260-301`). It has no copy of the spec, so a flag it invents is silently
  swallowed as a boolean — see **CONTRADICTIONS C2**.
- **Status:** `UNVERIFIED`

## 3. Output modes (`-o text | json | ndjson`)

- **What:** Three renderers over one normalised event stream.
- **Surface:** `parseOutput` at `packages/cli/src/commands.ts:201-205` and
  `packages/cli/src/wave6.ts:59-62`.
- **Inputs:** `-o` / `--output`.
- **Outputs:**
  - `text` — human output on stdout, diagnostics/usage/tool activity on stderr.
  - `json` — exactly one JSON document on stdout.
  - `ndjson` — one `UiEvent` per line on stdout.
- **Expected behaviour:**
  - Any value other than the three literals silently falls back to `text` (`commands.ts:203-204`).
    No warning is emitted.
  - `-o` is overloaded: `session export` and `receipt` treat `--output` as an output **file path**
    when it is not one of the three mode literals (`wave6.ts:258-269`, `wave6.ts:375-380`).
  - `text` streams live only for single-lane runs; multi-lane runs drain silently and render
    settled per-lane blocks so lanes never interleave character-by-character
    (`commands.ts:392-400`, `commands.ts:600-617`).
  - `json` never streams — the handler drains events without rendering and prints one document.
  - Secrets never reach stdout (module contract, `commands.ts:1-5`).
- **macOS app:** Uses `ndjson` for runs and `json` for one-shot queries
  (`NexusClient.swift:57`, `NexusClient.swift:65-67`).
- **Status:** `UNVERIFIED`

## 4. The `UiEvent` ndjson contract

- **What:** The single normalised projection of the engine's `StreamChunk` stream. This is the app's
  only wire contract.
- **Surface:**
  - Canonical union: `packages/core/src/projection.ts:14-108`.
  - Projection fold: `chunkToUiEvents` `packages/core/src/projection.ts:178-268`.
  - Lane key: `laneKey` `packages/core/src/projection.ts:271-274` (`"main"` for single runs, else adapter id).
  - Labeled entry point: `projectLabeled` `packages/core/src/projection.ts:277-284`.
  - CLI re-export: `packages/cli/src/ui.ts:13-19`. TUI re-export: `packages/tui/src/bridge/project.ts`.
- **Event types and payloads:**
  | `t` | Fields |
  | --- | --- |
  | `session` | `id` (RUN id), `sessionId?` (engine SESSION id), `provider`, `model`, `ts` |
  | `route` | `chosen`, `reason` (`explicit\|cost\|latency\|capability\|local`), `candidates[]` |
  | `failover` | `lane`, `from`, `to`, `code`, `message` |
  | `text` | `lane`, `delta` |
  | `reasoning` | `lane`, `delta` |
  | `agent` | `lane`, `phase`, `role`, `step`, `text`, `data?` |
  | `tool_call` | `lane`, `id`, `name`, `args` (always `undefined` at emit — see below) |
  | `tool_result` | `lane`, `id`, `ok`, `result` |
  | `diff` | `lane`, `path`, `patch` |
  | `approval` | `lane`, `id`, `action`, `detail` (JSON string), `resolution?` |
  | `usage` | `lane`, `inputTokens`, `outputTokens`, `cacheRead?`, `cacheWrite?`, `costUsd: number \| null` |
  | `error` | `lane`, `code`, `message`, `retryable` |
  | `done` | `lane`, `finishReason` |
- **Expected behaviour:**
  - `usage.costUsd` is `null` when pricing is genuinely **unknown**, distinct from a real `0` for a
    free provider. A consumer must render `null` as "unpriced", never `$0.00`
    (`projection.ts:98-105`, `projection.ts:114-116`).
  - `session.id` is a **run** id. `session.sessionId` is the engine session id and is the only value
    `--resume` accepts; passing `id` silently starts a new session (`projection.ts:22-30`).
    `sessionId` is present only when the caller passes it into `projectLabeled`.
  - `tool_call.args` is emitted as `undefined` — argument fragments stream as `tool-call-delta`
    chunks which project to nothing, and `tool-call-end` projects to nothing
    (`projection.ts:231-236`, `projection.ts:263-264`). **Argument values never reach the ndjson
    stream.**
  - `approval` appears twice for one real approval: the request (no `resolution`) then the
    settlement (same `id`, `resolution: {granted, cause}`) where `cause ∈ explicit | timeout |
    cancelled | stdin-closed` (`projection.ts:76-89`). `timeout` is **not** a decision;
    `cancelled`/`stdin-closed` mean the approval is moot, not refused.
  - A `run-start` carrying a `raw.failover` trail emits one `failover` event **per hop** before the
    `session` event (`projection.ts:180-198`).
  - `session-init` is a synthetic chunk emitted by agent loops on later turns; it projects to the
    failover trail only, never a duplicate `session` banner (`projection.ts:200-211`).
  - `usage` is projected exactly once, from the dedicated `usage` chunk. `run-end` deliberately
    does **not** re-project usage (`projection.ts:255-259`).
  - An unrecognised chunk type projects to `[]` (`projection.ts:265-266`) — silently dropped.
  - `chat -o ndjson` adds one non-`UiEvent` line per turn: `{"t":"turn_end","turnId":…,"ok":…}`
    (`commands.ts:3499-3501`). It is not part of the `UiEvent` union.
  - The TUI additionally injects a client-side `prompt` event that the CLI never emits
    (`packages/tui/src/store/events.ts`); the macOS app decodes it (`UiEvent.swift:71-75`).
- **macOS app:** Hand-written mirror at `apps/nexus-mac/Sources/NexusKit/UiEvent.swift:17-303`,
  decoder at `UiEvent.swift:305-327`. Drift guard is `Tests/NexusKitTests/UiEventDecodingTests.swift`.
  Unknown `t` values degrade to `.unknown` rather than being dropped (`UiEvent.swift:296-297`).
- **Status:** `UNVERIFIED`

## 5. Exit codes

- **What:** A consistent code vocabulary across commands.
- **Surface:** per-handler returns; the shared helper is `exitFor` `packages/cli/src/commands.ts:675-678`.
- **Expected behaviour (as implemented):**
  - `0` — success.
  - `1` — the operation ran and failed: provider unavailable, run errored, no results, a denied
    permission/RBAC check, a tampered audit chain, a budget deny.
  - `2` — usage error: missing prompt, unknown subcommand, malformed `--args` JSON, missing required
    flag, unknown `--role`, `--device` on a provider with no device endpoint.
  - `130` — `promptHiddenValue` on Ctrl+C during a hidden secret prompt (`commands.ts:4605`).
  - Single-lane: `0` iff `outcome.winner.status === "ok"`. Multi-lane: `0` iff not `partial`
    (`commands.ts:676-677`).
  - `race`: `0` iff a winner settled `ok` (`commands.ts:2621`). `consensus`: `0` iff a `merged`
    result exists (`commands.ts:2655`). `chain`: `0` iff not `partial` (`commands.ts:2733`).
  - `nexus lsp` deliberately returns `0` even when no language server is installed, so scripts can
    probe availability without treating absence as a crash (`commands.ts:5863-5865`).
  - `nexus login` with no provider on a **non-TTY** returns `0` with guidance, not `2`
    (`commands.ts:4917-4924`).
- **macOS app:** `NexusClient.runJSON` treats any non-zero exit as `.nonZeroExit(code, stderr)`
  (`NexusClient.swift:271-274`); it does not distinguish `1` from `2`.
- **Status:** `UNVERIFIED`

## 6. Bare `nexus` / the default command

- **What:** What happens with no verb, or with an unknown verb.
- **Surface:** `DefaultCommand` `packages/cli/src/index.ts:963-992`.
- **Inputs:** proxied argv; `process.stdout.isTTY`.
- **Outputs:** the TUI, the usage screen (`index.ts:173-265`), or an error line.
- **Expected behaviour:**
  - A first token that is not `--` and does not start with `-` reached the default command only
    because clipanion matched no path ⇒ it is an unknown command. Print
    `nexus: unknown command "<x>" — run \`nexus --help\`…` on stderr, exit `1`
    (`index.ts:974-984`).
  - `nexus git <anything>` gets a special hint pointing at `nexus review` / `explain` / `pr`
    (`index.ts:978-981`).
  - Flags-only (`nexus -p mock`, `nexus --theme …`) or truly bare **on a TTY** ⇒ launch the TUI
    (`index.ts:986-988`).
  - Truly bare on a **non-TTY** ⇒ print `USAGE` to stdout, exit `0` (`index.ts:989-990`).
  - Flags-only on a non-TTY still reaches `cmdTui`, which degrades to the linear fallback (§66).
- **macOS app:** `NOT SURFACED` — the app always passes an explicit verb.
- **Status:** `UNVERIFIED`

## 7. `--help` / usage

- **What:** Two help surfaces: the top-level usage screen and clipanion's per-command usage.
- **Surface:** `USAGE` string `packages/cli/src/index.ts:173-265`; per-command `Command.Usage({…})`
  blocks throughout `index.ts:288-948`; interception at `index.ts:280-283`.
- **Expected behaviour:**
  - `nexus --help` → clipanion's `Builtins.HelpCommand` (registered `index.ts:1000`), which renders
    the registered commands' `description`s — **not** the hand-written `USAGE` constant. `USAGE` is
    printed only by the bare non-TTY default path (`index.ts:989`).
  - `nexus <verb> -h` → that command's detailed clipanion usage, exit `0`.
  - `nexus login --help` / `nexus logout --help` are special-cased inside the handlers to print an
    honest per-provider flow list computed from the live auth registry
    (`commands.ts:4815-4862`, invoked `commands.ts:4904-4907` and `commands.ts:5065-5068`).
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 8. `--version`

- **What:** Prints the binary version.
- **Surface:** `Builtins.VersionCommand` registered at `packages/cli/src/index.ts:1001`;
  `binaryVersion: NEXUS_VERSION` from `packages/cli/src/version.ts` (`index.ts:997`).
- **Expected behaviour:** prints the version, exit `0`. Note `packages/cli/src/extensions.ts:41`
  states the binary reports `0.0.0` during development while plugin version gating uses a separate
  stable `NEXUS_HOST_VERSION = "1.0.0"` (`extensions.ts:42`).
- **macOS app:** `NOT SURFACED` — the app never checks the CLI version, so it cannot detect an
  incompatible CLI (see **GAPS G9**).
- **Status:** `UNVERIFIED`

---

# Part II — Providers, model selection, routing, failover

## 9. Provider registry and provider kinds

- **What:** One registry assembled at bootstrap from config + a built-in default catalog; every
  command resolves providers through it.
- **Surface:**
  - Bootstrap: `packages/runtime/src/index.ts` (`buildRuntime`), re-exported
    `packages/cli/src/runtime.ts:12-14`.
  - Auth-aware bootstrap: `buildAuthedRuntime` `packages/cli/src/runtime.ts:36-43`.
  - Registry: `packages/core/src/registry.ts`. Adapter contract: `packages/core/src/adapter.ts`.
  - Config: `providers[]` (`packages/config/src/schema.ts:21-47`), `defaultProvider`,
    `defaultModel`, plus per-cloud sections `gemini` / `bedrock` / `vertex`
    (`schema.ts:595-640`).
- **Provider kinds (config `kind`)** — `packages/config/src/schema.ts:10-19`, dispatched at
  `packages/runtime/src/index.ts:285-360`:
  `mock`, `anthropic`, `openai-compat` (accepts `openai` / `openai-compatible` as aliases,
  normalised in `nexus providers add` at `commands.ts:4009-4012`), `gemini`, `bedrock`, `vertex`,
  `azure`, `subprocess`.
- **Built-in default catalog** (registered even with an empty `providers[]`):
  - OpenAI-compatible, registered **offline** (no health probe, no network):
    `groq`, `together`, `deepseek`, `mistral`, `openrouter`, `nvidia`, `lmstudio`, `vllm`
    (`packages/runtime/src/index.ts:88-98`, registration `:440-481`).
  - `azure-openai` (`runtime/src/index.ts:512-517`).
  - Cloud natives `gemini`, `bedrock`, `vertex` (`runtime/src/index.ts:184-213`).
  - `anthropic` — registered only when a caller supplies an auth registry
    (`registerDefaultAnthropicProvider`, `runtime/src/index.ts:547-619`). This is why nearly every
    command uses `buildAuthedRuntime`, not `buildRuntime`.
  - Subprocess coding CLIs `claude-code` (bin `claude`, env `NEXUS_CLAUDE_CODE_BIN`) and `codex`
    (bin `codex`, env `NEXUS_CODEX_BIN`) — `runtime/src/index.ts:123-124`, registration `:631-655`.
  - `mock` — always registered, always available; the offline escape hatch.
- **Outputs:** `runtime.registry`, `runtime.statuses` (`{id, kind, available, needsKey?, detail?}`,
  `runtime/src/index.ts:42-48`), `runtime.pricing`, `runtime.secrets`, `runtime.subsystems`.
- **Expected behaviour:**
  - A provider package that fails to `import()` degrades to `available: false` with the error as
    `detail` — never a crash (`runtime/src/index.ts:466`, `:480`, `:641-654`).
  - `available` and `needsKey` are **different axes**: `available:false` means the package could not
    load; `available:true, needsKey:true` means installed but no credential yet.
  - `kind: "subprocess"` in `providers[]` is rejected with a message pointing at the default catalog
    (`runtime/src/index.ts:300-302`).
  - A subprocess provider is registered unconditionally so `nexus code` can report a clean
    "not installed" instead of an unknown-provider error; the binary probe sets `available`.
- **macOS app:** `NexusProvider` at `apps/nexus-mac/Sources/NexusKit/Providers.swift:18-69`,
  including the correct `available`/`needsKey` distinction (`Providers.swift:18-31`) and
  `isUsable = available && !needsKey` (`Providers.swift:68`).
- **Status:** `UNVERIFIED`

## 10. `nexus providers list | status | reset | add`

- **What:** Inspect provider availability, circuit state and pricing; reset a circuit; add a provider
  to user config.
- **Surface:** `cmdProviders` `packages/cli/src/commands.ts:3895-4044`.
- **Inputs:**
  - `list` (default) / `status` — no args.
  - `reset [providerId]`.
  - `add <id> --kind <k> --adapter <pkg> [--base-url] [--api-key-ref] [--api-key-env]`.
  - `-o json`.
- **Outputs:**
  - `list -o json` → the raw `runtime.statuses` **array** (a deliberately frozen contract,
    `commands.ts:3913-3914`).
  - `status -o json` → `{providers, circuits, circuitStore, pricing}` (`commands.ts:3916-3932`).
  - `text` → one line per provider prefixed `ok␣␣␣` / `key␣␣` / `--␣␣␣` / `hold␣` / `limit`
    (`commands.ts:3942-3950`), plus a price range and any circuit block reason/expiry.
  - `reset` → count of cleared records; `add` → the written config path.
- **Expected behaviour:**
  - Both `list` and `status` use `buildAuthedRuntime` so a provider the user is signed into via
    OAuth only (no `providers[]` entry) still appears — this is the picker's source of truth
    (`commands.ts:3901-3907`).
  - `limit` is shown when the blocking circuit reason is `quota`; `hold` for any other block or
    probe state (`commands.ts:3942-3947`).
  - `reset` with the circuit breaker disabled prints an error and exits `1` (`commands.ts:3983-3986`).
  - `add` validates the whole resulting config against the schema **before** writing
    (`commands.ts:4028-4032`); a duplicate id exits `1` (`commands.ts:4015-4018`).
  - A provider that cannot report capabilities contributes no models and no pricing rather than
    failing the listing (`commands.ts:3958-3963`).
- **macOS app:** `ProvidersController.refresh()` calls `providers status -o json`
  (`Providers.swift:158-179`) — a superset of `list`. `SelectableProvider` greys out rather than
  hides unusable providers (`Providers.swift:71-88`). `providers reset` and `providers add` are
  `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 11. Default-provider resolution and first-run fallback

- **What:** A brand-new user must never be dead-ended by an unconfigured `defaultProvider`.
- **Surface:**
  - `isProviderUsable` `packages/cli/src/runtime.ts:172-176`.
  - `pickFallbackProviderId` `packages/cli/src/runtime.ts:185-194`.
  - `resolveDefaultProvider` `packages/cli/src/runtime.ts:218-227`.
  - CLI wrapper printing the notice: `resolveDefaultProviderForRun` `packages/cli/src/commands.ts:276-297`.
- **Inputs:** `config.defaultProvider` (schema default `"anthropic"`, `schema.ts:1102`).
- **Outputs:** stderr notice
  `Not logged in — using the offline '<id>' provider. Run \`nexus login\`…` (`commands.ts:290-294`).
- **Expected behaviour:**
  - Usable = registered AND `available && !needsKey`. An OAuth login counts, because
    `registerDefaultAnthropicProvider` folds the resolved credential into `needsKey` at bootstrap
    (`runtime.ts:150-171`).
  - Fallback order: `mock` → `ollama`, `lmstudio`, `vllm` (`runtime.ts:180-183`) → the first usable
    status.
  - **Only the default path degrades.** An explicit `-p <id>` that is unusable is a hard error,
    exit `1` — e.g. `commands.ts:698-704` (`ask`), `:1024-1027` (`agent`), `:3307-3312` (`chat`),
    `:3652-3659` (`tui`).
  - Commands that apply the graceful default: `ask`, `chat`, `tui`, `models`, and the `ai` tool
    group inside `tools run`. Commands that do **not** (they use `config.defaultProvider` raw):
    `agent` (`commands.ts:1023`), `agent --role` (`commands.ts:1284`), the git flows
    (`wave6.ts:489`). See **CONTRADICTIONS C6**.
  - When literally nothing is usable, print the "not even the built-in mock provider" line and
    return `undefined` (`commands.ts:279-284`).
- **macOS app:** `NOT SURFACED` as a concept — the app shows whatever `providers status` reports and
  lets the user pick. The fallback notice arrives as a stderr diagnostic
  (`AppState.swift:422-423`).
- **Status:** `UNVERIFIED`

## 12. Model resolution

- **What:** Deciding which model id a run actually uses.
- **Surface:**
  - `resolveModel` `packages/cli/src/commands.ts:237-239` — `explicit ?? config.defaultModel ??
    firstModel(registry, providerId) ?? providerId`.
  - `resolveRunModel` `packages/cli/src/commands.ts:255-265` — the run-time variant.
  - `isSubprocessProvider` `packages/cli/src/commands.ts:242-244`.
- **Expected behaviour:**
  - For a **subprocess** provider (`claude-code` / `codex`), `resolveRunModel` returns `""` when no
    explicit `-m` and no `config.defaultModel` — it must never invent `--model claude-code`, which
    the vendor CLI would reject as an invalid model (`commands.ts:246-265`).
  - For every other provider, the final fallback is the literal `providerId` string as a model id —
    a placeholder that will fail at the provider, not a real model.
  - Git flows use their own resolution defaulting to `"mock-fast"` (`wave6.ts:496`).
- **macOS app:** `-m` is passed through verbatim when the user picks a model
  (`AppState.swift:264`, `:290`); the app never fabricates one.
- **Status:** `UNVERIFIED`

## 13. `nexus models [provider]`

- **What:** List ONE provider's models — the same source the TUI `/model` picker uses.
- **Surface:** `cmdModels` `packages/cli/src/commands.ts:4061-4122`; live listing helper
  `listModelsForProvider` `packages/cli/src/runtime.ts:100-142`.
- **Inputs:** positional `[provider]`, else `-p`, else `config.defaultProvider`; `-o json`.
- **Outputs:**
  - `json` → `{provider, kind, available, models:[{id, hint?}]}` (`commands.ts:4102-4111`).
  - `text` → `provider (kind)[ (unavailable)]` then two-space-indented `model  (hint)` lines.
- **Expected behaviour:**
  - Live discovery via `adapter.listModels()` bounded by a **4 s** timeout
    (`runtime.ts:113`, `:130-142`); on timeout/throw/empty it degrades to the curated
    `capabilities().models`. Never throws; an unknown provider yields `[]`.
  - An explicit provider that is not registered is a hard error, exit `1` (`commands.ts:4080-4083`).
    With no explicit provider it degrades like §11 (`commands.ts:4086-4091`).
  - A subprocess CLI whose catalog is delegated to the vendor session honestly reports
    `no models advertised` rather than inventing entries (`commands.ts:4115-4118`).
  - `hint` is a free-text string like `"200k ctx"`; there is no numeric context-window field in the
    JSON output.
  - **Pricing is not reported by this command** — only `providers status` carries it.
- **macOS app:** `ProvidersController.models(for:)` (`Providers.swift:183-199`), command factory
  `Providers.swift:228-230`. `NexusModel.contextWindow` re-parses the `"NNk ctx"` hint string
  (`Providers.swift:127-131`); pricing is merged in from `providers status`
  (`Providers.swift:134-136`, `:206-222`).
- **Status:** `UNVERIFIED`

## 14. Capability negotiation

- **What:** Each adapter declares what it can do; routing and switching read it.
- **Surface:** `Capabilities` in `@nexuscode/shared` (re-exported via `packages/core/src/index.ts:11`);
  `registry.capabilitiesOf(id)`; capability predicates for routing at
  `packages/cli/src/commands.ts:2758-2773`.
- **Known capability flags used in code:** `models[]` (each with optional `contextWindow`),
  `streaming`, `tools`, `vision`, `fileEdit`, `shellExec`, `reasoning`, `embeddings`.
- **Expected behaviour:**
  - `--cap` maps: `vision`→`c.vision`, `code-edit`→`c.fileEdit`, `shell`→`c.shellExec`,
    `tools`→`c.tools`, `chat`→`c.streaming || c.models.length > 0`. Anything else ⇒ no filter
    (`commands.ts:2769-2771`).
  - `runtime.registry.recordDiscoveredModels(...)` folds live-discovered models back into the
    registry so every consumer — including core's `assessSwitchTarget` — agrees a model exists
    (`commands.ts:3861-3867`).
  - `capabilitiesOf` on an unavailable adapter legitimately throws; callers wrap it
    (`commands.ts:229-235`, `:3959-3963`, `:3729-3732`).
- **macOS app:** Only `reasoning` is indirectly surfaced (via the effort control, which is
  cosmetic — see **CONTRADICTIONS C2**). `NOT SURFACED` otherwise.
- **Status:** `UNVERIFIED`

## 15. Provider circuit breaker

- **What:** Persistent per-provider (and per-model) availability/cooldown state shared by every run.
- **Surface:**
  - Implementation: `packages/core/src/provider-circuit.ts` (1097 lines).
  - CLI wiring: `openProviderCircuit`, `providerCircuitPath`, `continuityEngineOptions`
    `packages/cli/src/reliability.ts`.
  - Config: `providerCircuit` (`packages/config/src/schema.ts:429-443`) — `enabled` (default
    `true`), `filePath`, `transientFailureThreshold` (3), `baseCooldownMs` (30 s),
    `maxCooldownMs` (15 min), `quotaCooldownMs` (60 min), `modelUnavailableCooldownMs` (5 min),
    `maxClockSkewMs` (5 s), `maxEntries` (512).
- **Outputs:** `providers status -o json` `circuits[]` + `circuitStore` path
  (`commands.ts:3919-3920`); `doctor` circuit section (`commands.ts:5221-5243`).
- **Expected behaviour:**
  - Statuses carry `target {providerId, modelId?}`, `state`, `availability`
    (`blocked` | `probing` | …), `reason` (e.g. `quota`), `blockedUntil`.
  - A blocked target is excluded/deprioritised by the router (passed as `providerCircuit` into
    `Router.select`, `commands.ts:2803-2807`, `:2850-2854`).
  - `nexus providers reset [id]` clears records (`commands.ts:3981-3999`).
  - `nexus keys set <ref>` resets the circuit for every provider whose `id`/`apiKeyRef` matches the
    ref, and for `defaultProvider` (`commands.ts:4662-4670`) — fixing the key un-blocks the provider.
  - A successful `nexus login` resets that provider's circuit (`commands.ts:5016-5021`).
  - A corrupt state file surfaces as `circuit.loadIssue` and is **ignored**, not fatal
    (`commands.ts:3975`, `:5230`).
- **macOS app:** `NOT SURFACED` — `providers status -o json` carries `circuits`, but
  `ProvidersController.refresh` reads only `providers` and `pricing`
  (`Providers.swift:161-175`). See **GAPS G6**.
- **Status:** `UNVERIFIED`

## 16. `nexus route explain | test` (declarative routing)

- **What:** Show which provider a `RouteRule` picks, or actually run through it with live failover.
- **Surface:** `cmdRoute` `packages/cli/src/commands.ts:2788-2985`; `Router`
  `packages/core/src/router.ts`; `dispatchRoute` / `selectRoute`
  `packages/core/src/orchestrate/orchestrator.ts:1256`, `:1246`.
- **Inputs:**
  - `--optimize cost|latency|quality|local|explicit` (default `cost`, `commands.ts:2739-2743`).
  - `--allow <id>` / `--deny <id>` / `--fallback <id>` (all repeatable, `commands.ts:2746-2755`).
  - `--cap chat|vision|code-edit|shell|tools`.
  - `--retries <n>` (test only) — caps same-provider attempts before cross-provider failover
    (`commands.ts:2885-2889`).
  - `--recover-partial` (test only) — opt into safety-gated mid-response continuation
    (`commands.ts:2891-2897`).
  - Router metadata from config: `pricing`, `latency`, `quality` (`schema.ts:1150-1155`),
    via `routerMetadataFrom` (`commands.ts:2798`).
- **Outputs:**
  - `explain -o json` → `{optimize, chosen:{providerId,modelId,reason}|null, candidates:[{…,pricing}]}`;
    exit `1` when no candidate matches.
  - `explain -o text` → `chosen: p/m — reason — $in/$out per 1M …` then a numbered candidate list.
  - `test` → the run's normal stream, plus a stderr `[route] candidates: a → b → c` preview and a
    `[route] answered by <p>:<m> (failover: …)` trailer; `-o json` adds `failovers[]` and
    `partialRecoveries[]` to the winner's run JSON (`commands.ts:2959-2966`).
  - `UiEvent`s: `failover` per hop, then the usual `session`/`text`/`usage`/`done`.
- **Expected behaviour:**
  - The candidate preview applies **cache affinity** — a soft pin toward the session's last-used
    provider that reorders but never removes a candidate, so live failover still works
    (`commands.ts:2846-2856`). Key is `route:<defaultProvider>`.
  - After a successful `test`, the session is re-pinned to whichever provider actually answered
    (`commands.ts:2956-2958`), gated on `config.cache.affinity`.
  - Failover is transparent: same-provider retries first, then a provider switch on a
    **pre-first-chunk** failover-eligible error (`orchestrator.ts:1256-1262`).
  - `--retries 1` forces cross-provider failover instead of same-provider recovery.
  - SIGINT cancels the turn scope (`commands.ts:2912-2915`).
  - Unknown subcommand ⇒ stderr + exit `2` (`commands.ts:2983-2984`).
  - The `route` `UiEvent` type exists in the union but **no code path emits it** — `route explain`
    prints its own text/JSON and never projects (`commands.ts:2809-2836`). See **GAPS G12**.
- **macOS app:** `NOT SURFACED`. The app has no routing UI and never invokes `nexus route`.
- **Status:** `UNVERIFIED`

## 17. Failover, retry, and the handoff capsule

- **What:** Recovering a run when a provider fails, without losing the conversation.
- **Surface:**
  - Retry policy: `DEFAULT_RETRY_POLICY`, `RetryPolicy` `packages/core/src/resilience.ts`.
  - Failover: `runWithFailover` inside `packages/core/src/orchestrate/orchestrator.ts` (see
    `:1256-1262`); `FailoverEvent` consumed at `commands.ts:2931-2943`.
  - Handoff capsule: `packages/transfer/src/handoff-capsule.ts` (1243 lines); seam
    `ProviderHandoffBuilder` `packages/core/src/types.ts:296`.
  - Config: `transfer.handoff` (`schema.ts:399-424`) — `mode` (`full`|`consult`),
    `inflightWaitMs` (30 s), `preventRetryWindow` (5), `maxCapsuleTokens` (24 000),
    `maxCapsuleBytes` (128 KiB).
- **Outputs:** one `failover` `UiEvent` per hop (`projection.ts:184-188`); CLI renders
  `[failover] <from> → <to> (<code>)` on stderr (`commands.ts:482-484`).
- **Expected behaviour:**
  - Failover is only eligible **before the first chunk** of a response; once text has streamed, the
    partial-recovery path (§18) governs instead.
  - The winning candidate's `run-start.raw.failover` carries the whole trail, so the receipt is
    visible even when the hand-off happened inside the engine (`projection.ts:180-198`).
  - Agent loops suppress duplicate `run-start` chunks on later turns and emit a synthetic
    `session-init` carrying only the failover trail (`projection.ts:200-211`).
  - A structured handoff capsule (a system message) is appended to the next provider's request so
    the new provider inherits the conversation's meaning, not just its text
    (`core/src/types.ts:284-296`).
  - `actionGuard` blocks replay of completed/partial actions reconstructed at a handoff
    (`core/src/types.ts:319-329`) — this is what stops a switch from re-running a write.
- **macOS app:** `UiEvent.Failover` is decoded (`UiEvent.swift:63-69`) and folded into `ViewState`;
  rendering is in `ConversationView`. Never suppressed.
- **Status:** `UNVERIFIED`

## 18. Partial recovery (safety-gated mid-response continuation)

- **What:** Continuing a response on another provider **after** useful text already streamed —
  off unless explicitly enabled.
- **Surface:** `packages/core/src/partial-recovery.ts` (677 lines); runtime options
  `PartialRecoveryRuntimeOptions` `packages/core/src/types.ts:332-334`; CLI opt-in
  `--recover-partial` (`commands.ts:2891-2897`); config
  `transfer.handoff.partialContinuation.{enabled,maxContextCodePoints}`
  (`schema.ts:414-419`, default `enabled:false`, `maxContextCodePoints: 32768`).
- **Outputs:** `FailoverEvent.partialRecovery` → stderr line
  `[route] safely continuing partial response on <to> (recovery <id>, N protected action(s))`
  (`commands.ts:2934-2941`); `-o json` `partialRecoveries[]`.
- **Expected behaviour:**
  - Disabled by default. Enabling it is a deliberate, per-invocation or per-config act.
  - Only **text-only** continuation is permitted; `doNotRepeatActionIds` protects actions already
    performed so they are not re-executed on the new provider.
  - `MutationRecoveryApproval` (`core/src/types.ts:333`) gates continuation when mutations are
    involved.
- **macOS app:** `NOT SURFACED` — the app never passes `--recover-partial`.
- **Status:** `UNVERIFIED`

## 19. Provider/model switching (preflight, compatibility, receipts)

- **What:** Changing provider or model mid-conversation without losing context, meaning, or
  capability — the harness's second governing principle.
- **Surface:**
  - Core policy: `packages/core/src/switching.ts` — `ProviderSwitchPolicy`
    (`strict|fallback|ask`, `:22`), `ProviderSwitchRequirements` (`:24-37`),
    `ProviderSwitchAssessment` (`:39-49`), `ProviderSwitchPlan` (`:51-56`),
    `ProviderSwitchReceipt` (schema `nexus.provider-switch-receipt/v1`, `:58-71`),
    `estimateSwitchTokens` (`:118`), `inferSwitchRequirements` (`:138`),
    `assessSwitchTarget` (`:177`), `compatibleSwitchCandidates` (`:258`).
  - CLI preflight: `preflightModelSwitch` / `preflightProviderSwitch` / `SwitchContext` /
    `SwitchResult` `packages/cli/src/model-switch.ts`, bound to live state at
    `commands.ts:3772-3789`.
  - Config: `switching` (`schema.ts:446-467`) — `policy` (default `fallback`), `maxFallbacks` (3),
    `preferredProviders`, `allowProviders`, `denyProviders`, `maxCostMultiplier` (4),
    `contextSafetyMarginTokens` (1024), `showReceipts` (`true`), `nativeSessionSlots` (`true`).
- **Expected behaviour:**
  - Requirements are **inferred from the live request** (modalities, tools, reasoning, git, mcp),
    then the target is assessed for compatibility; incompatibility produces `blockers[]` and
    `warnings[]` rather than a silent downgrade (`switching.ts:39-49`).
  - A receipt records `preserved[]`, `adaptations[]`, `warnings[]` and whether the switch was
    `automatic` — the honesty artefact for "switching never loses capability".
  - In the TUI, an accepted switch re-points `activeProvider`/`activeModel` for the **next** turn
    and clears a stale `/effort` level when the new provider has no reasoning mode
    (`commands.ts:3780-3789`).
  - The engine's history budget is re-read **every turn** from the active model, so a switch to a
    smaller model trims history *before* the request rather than failing it
    (`commands.ts:3706-3710`, `historyBudgetFor`).
  - `providerSessions` keeps provider-native session ids in independent slots so switching back
    resumes the original native session (`core/src/types.ts:355-356`, config
    `switching.nativeSessionSlots`).
  - `loadLastProvider` lets an explicitly resumed session restore its last successful
    provider/model (`core/src/types.ts:342-348`).
- **macOS app:** **Partially surfaced, and the weakest link.** `-p`/`-m` are baked into argv at
  spawn, so the app tracks `launchedWith` and tears down the live process when the picker changes
  (`AppState.swift:207-217`, `:333-336`, `:389-397`). `activeBackendProvider` /
  `activeBackendModel` exist precisely so the UI cannot claim one provider while another answers.
  But: the teardown **discards the live session object** and the next submit starts a fresh
  `chat --persistent` with `--resume <sessionId>`, so continuity depends entirely on
  `history.storePrompts` and text-only resume. No switch receipt is read or displayed. See
  **GAPS G5**.
- **Status:** `UNVERIFIED`

---

# Part III — Run commands

## 20. `nexus ask` (aliases `run`, `q`)

- **What:** One-shot completion.
- **Surface:** `cmdAsk` `packages/cli/src/commands.ts:682-781`.
- **Inputs:** positional prompt and/or piped stdin (joined with `\n\n`, `commands.ts:218-222`);
  `-p`, `-m`, `-s/--system`, `-o`, `-t/--tools`.
- **Outputs:** stdout = answer text (streamed in `text` mode); stderr =
  `[usage] <p>:<m> in=N out=N cost=$… finish=…` (`commands.ts:500-504`) and, when observability is
  on, `[trace] ttft=…ms latency=…ms spans=N` (`commands.ts:439-452`).
  `UiEvent`s: `session`, `text`, `usage`, `done`, plus `error`/`failover` as they occur.
  Exit `0` iff the winner settled `ok`.
- **Expected behaviour:**
  - **`-t`/`--tools` re-routes the whole command to `cmdAgent`** (`commands.ts:684`) — `ask --tools`
    and `agent` are the same code path.
  - Empty prompt (no arg, nothing piped) ⇒ `nexus ask: no prompt …`, exit `2`.
  - The default system prompt is injected when `-s` is absent: environment framing with cwd, OS and
    date, plus a statement of available tools/MCP (`defaultSystemPrompt`, `commands.ts:865-873`).
  - Project context is assembled **before** the response-cache lookup, so the cache signature covers
    the exact context sent (`commands.ts:717-736`). A context-source failure is swallowed —
    enrichment is best-effort and must not sink the run (`commands.ts:734-736`).
  - Response cache (§46): an identical request short-circuits the provider entirely and prints
    `[cache] hit …` on stderr, exit `0` (`commands.ts:744-758`). A fresh successful answer is stored
    (`commands.ts:774-779`).
  - Explicit `-p` unavailable ⇒ hard error exit `1`; no `-p` ⇒ graceful fallback with a notice (§11).
  - SIGINT cancels the turn scope (`commands.ts:380-383`).
  - **`ask` does not accept `--resume`** — the flag parses but nothing reads it.
- **macOS app:** `RunMode.ask` (`AppState.swift:86`), but `.ask` runs through
  `chat --persistent` rather than `nexus ask` (`AppState.swift:248-250`). A `NexusCommand.ask(...)`
  factory exists and appends `--resume` (`NexusClient.swift:50-62`) but is unused by the UI — and
  the flag would do nothing. See **CONTRADICTIONS C4**.
- **Status:** `UNVERIFIED`

## 21. `nexus agent` — the native tool-execution loop

- **What:** An agentic run where the harness executes tools locally and re-invokes the provider.
- **Surface:** `cmdAgent` `packages/cli/src/commands.ts:993-1258`; dispatch
  `dispatchAgent` `packages/core/src/orchestrate/orchestrator.ts:2227`; loop semantics documented
  `orchestrator.ts:1685-1691`.
- **Inputs:** prompt/stdin; `-p`, `-m`, `-s`, `-o`, `--max-turns` (default **8**,
  `commands.ts:1075-1076`), `--cwd`, permission flags `--yolo` / `--approve` / `--read-only`,
  `--principal` (enterprise).
- **Tool set assembled** (`commands.ts:1040-1062`): built-ins → LSP tools (if `lsp.enabled`) →
  enabled tool groups → MCP server tools → plugin-contributed tools.
- **Outputs:** stdout = answer; stderr = `[tool-call] <name>`, `[tool-result] ok|error`,
  `[file-edit] <path>` + patch, `[approval] …`, `[failover] …`, `[usage] …`.
  `UiEvent`s: `session`, `text`, `reasoning`, `tool_call`, `tool_result`, `diff`, `approval`,
  `usage`, `error`, `done`.
- **Expected behaviour:**
  - **`--role <name>` promotes the run to the OODA framework** and returns early
    (`commands.ts:1005-1012`) — see §22.
  - **A `cli-subprocess` provider is redirected to `cmdCode`** (`commands.ts:1032-1034`), because it
    runs its own loop and would otherwise have its already-executed tool calls re-executed locally.
  - Default permission mode is **`read-only`** (`resolvePermissionMode`, `commands.ts:821-826`).
    `--yolo` → `full-access`, `--approve` → `workspace-write`.
  - `buildToolGate(..., {approveAskTier: true})` (`commands.ts:1064`) attaches an
    **auto-approver for the `ask` tier** even in read-only, so network/MCP tools can run while
    write/exec stay hard-denied (`commands.ts:835-854`). There is **no human approval** on this path.
  - Intermediate `run-start`/`run-end` chunks are collapsed so the merged stream still has exactly
    one `run-start` first and one terminal last (`orchestrator.ts:1689-1691`).
  - A throwing `toolInterceptor` is caught and never breaks or blocks the run
    (`orchestrator.ts:1498-1500`).
  - Enterprise (when `mode:"on"`): a `run.start` audit record, a pre-dispatch budget gate that can
    `deny` (exit `1`), `downgrade` (re-point `run.adapterId`/`run.model`, or deny when no target),
    or `warn` (`commands.ts:1136-1174`); post-run spend accrual (`commands.ts:1207-1217`).
  - Hooks: `session-start` then `pre-run`; a `pre-run` veto aborts before any dispatch, exit `1`
    (`commands.ts:1178-1191`). `post-run`, `on-error` on failure, and `session-end` in `finally`
    (`commands.ts:1219-1248`).
  - Cleanup in `finally`: hooks closed, SIGINT listener removed, observability flushed, session and
    engine disposed, MCP closed, transfer + store closed (`commands.ts:1245-1257`).
- **macOS app:** `RunMode.agent` with `role == nil` (`AppState.swift:88`), which routes through
  `chat --persistent` (`AppState.swift:248-250`) — so the app's "Agent" mode is **not**
  `nexus agent`; it is `chat -t --ask`. See **CONTRADICTIONS C5**.
- **Status:** `UNVERIFIED`

## 22. `nexus agent --role <name>` — the OODA framework

- **What:** A specialized role running Observe→Reason→Plan→Act→Evaluate→Repeat, with plan drafting,
  reflection, retry/self-correction, dynamic replanning, and sub-agent delegation.
- **Surface:** `runAgentOoda` `packages/cli/src/commands.ts:1274-1511`; loop
  `packages/agent/src/runner.ts`; policies `packages/agent/src/policies.ts`; role registry
  `packages/agent/src/roles.ts`.
- **Inputs:** `--role`, `--max-steps` (default = the role's budget, `commands.ts:1370-1373`),
  `--max-turns` (per OODA step, default 8, `commands.ts:1374-1375`), `--cwd`, permission flags,
  `--resume <id>` / `--continue`, `-p`, `-m`, `-o`.
- **Outputs:**
  - stderr: `[resume] <id> — restored N message(s) (text only; tool calls are not replayed)` or a
    "no stored transcript" line; **always** `[session] <id>` (`commands.ts:1429-1441`); a readable
    per-phase step log, one line per OODA narration (`commands.ts:1479-1483`);
    `[agent] role=… steps=… stop=… progress=…% goalMet=…` and `[usage] …`
    (`commands.ts:1533-1542`).
  - `-o json` → `{role, goal, stopReason, goalMet, steps, finalText, progress, plan[], usage}`
    (`agentResultJson`, `commands.ts:1514-1530`).
  - `-o ndjson` → the `agent` `UiEvent` (phase/role/step/text/data) paired with `reasoning`.
  - Exit `0` unless `stopReason === "error"` or `finalText` is empty (`commands.ts:1498`).
- **Expected behaviour:**
  - **A `cli-subprocess` provider is refused, not redirected** (`commands.ts:1322-1330`, exit `2`)
    with a three-reason explanation: the CLI's tool names don't resolve, the role's sandbox is
    unenforceable, and `--cwd` doesn't reach it. Both working routes are named.
  - An unknown role ⇒ stderr listing `AGENT_ROLES`, exit `2` (`commands.ts:1291-1294`).
  - Permission mode: an explicit CLI flag wins; otherwise **the role's own `permissionMode`**
    (`commands.ts:1353-1361`).
  - **`--resume` / `--continue` are honoured** through the same `resolveResumeTarget` +
    `engine.openSession({resume})` path `chat` uses (`commands.ts:1427-1428`).
    What resumes is the **conversation**. What deliberately does **not** resume is plan/task state —
    `store` is a fresh `:memory:` TaskStore every invocation (`commands.ts:1380`,
    documented `commands.ts:1412-1426`).
  - `turn.input` is passed as `AgentRunOptions.input` (`commands.ts:1459`) — without it the loop
    falls back to a bare `userText(goal.objective)` and drops resumed history.
  - Background-job control tools are added to this path only (`jobTools`, `commands.ts:1339-1340`),
    so a coder/tester role can launch and poll long-running commands.
  - Honest success signalling (`packages/agent/src/policies.ts:15-33`): a goal is `met` only on
    evidence — either every declared success criterion appears in the accumulated evidence, or a
    dedicated tool-free verify turn returns a strict verdict. Otherwise the run reports
    `indeterminate`. **Producing text is not evidence.**
  - Delegation: a reflection may carry a `delegate` directive; the sub-agent runs with
    `parentGate.deriveChild(def.permissionMode)`, which **intersects** the ladder so a child can
    only narrow, never widen (`packages/agent/src/runner.ts:479-504`,
    `packages/tools/src/permission.ts:129-150`).
  - `processManager.killAll()` in `finally` (`commands.ts:1507`) — background jobs never outlive the run.
  - The step log is suppressed under `-o ndjson` so structured `agent` events reach the wire
    instead of prose on stderr (`commands.ts:1471-1483`).
- **The nine shipped roles** (`packages/agent/src/roles.ts:54-165`):
  | Role | Sandbox | Steps | Tools |
  | --- | --- | --- | --- |
  | `coordinator` | `workspace-write` | 12 | `*` |
  | `planner` | `read-only` | 4 | `fs_read`, `fs_search` |
  | `coder` | `workspace-write` | 10 | `fs_read`, `fs_search`, `fs_write`, `fs_patch`, `shell_exec` |
  | `reviewer` | `read-only` | 6 | `fs_read`, `fs_search` |
  | `tester` | `workspace-write` | 8 | `fs_read`, `fs_search`, `fs_write`, `shell_exec` |
  | `researcher` | `read-only` | 6 | `fs_read`, `fs_search` |
  | `architect` | `read-only` | 5 | `fs_read`, `fs_search` |
  | `doc-writer` | `workspace-write` | 6 | `fs_read`, `fs_search`, `fs_write` |
  | `security-reviewer` | `read-only` | 6 | `fs_read`, `fs_search` |
  No preset pins a model or provider — roles are provider-neutral by construction.
- **macOS app:** `ConversationController.role` exists (`AppState.swift:164`) and correctly moves the
  run onto the one-shot path (`AppState.swift:248-250`, `:280-282`). **No UI ever sets it** — only
  tests do. And `oneShotArguments` explicitly refuses to pass `--resume` for a role run
  (`AppState.swift:292-298`) on the now-false premise that the CLI ignores it.
  See **GAPS G1, G2** and **CONTRADICTIONS C1**.
- **Status:** `UNVERIFIED`

## 23. `nexus plan <objective>`

- **What:** Turn an objective into a verifiable, dependency-ordered task plan.
- **Surface:** `cmdPlan` `packages/cli/src/commands.ts:1571-1589`; tree renderer
  `renderPlanTree` `commands.ts:1547-1569`.
- **Inputs:** objective positional/stdin; `--role` (default `planner`, `commands.ts:1579`);
  everything `agent --role` accepts.
- **Outputs:** `text` → `plan for: <objective>` then an indented tree with status marks
  `[ ]` todo, `[~]` in_progress, `[x]` blocked, `[✓]` done, `[-]` cancelled
  (`commands.ts:1555-1561`), then the agent trailer. `(no tasks drafted)` when the plan is empty.
- **Expected behaviour:**
  - It is `runAgentOoda` with a role default, so every §22 behaviour applies — including
    `--resume`, the subprocess refusal, and the `:memory:` task store.
  - **The plan is not persisted.** `renderPlanTree` reads `res.result.plan` from the in-memory
    store; nothing writes it to the durable `nexus task` store. See **GAPS G3**.
  - `-o json` prints the agent result JSON (from `runAgentOoda`), not a separate plan document;
    `-o text` is the only mode that renders the tree (`commands.ts:1582`).
- **macOS app:** `NOT SURFACED` — the Tasks tab reads `nexus task list`, which `plan` never writes to.
- **Status:** `UNVERIFIED`

## 24. `nexus roles`

- **What:** The machine-readable catalog of roles `--role` accepts.
- **Surface:** `cmdRoles` `packages/cli/src/commands.ts:1632-1664`; listing type `RoleListing`
  `commands.ts:1594-1607`.
- **Inputs:** `-o json|ndjson|text`.
- **Outputs:**
  - `json`/`ndjson` → `{"roles":[{id, description?, tools[], maxSteps, permissionMode, model?, adapterId?}]}`
    (`commands.ts:1651-1654`). Note ndjson emits the **same single object**, not one line per role.
  - `text` → `id  permissionMode  NN steps  tool,tool` then an indented description line.
- **Expected behaviour:**
  - Every field is read from the same `createAgentRegistry()` that `--role` resolves against, so the
    catalog cannot list a role that is not runnable (`commands.ts:1634-1649`).
  - `permissionMode` mirrors `runAgentOoda`'s own fallback (`?? "read-only"`), so what is listed is
    what is applied (`commands.ts:1643`).
  - The assembled **system prompt is deliberately omitted**; the one-line human `description` is a
    distinct `AgentDefinition` field (the role preset's `summary`,
    `packages/agent/src/roles.ts:224`), never a slice of the prompt.
  - `["*"]` renders as `all tools`.
  - Always exits `0`; there is no failure path.
- **macOS app:** **`NOT SURFACED`.** The app never invokes `nexus roles` — no occurrence of
  `"roles"` exists anywhere in `apps/nexus-mac/Sources/`. See **GAPS G2**.
- **Status:** `UNVERIFIED`

## 25. `nexus code` — subprocess coding CLIs

- **What:** Drive a wrapped vendor coding CLI (`claude-code` / `codex`) through the same engine path
  as any other provider.
- **Surface:** `cmdCode` `packages/cli/src/commands.ts:2208-2252`; adapters
  `packages/providers/claude-code/src/index.ts`, `packages/providers/codex/src/index.ts`, shared
  base `packages/providers/subprocess/src/base.ts` (574 lines).
- **Inputs:** task positional/stdin; `-a/--agent <claude-code|codex>` (default `claude-code`,
  `commands.ts:2222`), `--provider` also accepted; `-m`, `-s`, `-o`.
- **Outputs:** stdout = the answer; stderr = reasoning deltas, `[file-edit] <path>` + patch,
  `[tool-call]`/`[tool-result]`, `[approval] <kind>: <detail>`.
  `UiEvent`s include `diff` and `approval` (the wrapped CLI's own `approval-request` chunk,
  projected at `projection.ts:241-242` — this flow **never** carries a `resolution`).
- **Expected behaviour:**
  - Not installed ⇒ `nexus code: <id> — <detail>` and exit `1` **without spawning**
    (`commands.ts:2229-2233`).
  - Not a registered agent id ⇒ exit `1` with the valid ids (`commands.ts:2223-2226`).
  - Model resolution never invents `--model <providerId>` (§12).
  - Uses `buildAuthedRuntime` so an OAuth-only provider is visible (`commands.ts:2220`).
  - **How subprocess providers differ from HTTP providers:**
    - `transport: "cli-subprocess"`; the CLI runs its **own** agentic loop.
    - Tool calls arrive **already executed** — the harness must not re-execute them.
    - The sandbox is the vendor CLI's, governed by `providers.<id>.sandbox` config, **not** the
      harness `PermissionGate`.
    - `--cwd` does not reach it; it runs in the process cwd.
    - It advertises no static model catalog — the vendor session owns model choice.
    - Consequently it is excluded from `dispatchAgent` in three places: `cmdAgent`
      (`commands.ts:1032-1034`, redirect), `runAgentOoda` (`commands.ts:1322-1330`, refuse), and the
      TUI dispatcher (`commands.ts:3802-3815`, single dispatch).
  - Reasoning is treated as diagnostic and kept off stdout (`commands.ts:462-465`).
  - **No context assembly:** `cmdCode` calls `runOrchestration` without
    `contextAlreadyAssembled`, so the assembler *does* run inside `runOrchestration`
    (`commands.ts:346-352`) — but `cmdCode` passes no system prompt unless `-s` is given
    (`commands.ts:2236-2238`), so the harness default system prompt is absent here.
- **macOS app:** `NOT SURFACED` as a mode. `claude-code`/`codex` can be chosen as a **provider**
  (`-p`), which for `.ask`/`.agent` routes into `chat --persistent` — a path that dispatches once
  per turn without the native loop (`commands.ts:3802-3815` is the TUI equivalent; `cmdChat`'s
  `-t` path has **no** subprocess guard). See **GAPS G8**.
- **Status:** `UNVERIFIED`

## 26. `nexus chat` — batch mode

- **What:** A headless line REPL: pipe lines in, each line is one turn, later turns remember earlier ones.
- **Surface:** `cmdChat` `packages/cli/src/commands.ts:3298-3608`; batch branch
  `commands.ts:3509-3512`.
- **Inputs:** piped stdin (read to EOF up front, `commands.ts:3330-3336`); `-p`, `-m`, `-s`, `-o`,
  `-t/--tools`, `--max-turns`, `--resume <id>`, `--continue`/`-c`, permission flags.
- **Outputs:** stdout = assistant text plus a blank line per turn; stderr = `[session] <id>`
  (always), resume notices, and every non-text event rendered through `renderStreaming`.
  `-o ndjson` → every `UiEvent` plus a `turn_end` line per turn.
- **Expected behaviour:**
  - A TTY stdin with no piped lines ⇒
    `nexus chat: interactive REPL requires a TTY; pipe lines for headless use` and exit **`0`**
    (`commands.ts:3333-3336`). It is not an interactive line editor.
  - One session across every line; `turn.input` carries prior turns (`commands.ts:3452-3454`).
  - Non-text events are **not** filtered out of `text` mode — quota/auth/empty-output failures used
    to look like blank replies and now render (`commands.ts:3476-3481`).
  - A thrown error inside a turn is caught, rendered as an `internal_error` `UiEvent`, and the loop
    continues — it must not take a persistent process down (`commands.ts:3487-3495`).
  - `turn_end` (ndjson) / a trailing newline (text) is emitted **unconditionally**, including on the
    defensive catch, so a caller waiting on one turn never hangs (`commands.ts:3499-3503`).
  - Exit `1` if any turn failed, else `0` (`commands.ts:3600`).
  - `-t` in batch mode with the default/`--ask` permission attaches **no approver at all**
    (`commands.ts:3427-3433`): stdin is already fully consumed, so an `ask` outcome fails closed
    immediately rather than waiting out the 120 s timeout for a reply that can never arrive.
  - **`cmdChat`'s `-t` path has no `cli-subprocess` guard** (`commands.ts:3468-3471`), unlike
    `cmdAgent` and the TUI. See **GAPS G8**.
- **macOS app:** This is the app's primary run path (`AppState.swift:260-270`).
- **Status:** `UNVERIFIED`

## 27. `nexus chat --persistent` — the long-lived stdio session

- **What:** Hold one process open across many turns, reading stdin incrementally — what lets a native
  client drive one backend instead of spawning per message.
- **Surface:** `cmdChat` persistent branches `packages/cli/src/commands.ts:3513-3599`; usage contract
  `packages/cli/src/index.ts:405-450`.
- **Inputs:** live stdin lines; the same flags as §26; `-o ndjson` strongly implied for clients.
- **Outputs:** as §26, streamed live; `[session] <id>` on stderr before any event.
- **Expected behaviour:**
  - Requires non-TTY stdin; a TTY ⇒ the same message and exit `0` (`commands.ts:3337-3340`).
  - Ends on stdin **EOF** or SIGINT/SIGTERM. A signal cancels the in-flight turn's scope and closes
    the readline interface, then the `finally` disposes exactly as a clean EOF would
    (`commands.ts:3519-3524`, `:3548-3553`).
  - **Two distinct loops:**
    - *No approval broker* (tools off, or `--yolo`/`--approve`): a plain `for await (const raw of rl)`
      loop. Readline queues line events internally, so turns are processed strictly one at a time,
      never interleaved (`commands.ts:3516-3538`).
    - *Approval broker live*: line-reading is **decoupled** from turn-processing
      (`commands.ts:3539-3598`), because a decision line must be resolvable while a turn is blocked
      mid-tool-call. Prompts queue in `promptQueue` and dispatch in arrival order; decision lines are
      handled immediately, out of band.
  - On stdin EOF the broker denies every still-pending approval with cause `stdin-closed` rather than
    letting them time out (`commands.ts:3575-3579`).
  - The session id printed on stderr and the `session.sessionId` ndjson field are the values to pass
    back into `--resume`; `session.id` is a run id and must not be used.
- **macOS app:** `PersistentSession` (`apps/nexus-mac/Sources/NexusKit/PersistentSession.swift:16-204`).
  Notable behaviours: prompts submitted before readiness are **queued**, not dropped
  (`PersistentSession.swift:39`, `:114-121`); readiness is signalled by the first `session` event
  **or** a stderr line containing `[session]` (`PersistentSession.swift:154-156`, `:167-173`);
  embedded newlines in a prompt are collapsed to spaces because a newline is the turn delimiter
  (`PersistentSession.swift:70-75`); `stop()` closes stdin for a graceful EOF shutdown rather than
  terminating outright (`PersistentSession.swift:84-98`); a broken pipe is reported as a
  termination rather than leaving the UI waiting (`PersistentSession.swift:105-111`).
- **Status:** `UNVERIFIED`

## 28. Real tool approvals (the approval broker)

- **What:** A tool call that needs approval genuinely blocks until a human (or scripted client)
  answers — the honesty guarantee behind "ask" mode.
- **Surface:**
  - `ApprovalBroker` `packages/cli/src/commands.ts:3179-3257`.
  - Control-line parser `parseApprovalDecision` `packages/cli/src/commands.ts:3266-3281`.
  - Chat permission resolution `resolveChatPermissionMode` `packages/cli/src/commands.ts:3291-3296`.
  - Timeout `APPROVAL_TIMEOUT_MS` `packages/cli/src/commands.ts:3056-3059`.
  - Diff preview `buildApprovalDiff` `commands.ts:3137-3156`, `unifiedLineDiff` `commands.ts:3082-3127`.
  - Detail payload shape `ApprovalDetailPayload` `commands.ts:3062-3070`.
- **Inputs:**
  - Enabled by `chat --persistent -t` with the default (read-only) or explicit `--ask` mode
    (`commands.ts:3416-3426`).
  - Decisions arrive as their own stdin line:
    `{"type":"approval","id":"<id>","decision":"allow"|"deny"}`.
  - `NEXUS_APPROVAL_TIMEOUT_MS` env override (test seam only; **never** read from user config or a
    flag, `commands.ts:3053-3058`).
- **Outputs:** two `approval` `UiEvent`s per approval — the request, then the settlement carrying
  `resolution: {granted, cause}`. `detail` is a JSON **string** of
  `{toolName, permission, mode, reason, input, diff?}`.
- **Expected behaviour:**
  - **Timeout: 120 s default, then deny with cause `timeout`** (`commands.ts:3239`). A timed-out
    approval is explicitly *not* a refusal — `cause` exists so a client can offer to ask again
    instead of reporting a "no" the human never gave (`commands.ts:3167-3176`).
  - Cancelling the turn (SIGINT/SIGTERM) denies pending approvals immediately with cause `cancelled`
    (`commands.ts:3237-3238`); an already-cancelled scope settles instantly (`commands.ts:3226-3229`).
  - stdin EOF ⇒ `denyAll()` with cause `stdin-closed` (`commands.ts:3253-3256`).
  - A settled approval is removed from `pending` first, so a late second decision is a no-op
    (`commands.ts:3232`).
  - **Any stdin line that is not exactly the control shape is dispatched as an ordinary chat
    prompt** (`commands.ts:3259-3281`) — the control channel shares stdin with prompts and must never
    swallow one. Non-JSON, wrong `type`, empty `id`, or a `decision` other than `allow`/`deny` all
    fall through.
  - `action` is derived from the tool's permission: `write`→`file`, `exec`→`shell`, else `tool`
    (`commands.ts:3207`) — mirroring the wrapped-CLI `approval-request` `kind` so a client can render
    both flows through one switch.
  - Diff preview: `fs_patch`'s input **is** a unified diff and is passed through; `fs_write` is
    diffed against the current on-disk content (empty for a new file). Everything else gets no
    preview (`commands.ts:3137-3156`). Beyond **2000 lines** per side the LCS table is skipped in
    favour of an honest "file too large to diff" shape (`commands.ts:3073`, `:3087-3093`).
  - `--yolo`/`--approve` keep their existing auto-approve meanings unchanged
    (`commands.ts:3412-3415`); the broker is only attached on the default/`--ask` + `--persistent`
    combination.
- **macOS app:** `ApprovalsController` (`Approvals.swift:145-217`), `PendingApproval`
  (`Approvals.swift:15-84`), `ApprovalDecision.controlLine` (`Approvals.swift:110-134`), sent on the
  same stdin as prompts (`AppState.swift:402-405`). The `.timeout` / `.cancelled` / `.stdinClosed`
  distinction is decoded and documented (`Approvals.swift:86-106`, `UiEvent.swift:119-131`).
  UI: `apps/nexus-mac/Sources/NexusApp/Features/ApprovalSheet.swift`. Enabled by default
  (`AppState.swift:175`).
- **Status:** `UNVERIFIED`

---

# Part IV — Permissions, tools, MCP, extensibility

## 29. The `PermissionGate` and its modes

- **What:** The approval/sandbox policy in front of every tool call.
- **Surface:** `packages/tools/src/permission.ts` — `MODE_POLICY:29-35`, `MODE_RANK:44-50`,
  `PermissionGate:104-233`, `check():152-232`, `deriveChild():129-150`.
- **Inputs:** `PermissionGateOptions {mode, approve?, allowlist?, denylist?}` (`permission.ts:73-81`);
  config `tools.allow` / `tools.deny` (`schema.ts:753-755`).
- **Outputs:** `PermissionDecision {allowed, toolName, permission, mode, reason, viaApproval,
  loggedInput}` (`permission.ts:83-95`).
- **The escalation ladder** (`permission.ts:29-35`):
  | Mode | read | write | exec | network |
  | --- | --- | --- | --- | --- |
  | `plan` | allow | deny | deny | deny |
  | `read-only` | allow | deny | deny | **ask** |
  | `ask` | allow | ask | ask | ask |
  | `workspace-write` | allow | allow | ask | ask |
  | `full-access` | allow | allow | allow | allow |
- **Expected behaviour:**
  - Evaluation order is fixed: **denylist → allowlist → mode policy → approve callback**
    (`permission.ts:18-22`). The denylist wins over everything, including the allowlist.
  - Patterns are `*`-globs compiled to anchored regexes (`permission.ts:98-101`).
  - **An `ask` outcome with no approver configured is a DENY**, with the reason saying so
    (`permission.ts:212-219`) — it fails closed, never silently proceeds.
  - `check` never throws for a plain denial; it returns `allowed:false` with a reason the caller
    surfaces to the model/user.
  - A tool may refine its permission class **per call** via `permissionFor(input)` — e.g. a DB tool
    that is `read` for a local sqlite file and `network` for a remote server. Any throw falls back to
    the declared `permission` so the gate is never skipped (`permission.ts:161-170`).
  - Arguments shown to the approver and recorded in the decision are **redacted**
    (`redactArgs`, `permission.ts:153`), so a secret passed to a tool never lands in an approval
    prompt or audit log.
  - `deriveChild(childMode)` takes the **minimum** of parent and requested mode on `MODE_RANK`, and
    carries the parent's denylist and approver forward — delegation can only narrow
    (`permission.ts:129-150`). `ask` ranks above `read-only` and below `workspace-write`.
  - `ApproveOutcome.note` is appended to the reason as `: denied (timeout)` / `: approved (…)`;
    a plain `boolean` approver still works with no note (`permission.ts:220-231`).
- **Who attaches which gate:**
  | Caller | Mode source | Approver |
  | --- | --- | --- |
  | `agent` (`commands.ts:1063-1064`) | flags, default `read-only` | auto-approve, **incl. ask tier** |
  | `agent --role` (`commands.ts:1353-1361`) | flag, else role's own | auto-approve, incl. ask tier |
  | `tools run` (`commands.ts:2052-2056`) | flags, default `read-only` | auto only for write-capable modes — **no ask tier** |
  | `chat -t --persistent` (`commands.ts:3408-3433`) | `resolveChatPermissionMode` | **real broker** (§28) |
  | `chat -t` batch | same | **none** (fails closed) |
  | TUI CHAT/AGENT (`commands.ts:3817-3820`) | `read-only` | auto-approve |
  | TUI AUTOPILOT | `workspace-write` | auto-approve |
- **macOS app:** Mode is chosen implicitly by `approvalsEnabled` → `-t --ask`
  (`AppState.swift:268`); with it off the backend is tool-less entirely, which the code calls the
  safe default (`AppState.swift:169-175`). `PendingApproval` carries `permission` and `mode`
  verbatim for display (`Approvals.swift:22-27`). There is **no** `--yolo`/`--approve` control.
- **Status:** `UNVERIFIED`

## 30. Built-in tools

- **What:** The starter tool suite every agentic path registers.
- **Surface:** `builtinTools()` / `registerBuiltins()` `packages/tools/src/builtins.ts:14-23`.
- **The five built-ins:** `fs_read`, `fs_write` (`packages/tools/src/fs.ts`), `fs_patch`
  (`packages/tools/src/patch.ts`), `fs_search` (`fs.ts`), `shell_exec`
  (`packages/tools/src/shell.ts`).
- **Supporting machinery:** `ToolRegistry` (`registry.ts`), `resolveInWorkspace` (`paths.ts`) for
  workspace-escape prevention, `redactArgs` (`redact.ts`), SSRF guard (`ssrf.ts`), input validation
  (`validate.ts`), streaming results (`stream.ts`), terminal/PTY (`terminal/`).
- **Expected behaviour:**
  - `runTool(tool, input, ctx)` with `ctx = {signal, cwd, …}`; a tool declaring `timeoutMs` is raced
    against it and the run is aborted on expiry (`withToolTimeout`, `commands.ts:2179-2196`).
  - `fs_write`/`fs_patch` are `write` class; `shell_exec` is `exec`; `fs_read`/`fs_search` are `read`.
  - Paths are resolved inside the workspace root (`resolveInWorkspace`, used at
    `commands.ts:3148`).
- **macOS app:** Tool activity is rendered from `tool_call`/`tool_result`/`diff` `UiEvent`s in
  `ConversationView`; the app never enumerates built-ins separately.
- **Status:** `UNVERIFIED`

## 31. Opt-in tool groups

- **What:** Six extra tool families, off by default, registered only when named in config.
- **Surface:** `packages/cli/src/tool-groups.ts` — catalog `GROUP_INTEGRATIONS:66-89`,
  descriptions `GROUP_DESCRIPTIONS:92-99`, order `TOOL_GROUP_NAMES:102-109`,
  roster `STATIC_TOOL_NAMES:206-213`, `buildToolGroup:135`, `registerToolGroups`,
  `reportToolGroups:235-247`, `probeIntegrations:224`, `groupOfTool:196-200`.
- **Config:** `tools.enabledGroups` (default `[]`, `schema.ts:751`), `tools.web`
  (`schema.ts:694-708`), `tools.db.connections` (`schema.ts:740-746`).
- **The six groups:**
  | Group | Tools | Optional integrations |
  | --- | --- | --- |
  | `web` | `web_search`, `web_fetch`, `web_crawl` | none (native fetch, SSRF-guarded) |
  | `browser` | `browser_navigate`, `browser_click`, `browser_extract`, `browser_screenshot` | `playwright` |
  | `db` | `db_query`, `db_schema` | `better-sqlite3`, `pg`, `mysql2`, `snowflake-sdk`, `@google-cloud/bigquery` |
  | `cloud` | `cloud_list`, `cloud_describe` | `@aws-sdk/client-s3`, `@azure/identity`, `@google-cloud/storage` |
  | `containers` | `docker_ps`, `docker_images`, `docker_logs`, `k8s_get`, `k8s_logs` | `docker`, `kubectl`, `oc` (binaries) |
  | `ai` | `ai_vision`, `ai_ocr`, `ai_image_generate`, `ai_speech` | `openai`, `tesseract.js` |
- **Expected behaviour:**
  - Client libraries are **optional lazy** dependencies, feature-detected purely for reporting via
    `require.resolve` (never executed) or a PATH probe (`tool-groups.ts:29-44`).
  - A group is registerable even when its integration is absent; the tool returns a clean
    "not installed" `ToolResult` at call time (`tool-groups.ts:10-16`).
  - Every group tool keeps its coarse permission class, so the gate treats it exactly like a built-in.
  - `tools.web.searchProvider: "mock"` forces the deterministic offline search provider so nothing
    hits the network (`tool-groups.ts:111-124`).
  - `STATIC_TOOL_NAMES` is a hand-kept roster used for reverse lookup and listing without building
    every group — it must stay in sync with the factories (`tool-groups.ts:202-213`).
- **macOS app:** `IntegrationsController` reads `nexus tools list -o json`
  (`Integrations.swift:269`); rendered in
  `apps/nexus-mac/Sources/NexusApp/Features/IntegrationsView.swift`. **Read-only** — the app cannot
  enable a group (that needs `nexus config set tools.enabledGroups`). See **GAPS G7**.
- **Status:** `UNVERIFIED`

## 32. `nexus tools list | run`

- **What:** Discover every registered tool with its permission class and integration availability, or
  invoke one directly under the gate.
- **Surface:** `cmdTools` `packages/cli/src/commands.ts:1932-2161`; row builder
  `toolListRows:1909-1930`; named-DB-connection sugar `resolveNamedDbConnection:2169-2176`.
- **Inputs:**
  - `list` (default).
  - `run <tool> --args '<json>'` (or piped stdin as the JSON); `--approve` / `--yolo` / `--read-only`;
    `--cwd`; `-p`/`-m` (for the `ai` group only); `--principal`.
- **Outputs:**
  - `list -o json` → `{groups:[{group, description, enabled, tools[], integrations[]}], tools:[{name,
    permission, group, enabled, integrationAvailable}], plugins:[{plugin, name, permission,
    description}]}` (`commands.ts:1951-1965`).
  - `list -o text` → grouped `[on ]`/`[off]` blocks with integration detection, then a stderr
    `[tools] N tool(s) across M group(s), K enabled` summary.
  - `run -o json` → `{tool, group, permission, ok, content}`; denial →
    `{tool, ok:false, denied:true, reason}` (`commands.ts:2062-2070`).
  - `run -o text` → the tool's text content on stdout, `[tool] <name> (<perm>) — ok|error` on stderr.
  - Exit `1` on denial, tool error, or thrown failure; `2` on missing tool name or bad JSON.
- **Expected behaviour:**
  - A tool in a **disabled** group is refused before the registry is even built, with the exact
    `nexus config set tools.enabledGroups '["<group>"]'` remedy (`commands.ts:2009-2016`).
  - `--args` is a repeatable flag in the shared grammar; for `tools run` the **last** occurrence wins
    (`commands.ts:2033-2037`).
  - `db_*` tools accept `{"connection":"<name>"}` resolved from
    `config.tools.db.connections`; an unknown name is left as-is so the tool surfaces a clear
    validation error rather than a silent substitution (`commands.ts:2169-2176`).
  - The gate is **strict** here: no `approveAskTier`, so `read-only` denies the network tier before
    any socket opens (`commands.ts:2052-2056`) — deliberately unlike the agent loop.
  - Enterprise RBAC runs **after** the gate and **before** the tool: the acting principal must hold
    the tool's action verb; a deny exits `1` (`commands.ts:2075-2090`).
  - Provider adapters for the `ai` group are bound **only after** permission and RBAC pass, so a
    denied manual call never initialises provider clients (`commands.ts:2092-2124`).
  - SIGINT aborts the tool via its `AbortController` (`commands.ts:2126-2128`).
  - Plugin-contributed tools appear alongside built-in groups in both output modes
    (`commands.ts:1940-1950`, `:1985-1990`).
- **macOS app:** `tools list` only (`Integrations.swift:269`). `tools run` is `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 33. LSP code intelligence

- **What:** Language-server-backed navigation, both as agent tools and as a CLI command.
- **Surface:**
  - Client: `packages/lsp/src/client.ts` (568 lines); registry `LanguageServerRegistry`.
  - Tools: `lspTools()` `packages/cli/src/lsp-tools.ts` (401 lines).
  - Registration into the agent loop: `registerLspTools` `packages/cli/src/commands.ts:914-920`.
  - Registry construction from config: `buildLspRegistry` `packages/cli/src/commands.ts:891-906`.
  - CLI command: `cmdLsp` `packages/cli/src/commands.ts:5795-5866`.
- **Config:** `lsp.enabled` (default `true`), `lsp.servers[]` (`{language, languageId, command,
  args, extensions, rootMarkers, label?}`), `lsp.timeoutMs` (5000) — `schema.ts:649-679`.
- **Inputs:** `nexus lsp <definition|references|diagnostics|hover|rename> <file> [--line L]
  [--character C] [--name <newName>]`; positions are **0-based**.
- **Outputs:** `json` → `{op, file, ok, output}`; `text` → the tool's text on stdout when `ok`,
  on **stderr** when not (graceful degradation).
- **Expected behaviour:**
  - `lsp.enabled = false` ⇒ `nexus lsp: disabled (set lsp.enabled=true)`, exit `1`
    (`commands.ts:5800-5803`).
  - Unknown subcommand ⇒ exit `2`; missing file ⇒ exit `2`; `rename` without `--name` ⇒ exit `2`.
  - **A missing language server is not a failure**: the message goes to stderr and the command exits
    `0`, so scripts can probe availability (`commands.ts:5857-5865`).
  - Tools are registered lazily and spawn a server per call; `registerLspTools` is safe to call
    unconditionally on the agent loop and is a no-op when disabled (`commands.ts:908-920`).
  - Existing registry entries are never overwritten (`if (!toolRegistry.has(t.name))`,
    `commands.ts:918`).
  - `doctor` reports detected servers by feature-detection only — no server is spawned
    (`commands.ts:5389-5398`).
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 34. MCP — `nexus mcp add | list | rm | tools | call`

- **What:** Declare Model Context Protocol servers, discover their tools, and call one directly.
- **Surface:** `cmdMcp` `packages/cli/src/commands.ts:4167-4402`; session/attachment
  `packages/cli/src/mcp.ts` (`startMcpSession`, `attachMcpTools`); client
  `packages/mcp/src/client.ts` (494 lines); bridge `packages/mcp/src/bridge.ts`; server
  `packages/mcp/src/server.ts`; config `packages/mcp/src/config.ts`.
- **Config schema:** `mcp[]` `packages/config/src/schema.ts:87-131` — `name`, `transport`
  (`stdio|sse|http`, `schema.ts:72`), `enabled` (default `true`), `trustAnnotations` (default
  `false`), `command`, `args[]`, `env{}`, `url`, `timeoutMs`, `auth` (`bearerRef`, `headerRefs{}`,
  `headers{}`, `schema.ts:75-85`).
- **Inputs:**
  - `add <name> [--transport stdio --command <cmd> [--args a]… [--env K=V]…]`
    or `[--transport http|sse --url <url> [--bearer-ref <ref>]]`, `--disabled`.
  - `list`, `rm <name>`, `tools`, `call <server> <tool> [--json '<obj>'] [--arg K=V]…`.
- **Outputs:**
  - `list -o json` → the raw `config.mcp` array; text → `on |off <name> (<transport>) — <target>`.
  - `tools -o json` → `{servers:[reports], tools:[{server, name, description}]}`;
    text → `[ok]`/`[--]` per server then `  <server>__<tool> — <desc>`.
  - `call` → text content on stdout, or `structuredContent` JSON, or `(no content)`;
    exit `1` when `result.isError`.
- **Expected behaviour:**
  - **Named templates:** `knownMcpServers()` (`commands.ts:4152-4165`) currently ships one entry,
    `kyp-mem` (stdio, `kyp-mem serve`, `KYP_VAULT` defaulting to
    `$HOME/Documents/docs_and_memory/memory` and honouring an already-exported value). A template
    makes `nexus mcp add kyp-mem` work with zero flags; any explicit flag overrides it.
  - The candidate is validated against the **real** `McpServerConfig` zod schema before writing, so a
    bad declaration fails loudly here rather than bricking every later command that re-parses config
    (`commands.ts:4206-4213`). Failure ⇒ exit `2` with per-issue detail.
  - A duplicate server name ⇒ exit `2` with "rm it first" (`commands.ts:4217-4220`).
  - Discovered tools are namespaced `<server>__<tool>` when registered into a tool registry
    (`commands.ts:4306`).
  - `tools` and `call` deliberately use the **plain unauthed** `buildRuntime` — they only need a
    SecretStore for `--bearer-ref` resolution and never resolve a provider id
    (`commands.ts:4272-4277`, `:4354-4356`).
  - `call` distinguishes: no such server (exit `1` with an `mcp add` hint), server unreachable
    (exit `1` with the error), no such tool (exit `1` **plus a list of that server's available
    tools**) — `commands.ts:4358-4373`.
  - `--arg K=V` values are JSON-parsed when possible, else kept as strings; they override `--json`
    keys (`commands.ts:4341-4351`).
  - Unreachable servers are reported, never fatal — `doctor` and `tools` both survive an offline
    server (`commands.ts:5419-5437`).
  - Sessions are always closed in `finally` (`commands.ts:4310-4313`, `:4394-4397`).
  - MCP tools carry the `network` permission class, which is why the agent loop opts into the
    `ask` tier and `tools run` does not (§29).
- **macOS app:** `mcp list` and `mcp tools` (`Integrations.swift:261`, `:265`), rendered in
  `IntegrationsView.swift`. `mcp add` / `rm` / `call` are `NOT SURFACED` — the app cannot add a
  server. See **GAPS G7**.
- **Status:** `UNVERIFIED`

## 35. Lifecycle hooks

- **What:** Ten lifecycle points a user-configured command can observe or veto.
- **Surface:**
  - Contract: `packages/hooks/src/types.ts` — `HookEvent:12-22`, `VETOABLE_EVENTS:30-35`,
    `HookPayloads:38-84`, `HookVerdict:96-101`, `HookExecutionError:139-146`, `HookOutcome:149-164`.
  - Bus: `packages/hooks/src/bus.ts`; command hooks `packages/hooks/src/command.ts`.
  - CLI wiring: `buildHooks` `packages/cli/src/extensions.ts:78-127`.
  - Config: `hooks.enabled` (default `true`), `hooks.hooks[]` with `event`, `command`, `args[]`,
    `matcher?`, `timeoutMs` (5000), `env{}`, `failOpen` (default `false`) —
    `schema.ts:771-829`.
- **The ten events:** `session-start`, `session-end`, `pre-run`, `post-run`, `pre-tool`, `post-tool`,
  `pre-agent-step`, `post-agent-step`, `on-error`, `on-approval`.
- **The four vetoable events:** `pre-run`, `pre-tool`, `pre-agent-step`, `on-approval`
  (`hooks/types.ts:30-35`). Everything else is observe-only — a returned verdict's
  `block`/`modify`/`approve` is ignored, though the handler still runs.
- **Expected behaviour:**
  - `block: true` vetoes; `modify` shallow-merges into the payload and is threaded to later hooks
    **and back to the caller**, so a `pre-tool` hook can rewrite the tool `input`
    (`hooks/types.ts:88-95`; applied `extensions.ts:112-114`).
  - **Fail-closed on adapter failure:** a `HookExecutionError` (the hook could not spawn/execute, as
    opposed to a bug in handler logic) is treated as a DENY on a vetoable event unless the hook opts
    into `failOpen: true` (`hooks/types.ts:132-146`, config `schema.ts:814`).
  - A throwing handler is isolated and collected into `HookOutcome.errors`; it never crashes the run
    (`hooks/types.ts:161-163`). `buildHooks.emit` wraps the bus defensively on top of that
    (`extensions.ts:88-98`).
  - Hooks run ordered by `order` (default 0), ties broken by registration order
    (`hooks/types.ts:120-125`).
  - The `pre-tool`/`post-tool` bridge is only installed when a hook or webhook actually subscribes to
    a tool event (`hasToolHooks`, `extensions.ts:61-65`) — otherwise `toolInterceptor` is
    `undefined` and the loop is untouched.
- **Which events the CLI actually fires:** `session-start`, `pre-run`, `post-run`, `on-error`,
  `session-end` (all in `cmdAgent`, `commands.ts:1178-1248`) and `pre-tool`/`post-tool` (via the
  interceptor). **`pre-agent-step`, `post-agent-step`, and `on-approval` are declared but never
  emitted by any CLI code path.** See **GAPS G11**.
- **macOS app:** Read-only — `IntegrationsView.swift:255` runs `nexus config get hooks -o json` to
  display the configured hooks. No editing.
- **Status:** `UNVERIFIED`

## 36. Outbound webhooks

- **What:** Signed, redacted, SSRF-guarded HTTP POSTs on lifecycle events.
- **Surface:** `packages/hooks/src/webhook.ts` — `WebhookDispatcher`, `signBody`,
  `SIGNATURE_HEADER`, `EVENT_HEADER`, `DELIVERY_HEADER`, `TIMESTAMP_HEADER`,
  `MAX_WEBHOOK_REDIRECTS` (`packages/hooks/src/index.ts:44-56`); CLI wiring
  `packages/cli/src/extensions.ts:82-84`, `:100-108`.
- **Config:** `webhooks[]` `schema.ts:839-859` — `url`, `events[]` (min 1), `secretRef?`,
  `enabled` (default `true`), `timeoutMs` (5000), `maxRetries` (2), `allowPrivate` (default `false`).
- **Expected behaviour:**
  - Bodies are HMAC-signed from a SecretStore-resolved secret; secrets are redacted from payloads.
  - Private/loopback targets are blocked unless `allowPrivate` is set.
  - **Delivery is fire-and-forget from the run's perspective**: a failed POST (network, non-2xx,
    SSRF-blocked) never affects run control flow (`extensions.ts:100-108`, isolated in a `try`).
  - The dispatcher is only constructed when at least one enabled webhook exists
    (`extensions.ts:82-84`).
  - `doctor` lists `<url> → <event>/<event>` per enabled webhook (`commands.ts:5450-5454`).
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 37. Plugins — `nexus plugin list | add | remove | info`

- **What:** Engine-extending packages that contribute into the **same** registries the builtins use.
- **Surface:** `cmdPlugin` `packages/cli/src/commands.ts:4412-4541`; host
  `packages/plugins/src/host.ts` (562 lines); manifest `manifest.ts`; version gate `semver.ts`;
  CLI glue `packages/cli/src/extensions.ts:132-236`.
- **Config:** `plugins.enabled` (default `true`), `plugins.dirs[]`, `plugins.scanNodeModules`
  (default `true`) — `schema.ts:871-895`.
- **Contribution kinds:** `providers`, `tools`, `commands`, `prompts`, `mcpServers`, `uiPanels`
  (`commands.ts:4427-4434`).
- **Inputs:** `list` (default), `info <name>`, `add <dir>`, `remove|rm <dir>`; `-o json`.
  Env: `NEXUS_PLUGINS_DIR` (path-delimited search override, `extensions.ts:170`),
  `NEXUS_DATA_DIR`, `NEXUS_TRUST_WORKSPACE`.
- **Outputs:** `list -o json` → `{plugins:[{name, version, source, description, contributions{…}}],
  failures:[{name, reason, error}]}`; text → `[ok] name@ver (source) — <summary>` /
  `[--] name — reason: error`, plus stderr `[plugins] N loaded, M failed`.
- **Expected behaviour:**
  - **Discovery is a security boundary.** Scanning the cwd's `node_modules` means `import()`-ing
    modules that ship inside a cloned repo — arbitrary code execution before any capability gate.
    So the cwd is scanned **only** under the explicit `NEXUS_TRUST_WORKSPACE` env opt-in
    (`1`/`true`/`yes`), because a repo cannot set an env var
    (`extensions.ts:130-147`, `:192-198`).
  - Search dirs otherwise: the data-dir `plugins/`, `config.plugins.dirs` (honoured only from the
    trusted user/global config layer), and `NEXUS_PLUGINS_DIR` (`extensions.ts:158-172`).
  - Loading is sandboxed and version-gated against `NEXUS_HOST_VERSION = "1.0.0"`
    (`extensions.ts:41-42`, `:203`), **not** the binary version.
  - **`loadPlugins` never throws** — a bad plugin becomes a `failure`, not an exception
    (`extensions.ts:174-207`). Disabled ⇒ an inert empty runtime.
  - `add`/`remove` edit **search directories**, not plugins; the immediate subdirectories of each dir
    are scanned. Paths are resolved to absolute (`commands.ts:4497`, `:4521`).
    Duplicate add ⇒ exit `1`; removing a non-configured dir ⇒ exit `1`.
  - A plugin tool is permission-gated exactly like a first-party one; a plugin provider is routed
    identically (`extensions.ts:210-215`).
  - `info` on a plugin that failed to load reports the failure reason and exits `1`, distinct from
    "no such plugin" (`commands.ts:4464-4471`).
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

---

# Part V — State: tasks, jobs, memory, context, retrieval, cache

## 38. `nexus task` — the durable task plan

- **What:** A persistent task list with parents, dependencies, status and progress.
- **Surface:** `cmdTask` `packages/cli/src/commands.ts:1679-1788`; store
  `packages/tasks/src/store.ts` (442 lines); path `tasksFile()`; opened via `openTaskStore`
  `commands.ts:1669-1671`.
- **Config:** `tasks.persist` (default `true`), `tasks.file` (`schema.ts:548-556`).
- **Subcommands:** `list` (default), `add <title> [--parent <id>] [--deps a,b]`, `start <id>`,
  `done <id>`, `block <id>`, `cancel <id>`, `rm <id>`, `show <id>`, `clear`.
- **Statuses:** `todo`, `in_progress`, `blocked`, `done`, `cancelled`.
- **Outputs:**
  - `list -o json` → the raw task array; text → `<id>  [<status>][ parent=…][ deps=[…]]  <title>`
    plus a stderr `[progress] D/T done (P%)` line (`commands.ts:1673-1677`, `:1694-1697`).
  - `add` → `added <id>  <title>`; mutations → `<id>  [<status>]  <title>`.
  - `rm` → `removed <id>` (exit `0`) or `no task "<id>"` (exit `1`).
  - `clear` → `cleared all tasks` / `{cleared: N}`.
- **Expected behaviour:**
  - Missing id on a mutation ⇒ usage line, exit `2`. Unknown id ⇒ exit `1`.
  - `add` accepts the title from positionals or piped stdin (`commands.ts:1701`); empty ⇒ exit `2`.
  - `add` failures (e.g. an invalid dependency) are caught and reported, exit `1`
    (`commands.ts:1714-1721`).
  - **There is no subcommand that reverts a task to `todo`** — `start`/`block`/`done`/`cancel` are
    the only transitions.
  - `clear` deletes every task individually rather than truncating (`commands.ts:1776-1777`).
  - Progress excludes cancelled tasks from the denominator.
  - Unknown subcommand ⇒ exit `2` listing the valid set.
  - **The OODA `plan` path does not write here** — it uses a `:memory:` store (§23).
- **macOS app:** Fully surfaced. `TasksController` (`Tasks.swift:84-165`), commands
  `NexusClient.swift:91-116`, UI `apps/nexus-mac/Sources/NexusApp/Features/TasksView.swift`.
  `taskSetStatus` returns `nil` for `.todo`/`.unknown` and the controller reports
  "no `nexus task` subcommand sets status …" rather than silently no-oping
  (`NexusClient.swift:106-116`, `Tasks.swift:138-142`) — a good honesty precedent.
  `TaskStatus.unknown` keeps an unrecognised status visible instead of hiding the row
  (`Tasks.swift:13-18`). Progress mirrors the CLI's denominator rule (`Tasks.swift:157-162`).
- **Status:** `UNVERIFIED`

## 39. `nexus jobs` — background processes, command history, PTY

- **What:** Terminal integration: run a command as a tracked job, inspect command history, report the
  interactive-PTY seam.
- **Surface:** `cmdJobs` `packages/cli/src/commands.ts:1792-1881`; `ProcessManager`
  `packages/tools/src/terminal/process-manager.ts` (409 lines); `CommandHistory`,
  `isNodePtyAvailable`, `jobTools` (all from `@nexuscode/tools`).
- **Config:** `terminal.*` (`schema.ts:563-586`) — `shell`, `pty` (`auto|child_process|node-pty`),
  `maxOutputBytes` (8 MiB), `historySize` (1000), `maxConcurrentJobs` (8),
  `maxJobRuntimeMs` (10 min).
- **Subcommands:** `list` (default), `run <command> [args…]`, `history`, `pty`.
- **Outputs:**
  - `run -o text` → the child's output streamed live to stdout, then a stderr
    `[job] <status> exit=<code>[ signal=…]` line.
  - `run -o json` → `{id, status, exitCode, signal, output}` with the combined output **buffered**
    into one field so stdout stays a single valid JSON document (`commands.ts:1816-1839`).
  - `history` → the last **20** entries as `<command> <args…>  exit=<code>`, or `[]` / `no command
    history`.
  - `pty` → `{available, implementation}` / `pty: node-pty available (interactive shell)` |
    `child_process fallback (no native pty)`.
  - `run` exits `0` only when the job `exited` with code `0`.
- **Expected behaviour:**
  - **`jobs list` always reports nothing.** Jobs are tracked per-process by the `ProcessManager`, and
    a fresh CLI invocation has none — the command returns `[]` / `no background jobs`
    unconditionally (`commands.ts:1796-1801`). It is a truthful statement about a
    per-invocation manager, not a query. See **GAPS G4**.
  - `run` takes everything after `run` (past an optional `--`) as argv; empty ⇒ exit `2`.
  - Each completed job is appended to `CommandHistory` with command, args, cwd and exit code
    (`commands.ts:1824-1829`).
  - The PTY seam is **feature-detected**, never assumed: `node-pty` when present, `child_process`
    otherwise (`commands.ts:1863-1876`).
  - Background-job *tools* (`jobTools`) are registered only on the OODA path
    (`commands.ts:1339-1340`), not the plain `agent` loop.
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 40. `nexus memory` — durable memory

- **What:** A three-tier memory store that feeds the context engine.
- **Surface:** `cmdMemory` `packages/cli/src/commands.ts:2265-2360`; store
  `packages/memory/src/store.ts` (333 lines); `openMemory`, `ingestInstructionFiles`.
- **Tiers:** `short` (session scratchpad, a singleton item under a fixed id), `long`, `knowledge`.
  `DURABLE_TIERS = ["long","knowledge"]` — only those persist (`memory/src/store.ts:42`).
- **Subcommands:** `list [--tier …]`, `add <text> [--tier] [--kind] [--tags a,b]`, `get <id>`,
  `rm <id>`, `ingest`.
- **Outputs:** `list` → `<id>  <tier>/<kind>  <first line, ≤80 chars>` (`commands.ts:2256-2259`);
  `add` → `added <id> (<tier>/<kind>)`; `get` → id line then full text; `rm` → exit `1` if absent;
  `ingest` → `ingested N instruction file(s)` then each path.
- **Expected behaviour:**
  - `--tier` accepts only `short|long|knowledge`; anything else is treated as absent
    (`asTier`, `commands.ts:2261-2263`). `add` defaults to `long`, `kind` defaults to `note`.
  - `add` reads from positionals or piped stdin; empty ⇒ usage, exit `2`.
  - `ingest` scans the cwd for instruction files (AGENTS.md / CLAUDE.md-class) and writes them into
    memory (`commands.ts:2347-2356`).
  - `doctor` reports the store path (`commands.ts:5296`).
  - Memory is injected into every run as a context lane via `MemorySource`
    (`packages/cli/src/power.ts:458`) — see §41.
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 41. The Context Engine and its lanes

- **What:** Assembles a model-ready request from ordered context lanes under a token budget.
- **Surface:**
  - Engine: `packages/context/src/engine.ts` (547 lines); lanes
    `packages/context/src/types.ts:21-35`; static/volatile split
    `packages/context/src/lanes.ts:46-49`.
  - Core seam: `ContextAssembler` `packages/core/src/types.ts:222-227`.
  - CLI adapter: `EngineContextAssembler` `packages/cli/src/commands.ts:939-991`.
  - Applied in the kernel for every non-agent run (`orchestrator.ts:258-262`) so `ask`, `chat`,
    every orchestration primitive and routed failover cannot bypass it.
- **The eleven lanes, most cache-stable first** (`context/src/types.ts:21-33`):
  `system`, `tools`, `memory`, `conventions`, `repo-map`, `env`, `retrieved`, `git`, `history`,
  `terminal`, `task`.
- **Config:** `context.budgetTokens` (4096), `context.conventions` (`true`),
  `context.conventionsMaxBytes` (4096), `context.conventionsMaxFiles` (2), `context.git` (`true`),
  `context.gitDiff` (`false`), `context.gitMaxBytes` (2048), `context.envKeys[]` (empty) —
  `schema.ts:315-369`.
- **Expected behaviour:**
  - STATIC lanes serialise into the `system` prefix so provider prompt-caches hit; VOLATILE lanes
    render into `messages` and are **trimmed tail-first** when over budget
    (`context/src/types.ts:15-20`).
  - `EngineContextAssembler` solves two failure modes at once (`commands.ts:960-976`):
    returning `res.messages` verbatim drops every prior turn (multi-turn amnesia), while
    `res.messages.slice(0,-1)` drops the retrieved context (the engine packs volatile lanes *into*
    the rebuilt final turn). The fix keeps the history-lane preamble, keeps the caller's real
    conversation, and splices `res.volatilePreamble` onto the caller's **own** final user turn — so
    non-text content (images, tool results) the caller attached is never dropped and the query
    appears exactly once.
  - The caller's `system` and the engine's `system` are joined with a blank line, in that order
    (`commands.ts:957-959`, `:988`).
  - Assembly failure is best-effort in `cmdAsk` (swallowed, `commands.ts:734-736`) but not wrapped
    elsewhere.
  - Token estimation defaults to chars/4; the estimator is a swappable seam
    (`context/src/types.ts:37-38`).
- **macOS app:** `NOT SURFACED` — no context inspector. The TUI has `/context`
  (`packages/tui/src/chrome/commands.ts:259`); the app has no equivalent.
- **Status:** `UNVERIFIED`

## 42. Context power sources

- **What:** Which concrete sources feed the lanes on a real run.
- **Surface:** `buildPowerSources` `packages/cli/src/power.ts:455-516`.
- **The sources, in registration order:**
  1. `MemorySource` — durable memory (`power.ts:458`), on unless the caller opts out.
  2. `ProjectConventionsSource` — the repo's own rules (AGENTS.md-class), gated on
     `config.context.conventions` (`power.ts:462-470`). Previously reachable only via
     `nexus memory ingest`, so a fresh user never sent them.
  3. `RepoMapSource` — the structural repo map, gated on `config.fileintel.repoMap`
     (`power.ts:472-481`).
  4. `EnvSource` — opt-in by key list; the default empty list collects nothing
     (`power.ts:484-486`).
  5. `RagRetrievalSource` — gated on `config.rag.enabled` **and** a persisted, non-empty index
     (`power.ts:490-499`).
  6. `GitDiffSource` — working-tree state, gated on `config.context.git`; outside a git repo it
     yields empty output (`power.ts:503-511`).
- **Expected behaviour:**
  - `rag.enabled` is a **permission, not a promise**: retrieval only joins when an index actually
    exists and is non-empty, otherwise it would spend a query to contribute nothing
    (`power.ts:488-490`).
  - Git state is volatile by construction, so it sits behind the cacheable prefix and is trimmed
    before any static context (`power.ts:501-503`).
  - `repoMapBudgetTokens(config)` clamps the raw setting against `context.budgetTokens`; `doctor`
    reports the **effective** budget, which differs from the raw one exactly when a
    misconfiguration would otherwise silently produce no map (`commands.ts:5333-5339`).
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 43. RAG — `nexus index` and `nexus search`

- **What:** Build and query a local retrieval index over a project.
- **Surface:** `cmdIndex` `packages/cli/src/commands.ts:5647-5723`; `cmdSearch`
  `packages/cli/src/commands.ts:5733-5784`; `startIndexWatch` `commands.ts:5606-5645`;
  `runIndexInBackground` `commands.ts:5556-5584`; `resolveRagEmbedder` `commands.ts:5498-5526`;
  package `packages/rag/` (`index-api.ts`, `watchAndReindex`).
- **Config:** `rag.*` `schema.ts:160-233` — `enabled` (default **`false`**), `embedder`
  (`hashing|ollama|openai|provider`), `embedderModel`, `embedderProvider`, `dims` (512), `topK` (5),
  `storeFile`, `chunkSize` (800), `overlap` (100), `ignore[]`, `secretScan` (`true`),
  `maxTotalBytes` (128 MiB), `maxTotalChunks` (100 000), `embedBatchSize` (128).
- **Inputs:** `nexus index [path] [--watch] [--background|--bg]`; `nexus search <query>` (or piped).
  Env: `NEXUS_INDEX_CHILD` (internal marker, `commands.ts:5547`).
- **Outputs:**
  - `index -o json` → `{root, indexFile, documents, chunks, embedder, repoMap:{files, symbols,
    tokens, truncated}}`.
  - `index -o text` → `indexed N file(s) → M chunk(s)`, `rag index: <path>`, `repo map: …`.
  - `search -o json` → array of `{score, semanticScore, keywordScore, citation:{docId, source, span,
    lang}, text}`; exit `1` when empty.
  - `search -o text` → `<source>:<start>-<end>  score=0.NNN` then a ≤160-char collapsed snippet
    (`commands.ts:5728-5731`).
  - `--watch` stderr → `[watch] reindexed: N changed, M unchanged, K removed` per pass.
- **Expected behaviour:**
  - **Hybrid scoring:** results carry both `semanticScore` and `keywordScore` alongside the combined
    `score` (`commands.ts:5758-5760`).
  - **Fork-bomb guard:** `--background` re-launches `nexus index <root>` detached with
    `NEXUS_INDEX_CHILD=1` stamped on the child env. `cmdIndex` treats that marker — **not** the
    absence of `--background` — as the authoritative "you are the worker" signal, because
    `config.performance.background` can also enable backgrounding and the child inherits that config
    (`commands.ts:5539-5547`, `:5673-5676`). Without the marker this would fork unboundedly.
  - Background launch prints `{background:true, pid, root}` / `indexing … in the background (pid N)`
    and returns `0` immediately. An unresolvable CLI entry ⇒ exit `1` (`commands.ts:5562-5566`).
  - `--watch` does one full index, then debounced incremental re-embedding of only the documents
    whose **content hash** changed, saving after each pass; it runs until SIGINT/SIGTERM
    (`commands.ts:5606-5645`, `:5652-5665`). Debounce and prune come from
    `performance.watch` (`schema.ts:1013-1021`, defaults 150 ms / no prune).
  - Embedder resolution degrades loudly-but-gracefully to the offline `hashing` embedder with a
    stderr note when: `rag.embedderProvider` is unset, the provider is absent, or the provider has
    no embeddings API (`commands.ts:5498-5526`). `index`/`search` never crash on this.
  - `index` with no indexable files ⇒ stderr + exit `1` (`commands.ts:5679-5682`).
  - `search` with no index file ⇒ `run \`nexus index\` first`, exit `1`; an empty index ⇒ same, exit
    `1`; no matches ⇒ `no matching chunks`, exit `1` (`commands.ts:5742-5777`).
  - `index` also builds the structural repo map over the same tree in the same pass
    (`commands.ts:5697-5703`).
- **macOS app:** `NOT SURFACED` — no index/search UI at all.
- **Status:** `UNVERIFIED`

## 44. File intelligence / repo map

- **What:** An aider-style, PageRank-ranked structural map of the repo, injected as a context lane.
- **Surface:** `repoMap`, `detectLanguage` `packages/fileintel/` (`heuristic.ts` 401 lines);
  called `commands.ts:5697-5703`; lane source `RepoMapSource` (`power.ts:472-481`).
- **Config:** `fileintel.*` `schema.ts:264-306` — `repoMap` (default `true`), `budgetTokens` (768),
  `maxFiles`, `ignore[]`, `maxTotalFiles` (20 000), `maxTotalBytes` (128 MiB).
- **Outputs:** `{files[], ranked[], tokens, truncated}` — reported by `index` and `doctor`.
- **Expected behaviour:**
  - Budget is clamped against `context.budgetTokens`; `truncated` is reported honestly rather than
    silently dropping symbols.
  - `detectLanguage(path)` returns `"unknown"` for unrecognised files, and the RAG document then
    carries no `lang` field rather than a fabricated one (`commands.ts:5590-5594`, `:5691-5693`).
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 45. `nexus cache stats | clear`

- **What:** Inspect or clear the response and embedding caches.
- **Surface:** `cmdCache` `packages/cli/src/commands.ts:5870-5908`; helpers `cacheDir`,
  `cacheEntryCounts` `packages/cli/src/power.ts:517-534`; package `packages/cache/`.
- **Config:** `cache.*` `schema.ts:240-258` — `enabled` (default **`false`**), `dir`, `ttlMs`,
  `backend` (`memory|disk`, default `disk`), `responses` (`true`), `embeddings` (`true`),
  `affinity` (`true`).
- **Outputs:** `stats -o json` → `{dir, enabled, backend, responses, embeddings}`;
  text → four lines including `affinity: on|off`. `clear` → `cleared cache under <dir>`.
- **Expected behaviour:**
  - Entry counts are computed by counting `.json` files under `<dir>/responses` and
    `<dir>/embeddings`; a missing dir counts `0` and a read failure counts `0` rather than throwing
    (`power.ts:521-531`).
  - `clear` recursively removes both namespace directories with `force: true`
    (`commands.ts:5897-5904`) — it does not ask for confirmation.
  - Unknown subcommand ⇒ exit `2`.
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 46. Response cache (CAG)

- **What:** An exact-request cache that short-circuits the whole provider dispatch.
- **Surface:** `openResponseCache` (`packages/cli/src/power.ts`), used in `cmdAsk`
  `commands.ts:744-758` and `:774-779`; renderer `renderCachedResponse` `commands.ts:784-816`.
- **Inputs:** the `ChatRequest` signature `{model, messages, system?}` (`commands.ts:745-746`).
- **Outputs:**
  - stderr on hit: `[cache] hit <p>:<m> — saved N tokens ($…), hitRate=0.NN`
    (`commands.ts:751-755`).
  - `json` → the normal run shape **plus `"cached": true`** (`commands.ts:790-806`).
  - `ndjson` → `{"t":"text",…}`, then **`{"t":"cache","hit":true}`**, then `{"t":"done"}`
    (`commands.ts:808-812`).
  - Exit `0`.
- **Expected behaviour:**
  - Opt-in: requires `cache.enabled` **and** `cache.responses`, so the default path is unchanged.
  - The signature is computed **after** context assembly, so an unchanged question does not return
    an answer cached before AGENTS.md / the repo map / RAG / memory / the working diff changed
    (`commands.ts:715-717`).
  - Only a successful (`status === "ok"`) winner is stored.
  - **Only `nexus ask` uses it.** `agent`, `chat`, `code`, and the orchestration primitives do not.
  - The `ndjson` `{"t":"cache"}` line is **not a member of the `UiEvent` union**
    (`projection.ts:14-108`). See **CONTRADICTIONS C7**.
- **macOS app:** `NOT SURFACED`; and because the app never runs `nexus ask`, it would never see the
  `cache` line — except that an unknown `t` decodes to `.unknown` and is preserved
  (`UiEvent.swift:296-297`).
- **Status:** `UNVERIFIED`

## 47. Session/provider cache affinity

- **What:** A soft pin toward the session's last-used provider so its prompt cache stays warm.
- **Surface:** `preferAffineProvider`, `sessionAffinity` (`packages/cli/src/power.ts`), used in
  `cmdRoute` `commands.ts:2846-2856` and `:2956-2958`.
- **Config:** `cache.affinity` (default `true`, `schema.ts:255`).
- **Expected behaviour:**
  - Reorders the candidate list but **never removes a candidate**, so live failover still works
    (`commands.ts:2846-2850`).
  - The affinity key is `route:<config.defaultProvider>` — stable across repeated invocations so the
    pin can build up.
  - Re-pinned after the run to whichever provider actually answered, which may differ from the
    chosen candidate after failover.
  - **Only `nexus route test` records or applies affinity.** No other command does.
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

---

# Part VI — Orchestration, accounting, history, observability

## 48. Orchestration primitives (the shared model)

- **What:** Five primitives defined as **data**, not hand-wired code paths.
- **Surface:** `OrchestrationSpec` `packages/core/src/types.ts:135-141`; dispatch
  `packages/core/src/orchestrate/orchestrator.ts:852`; handle
  `OrchestrationHandle` `core/src/types.ts:155-162`; outcome `OrchestrationOutcome`
  `core/src/types.ts:146-153`.
- **The five kinds:** `single`, `compare`, `race` (`mode: first|best`, optional `judge`),
  `consensus` (required `judge`), `chain` (`stages[]`).
- **Expected behaviour:**
  - **Every primitive settles rather than short-circuits.** Each lane produces a `RunResult`; a
    failed lane becomes `status:"error"` and is never discarded; judge runs fold into the aggregated
    `usage`; the outcome reports `partial: true` when any lane failed
    (`orchestrator.ts:8-11`, `core/src/types.ts:152`).
  - `OrchestrationHandle` exposes `events()` (live labeled chunks), `outcome()` (resolves once every
    lane settles) and `scope` (cancellation).
  - Lane scopes are children of the turn scope, so `race first` can cancel losers the moment a
    winner's terminal chunk is observed (`orchestrator.ts:938-943`).
  - Every provider run is instrumented as a span, bracketed with `span.start`/`span.end` and
    emitting `span.first-token` for TTFT; a no-op passthrough when no `emit` sink is wired
    (`orchestrator.ts:191-197`). Subprocess CLIs nest as span kind `subprocess`
    (`orchestrator.ts:182`).
  - Store writes (`appendLabeledChunk`, `summarize`) are **best-effort and never sink the run**
    (`orchestrator.ts:884`, `:900`).
  - Transfer-handle failures are isolated the same way and surfaced on the store-error trace channel
    prefixed `[transfer]` (`orchestrator.ts:1674-1681`).
- **macOS app:** `RunMode` maps `.compare`/`.race` onto the CLI's own primitives
  (`AppState.swift:83-115`). `consensus` and `chain` are `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 49. `nexus compare`

- **What:** Fan one prompt out across N providers, aligned side by side.
- **Surface:** `cmdCompare` `packages/cli/src/commands.ts:2378-2420`; runner
  `runOrchestration` (`kind: "compare"`) `commands.ts:321-431`; backend parser
  `parseBackends` `commands.ts:2369-2376`.
- **Inputs:** prompt; `-b/--backend <provider[:model]>` repeated, **minimum 2**; `-o`.
- **Outputs:**
  - `text` → one `── <provider>:<model> ──` block per lane with the full settled text
    (`renderLaneBlocks`, `commands.ts:600-617`), then per-lane
    `[lane p:m] status=… out=N cost=…` stderr lines, then an aggregate
    `[usage] in=… out=… cost=…` line.
  - `json` → `{kind:"compare", partial, runs:[…], usage:{…, costIncomplete}}`
    (`toCompareJson`, `commands.ts:661-673`).
  - `ndjson` → every lane's events, keyed by lane (`laneKey` returns the adapter id, not `"main"`).
  - Exit `0` iff not `partial`.
- **Expected behaviour:**
  - Fewer than two backends ⇒ exit `2` (`commands.ts:2391-2394`); an unregistered backend ⇒ exit `1`.
  - `text` mode **does not stream** — lanes drain silently and render as settled blocks, because
    streaming several lanes to stdout interleaves them character-by-character into one garbled line
    (`commands.ts:392-400`, `:593-599`).
  - A cancelled lane prints `(cancelled after partial output)` or `(cancelled after another race
    lane completed)` rather than being shown as an error (`commands.ts:605-611`).
  - An empty lane prints `(no output)`; an errored lane prints the human error line with a hint.
  - Uses `buildAuthedRuntime` because `-b` names providers by id (`commands.ts:2387-2389`).
- **macOS app:** `RunMode.compare` (`AppState.swift:96`), argv built at `AppState.swift:283-286`.
  Requires ≥2 backends before submit is allowed (`AppState.swift:303-307`).
- **Status:** `UNVERIFIED`

## 50. `nexus race`

- **What:** Race N providers; take the fastest usable answer, or the judged best.
- **Surface:** `cmdRace` `packages/cli/src/commands.ts:2590-2622`; multi-lane runner
  `runMultiLane` `commands.ts:2497-2556`.
- **Inputs:** prompt; `-b` ×≥2; `--mode first|best` (default `first`, `commands.ts:2603-2604`).
- **Outputs:** per-lane blocks, then `race — winner <p>:<m>[ (partial)]`, then per-lane summary with
  ` winner` marking the winning run, then aggregate usage. `json` → `toOrchestrationJson`
  (`commands.ts:2425-2447`) including `winner` and, for `best`, `merged:{text, rationale,
  pickedFrom, scores}`. Exit `0` iff a winner settled `ok`.
- **Expected behaviour:**
  - `first` settles on the first successful lane and cancels the losers (`orchestrator.ts:938-943`).
  - `best` attaches a judge (`{domain:"chat"}`, `commands.ts:2606-2609`) and ranks the settled lanes.
  - The default judge is offline, so `race --mode best` is fully exercisable with `mock`
    (`commands.ts:2491-2496`).
  - A merged answer is printed as a separate `── merged answer ──` block **only when it differs from
    every lane's text** — otherwise race/chain output would repeat the winner verbatim and could
    double an enormous response (`commands.ts:2460-2468`).
- **macOS app:** `RunMode.race` (`AppState.swift:98`). **`--mode` is never passed**, so the app can
  only ever run `race first`; the mode picker does not exist. `AppState.swift:284`.
- **Status:** `UNVERIFIED`

## 51. `nexus consensus`

- **What:** Fan across N providers, then reconcile them into one answer via a judge.
- **Surface:** `cmdConsensus` `packages/cli/src/commands.ts:2624-2656`.
- **Inputs:** prompt; `-b` ×≥2; `--judge <model>` (a model hint); `--strategy rank|vote|merge`
  (default **`merge`**, `commands.ts:2638-2640`).
- **Outputs:** as §50, plus `merged`. **Exit `0` iff `outcome.merged` exists**
  (`commands.ts:2655`) — a settled winner alone is not success.
- **Expected behaviour:**
  - `JudgeSpec` (`core/src/types.ts:98-108`): `domain` (`chat|code`), optional `model`/`adapterId`,
    `rubric`, `strategy`, `votes` (default 3 for `vote`).
  - Strategies (`core/src/types.ts:110-118`): `rank` picks a winner; `merge` produces a possibly
    synthesised reconciling answer; `vote` runs K independent judge passes and picks the candidate
    with the majority of #1 placements, with a domain-specific tie-break.
  - `judgeResults()` exposes the judge's own provider runs so their usage is accounted for, not
    hidden (`core/src/types.ts:117`).
  - An invalid `--strategy` silently falls back to `merge`.
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 52. `nexus chain`

- **What:** Run staged with hand-offs between stages.
- **Surface:** `cmdChain` `packages/cli/src/commands.ts:2665-2734`; preset `CHAIN_PRESET`
  `commands.ts:2659-2663`; stage type `ChainStage` `core/src/types.ts:120-133`.
- **Inputs:** prompt; `--stages <provider[:model],…>`; `-p` (default `"mock"`,
  `commands.ts:2675`).
- **Outputs:** as §50. Exit `0` iff not `partial` — a chain "passes" only when every stage ran and
  succeeded, with no early stop (`commands.ts:2732-2733`).
- **Expected behaviour:**
  - Default preset is **plan → edit → review** over one provider; with `mock` the stages map to
    `mock-fast`, `mock-smart`, `mock-fast` (`commands.ts:2659-2663`, `:2710-2718`).
  - With `--stages`, stage names become `stage1`, `stage2`, … (`commands.ts:2699`) — the semantic
    plan/edit/review names are lost.
  - Only stage 0 receives the prompt; later stages get `input: []` and rely on the hand-off
    (`commands.ts:2700`, `:2715`).
  - When a stage declares no `handoff`, the previous result's text is appended as a user turn
    (`core/src/types.ts:126-132`, `orchestrator.ts:1149`).
  - `ChainStage.optional` and `ChainStage.gate` (`auto|confirm`) exist in the type but **the CLI
    never sets either** — every stage is mandatory and ungated from `nexus chain`.
  - Empty `--stages` ⇒ exit `2`; an unregistered provider ⇒ exit `1`.
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 53. Reasoning effort levels

- **What:** A reasoning-budget level applied to a run.
- **Surface:** `EFFORT_BUDGET` `packages/cli/src/commands.ts:880-884`; applied in the TUI dispatcher
  `commands.ts:3794-3801`; TUI picker `/effort` `packages/tui/src/chrome/commands.ts:215-229`;
  request field `SamplingParams.reasoning` `core/src/types.ts:33-38`;
  capability probe `reasoningSupportedFor` (`packages/cli/src/model-switch.ts`), read at
  `commands.ts:3768`.
- **Levels and budgets:** `low` → 4000, `medium` → 10 000, `high` → 24 000 thinking tokens;
  plus `off`.
- **Expected behaviour:**
  - The level is set as **both** `effort` (which OpenAI-compatible providers read directly) and
    `budgetTokens` (which Anthropic bills/limits by), because the two provider families express the
    same concept differently (`commands.ts:876-884`).
  - Applies to the **next** turn after the picker changes (`commands.ts:3796-3801`).
  - A provider with no reasoning mode must not keep a stale level attached: an accepted switch to
    such a provider resets `activeEffort` to `off` (`commands.ts:3784-3786`).
  - The picker reflects `reasoningSupported` so it does not offer a level the provider ignores
    (`commands.ts:3877`).
  - **There is no CLI flag for effort.** It exists only as a TUI slash command; no entry named
    `effort` appears in `FLAG_SPEC` (`index.ts:68-171`). See **CONTRADICTIONS C2**.
- **macOS app:** A control exists and splices `--effort <level>` into the **command preview only**
  (`ConversationView.swift:331-341`), never into the spawned argv. The flag does not exist in the
  CLI. This is the sharpest violation of the preview-equals-spawn rule.
- **Status:** `UNVERIFIED`

## 54. Token and cost accounting

- **What:** Per-run and per-session token/cost figures, with unknown pricing kept distinct from zero.
- **Surface:**
  - `formatCostUsd` `packages/cli/src/commands.ts:529-531` and `packages/cli/src/wave6.ts:122-124`
    — `null`/`undefined` → the literal string `"unpriced"`.
  - `costIsIncomplete` `packages/cli/src/commands.ts:541-544`; note builder
    `costIncompleteNote` `commands.ts:547-549`.
  - `usageCost` `packages/core/src/projection.ts:114-116` —
    `u.costUsd ?? u.reportedCostUsd ?? null`.
  - Pricing table: `pricingTable` / `DEFAULT_PRICING` `packages/config/src/schema.ts:1186-1209`;
    config `pricing` (per-1M in/out/cacheRead/cacheWrite/reasoning), `latency`, `quality`
    (`schema.ts:1150-1155`).
  - Session totals: `sessionCostLabel` `wave6.ts:112-115`; `SessionMeta.costIncomplete`.
- **Expected behaviour — the honesty rules:**
  - `costUsd: null` means **UNKNOWN**, not free. Rendering it as `$0.00` would make a real paid call
    display as free (`projection.ts:98-105`).
  - **Never coerce with `?? 0` at a call site** — always go through `formatCostUsd`
    (`commands.ts:521-528`).
  - A multi-lane total that mixes priced and unpriced lanes appends
    `(partial — pricing unknown for some lanes)` and sets `usage.costIncomplete: true` in JSON,
    because `sumUsage` only sums the known lanes and would otherwise read as a confident total
    (`commands.ts:533-549`, `:670`).
  - A session total with unpriced runs renders `$X (incomplete)` (`wave6.ts:106-115`).
  - `reportedCostUsd` (a provider-reported figure) is used when no computed cost exists.
  - Cache read/write tokens are carried separately (`projection.ts:251-252`).
  - `DEFAULT_PRICING` ships Anthropic prices so cost works out of the box; `config.pricing`
    overrides per model id.
- **macOS app:** **This is where the rule breaks.** `UiEvent.Usage.costUsd` is a non-optional
  `Double` (`UiEvent.swift:188`), so a `null` fails to decode and the entire usage event degrades to
  `.unknown(type:"malformed")` (`UiEvent.swift:313-320`) — the tokens are lost too, silently.
  `NexusSession.costUsd` coerces a missing cost to `0` (`Sessions.swift:84`) and drops
  `costIncomplete` entirely. Displays gate on `> 0` (`RootView.swift:428`,
  `SessionsView.swift:276`, `:352`), so unknown and free both render as nothing.
  See **CONTRADICTIONS C3**.
- **Status:** `UNVERIFIED`

## 55. `nexus history list | show`

- **What:** The SQLite run timeline.
- **Surface:** `cmdHistory` `packages/cli/src/commands.ts:5912-6010`; store
  `packages/cli/src/history.ts` (545 lines) — `openHistory`, `historyList`, `historyShow`,
  `latestStoredSession`.
- **Config:** `history.enabled` (default `true`), `history.dbPath`, `history.storePrompts`
  (**default `true`**, `schema.ts:481`), `history.encryptPrompts` (default `true`, AES-256-GCM,
  `schema.ts:483`).
- **Outputs:**
  - `list` → the last **20** runs as
    `<ISO ts>  <runId>  <p>:<m>  <status>  in=N out=N <cost|unpriced>`;
    `-o json` → the full row objects.
  - `show <runId|sessionId>` → `#<seq> <runId prefix> <detail>` per event; `-o json` → the events
    with `payload` parsed.
- **Expected behaviour:**
  - `show` on an id with no events ⇒ exit `1`; missing id ⇒ exit `2`; unknown subcommand ⇒ exit `2`.
  - A malformed stored payload is **preserved rather than crashing the inspection command** — the
    raw string is returned in JSON mode (`commands.ts:5969-5977`) and the detail falls back to the
    raw type in text mode (`commands.ts:6000-6002`).
  - Prompts are secret-redacted before persistence and encrypted at rest unless explicitly disabled
    (`schema.ts:473-483`; `history.ts:193`).
  - `storePrompts` gates both `appendTranscript` and `loadTranscript`
    (`history.ts:366`, `:388`) — with it off, resume has nothing to restore.
- **macOS app:** `NOT SURFACED` — the app shows sessions, not raw run history.
- **Status:** `UNVERIFIED`

## 56. `nexus session list | show | rename | branch | delete | export`

- **What:** Manage sessions over the shared `event_log`.
- **Surface:** `cmdSession` `packages/cli/src/wave6.ts:126-279`; store
  `packages/session/src/store.ts` (546 lines) — `listSessions:239`, `getSession:166`,
  `runsOf:155`, `eventsOf:145`, `loadBundle:257`, `replay:270`, `rename:289`, `branch:390`,
  `delete:315`, `export:453`, `generateReceipt:522`, `snapshot:328`, `listSnapshots:355`.
- **Inputs:** `list`; `show <id>`; `rename <id> <name>`; `branch <id> [--name <n>]`;
  `delete|rm <id>`; `export <id> [--format json|md|markdown|html] [-o <file>]`.
- **Outputs:**
  - `list` → `<ISO updatedAt>  <name (id)|id>  <p>:<m>  turns=N runs=N $cost[ (incomplete)]`.
  - `show` → session header, created, provider, counts, then one line per run.
  - `export` → the rendered document on stdout, **or** written to the `-o` path (chmod `0600`) with
    only the path printed (`wave6.ts:258-269`).
  - `branch` → `branched <id> → <newId>[ ("<name>")]` / `{sessionId, parentSessionId, name}`.
- **Expected behaviour:**
  - `openStore` reports `no session history yet (<path>) — run a turn first` and returns `1` when the
    db file does not exist; an open failure reports `session store unavailable: <msg>` and returns
    `1` — never a stack trace (`wave6.ts:86-98`).
  - Every mutation checks the session exists first and exits `1` with `no session "<id>"` otherwise.
  - `--format` accepts `html`, `md`/`markdown`, else defaults to **`json`**
    (`parseExportFormat`, `wave6.ts:282-286`). `--mode` is accepted as an alias (`wave6.ts:252`).
  - An exported file is written with `0600` on a best-effort basis (platforms without POSIX perms
    are tolerated, `wave6.ts:262-266`).
  - `-o` is disambiguated from the output-mode literals: `text`/`json`/`ndjson` are treated as modes,
    anything else as a file path (`wave6.ts:259`).
  - The store also supports `snapshot`/`listSnapshots`, which **no CLI command exposes**.
    See **GAPS G10**.
  - `store.close()` runs in `finally` for every path (`wave6.ts:276-278`).
- **macOS app:** `session list` and `session show` (`NexusClient.swift:75-83`,
  `Sessions.swift:145-171`), UI `SessionsView.swift`. `rename`, `branch`, `delete` and `export` are
  **`NOT SURFACED`**. See **GAPS G7**.
- **Status:** `UNVERIFIED`

## 57. `nexus replay <sessionId>`

- **What:** Re-render a recorded session's `UiEvent` timeline.
- **Surface:** `cmdReplay` `packages/cli/src/wave6.ts:314-349`; line renderer `replayLine`
  `wave6.ts:291-312`; bundle `store.loadBundle`.
- **Outputs:**
  - `text` → a mirror of the live renderer: `— session <p>/<m>`, raw text deltas,
    `[tool-call] <name>`, `[tool-result] ok|error`, `[file-edit] <path>`, `[error] <code>: <msg>`,
    `[usage] in=N out=N <cost|unpriced>`, `[done] <finishReason>`; the session banner goes to
    **stderr** (`wave6.ts:339`).
  - `ndjson` → **the exact `UiEvent` stream, one per line** — this is what feeds a TUI or a client.
  - `json` → the whole timeline array.
  - Missing id ⇒ exit `2`; unknown session ⇒ exit `1`.
- **Expected behaviour:**
  - `replayLine` returns `null` for events with nothing to render (including `approval`, `diff`
    patches, `reasoning`, `agent`, `failover`, `route`), so **`-o text` replay is lossy** relative to
    the recorded stream; `-o ndjson` is not.
  - Replaying through the same fold that live streaming uses is what prevents a "history looks
    different from live" class of bug.
- **macOS app:** `NexusCommand.replay` (`NexusClient.swift:85-87`) → fed through
  `ConversationController.ingest` so a past session rebuilds the identical transcript with no second
  code path (`AppState.swift:448-461`). Wired in `SessionsController.replayCommand`
  (`Sessions.swift:176-178`).
- **Status:** `UNVERIFIED`

## 58. `nexus receipt <sessionId>` — the Code Receipt

- **What:** A private, local, self-contained HTML artefact for one coding session
  (prompt → diff → passing tests).
- **Surface:** `cmdReceipt` `packages/cli/src/wave6.ts:353-397`; generator
  `store.generateReceipt` `packages/session/src/store.ts:522`; HTML helpers
  `packages/session/src/html.ts` (`escapeHtml`, `htmlDocument`, `renderDiff`).
- **Inputs:** `<sessionId>`; `-o <file.html>`; `--prompt <text>`; `--title <text>` (`--system` is
  accepted as an alias, `wave6.ts:383`).
- **Outputs:** **only the local file path on stdout** (`wave6.ts:392`).
- **Expected behaviour:**
  - **Private by default: never uploaded, published, or otherwise sent anywhere**
    (`wave6.ts:1-14`, `:391`).
  - Missing id ⇒ exit `2`; unknown session ⇒ exit `1` (checked twice — before and after generation,
    `wave6.ts:363-366`, `:387-390`).
  - `-o` is split into `outDir` + `fileName` for the generator, and the mode literals are excluded
    from being treated as paths (`wave6.ts:375-380`).
  - With no `-o` the receipt lands at a default temp path.
- **macOS app:** `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 59. Observability — spans, metrics, `nexus trace`

- **What:** Every run is instrumented; spans are exported and can be re-rendered as a Gantt timeline.
- **Surface:**
  - Package: `packages/observability/` — `tracer.ts`, `store.ts`, `exporters.ts`, `metrics.ts`,
    `engine-bridge.ts`, `redact.ts`, `ids.ts`.
  - CLI runtime: `buildObservability`, `loadTraceSpans`, `renderTimeline`, `TraceStore`
    `packages/cli/src/observability.ts`.
  - Command: `cmdTrace` `packages/cli/src/wave6.ts:408-471`.
  - Per-run trailer: `renderMetricsTrailer` `packages/cli/src/commands.ts:439-452`.
  - Span emission: `orchestrator.ts:191-197`; core trace types `packages/core/src/trace.ts`.
- **Config:** `observability.enabled` (default `true`), `exporter` (`file|memory|otlp|none`,
  default `file` = NDJSON, offline), `filePath`, `otlpEndpoint` (`schema.ts:495-510`).
- **Inputs:** `nexus trace [traceId|runId|sessionId]`.
- **Outputs:**
  - `text` → `trace <id> — N span(s)` then a Gantt-style timeline per trace.
  - `json` → the selected span objects.
  - Per-run stderr trailer: `[trace] ttft=<p50>ms latency=<p50>ms spans=N`.
- **Expected behaviour:**
  - Filter resolution is tiered: exact `traceId` → span attribute `nexus.run_id` → treat as a
    session id and map through the session store's turn ids (turn id **is** trace id,
    `wave6.ts:402-406`, `:425-452`).
  - No trace file ⇒ `no trace data yet (<path>) …`, exit `1`; zero spans ⇒ `no spans recorded`,
    exit `1`; a filter matching nothing ⇒ exit `1`.
  - Metrics recorded include the `nexus.ttft.ms` and `nexus.latency.ms` histograms
    (`commands.ts:445-447`).
  - The trailer is **silent** when observability is off or the run produced no latency sample, so a
    piped/quiet run is unaffected (`commands.ts:433-438`).
  - `obs.flush()` runs in `finally` on every instrumented command.
  - Spans are redacted before export (`packages/observability/src/redact.ts`).
- **macOS app:** `NOT SURFACED`. The TUI has `/trace`
  (`packages/tui/src/chrome/commands.ts:284`); the app has no equivalent.
- **Status:** `UNVERIFIED`

## 60. ZLCTS — Zero-Loss Context Transfer

- **What:** A harness-owned, provider-neutral knowledge core so a mid-run provider switch loses
  nothing.
- **Surface:**
  - Package: `packages/transfer/` — `handle.ts`, `projector.ts`, `wal.ts`, `deltas.ts`, `items.ts`,
    `store.ts`, `snapshot.ts`, `blobs.ts`, `sync.ts`, `integrity.ts`, `recover.ts`, `verbatim.ts`,
    `tool-progress.ts`, `migrate.ts`, `mutex.ts`, `handoff-capsule.ts`.
  - Core seam: `TransferHandle` `packages/core/src/types.ts:238-256`,
    `TransferHandleFactory` `:265`, `TransferRunIdentity` `:259-263`.
  - CLI runtime: `openTransferRuntime` `packages/cli/src/transfer.ts` (801 lines).
- **Config:** `transfer.*` `schema.ts:379-426` — `enabled` (default `true`), `dbPath`,
  `embedder` (`hashing`), `compressionPolicy` (`semantic|truncateMiddle`, default `semantic`),
  `validationStrictness` (`strict|relaxed`, default `strict`), plus the `handoff` block (§17).
- **The handle's five operations** (`core/src/types.ts:245-255`):
  `captureVerbatim(chunk)` (raw, **before** the redacting SessionStore append),
  `project(chunk)` (typed deltas folded into the PNKC WAL + items),
  `recordToolOutput(tool, stdout)` (for mid-tool-call-termination resume),
  `turnBoundary(kind, turn)`, `flush()` (durability barrier).
- **Expected behaviour:**
  - One handle **per provider run**, created lazily by the factory, because concurrent orchestration
    lanes need independent projector state while sharing one durable store
    (`core/src/types.ts:258-265`).
  - Every method is best-effort and **must** be isolated by the caller — a throwing handle never
    crashes the run (`core/src/types.ts:243-245`; enforced `orchestrator.ts:1674-1683`).
  - When `undefined`, nothing is captured and behaviour is exactly as before.
  - `createIntegrityRepair` produces `IntegrityReport` / `RepairAction` / `LossEvent` — loss is
    **recorded as an event**, not silently absorbed (`packages/transfer/src/index.ts:82-83`).
  - `recoverMindDbOnOpen` and `recoverUnfolded`/`refold` handle crash recovery
    (`transfer/src/index.ts:74-87`).
  - `doctor` reports `transfer: [ok]|[--] <detail>` (`commands.ts:5218-5220`).
- **macOS app:** `NOT SURFACED` — no transfer/integrity view; loss events are invisible to the app.
- **Status:** `UNVERIFIED`

---

# Part VII — Auth, config, health, daemon, SDK, TUI, enterprise

## 61. `nexus login` — real per-provider auth

- **What:** Run each provider's genuine auth flow; never a fake one.
- **Surface:** `cmdLogin` `packages/cli/src/commands.ts:4894-5050`; strategies
  `packages/auth/src/strategies/`; flows `packages/auth/src/flows/`; PKCE
  `packages/auth/src/pkce.ts`; token store `packages/auth/src/store.ts`; browser opener
  `packages/auth/src/browser.ts`; CLI registry `buildAuthRegistry` `packages/cli/src/auth.ts`.
- **The four honest strategy kinds:** `oauth`, `api-key`, `cli-delegate`, `cloud-sso`
  (`packages/auth/src/strategies/types.ts`).
- **Inputs:** `[provider]`; `--device`; `--api-key`; `--open`; `-o json`; `-h`.
  Config: `auth.providers.<id>` overrides (`method`, `mode`, `clientId`, `authorizeUrl`,
  `tokenEndpoint`, `deviceEndpoint`, `scopes`, `openBrowserOnLogin`, `schema.ts:1054-1080`);
  `auth.tokenStore` (`auto|keychain|file`, default `auto`, `schema.ts:1092`).
- **Outputs:** stdout `signed in to <id> via <method>[ (token expires ~Nh)]` or
  `{providerId, loggedIn, method, expiresAt?, expiresIn?}`. URLs, device codes and prompts go to
  **stderr** so stdout stays clean. Exit `0` when `loggedIn`.
- **Expected behaviour:**
  - **Tokens are never printed** (`commands.ts:4889-4893`, `:4819`).
  - Method precedence: `--api-key` flag → config `method` pin → the strategy's own default
    (`commands.ts:4941-4944`). Mode precedence: `--device` → config `mode` pin
    (`commands.ts:4945-4947`).
  - **`--device` is rejected rather than faked** when the provider has no real device endpoint —
    with a kind-specific message for `api-key`, `cli-delegate`, `cloud-sso`, and plain OAuth — exit
    `2` (`commands.ts:4956-4983`). `--api-key` wins over `--device` for a composite provider, so
    that combination is not rejected.
  - `--open` (or `auth.providers.<id>.openBrowserOnLogin`) is required to auto-open a browser during
    a guided **api-key** login; the default just prints the URL, because auto-launching a browser to
    a login-walled key page during a plain key login is surprising (`commands.ts:4948-4953`).
  - **Anthropic OAuth is flagged EXPERIMENTAL** at three separate points — the command usage
    (`index.ts:603`), a stderr note before the attempt (`commands.ts:5005-5012`), and
    `auth status` (`commands.ts:5144-5150`) — each naming the two more reliable paths
    (`-p claude-code`, or `--api-key`).
  - Anthropic uses a **manual code paste** (`code#state`), not a loopback redirect, so there is no
    automatic callback to wait on (`commands.ts:4794-4808`). The pasted code is echoed like any
    other answer because it is a one-time authorization code, not a durable credential. On piped
    stdin it reads one line; immediate EOF yields `""`, which the caller turns into a clean error
    rather than hanging.
  - API keys are captured with **echo disabled** via raw-mode TTY handling, so they never touch
    argv/`ps`/shell history; Ctrl+C exits `130` without ever having buffered the partial value
    (`promptHiddenValue`, `commands.ts:4575-4617`).
  - A successful login resets that provider's circuit (`commands.ts:5016-5021`).
  - **Login errors print the FULL message** — `redactSecret` is a key-masking helper for a secret
    *value*, and applying it to a whole sentence used to mangle every login error down to an
    ellipsis plus four characters (`commands.ts:5040-5048`).
  - With no provider on a TTY, an interactive numbered picker runs (`commands.ts:4870-4886`);
    on a non-TTY it degrades to guidance + the provider list and exits **`0`**, never crashing
    (`commands.ts:4911-4928`).
  - `AuthCommandDeps` (`commands.ts:4739-4758`) is the injectable seam that lets the whole OAuth
    machinery be tested against an in-process mock authorization server — no real browser, no real
    auth server.
- **macOS app:** `AuthController` + commands at `Auth.swift:91-132`
  (`auth status`, `login <p>`, `logout <p>`, `logout --all`, `keys set <ref> --stdin`), UI
  `apps/nexus-mac/Sources/NexusApp/Features/AuthView.swift`. `AuthKind.unknown` keeps an
  unrecognised fifth kind visible rather than hiding the provider (`Auth.swift:18-22`).
  `--device`, `--api-key` and `--open` are **`NOT SURFACED`**.
- **Status:** `UNVERIFIED`

## 62. `nexus logout` and `nexus auth status`

- **What:** Clear stored credentials; report per-provider sign-in state.
- **Surface:** `cmdLogout` `packages/cli/src/commands.ts:5057-5108`; `cmdAuth`
  `packages/cli/src/commands.ts:5115-5152`; rows `authStatusRows` `packages/cli/src/auth.ts`;
  expiry formatting `formatExpiry`.
- **Inputs:** `logout [provider] | --all | -h`; `auth status [-o json]`.
- **Outputs:**
  - `logout` → `logged out of <id>[ (was not signed in)]`, or `logged out of N provider(s)` for
    `--all`. **Always exits `0`.**
  - `auth status -o json` → the row array; text → `[✓ ]`/`[  ]` per provider with method, relative
    expiry, and detail.
- **Expected behaviour:**
  - `logout` distinguishes "was signed in" from "was not" in its message, but the status probe is
    best-effort and a failure still proceeds to clear (`commands.ts:5094-5101`).
  - `logout` with no provider and no `--all` ⇒ exit `2`; an unknown provider ⇒ exit `1`.
  - `auth status` never prints a token; `expiresIn` is a pre-formatted relative string
    (`~5h`/`~42m`), never a raw timestamp.
  - `auth` with any subcommand other than `status` ⇒ exit `2` (`commands.ts:5120-5124`).
  - When nothing is signed in, a stderr nudge to `nexus login` is added but the exit stays `0`.
- **macOS app:** Surfaced (see §61).
- **Status:** `UNVERIFIED`

## 63. `nexus keys set | list | test`

- **What:** Manage raw secrets. The CLI actively steers users to `nexus login` instead.
- **Surface:** `cmdKeys` `packages/cli/src/commands.ts:4637-4729`; value resolution
  `resolveSecretValue` `commands.ts:4626-4635`; hidden prompt `promptHiddenValue`
  `commands.ts:4575-4617`; SecretStore `@nexuscode/config` (`createSecretStore`, `redactSecret`).
- **Inputs:** `set <ref> [value]` / `--value` / `--stdin` / interactive hidden prompt;
  `list`; `test <provider>`.
- **Outputs:**
  - `set` → `saved key for <ref> (<source>) — <masked>` — the value is **always masked**
    (`commands.ts:4672`).
  - `list` → `<ref>: <source|unset>[ (<masked>)]` per ref, plus a stderr tip pointing at
    `nexus login` / `nexus auth status` (`commands.ts:4693-4697`).
  - `test` → `<provider>: ok|FAILED[ — detail]`, or `no health probe (assumed reachable)`;
    exit `0`/`1`.
- **Expected behaviour:**
  - An explicit positional/`--value` always wins so scripting never blocks on a prompt
    (`commands.ts:4631-4632`).
  - `list` always includes `config.defaultProvider` even before it is formally in `providers[]`,
    because the natural first-run flow is `keys set <defaultProvider>` before the provider is
    configured — so the list is never empty and the user can confirm the key landed
    (`commands.ts:4681-4687`).
  - `set` resets the provider circuit for every provider whose id or `apiKeyRef` matches (§15).
  - `test` on an adapter with no `health` probe reports that honestly and exits `0`, rather than
    claiming success (`commands.ts:4712-4715`).
  - Unknown subcommand ⇒ exit `2`.
- **macOS app:** `keys set <ref> --stdin` only (`Auth.swift:132`). `keys list` and `keys test` are
  `NOT SURFACED`.
- **Status:** `UNVERIFIED`

## 64. Config layering and `nexus config get | set | path`

- **What:** A validated, layered configuration cascade.
- **Surface:** `cmdConfig` `packages/cli/src/commands.ts:5156-5200`; loader
  `packages/config/src/loader.ts` (339 lines); schema `packages/config/src/schema.ts` (1209 lines);
  CLI IO `packages/cli/src/config-io.ts` — `readUserConfig`, `writeUserConfig`,
  `validateUserConfig`, `getPath`, `setPath`, `userConfigDir`, `userConfigFile`.
- **Inputs:** `get [key]`, `set <key> <value>`, `path`. Env: `NEXUS_DATA_DIR`,
  `NEXUS_PLUGINS_DIR`, `NEXUS_TRUST_WORKSPACE`, plus per-provider key envs.
- **Outputs:** `get` → pretty-printed JSON of the whole effective config or one dotted path
  (`null` when absent); `set` → `set <key> = <value> → <file>`; `path` → the user config file path.
- **Expected behaviour:**
  - **Validation happens before writing.** `setPath` mutates a copy, then `validateUserConfig`
    checks the whole document against the zod schema; a bad key fails loudly with exit `2` instead of
    bricking every later command that re-parses config (`commands.ts:5186-5192`).
    The same guard is applied by `providers add` (`:4028`), `mcp add` (`:4208`), and
    `budget set` (`enterprise-commands.ts:410-416`).
  - The root schema is `.strict()` (`schema.ts:1198`), so an unknown top-level key is a hard
    validation error, not silently ignored.
  - `writeUserConfig` targets the file the loader actually reads and **refuses rather than writing
    somewhere shadowed** (e.g. when a YAML config shadows what the CLI can write) — callers report
    that as a command failure (`enterprise-commands.ts:393-426`).
  - `get` with no key dumps the fully-defaulted effective config, which is the practical way to see
    every default.
  - Unknown subcommand ⇒ exit `2`.
  - `setPath` writes **string** values; there is no type coercion at this layer beyond what the
    schema then validates.
- **macOS app:** `config get hooks -o json` only, read-only (`IntegrationsView.swift:255`).
  There is **no** `config set` anywhere in the app.
- **Status:** `UNVERIFIED`

## 65. `nexus doctor`

- **What:** One command that proves every subsystem is wired, offline, and exits `0` on a fresh machine.
- **Surface:** `cmdDoctor` `packages/cli/src/commands.ts:5204-5485`.
- **Outputs (the full report, in order):** config dir; history db + enabled; transfer; circuit
  (+ each blocked target); **providers** (`[--]` unavailable / `[key]` needs key / `[ok]`/`[!!]`
  health); keys; **auth** (token store + per-provider); **subsystems** — context lanes, memory path,
  prompt engine, builtin tools, agent roles, tasks store + progress, terminal (history size, path,
  PTY mode), rag (enabled/embedder/chunks), repomap (effective budget), cache (per-namespace
  counts + affinity), perf (pool sizes, lazy cells built/total, index background, watch debounce),
  observ (exporter + span count + file), git (version or not found), lsp (servers detected + tool
  names), toolgrp (per-group enabled + integration detection); **mcp servers**;
  **extensibility** — sdk, server, hooks (count + events), webhooks, plugins (+ each loaded/failed);
  **enterprise** status lines and, when on, the audit-chain verification.
- **Expected behaviour:**
  - Uses `buildAuthedRuntime` so the providers section **agrees with** the auth section — an
    unauthed runtime would report a provider the user is signed into as entirely absent, which is
    the exact failure this command must never produce (`commands.ts:5206-5212`).
  - A cloud provider with no credential is `[key]`, **not** a failure — `doctor` still exits `0` on
    a fresh, unconfigured machine (`commands.ts:5252-5257`).
  - Everything is feature-detection or offline introspection: no LSP server is spawned
    (`commands.ts:5389-5391`), tool-group integrations are resolved not imported, and the `git`
    probe is a reaped `git --version` with a 3 s timeout that degrades to `git not found` and is
    never fatal (`commands.ts:5375-5384`).
  - Exit `1` only when the `mock` provider is unhealthy (pipeline broken) or any healthy-checked
    provider failed its probe (`commands.ts:5479-5484`).
  - An unreadable RAG index is reported as `index unreadable: <msg>` rather than crashing
    (`commands.ts:5322-5331`).
- **macOS app:** `NOT SURFACED`. The app has no health view, so a broken subsystem is invisible
  until a run fails. See **GAPS G6**.
- **Status:** `UNVERIFIED`

## 66. `nexus tui` and the terminal UI

- **What:** The rich Ink terminal UI over the same engine.
- **Surface:** `cmdTui` `packages/cli/src/commands.ts:3636-3891`; package `packages/tui/`
  (`bridge/runTui.ts`, `store/viewState.ts`, `chrome/`, `panels/`, `layout/`, `theme/`, `caps/`,
  `render/`, `interrupt/`); capability gate `detectCapabilities` + `canMountTui`.
- **Inputs:** `--theme <name>`, `--preset <id>`, `-p`, `-m`, `-s`.
- **Presets:** `conversation` (**the default**), `chat`, `agent`, `compare`, `dashboard`
  (`parsePreset`, `commands.ts:3617-3623`).
- **Slash commands** (`packages/tui/src/chrome/commands.ts`): `/model:123`, `/theme:165`,
  `/provider:181`, `/agent:196` (modes `CHAT` / `AGENT` / `AUTOPILOT`), `/effort:215`
  (`off|low|medium|high`), `/tools:237`, `/mcp:248`, `/context:259`, `/cost:271`, `/trace:284`,
  `/help:299`, `/clear:305`, `/new:310`, `/quit:315`.
- **Expected behaviour:**
  - **The TTY guard runs first** — before provider resolution — so an offline default provider can
    never mask the graceful degradation path. On a non-TTY / `TERM=dumb` / too-narrow terminal it
    prints one linear-mode fallback line and exits `0`; it never crashes
    (`commands.ts:3637-3646`, `:3881`).
  - Mode → gate mapping (`commands.ts:3814-3825`): `AUTOPILOT` → `workspace-write` + approver;
    `CHAT`/`AGENT` → `read-only` + approver (so MCP `network` tools run while `write`/`exec` stay
    hard-denied). Plain `CHAT` **also** runs the agentic loop whenever any tool is registered, which
    is what lets the default conversation actually call MCP tools instead of saying it has none
    (`commands.ts:3751-3764`, `:3814-3815`).
  - `maxTurns: 40` in the TUI (`commands.ts:3825`), against `8` headless — a generous budget so the
    model can do real agentic work before it must answer.
  - A `cli-subprocess` provider is **never** routed through `dispatchAgent`
    (`commands.ts:3802-3813`).
  - `/model` lists only the **active provider's** models, discovered live via `listModelsFor`, and
    every row shown is recorded into the shared `ModelCatalog` so the switch preflight accepts
    exactly what it offered — a model you can see can never be rejected as "not advertised"
    (`commands.ts:3669-3672`, `:3854-3869`).
  - Discovered models are also folded back into the registry so core's `assessSwitchTarget` agrees
    they exist, without which it would call the target incompatible and skip the context-window
    compaction that makes a switch safe (`commands.ts:3858-3867`).
  - `/mcp` is fed the live server reports, so it no longer claims "no MCP servers configured" while
    servers are connected (`commands.ts:3842-3849`).
  - The TUI stays a **pure renderer**: it signals a switch, but the engine dispatch stays in
    `cmdTui` (`commands.ts:3695-3699`).
  - Themes: `nexus-noir`, `paper-nexus`, `solar-flare`, `glacier`, `contrast-max`, `synthwave-grid`,
    `neon`, `midnight`, `vampire`, `retro-amber`, `pastel`, `frost`, `matrix`, `vivid`, `rose`,
    `forest` (`index.ts:479`); package `packages/theme/`.
- **macOS app:** Not applicable — the app is a separate client of the same CLI, not a TUI wrapper.
  Its themes are a separate Swift set (`AppThemes.swift`, `Generated/Themes.swift`).
- **Status:** `UNVERIFIED`

## 67. `nexus serve` — the REST + SSE daemon

- **What:** Expose the harness over HTTP for a non-CLI client.
- **Surface:** `cmdServe` `packages/cli/src/serve.ts:38-119`; server
  `packages/server/src/server.ts` (568 lines); embeds one `@nexuscode/sdk` `Nexus`.
- **Inputs:** `--port <n>` (default ephemeral; an invalid value silently becomes `0`,
  `serve.ts:32-36`), `--host <addr>` (default `127.0.0.1`).
- **Routes** (`packages/server/src/server.ts`): `GET /v1/health` (**public**, `:252`),
  `GET /v1/providers` (`:292`), `GET /v1/tools` (`:296`), `GET /v1/config` (**redacted**, `:300`),
  `GET /v1/sessions` (`:304`), `GET /v1/sessions/:id` (`:309`), `GET /v1/runs` (`:318`),
  `POST /v1/runs` (`:322`), `GET /v1/runs/:id/events` (SSE, `:327`), `GET /v1/runs/:id` (`:332`),
  `OPTIONS` (`:246`).
- **Outputs:** startup banner with the URL, the public health route, **the bearer token**, and a
  ready-to-paste `curl` example (`serve.ts:95-101`).
- **Expected behaviour:**
  - **Bearer-token auth on every data route**; loopback bind by default; `GET /v1/config` is
    redacted; the PermissionGate governs agent/tool execution (`serve.ts:10-13`).
  - The token is printed once on startup because it is the operator's own token on their own machine.
  - A build failure or a bind failure both close cleanly and exit `1`, closing the transfer runtime
    (`serve.ts:78-91`).
  - Stays up until SIGINT/SIGTERM, then shuts the server and transfer down idempotently
    (`serve.ts:103-118`).
  - Enterprise mode maps each bearer token → principal → role and authorizes every data request
    (403 on deny); off ⇒ single-token behaviour unchanged (`serve.ts:43-47`, `:75`).
  - The daemon inherits the same continuity options (transfer factory, handoff builder, action guard,
    provider circuit, partial recovery, switching) as the CLI (`serve.ts:59-74`).
- **macOS app:** **`NOT SURFACED`.** The app spawns CLI processes directly and never uses the daemon.
- **Status:** `UNVERIFIED`

## 68. The embeddable SDK

- **What:** `@nexuscode/sdk` — the same engine as a library.
- **Surface:** `packages/sdk/src/nexus.ts` (789 lines) — `Nexus:294`, `NexusSession:263`,
  `createNexus:787`.
- **API:** `ask:540`, `compare:556`, `race:565`, `consensus:583`, `chain:593`, `agent:636`,
  `registerProvider:668`, `registerTool:677`, `listProviders:683`, `listTools:709`,
  `openSession:733`, `resumeSession:740`, `dispose:754`; session-scoped `ask:274` / `agent:278`.
- **Expected behaviour:**
  - `NexusOptions.loadFromDisk` makes the SDK read the same on-disk config the CLI does, which is how
    `nexus serve` gets configured providers (`serve.ts:60-61`).
  - `Backend` accepts either `"provider"` or `{provider, model?}` (`sdk/src/nexus.ts:72`).
  - `resumeSession(id)` is the SDK equivalent of `--resume`.
  - Every run returns a `NexusRun` handle over the same `UiEvent`/`StreamChunk` stream.
- **macOS app:** `NOT SURFACED` (Swift cannot embed it; the app uses the CLI).
- **Status:** `UNVERIFIED`

## 69. Enterprise — RBAC, policy, budgets, gateway, audit, usage

- **What:** Off-by-default, fail-closed governance layer.
- **Surface:** `packages/enterprise/src/` (`rbac/`, `policy/`, `cost/`, `gateway/`, `audit/`,
  `analytics/`, `wire/`); CLI commands `packages/cli/src/enterprise-commands.ts`; CLI glue
  `packages/cli/src/enterprise.ts` (`buildEnterprise`, `resolvePrincipal`, `costPrincipalFor`,
  `enterpriseToolInterceptor`, `estimateRunUsd`, `recordRunSpend`, `enterpriseStatus`,
  `composeInterceptors`, `toServerEnterprise`).
- **Config:** `enterprise.*` `schema.ts:967-1002` — `mode` (`off`|`on`, default **`off`**),
  `defaultRole` (`default`), `roles[]`, `principals[]` (id, roles, optional bearer `token`),
  `policies[]` (deny-overrides rules with `effect`, `subjects`, `actions`, `resources`,
  `conditions{maxCostUsd, timeWindow, dataClass}`), `budgets[]`
  (`{id, scope: principal|role|org, key, limitUsd, window: run|day|month, warnThreshold?,
  onExceed: deny|downgrade, downgradeTo?}`), `gateways{global, byProvider}`, `audit.file`,
  `defaultPrincipal`.
- **Built-in roles:** `admin`, `developer`, `viewer`, `default`
  (`enterprise-commands.ts:59`).
- **The five commands:**
  | Command | Subcommands | Exit |
  | --- | --- | --- |
  | `nexus rbac` (`:52`) | `list`\|`roles`, `check --principal --action --resource` | `1` on DENY |
  | `nexus policy` (`:120`) | `list`, `test --principal --action --resource [--cost]` | `1` on DENY |
  | `nexus usage` (`:198`) | (flags only) `--window day\|week\|month`, `--provider`, `--model`, `--from`, `--to`, `--format csv\|json` | `1` on forbidden |
  | `nexus audit` (`:289`) | (flags) `--actor`, `--action`, `--decision`, `--from`, `--to`, `--limit` (50), `--verify` | `1` on tamper/unverifiable |
  | `nexus budget` (`:346`) | `show`\|`list`, `set --id --scope --key --limit --window [--on-exceed] [--downgrade-to] [--warn-threshold]` | `2`/`1` on bad input/write |
- **Expected behaviour:**
  - **Fail-closed and off by default.** `mode: "off"` leaves single-user behaviour entirely
    unchanged — no authorization check, no budget gate, no audit (`schema.ts:889-895`).
  - **`nexus usage` is deliberately ORG-WIDE.** The run history has no principal column, so
    per-person figures cannot be derived and are never invented: every row is recorded under
    `UNATTRIBUTED_PRINCIPAL` and every output carries `UNATTRIBUTED_NOTE`
    (`enterprise-commands.ts:187-196`, `:234-240`, `:262-274`). Because the view is unavoidably
    org-wide, enterprise mode gates it on `manage` over `command:usage` — held by `admin`, and
    deliberately not by `developer`/`viewer`/`default`. The gate is checked **before** the history
    is read, so no figure reaches any output branch on the denied path
    (`enterprise-commands.ts:211-232`).
  - The code states plainly that CLI identity is **self-asserted** (`--principal` /
    `$NEXUS_PRINCIPAL` are unauthenticated), so this is role hygiene, **not** an access-control
    boundary against a local user who can claim another id (`enterprise-commands.ts:212-217`).
  - Machine consumers get JSON on the denied path too, never prose where JSON is expected
    (`enterprise-commands.ts:224-229`).
  - **Audit log:** append-only, redacted, hash-chained NDJSON. `--verify` recomputes the chain from
    disk. An unreadable chain is reported as `audit chain UNVERIFIABLE — <msg>` and exits `1`
    rather than crashing the reporter — the tool an operator reaches for when the log is suspect
    must not itself fall over (`enterprise-commands.ts:293-313`).
  - **Budgets** are enforced pre-dispatch (§21): `deny` aborts before any provider call;
    `downgrade` re-points provider/model, and a `downgrade` with **no target is defensively treated
    as a deny** so spend can never exceed the limit (`commands.ts:1154-1170`); `warn` prints and
    proceeds. Spend accrues post-run into the persisted `FileBudgetStore` that `budget show` reads,
    so display and enforcement share one accrual (`enterprise-commands.ts:353-355`).
  - **RBAC on tools** runs before execution: `actionForToolPermission(tool.permission)` maps the
    tool's class to a verb, and a deny aborts (`commands.ts:2075-2090`).
  - The **gateway** applies at registry construction, so a private model endpoint is in force before
    any adapter is built (`commands.ts:1018-1022`).
  - `budget set` refuses when the effective config file cannot be written and reports it as a
    failure rather than printing a success the config would not reflect
    (`enterprise-commands.ts:393-426`).
- **macOS app:** **`NOT SURFACED`** — none of the five commands is invoked anywhere in
  `apps/nexus-mac/Sources/`.
- **Status:** `UNVERIFIED`

## 70. Cancellation, signals, and cleanup

- **What:** Ctrl+C must cancel work, not corrupt state.
- **Surface:** `CancelScope` `packages/core/src/cancel.ts`; per-command SIGINT handlers.
- **Expected behaviour:**
  - Every long-running command registers `process.once("SIGINT", …)` that calls
    `turn.scope.cancel("user")` and removes the listener in `finally` —
    `runOrchestration` (`commands.ts:380-384`, `:424`), `cmdAgent` (`:1127-1130`, `:1250`),
    `runAgentOoda` (`:1444-1447`, `:1502`), `runMultiLane` (`:2525-2528`, `:2549`),
    `cmdRoute` (`:2912-2915`, `:2975`), `tools run` (`:2126-2128`, `:2154`).
  - `chat --persistent` handles **both** SIGINT and SIGTERM, cancelling the in-flight turn and
    closing readline so the `finally` disposes exactly as a clean EOF would
    (`commands.ts:3519-3524`, `:3548-3553`).
  - Cancelling a turn denies its pending approvals immediately with cause `cancelled`
    (`commands.ts:3237-3238`).
  - `index --watch` stops on SIGINT/SIGTERM and closes the watcher (`commands.ts:5656-5663`).
  - `serve` shuts down idempotently on either signal (`serve.ts:104-117`).
  - A cancelled lane settles as `status: "cancelled"` and renders as such — never as an error
    (`commands.ts:605-611`).
  - Cleanup in `finally` consistently covers: hooks closed, observability flushed, session disposed,
    engine disposed, MCP closed, process manager killed, transfer closed, store closed.
- **macOS app:** `ConversationController.cancel()` cancels the Task (`AppState.swift:432-436`);
  `PersistentSession.stop()` closes stdin for a graceful EOF rather than terminating
  (`PersistentSession.swift:84-98`); `NexusClient.stream`'s `onTermination` terminates the child on
  stream cancellation (`NexusClient.swift:204-208`).
  **Note:** `cancel()` cancels the Swift Task but does **not** stop the live backend process — only
  `endSession()` and `stopLiveSession()` do. See **GAPS G13**.
- **Status:** `UNVERIFIED`

## 71. Secret redaction and safety invariants

- **What:** Cross-cutting rules that every surface is expected to hold.
- **Surface:** `redactSecret` (`@nexuscode/config`), `redactArgs`
  (`packages/tools/src/redact.ts`), `packages/auth/src/redact.ts`,
  `packages/observability/src/redact.ts`, `packages/tools/src/ssrf.ts`.
- **The invariants, as stated in code:**
  - Secrets never touch stdout (`commands.ts:1-5`).
  - Tokens are never printed by any auth command (`commands.ts:4819`, `:4889-4893`).
  - Tool arguments are redacted before reaching an approval prompt or an audit log
    (`permission.ts:36-38`, `:153`).
  - History prompts are secret-redacted before persistence and encrypted at rest by default
    (`schema.ts:473-483`).
  - The audit log is redacted and hash-chained.
  - Webhook bodies are redacted and SSRF-guarded; private targets require `allowPrivate`.
  - `web_fetch`/`web_crawl` are SSRF-guarded (`packages/tools/src/ssrf.ts`,
    `tools.web.ssrfAllowlist`).
  - `resolveInWorkspace` prevents workspace escape for file tools.
  - `redactSecret` is for a secret **value** (`<prefix>…<last4>`), never for a whole sentence —
    misapplying it mangled login errors (`commands.ts:5040-5048`).
  - Exported session files are chmod `0600` best-effort (`wave6.ts:261-266`).
  - Plugin discovery from the cwd requires explicit workspace trust (§37).
- **macOS app:** `PendingApproval` renders the already-redacted `input` verbatim
  (`Approvals.swift:32`). `ProviderAuth` promises never to carry a token
  (`Auth.swift:29-32`).
- **Status:** `UNVERIFIED`

<!-- SECTION-BREAK -->
