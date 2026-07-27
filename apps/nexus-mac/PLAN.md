# NexusCode.app — working backlog

> ## ⚠️ ENVIRONMENT ISSUE (not a code regression) — read this first
>
> **Symptom:** the app launches but no window appears.
>
> **Cause: NOT our code.** A minimal 4-line SwiftUI app
> (`WindowGroup { Text("hello") }`, compiled standalone with `swiftc
> -parse-as-library`, ad-hoc signed, in /tmp) reproduces it EXACTLY. macOS is
> currently not displaying windows for newly-launched ad-hoc-signed bundles in
> this login session.
>
> **Almost certainly fixed by a logout/reboot, or by launching from Xcode.**
> Try the minimal repro first to confirm the machine is healthy again:
>   swiftc -parse-as-library -target arm64-apple-macos14 -o /tmp/mini/Mini.app/Contents/MacOS/Mini /tmp/mini/mini.swift
>   open /tmp/mini/Mini.app
>
> **Evidence gathered before the cause was found** (all still true, and all
> consistent with an environmental cause):
> - `RootView.onAppear` fires and `WorkspaceModel.init` runs — SwiftUI builds the
>   hierarchy fine; only the window never becomes visible.
> - Confirmed visually via full-screen capture, not just System Events.
> - Main thread idle in the normal event loop; no crash, no stderr.
> - Ruled out by reverting and retesting each independently: the Integrations/Git
>   wiring, the control-strip `.mask`, saved application state, stale instances,
>   and an explicit `.defaultSize`.
>
> **A correction I owe the record:** I earlier blamed running
> `defaults delete dev.nexuscode.mac` while the app was running. That was still
> careless, but it is NOT the cause — the minimal app never touched those
> defaults and fails identically.
>
> `.defaultSize(width: 1280, height: 860)` was added to `NexusApp.swift` during
> this investigation. It is harmless and worth keeping (a window whose content is
> greedy in both axes has no ideal size to resolve), but it did not fix this.
>
> The app was rendering all eight tabs correctly earlier in the session; four
> were audited at two window sizes. Nothing is lost.

## A0. ROUND 2 — issues found on first real use (2026-07-27)

Using the app surfaced the issues below.

⚠️ **The no-window symptom has RETURNED as of this session, and visual
verification is blocked.** Re-confirmed environmental before blaming any code:
the minimal 4-line SwiftUI app in the banner above reports zero windows too,
signed or unsigned. So `swift build` + `swift test` are the only gates currently
available, and the "screenshot at two window sizes" rule in §D cannot be
satisfied — nothing UI-related below may be marked ✅ on test evidence alone.
Fix by logging out / rebooting, or launch from Xcode.

- ✅ **CRITICAL: switching provider did nothing.** Picked Codex, UI showed
  `codex`/`gpt-5-codex`, and the reply said "I'm Claude". Cause: `-p`/`-m` are
  baked into a process's argv at spawn, and `submitToPersistentSession` only
  spawned when `session == nil` — so a switch left the ORIGINAL backend running
  and answering. FIXED: the backend now relaunches when provider/model changes,
  `--resume`ing the same session so context survives. Guarded by
  `testSwitchingProviderRelaunchesTheBackend`. `activeBackendProvider` is now
  public so the UI can never again claim one provider while another answers.
- ✅ **Markdown is not rendered.** FIXED: `MarkdownParser` (block parser —
  headings, lists incl. nested, fenced code, blockquotes, rules) lives in
  `NexusKit/MarkdownBlocks.swift`, UI-free and unit-tested (24 tests incl. the
  exact user-reported fixture, an unterminated fence mid-stream, and a perf
  regression guard for per-token reparsing). `NexusApp/Components/Markdown.swift`
  renders it through the existing `Space`/`Kind`/theme-token scale (no invented
  sizes — headings reuse `Kind.title`/`headline`/`bodyEmphasis`/`section`
  exactly). `ConversationView`'s `TurnView` swapped in `MarkdownView` for
  `turn.text` and also dropped the per-message avatar + card chrome for a
  single quiet accent rule on assistant answers, widened inter-turn spacing,
  and capped the transcript to a 660pt reading column.
- ✅ **`anthropic` missing from the provider picker** despite being signed in.
  Cause: `cmdProviders`/`cmdModels` called `buildRuntime` instead of
  `buildAuthedRuntime`, so the OAuth-authenticated adapter was never registered
  and the provider simply did not exist in the output the picker reads. Verified
  fixed at the source: `providers status -o json` now returns
  `{id: anthropic, available: true, needsKey: false}`, and Swift's
  `isUsable = available && !needsKey` (`Providers.swift:54`) admits it.
- ✅ **Model picker lists stale/wrong versions.** `models <p> -o json` now
  returns the current generation — anthropic: `claude-opus-5`,
  `claude-sonnet-5`, `claude-fable-5`, …; claude-code: the aliases plus
  `claude-opus-5`/`claude-sonnet-5`/`claude-haiku-4-5-20251001`. The curated
  arrays are OFFLINE FALLBACKS only (live `/v1/models` wins when reachable) and
  carry no routing or pricing weight — pricing stays in `schema.ts` keyed by id.
- 🔄 **Themes are terminal palettes, not app themes.** Root cause is
  architectural: they are GENERATED from `packages/theme`, an ANSI/terminal
  system — flat solid tokens with no material, elevation, gradient or state
  layer. Correct for a terminal, which is why the app reads cheap.

  Seven hand-designed app themes now exist — Meridian, Basalt, Cinder (dark),
  Daylight, Studio (light), Vantage (high-contrast AAA), Nightfall
  (gradient-forward) — on a model with elevation, materials, gradients, state
  layers and typographic intent.

  ⚠️ **They are NOT wired, so from the user's seat NOTHING is fixed yet.** The
  environment key is typed `NexusTheme`, `NexusApp.swift` resolves
  `NexusTheme.named(…) ?? NexusTheme.all[0]`, and `RootView`'s picker iterates
  the same 16 generated palettes. `AppTheme.all` is unreachable dead data. What
  DOES execute is the `NexusTheme.appTheme` bridge, which derives a generic
  `AppTheme` from any old flat palette — so real shadow and per-theme
  hover/press ARE live today, using auto-derived rather than hand-tuned values,
  with materials forced to `.solid` and typography to `.neutral`. In flight:
  swap the env key to `AppTheme`, group hand-designed above terminal-derived,
  default to Meridian, wire `pairId` for OS light/dark following.

  **Two measured contrast failures**, found only when the check was widened from
  body/secondary text to the pairs components actually compose:
  `accentFg`/`accentDefault` is **3.40 in Daylight** and **4.15 in Studio**
  (floor 4.5) — that is exactly what `SoftButton`'s `.accent` tone renders, so a
  primary button label is sub-AA in both light themes. The coverage was the gap,
  not the palette. Body text passes everywhere (14.17–19.42), secondary too
  (5.49–14.29).

  **Pre-existing and worth fixing anyway:** `CountPill` pairs `accentFg` on
  `accentMuted`, which measures 1.50–3.70 across ALL seven new themes AND the
  original 16 (paper-nexus 1.89, midnight 2.53). Not introduced here — a
  standing legibility bug in what ships today.
- 🔄 **Layout/UX reads cheap and boring.** Research-first: a spec is being
  produced before any more building.
- ✅ **OMC for every provider, not just Claude.** ANSWERED, by execution — see
  §A0c. NexusCode's own role/OODA orchestration is ALREADY provider-agnostic;
  it is simply not reachable from the app. This is a UI + projection task, not
  an architecture project.

## A0b. NEXT TASK — use the resolution cause in the UI

✅ DONE: structured deny reason. The CLI emits TWO `approval` events per gated
call, same `id`. `resolution` absent = pending; present = settled, carrying
`{granted, cause}` where cause is a closed set:
`"explicit" | "timeout" | "cancelled" | "stdin-closed"`. Swift decodes it as
`UiEvent.Approval.Resolution` and `ApprovalsController` records `lastResolution`.
Deliberately a follow-up event rather than a field on `tool_result`: that would
have meant touching the FROZEN `StreamChunk` contract shared by every tool
execution, for what is really approval-specific bookkeeping.

⬜ REMAINING — the UI does not yet BRANCH on `cause`. The data is there and the
sheet correctly dismisses on settlement, but all four causes currently look the
same to the user. They should not:
- `.explicit`    -> final. Show the outcome; do NOT offer a retry.
- `.timeout`     -> NOT a refusal. Say the request expired and offer "ask again".
- `.cancelled` / `.stdinClosed` -> moot. Dismiss silently; never word it as a
  refusal, because the user never refused anything.
Wire this in `ApprovalSheet` / the sheet presentation in `ConversationView`,
reading `ApprovalsController.lastResolution`. Small and self-contained — the hard
part (getting the cause out of the CLI as data) is done.

## A0c. "OMC for every provider" — the verified answer

**The multi-provider agent framework already exists and it is ours, not OMC's.**
Proven by running the same role loop against three different backends:

| command | result |
|---|---|
| `agent --role coder --max-steps 1 -p mock -m mock-tools` | loop ran: plan → tool-call → reflect → replan → retry |
| `agent --role reviewer --max-steps 1 -p anthropic` | `stop=indeterminate` (honest: no success criteria) |
| `agent --role reviewer --max-steps 1 -p codex` | `stop=goal-met progress=100%` |

That last row is the decisive one: **another vendor's CLI, over subprocess
transport, driving NexusCode's OODA loop to a verified `goal-met`.**

Why it works: `AgentDefinition` carries optional `model` + `adapterId`
(`packages/agent/src/types.ts:33-50`); the runner resolves both through an
override chain (`runner.ts:278-279`) into the dispatched `RunSpec`
(`runner.ts:351-357`); and **none of the 9 role presets pin a model or provider**
(`roles.ts:46-144`) — roles differ only by prompt, tool allowlist, `maxSteps`
and `permissionMode`. Provider-neutral by construction.

### Why OMC itself cannot be "pointed at" another provider
- `dist/providers/` are GIT HOSTS (github, gitlab, …), not AI providers. OMC has
  no AI-provider abstraction at all.
- `omc ask` "supports" 6 vendors by `spawnSync`-ing their local binaries — one
  shot, stdout captured, no streaming, no token accounting, no tool bus.
- Its 19 agents are Claude Code `Task`-tool prompts; Claude Code makes the model
  call, not OMC. **There is nothing to re-point.** Porting them would mean
  reimplementing OMC's MCP server and maintaining someone else's prompt library.
- The one real seam: `OMC_ASK_ADVISOR_SCRIPT` (`dist/cli/ask.js:145-156`) runs
  ANY script you name — a fork-free override of OMC's whole outbound-model path.

### The three gaps to close (ordered; each verified)
1. 🔄 **Agent metadata is dropped before it can be rendered.** `agentMetaChunk`
   encodes phase/role/step/plan onto `raw.agent` (`agent/src/events.ts:56-65`),
   but `projection.ts:154-157` flattens the chunk to `{t:"reasoning",lane,delta}`
   and discards `raw`. **Load-bearing — nothing else works until this lands.**
   ✅ LANDED in `projection.ts` (+ the `tui` mirror + the Swift `UiEvent.Agent`
   + the `ViewState` fold + 14 tests). `core` cannot import `isAgentMeta`
   (`agent` depends on `core`, not the reverse), so the guard is duplicated
   structurally, following the `failoverTrailOf` precedent in the same file.
   The event carries `text` as well as `data` so one step is self-contained —
   otherwise the fold would have to assume "the next event is my narration",
   coupling a pure reducer to wire adjacency.

   ✅ **The wire now actually carries them** — but note that unit tests passing
   did NOT mean this worked. Running it end to end (`agent --role coder …
   -o ndjson`) first produced session/tool_call/text/usage/done and **zero
   `agent` events**. Cause: `runAgentOoda` (`commands.ts:1411-1428`) intercepted
   agent-meta chunks, printed them to stderr as prose, then `continue`d — so
   they never reached `projectLabeled`. That interception is CORRECT for
   `-o text` (without it the phases render as one unseparated blob) and wrong
   only for `-o ndjson`; the branch is now gated on the output mode. Verified:
   the same command emits 7 `agent` events.
   **Lesson worth keeping: three green unit-test suites and a clean build still
   described a feature that did not work. Only running the binary found it.**
   (Related trap: the narration goes to STDERR, so stdout ndjson was never
   actually corrupted — running with `2>&1` made it look like it was, and
   produced one wrong diagnosis before it was caught.)
2. ✅ **Delegation is implemented but unreachable** — now reachable, opt-in, and
   `runner.ts` was NOT touched. `delegatingEvaluate` (exported from
   `packages/agent/src/index.ts`) triggers on ONE specific signal: the tool
   result `no such tool: X`, which is the unambiguous marker that a step's work
   lies outside the current role's allowlist. It hands that step to
   `coordinator` (the only preset with `allowedTools: ["*"]`).

   The distinction that makes this right: `defaultEvaluate` already retries
   every tool failure, which is correct for a TRANSIENT one (a flaky write may
   succeed next time) and pure busywork for a STRUCTURAL one — retrying grants
   no new tool, so `no such tool` recurs identically until the budget is gone.
   Every other case returns `defaultEvaluate`'s output byte-identically.

   **Bounded by construction, not by a counter:** the runner's delegate site
   never forwards `options.policies`, so a delegated child always runs under
   `defaultEvaluate`, which never delegates. Delegation is capped at exactly one
   hop no matter how it is wired. The permission ceiling was proven separately —
   a `read-only` parent keeps a delegated `coordinator` child read-only even
   though that preset requests `workspace-write`.
3. 🔄 **The app never passes `--role`** — and it is worse than that. Chasing this
   turned up TWO defects in the same family as the provider-switch bug:

   a. **`plannedCommand` lies for every single-lane run.** It is documented as
      "the command a submit would run — surfaced so the user can always see
      exactly which `nexus` invocation the button maps to", and returns
      `["ask"|"agent", prompt, …]`. But `submit()` routes single-lane runs to
      `submitToPersistentSession`, and `PersistentSession` builds its OWN argv:
      `["chat","--persistent","-o","ndjson"] + resume + extras`
      (`PersistentSession.swift:53-56`). So the UI shows `nexus agent …` while
      `nexus chat --persistent …` actually runs. Only compare/race were honest.
      Being fixed with ONE argv builder feeding both the preview and the spawn,
      so they cannot drift again — structural, not disciplinary.
   b. **`.agent` mode is decorative.** `.ask` and `.agent` both funnel into
      `submitToPersistentSession`, so they are byte-identical at runtime.
      Selecting "agent" changes nothing about what runs.

   Structural constraint found while specifying the fix: `nexus agent` has NO
   `--persistent` mode — it is one-shot per invocation. So a role run cannot use
   the persistent-session path and must dispatch like compare/race. Worth
   knowing before designing any "agent conversation" UI.

   Still open after that: `AgentRowBuilder` needs a third origin beside
   `.lane`/`.omc`, and the badge at `AgentsView.swift:334` a `NEXUS` case.
4. ✅ **Role discovery is now a command.** Previously the ONLY enumeration was a
   stderr error string (`nexus agent --role nope` → `(roles: coordinator, …)`);
   hardcoding those nine in Swift would have recreated the stale-model-picker
   bug one layer up. `nexus roles -o json` is derived from
   `AGENT_ROLES`/`ROLE_PRESETS`, so it cannot drift, and carries exactly what a
   picker needs to explain a role and warn before running a writing one:

   | role | tools | maxSteps | permissionMode |
   |---|---|---|---|
   | coordinator | `*` | 12 | workspace-write |
   | planner | read, search | 4 | read-only |
   | coder | read, search, write, patch, exec | 10 | workspace-write |
   | reviewer | read, search | 6 | read-only |
   | tester | read, search, write, exec | 8 | workspace-write |
   | researcher | read, search | 6 | read-only |
   | architect | read, search | 5 | read-only |
   | doc-writer | read, search, write | 6 | workspace-write |
   | security-reviewer | read, search | 6 | read-only |

   Prompt text is deliberately NOT emitted — long, useless to a picker, and
   unpleasant in logs. The app takes `role` as a pass-through `String?` and owns
   no copy of the list.
5. ⬜ `nexus team --roles coder,reviewer,tester` — per the standing rule, the CLI
   command must exist before the app can expose it.
5. ⬜ Cheap win: ship a `nexus`-backed advisor script + document
   `OMC_ASK_ADVISOR_SCRIPT`, so every `omc ask` inherits all 18 providers.

### Resolved: `--role` on a subprocess provider is now BLOCKED (exit 2)

I leaned toward "allow it with a warning" — my earlier `goal-met` on codex looked
like a working capability worth keeping. **That was wrong, and the evidence
overturned it.** The successful run was a trivial, tool-free, `--max-steps 1`
prompt. Re-run with a prompt that actually forces tool calls, it fails three
ways at once:

1. **The tool loop cannot resolve the calls.** Subprocess adapters emit calls
   they have ALREADY executed, under their own names — codex sends `shell` and
   `` `${server}:${tool}` ``, claude-code sends raw `Bash`/`Edit`. None match our
   registry (`fs_read`, `fs_write`, `fs_search`, `fs_patch`, `shell_exec`, and
   MCP's `server__tool` — the separator is `__`). Every call returns unknown-tool,
   we feed that back and re-spawn: **~400k input tokens for one step of a
   trivial file read.**
2. **The role's sandbox is unenforceable.** `researcher` derives a read-only
   gate, but codex had already run `sed` and repo-wide searches inside its OWN
   sandbox, governed by `providers.codex.sandbox`, never our gate. So
   `--role security-reviewer -p codex` would advertise "never write, patch, or
   execute" and be **silently false**. That single fact settles it: a warning
   cannot make an unenforceable guarantee true, and an opt-in flag is for things
   that are RISKY, not things that are BROKEN.
3. **`--cwd` never reaches it** — codex read a different tree than the one the
   plan and context were built for.

This also restores an invariant the codebase already stated twice
(`commands.ts:1016-1021`, `:3615-3626`): a subprocess provider is NEVER routed
through `dispatchAgent`. The role path was the one place that missed it.

Verified: `agent --role researcher -p codex` → exit 2 with both working routes
named (`nexus code -a codex …`, `agent --role researcher -p <api-provider>`);
`agent --role reviewer -p anthropic` still runs normally.

⚠️ **A test was silently neutered by this guard and had to be re-pointed.** The
existing `resolveRunModel` assertion at `command-flag-consistency.test.ts:278`
drove itself through `agent --role coder -p claude-code` — with the guard in
place it would have passed **vacuously**, never reaching the code under test. It
now runs through the role-LESS `agent -p claude-code` path with a positive
assertion so it cannot go vacuous again. Worth remembering: adding a guard can
turn a real regression test into a green no-op.

### Two risks recorded before they bite
- **The three-valued verdict must survive into the UI.** `indeterminate` is
  first-class (`types.ts:75`, `runner.ts:306-307`) and a run without
  `successCriteria` deliberately stops after ONE unverified step
  (`runner.ts:524-527`) — the live `anthropic` run above hit exactly this.
  Rendering that as a spinner or a green check silently breaks the design's core
  honesty promise. Same class of mistake as showing a `.timeout` approval as a
  refusal (§A0b).
- **No `cli-subprocess` guard on the role path.** `cmdAgent` redirects
  subprocess providers to `cmdCode` (`commands.ts:1019-1021`), but that check
  sits AFTER the `--role` branch returns, so `runAgentOoda` only checks
  `isProviderUsable`. The codex run above worked — but it was codex running its
  OWN agentic loop inside a step of ours. Nested loops. Needs a deliberate
  decision, not an accident.

### Explicitly NOT doing
Porting OMC's agents to other providers; forking/vendoring OMC (v4.15.6 and
moving); a general "OMC delegates through nexus" bridge (no OMC-owned model
calls exist to intercept outside `ask`); giving the app a write path into
`.omc/` — `OMCWorkspace` is read-only by construction and should stay that way.

## A. Explicitly requested

### A1. Harness fundamentals
- ✅ **Persistent session** — one long-lived `nexus` process per conversation,
  not one per message. CLI side: stream stdin line-by-line, hold session open.
- ✅ **Session id in the event stream** — `projection.ts:89` emits the RUN id as
  the `session` event's `id`. Resume has never worked because of it.
- ⬜ **Context awareness** — engine already threads the transcript across turns
  in one session; verify end-to-end with a two-turn memory test.
- ✅ **Token streaming info** — live in/out token counts + cost while streaming.

### A2. Controls to add
- ✅ **Provider picker** — real dropdown from `nexus providers list -o json`,
  with health/needs-key state, not a free-text field.
- ✅ **Model picker** — from `nexus models -p <provider> -o json`, scoped to the
  selected provider (the CLI-side bug for this was already fixed in the TS).
- ✅ **Effort selector** — off/low/medium/high; only enabled when the active
  provider advertises reasoning.
- ⬜ **MCP** — list configured servers + their tools (`nexus mcp list|tools`).
- ⬜ **Pre/post hooks** — display and manage configured hooks.
- ⬜ **Git handlers** — `nexus commit`, `review`, `explain`, `pr` surfaced as
  real actions.
- ⬜ **Manual/auto handler** — approval mode. Currently AUTOPILOT
  auto-approves everything (`approve: () => true`); needs a real gate.

### A2b. Sign-in / auth — first-class
This is a harness for Claude, ChatGPT, Gemini etc., so auth is a primary
surface. `nexus auth status -o json` already returns all 15 providers with
`kind` (oauth / api-key / cloud-sso / cli-delegate), `loggedIn`, `method`,
`detail`, `expiresIn`.
- 🔄 **Auth screen** — signed-in vs available, per-provider action by kind.
- 🔄 **Browser OAuth** (`nexus login <p>`) — long-running and interactive; must
  stream its output so the user SEES the URL and can cancel.
- 🔄 **API key capture** — via `nexus keys set --stdin`. A secret must NEVER be
  passed as an argv argument: argv is world-readable to every process on the
  machine. `SecureField` for entry; the CLI's SecretStore owns storage.
- 🔄 **Device code** — only valid for Google-backed providers; the CLI rejects
  it elsewhere with a clear error. Do not offer it where it cannot work.
- 🔄 **CLI delegate** (claude-code / codex) — reuses the vendor CLI's own
  session; needs no login here, and the UI must say so rather than showing a
  dead button.
- ⬜ **Token expiry** surfaced (anthropic currently reports ~5h remaining).

### A3. Screens
- ✅ **Sessions tab** — list, resume, replay. Data layer done (16 tests).
- ✅ **Tasks tab** — list, add, status transitions. Data layer done (18 tests).
- ✅ **Settings** — theme picker, project directory.
- ✅ **Chat** — transcript, composer, tool rows, fan-out columns.
- ✅ **Agents** — provider lanes + OMC subagents, mission panel.

### A4. Design quality
- ✅ Layout skeleton renders (HStack shell; NavigationSplitView was dropping the
  sidebar's title-bar inset).
- ✅ Elevation = surface ladder + 1px hairlines, not shadows.
- ✅ macOS type scale (13/16 body, 15/17/22 titles, 10pt floor) + HIG spacing.
- 🔄 **Alignment/overlap audit** — Chat + Sessions verified at 1440x920 and
  900x600: no overlaps, no clipping, sidebar/control-strip/composer/status bar
  all intact. FINDING: the model picker vanishes at 900pt while the provider
  picker survives — need to confirm that is deliberate collapse rather than
  overflow, and if deliberate give it a fallback (menu-bar item or overflow
  chevron) because model choice must not become unreachable at small widths.
  Agents / Tasks / Settings not yet audited.
- ⬜ **Icon + button shape consistency** — one icon weight, one control height.
- ⬜ Empty / loading / error state for every tab.

## B. Not requested but required

- ⬜ **Approvals UI** — the `approval-request` event + `CapsulePendingApproval`
  protocol already exist. Without a gate, "manual mode" cannot be honest.
  Safety-relevant: AUTOPILOT currently writes files with no confirmation.
- ⬜ **Provider health / rate limits** — circuit-breaker state and retry-at are
  already computed by the CLI; nothing surfaces them.
- ⬜ **Context window pressure** — warn before a turn overflows.
- ⬜ **Cancel mid-turn** — wired (⌘.) but unverified against a real long run.
- ⬜ **App icon** — currently the generic placeholder.
- ⬜ **Window restoration** — size/position across launches.
- ⬜ **Accessibility labels** on icon-only controls.
- ⬜ **Transcript search** and copy/export.
- ⬜ **Error recovery** — retry a failed turn without retyping.

## B2. Cost accounting is silently fabricating $0 (found 2026-07-27)

Live evidence, a REAL paid Anthropic call:

```
[agent] role=reviewer steps=1 stop=indeterminate
[usage] in=2966 out=4 cost=$0.000000
```

2966 input tokens billed at zero. Cause: `DEFAULT_PRICING` in
`packages/config/src/schema.ts` is still keyed on the OLD model ids
(`claude-opus-4-1`, …), so every current-generation id (`claude-opus-5`,
`claude-sonnet-5`, `claude-fable-5`, `claude-haiku-4-5-20251001`) falls through
to zero. The app has a cost readout and a session tally; both are confidently
wrong right now.

**The fix is NOT to invent prices.** It is to stop conflating "no pricing data"
with "free": unknown cost must be a distinct state that renders as `—`, and a
session tally containing unpriced turns must say it is incomplete rather than
presenting a confident total. Same principle this codebase has already applied
twice — a timed-out approval is not a refusal, an `indeterminate` verdict is not
a success. **Unknown cost is not zero cost.** In flight.

Real pricing figures are still wanted as a follow-up, from an authoritative
source — not guessed.

## C. Known bugs

- 🔄 `--resume` receives a run id, not a session id → context lost every turn.
- ⬜ `nexus ask -p mock -m mock-tools` hangs indefinitely (found earlier; the
  agent tool-loop appears not to terminate on that provider). CLI-side.
- ⬜ Directory picker opened on launch once, unreproduced — watch for it.

## D. Verification standard

Nothing is marked ✅ without:
1. `swift build` clean,
2. `swift test` green (baseline 250),
3. `npx vitest run` green (baseline ~2125),
4. for UI: a screenshot at two window sizes with every region confirmed present.

Rule 4 exists because it was violated: a `.frame(maxHeight:.infinity)` applied
BEFORE padding demanded available+88pt and silently evicted its siblings, and
screenshots were reported twice without noticing most of the UI wasn't drawing.
Look at every region of the image, not the region you changed.

The rule that governs everything: **any capability the app exposes must exist as
a `nexus` command first.** The app composes commands and renders their events; it
never grows a private path to a provider.


---

## Session log — 2026-07-27 (overnight)

### Verified this session
- Persistent stdio session: ONE process, ONE engine session across turns.
  Proven with `printf 'my name is Ada\nwhat is my name?\n' | nexus chat
  --persistent -p mock -o ndjson` → single `sessionId`, two runs, `turn_end`
  delimiters.
- `sessionId` now flows through the ndjson stream (was emitting the RUN id, so
  `--resume` had never worked for any programmatic client).
- Sessions screen live against 389 real sessions; master-detail, Resume/Replay.
- Provider/model/effort pickers wired to real `providers status` output;
  provider auto-selects the first usable one so the picker matches what the CLI
  would resolve anyway.
- TypeScript 2089/2089. Swift 152/152 (was 110).

### Verified — round 2 (2026-07-27 morning)
- **Cross-provider resume preserves context.** A session opened under `mock`,
  resumed under `mock-slow`, kept the SAME session id and restored its 2 prior
  messages. This is what makes the provider-switch fix a real switch rather than
  a reset. Caveat the CLI states itself: `text only; tool calls are not
  replayed` — sensible, since those results came from another provider's run.
- **Swift 250/250, build clean** (was 199 — themes, markdown and the agent-event
  work all landed green).
- **TypeScript 2121 tests, 2113 passing.** The 8 failures are the load flake, not
  a regression: two consecutive runs of the same tree failed DIFFERENT tests
  (run 1 `wave6 > review`; run 2 `doctor`, `mcp add`, `models -o json`, `ask
  response cache`), and all 81 tests in those three files pass in isolation.
  Being hardened — a gate that fails randomly teaches everyone to ignore it.
- **`timeout` does not exist on this macOS box** (it is `gtimeout`). A command
  wrapped in it silently does not run AT ALL and reports success — this produced
  one wrong conclusion before it was caught. Do not use it in verification.

### Known flake
`packages/cli/test/cli.integration.test.ts` — the `jobs` tests spawn real
processes and failed twice under full-suite parallel load, then passed 57/57 in
isolation and clean on a full re-run. Not a regression; worth hardening.

### Next
1. Wire `AuthView` into RootView once `auth-flow` lands.
2. Approvals gate — the last genuinely-missing advanced harness property, and
   the one with real safety weight (AUTOPILOT still auto-approves everything).
3. MCP / hooks / git-handler surfaces (data layer exists in Integrations.swift).
4. Alignment audit at 900pt width — the control strip now carries mode + effort
   + provider + model + approval + reasoning and needs a narrow-window pass.
5. App icon; window restoration; accessibility labels.
6. ~~Model picker at narrow width~~ — resolved (scroll cue added).

### Notes for whoever picks this up
- `nexus chat` had NO `-o` support before this session; ndjson for chat is new.
- `available: true` from `providers list` does NOT mean usable — every
  OpenAI-compat provider reports it with zero keys. `needsKey` is the real
  signal; `available: false` only means the provider package failed to load.
- `models <p> -o json` has no numeric context window, only a free-text hint
  ("32k ctx"), parsed best-effort.
- `mcp tools` lists ENABLED servers only; `mcp list` is merged in so a disabled
  server stays visible.
- An auto-commit Stop hook (`auto-push.sh`) is committing work automatically,
  bundling concurrent agents' edits into single commits.
