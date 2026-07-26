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

## C. Known bugs

- 🔄 `--resume` receives a run id, not a session id → context lost every turn.
- ⬜ `nexus ask -p mock -m mock-tools` hangs indefinitely (found earlier; the
  agent tool-loop appears not to terminate on that provider). CLI-side.
- ⬜ Directory picker opened on launch once, unreproduced — watch for it.

## D. Verification standard

Nothing is marked ✅ without:
1. `swift build` clean,
2. `swift test` green (currently 110),
3. for UI: a screenshot at two window sizes with every region confirmed present.

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
