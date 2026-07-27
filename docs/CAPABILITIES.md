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

<!-- SECTION-BREAK -->
