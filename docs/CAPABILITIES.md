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

<!-- SECTION-BREAK -->
