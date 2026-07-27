# NexusCode.app — working backlog

## ★ STANDING MANDATE (2026-07-27, from the owner) — do not lose this

**Objective is now recorded** in project memory and injected every session. In
short: the CLI is the only engine (every app capability must exist as a `nexus`
command first); switching provider/model must never lose context; honesty over
convenience; every basic AND advanced harness property; UI/UX is the product,
not polish; never ship a silent failure.

### Step 1 — capability completeness
1. Understand the objective first — every decision depends on it. ✅ recorded
2. List ALL inputs, outputs, features, tools, options (MCP, pre/post hooks, RAG,
   AI interactions, AI behaviours, AI switching, …). 🔄 `docs/CAPABILITIES.md`
3. For EACH item, capture in detail how it is expected to work. 🔄 same doc
4. Anything missing → design how it should work. 🔄 GAPS section
5. Verify every item actually works; fix and test; **keep fixing until right.** ⬜

### Step 2 — interface
Study how the app interface SHOULD be. Full focus on design, UI, UX, layout,
colours, buttons, shapes. List every button and option, analyse, test, refix
until right. 🔄 `apps/nexus-mac/UI-INVENTORY.md`

### Step 1.5 — verification evidence so far (2026-07-27 night)

Harnesses live in `<scratchpad>/{smoke,smoke2,edge}.mjs`. They spawn each command
in a child with a hard SIGKILL deadline and capture stdout/stderr SEPARATELY.
**Built because `timeout` is not installed on this machine** — and a command
wrapped in a missing `timeout` silently does not run AND reports success.

- ✅ **45/45 commands answer `--help` cleanly** — no load-time crashes. The real
  command list is: agent ask audit auth budget cache chain chat code commit
  compare config consensus doctor explain history index jobs keys login logout
  lsp mcp memory models plan plugin policy pr providers race rbac receipt replay
  review roles route search serve session task tools trace tui usage.
  (Note it is `session`, singular — not `sessions`.)
- ✅ **20/20 safe read-only invocations pass, ZERO hangs**, all ≤840ms: audit,
  auth, budget, cache, config, doctor, history, jobs, keys, mcp, memory, models,
  plugin, policy(list), providers, rbac(list), roles, session, task, tools,
  usage, and `ask -p mock -m mock-fast` (819ms).
  **So the hang is specific to the agent/tool-loop path, not the CLI generally.**
- ✅ **Argument validation is solid** — 9 of 10 identifier-taking commands reject
  an EMPTY argument with a usage error, exactly as they reject a bogus one.
- 🔴 **BUG: `nexus trace ""` returns 11,134,907 bytes with exit 0** — an empty
  identifier silently widens into "dump every span ever recorded", while
  `trace zzz-not-real` correctly exits 1. Isolated, not systemic. Fix in flight.
- ⬜ `lsp diagnostics` reports "no language server available for typescript" in a
  TypeScript repo — exits 0. Degraded-but-honest, or a real gap? Needs a call.

### Step 2 — UI audit findings (`UI-INVENTORY.md`, 885 lines, ~102 controls)

**Three RED house-rule violations**, all found by inventorying controls against
their CLI backing — none were visible from screenshots:

1. 🔴 **The effort picker is a FABRICATED capability.** `--effort` is not a CLI
   flag at all — absent from `FLAG_SPEC.value` (`cli/src/index.ts:68-128`).
   Reasoning effort exists ONLY as an interactive `/effort` picker inside
   `nexus tui`, which `chat --persistent` never mounts.
   **And the preview lies about it**: `commandPreview` splices
   `--effort <level>` into the displayed string while
   `persistentSessionArguments()` and `oneShotArguments()` never add it.
   ⚠️ **This is the SAME bug class we already fixed once** (preview showing
   `nexus agent …` while `chat --persistent …` ran) reappearing through a
   different door — which is why "the preview equals the spawned command" needs
   a standing test, not a one-time fix. Fix direction per the house rule: give
   the CLI a real `--effort`, never make the app lie less loudly.
2. 🔴 **`Sessions → Resume` and `→ Replay` are `Button(...) {}` — empty
   closures** (`SessionsView.swift:334-337`). Resume is styled `.accent`, the
   loudest control on the screen, and does nothing. Both have real CLI backing
   (`nexus replay` exists; `--resume` is verified working).
3. 🟠 **Theme picker writes only `UserDefaults`**, while the CLI has
   `tui.theme` in config — GUI and terminal will always disagree.

**13 CLI capabilities have NO UI at all**: `agent --role` (the property exists
on the controller but nothing sets it), `roles`, `consensus`, `chain`, `route`,
`plan`, `search`/`index`, `memory`, `doctor`, `history`, `cache`, `receipt`/
`trace`, and the enterprise set (`rbac`/`policy`/`usage`/`audit`/`budget`).
That is the concrete answer to Step 1.4 "what are we missing".

**Accessibility**: ~92 of ~102 controls have no author-written label. Read that
as "not deliberately named" rather than "silent" — SwiftUI supplies fallbacks.
The genuinely wrong ones are 6 icon-only buttons announced by SF Symbol shape
rather than action, and 29 of 34 decorative `Image(systemName:)` that are
neither hidden nor labelled.

⚠️ **A false negative to remember:** AppleScript/System Events reports
`NSAttributedString`-backed AX descriptions as "missing value" even when a real
label exists. My original "zero accessibility labels" claim came from System
Events and was wrong — `RootView.swift:346` labels all eight nav rows. Verify
with a native `AXUIElementCopyAttributeValue` inspector, or read the source.

**More structural findings** (full detail + evidence tiers in `UI-INVENTORY.md`
§0.1 — it tags every accessibility claim by how well proven it is, and later
work should respect those tiers rather than treating all findings as equal):

- 🔴 **23 theme swatches are not buttons at all.** `RootView.swift:538`,`:556`
  use `.onTapGesture` on a `VStack` — no `Button`, so **no `AXButton` role
  exists to name and there is NO keyboard access**. Worse than an unnamed
  button, because there is no element. Structural certainty, no runtime tool
  needed.
- 🔴 **Keyboard focus is invisible app-wide.** `SoftButton`'s doc promises a
  focus-visible border; `makeBody` never reads focus state. Only the composer
  shows focus.
- 🔴 **At 900pt the leading control cluster needs ~650pt and gets ~376pt**, so
  the provider and model pickers scroll out of reach while an inert "Ask first"
  readout and an unclickable session id stay pinned. Fine at the 1280 default,
  which is why it survived.
- 🟠 **Destructive actions are inconsistently gated**: `Delete task` and
  `Commit` confirm; **`Clear transcript` and `Sign out` do not** — both destroy
  real state.
- 🟠 **12 glyphs render at 7-9pt**, below the 10pt floor `Kind.micro`'s own doc
  comment declares (`DesignSystem.swift:53`).
- 🟠 **Settings is the last vertical-composition violation** — a bare
  `ScrollView` containing header + both grids + project card. It only avoids the
  symptom because 23 swatches happen to fill the window. Sessions and Accounts
  implement the rule by hand (`Group{}.frame(maxHeight:.infinity)`) rather than
  via `PageScaffold`; that is correct, not a violation.
- 🟠 **The Agents screen has ZERO interactive controls** — nothing clickable,
  expandable, or focusable — despite being the flagship feature.

**The composition rule, now written down** (`UI-INVENTORY.md` §B.1): *a screen is
a fixed-height header plus exactly one region that owns all remaining height;
that region either scrolls or centres, and never top-aligns short content inside
a tall scroll view.*

### STATE AS OF 2026-07-28 (overnight run)

**Green:** Swift **314/314** (7.6s) · TypeScript **2215/2215** (222 files, exit 0)
· both builds clean · 45/45 CLI commands healthy · zero hangs ·
`docs/CAPABILITIES.md` (2908 lines) · `apps/nexus-mac/UI-INVENTORY.md`
(885 lines, ~102 controls).

⚠️ **One test file is knowingly unprotected against the `tsup` dist-rewrite
race**: `packages/cli/test/stdin-hang.integration.test.ts` cannot use the shared
`spawnCli()` retry helper, because that helper always calls `child.stdin.end()`
— which would hide the exact bug the file exists to test. So it can flake ~1 run
in N under full parallel load, and passes in isolation every time. **Do not
"fix" it by adopting `spawnCli`.** The durable fix is making `tsup` writes atomic
(temp-dir + rename) across the workspace.

For scale: that same TypeScript suite ran **2757 seconds with 15 failures**
earlier in this session. The stdin/context/MCP/keychain bounds plus the
`tsup`-race fix are what turned it back into a usable gate.

**All six core promises verified BY EXECUTION**, not by reading:
provider switch preserves context · preview == spawned argv (CLI side) ·
unknown cost ≠ zero · all four approval causes distinguishable · ndjson contract
holds · errors are never silent. One gap: the `t: "route"` UiEvent is declared
in `projection.ts` but **never constructed anywhere** — dead type.

**Bugs found and fixed that nobody asked for** (each real, each with evidence):
- `nexus trace ""` dumped 11MB with exit 0 — `if (filter)` treats `""` as absent
- `commit`/`review`/`explain`/`pr` **dumped raw JS stack traces to STDOUT** on an
  unauthenticated provider. `nexus pr | gh pr create --body-file -` would have
  injected a stack trace into a real PR body.
- the TUI showed a live-looking `/effort` picker for DeepSeek that **silently did
  nothing** — `reasoningSupportedFor()` only checked `capabilities().reasoning`
- the response cache key omitted `reasoning`, so `--effort high` could replay an
  answer cached at a different effort
- three unbounded native calls, each in a different package: MCP connect,
  `ContextEngine` source collection (an unbounded recursive walk), and a
  **Keychain read that runs on EVERY command regardless of `-p mock`**

**✅ THE HANG — root-caused and FIXED.** `readPrompt` (`commands.ts:218`) awaited
`readStdin()` **unconditionally**, and `readStdin` only short-circuited on
`isTTY`. Any caller with a non-TTY stdin that stayed open blocked forever before
producing a byte — which is every programmatic caller. `--help` promised "reads
stdin when no prompt is given"; the code didn't honour it. Sibling call sites
(`:1804`, `:2402`, `:2985`) were already correct — `readPrompt` was the outlier.

Fixed in two parts, and verified with stdin ACTUALLY inherited:

| case | before | after |
|---|---|---|
| prompt arg + inherited stdin | **hang forever, 0 bytes** | exit 0, 1s |
| piped input, no arg | worked | works |
| 1.4M-token `git diff` piped | worked | works, 2s |
| producer silent 4s, then emits | — | exit 0, 5s |

1. `readPrompt` short-circuits on a present positional — a prompt argument means
   stdin is never touched. (Note: concatenating an argument WITH piped stdin was
   never a documented feature; it was a side effect of this very bug. The
   documented contract won, and a test now pins that choice.)
2. `readStdin` bounds only the **first byte-or-EOF** wait
   (`STDIN_FIRST_BYTE_TIMEOUT_MS`, 30s, overridable via `NEXUS_STDIN_TIMEOUT_MS`).
   Once anything real arrives the rest streams with no time pressure, so a slow
   producer is never cut off mid-stream. 30s because, once the short-circuit
   removed the common case, EVERY remaining caller has stdin as its ONLY input
   source — reaching that read means a real pipe or a genuine mistake, so erring
   generous costs nothing and cutting short silently discards real input.

⚠️ **A second bug this surfaced, worth remembering on its own:** bounding the
read wasn't enough — `chat` printed its output and then still refused to exit,
because walking away from an open, `ref`'d stdin keeps Node's event loop alive.
Needed `stdin.pause()` + `stdin.unref()` in the same cleanup path.
**Bounding a wait is only half the job; you must also release what you were
waiting on.**

⚠️ **Why six of us missed it for hours: every watchdog harness we built spawned
children with `stdio: ["ignore", …]`.** My own harness reported 641ms for the
command that hung 22.8 minutes in a plain shell. **The measurement tool was
hiding the bug.** Verify hangs with stdin actually inherited.

### Cost honesty now has THREE states, not two

The unpriced-cost work established `unknown ≠ zero`. Wiring the new `cache`
UiEvent surfaced a third, verified against real bytes: **a cache-hit `ask` emits
NO `usage` event at all** — no `session`, no `usage`, just:

```
{"t":"text","lane":"main","delta":"[mock-fast] Echo: …"}
{"t":"cache","lane":"main","hit":true}
{"t":"done","lane":"main","finishReason":"stop"}
```

So a cached turn's cost is a **confirmed** $0.00 (no model call happened), which
is different again from "unknown" and from "a priced run that came to zero".
`Turn.cacheHit` is `Bool?` on purpose: `nil` means never checked, `false` means
checked-and-missed — `hit` is a real boolean, not a literal `true`.

⬜ Open: the visible treatment. Proposal on the table is a quiet "cached" label
where that turn's cost figure would otherwise render. Nobody has built it.

### The OODA framework is reachable from the app (G1 + G2)

`nexus roles` was written FOR the app's picker and nothing consumed it; nothing
ever set `ConversationController.role`. Now: `Roles.swift` + `RolesController`
mirror the `Providers` pattern, and the picker appears in the ControlStrip in
`.agent` mode with a `"native"` sentinel for "no role" as a first-class choice.

Two judgement calls worth keeping:
- **`canWrite` treats a MISSING `permissionMode` as "warn".** The CLI's own
  fallback for absent is `read-only`, but a client cannot distinguish "the CLI
  applied its safe default" from "the field is missing entirely", so it errs
  toward the visible warning rather than silently trusting an unreadable field.
- The warning renders on **both** the popover row and the closed button, so a
  write-capable role's warning is never one click away from invisible.

Also fixed: role runs now get `--resume`. The app had refused, on a comment that
was true when written and false by the time it was read.

**Verified:** the real CLI emits exactly what the picker expects — 9 roles, all
with descriptions, and precisely 4 write-capable (`coordinator`, `coder`,
`tester`, `doc-writer`). 13 `RolesTests` lock that 4/5 split against the real
presets in `packages/agent/src/roles.ts`.
⬜ Not yet seen: the picker populated by the REAL binary. It was verified with a
fake `nexus` returning the same shapes, and the shapes are confirmed identical,
so the residual risk is low — but nobody has watched it happen.

⚠️ **AppleScript/System Events CANNOT drive this UI.** It reports every SwiftUI
button's description as the literal string `"button"`, because SwiftUI exposes
labels via `kAXDescriptionAttribute` backed by `NSAttributedString`, which
System Events fails to marshal. This produced one false accessibility finding
(a claim that nav rows had no labels — they did) and one failed verification
attempt. **Use a native `AXUIElementCopyAttributeValue` walk instead.**

### Hard rules learned the hard way
- **NEVER drive the GUI with synthetic keystrokes or coordinate clicks.** An
  agent's coordinate click landed in the owner's real Notes document, typed into
  it, then pressed Cmd+Z three times — possibly destroying their concurrent
  work. Screenshots + accessibility-resolved `AXPress` inside
  `window "NexusCode"` ONLY. Never automate text entry into the live app.
- Nothing is done without the binary/app actually run and observed. A green
  suite has twice described features that did not work.


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

  ✅ **Now wired and selectable.** The environment key is `AppTheme`; the default
  is **Meridian**; `WorkspaceModel.activeTheme` resolves through EITHER
  catalogue (`AppTheme.named(id) ?? NexusTheme.named(id)?.appTheme`), so the 16
  generated palettes are kept and still selectable, just routed through the
  richer model. The picker shows two groups: the 7 designed for a window, then
  the terminal palettes labelled as kept "for parity with the terminal, not
  because they suit a window."

  `pairId` is real, not cosmetic: `ThemedRoot` reads the OS `colorScheme` and
  injects `activeTheme.resolved(for:)`, then asserts `preferredColorScheme`
  DOWNSTREAM of where the scheme was read, so there is no feedback loop. Pick
  Meridian, put the Mac in Light Mode, the app renders Studio and flips back
  live. Unpaired themes return `self` unchanged.

  Compatibility held better than expected: only 4 files had explicit
  `NexusTheme` annotations needing a change, because every other Features file
  uses `@Environment(\.nexusTheme)` with an inferred type and only calls
  `.color(_:)`/`.hairline`, which `AppTheme` answers identically.

  **Contrast — three failure patterns, all fixed, all measured.** Widening the
  check from body/secondary text to the pairs components ACTUALLY compose is
  what found every one of them; the coverage was the gap, not the palettes.
  - `accentFg`/`accentDefault` (SoftButton `.accent`): Daylight 3.40→4.61,
    Studio 4.15→4.63. Fixed by darkening the FILL via HSL lightness only, hue
    and saturation held exactly, so it is still the same coral/blue.
  - `warningFg`/`warningBg` and `errorFg`/`errorBg` — found only by asserting
    every composed pair: Daylight warning 3.57→4.64, Studio warning 3.23→4.61,
    errors nudged off the 4.44/4.50 line for margin. Darkened the Fg here
    because the Bg is a near-white pastel with no headroom left — white against
    the old `warningFg` only reaches 4.12, so lightening the bg could never work.
  - `CountPill.accent` (`accentFg` on `accentMuted`, 1.50–3.70 everywhere):
    fixed the COMPOSITION, not the tokens. No single existing token pairs
    safely with `accentMuted` across all 23 themes, so
    `Color.readableText(on:preferring:otherwise:)` now picks whichever of
    `textPrimary`/`textInverse` actually reads, per theme, at render time.
    All 7 new themes clear 4.5 (5.24–10.77) and 11 of the 16 old ones do too,
    up from roughly none.

  ⬜ **5 old generated themes still cannot reach 4.5** on that pair even with the
  best available token — midnight 4.49, retroAmber 3.95, pastel 3.89, frost
  3.50, forest 3.25. That is a token-level gap in `Generated/Themes.swift`
  itself and needs a change at the generator, not in the app.

  **Correction to an earlier note here:** `CountPill` was NOT purely
  pre-existing. Shipping `nexus-noir` scored ~5.3 — fine — so for themes that
  were passing it was a genuine regression the new themes introduced;
  `paper-nexus` at 1.89 was already broken.
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
   Precise stream behaviour, measured to separate files rather than inferred:
   - BEFORE the fix, `-o ndjson` sent the narration to STDERR. So stdout ndjson
     was never actually corrupted, despite appearing so under `2>&1`.
   - AFTER the fix, `-o ndjson` stderr is **completely empty** (`OUT: total=23
     agent=7 / ERR: total=0 agent=0`). ndjson is ONE structured stream.
   - `-o text` is unchanged: one narration line per phase on stderr.

   ⚠️ **This exact trap bit twice, in two different shapes** — once via `2>&1`
   merging the streams, once via `2>&1 >/dev/null` under zsh MULTIOS. When a
   claim is about WHICH stream something is on, redirect to separate files and
   count. Do not reason about redirection operators.
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
3. ✅ **The app never passes `--role`** — fixed, along with TWO worse defects in
   the same family as the provider-switch bug that chasing it turned up:

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

   **How they were fixed:** the controller now computes the FULL argv, and
   `PersistentSession` is HANDED it (`init` takes `arguments:`) instead of
   assembling its own. One builder, `persistentSessionArguments()`, feeds both
   the preview and the spawn — so they cannot drift again by anyone's
   inattention. The guard test asserts structural equality between the two, not
   two literals that happen to match. Two pre-existing tests had encoded the old
   dishonest behaviour and were corrected; note the preview for a persistent run
   no longer contains the prompt text, because the prompt goes over STDIN and
   was never in argv.

   `launchedWith` is now `(provider, model, role)`, and the relaunch check moved
   up into `submit()` — a role change can cross the persistent/one-shot boundary
   entirely, so role going nil→non-nil must STOP the stale role-less backend
   rather than leave it running alongside.

   ⚠️ **Real CLI limitation, recorded rather than papered over: a role run
   cannot resume.** `runAgentOoda` calls `engine.openSession()` fresh on every
   invocation and never reads the `resume` flag — `--resume` is dead on that
   path. So the app deliberately omits it for role runs. This matters against
   the project's own promise that switching providers must not lose context:
   starting a role run mid-conversation currently starts a NEW session. Worth
   fixing in the CLI (teach `runAgentOoda` to honour `--resume` like the chat
   path does) — queued behind the in-flight `commands.ts` work.

   Structural constraint worth remembering: `nexus agent` has NO `--persistent`
   mode — one-shot per invocation — so a role run dispatches like compare/race
   and can never use the persistent-session path.

   Still open: `AgentRowBuilder` needs a third origin beside `.lane`/`.omc`, and
   the origin badge in `AgentsView.swift` a matching case. IN FLIGHT — with the
   hard requirement that the three-valued verdict plus "running" render as FOUR
   visibly distinct states, since `AgentRow`'s two booleans cannot express them.
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
- 🔴 **THE CLI HANGS. Top priority — it now reproduces in the test suite.**

  `npx vitest run packages/cli`: **4 files failed, 7 tests failed, 349 passed,
  2166 SECONDS** for a suite that normally runs in 35-42s. Durations:

  ```
  × roles > every listed role is actually runnable by `agent --role`   1011476ms
  × mcp  > mcp call invokes a discovered tool ...                       932030ms
  × wave6 > trace renders spans for a recorded mock run                 177055ms
  × #6   > `nexus git diff` maps to the same clear guidance             176455ms
  × providers list > shows the new compat + azure providers             176342ms
  × config > set then get round-trips a value                           176169ms
  × ask   > -o json emits a single valid JSON object                        521ms
  ```

  The 521ms one is a DIFFERENT bug — an ordinary assertion failure from the
  cost-accounting change, not a hang. The other six are hangs, and **four cluster
  at ~176,000ms**, which looks like a fixed ceiling rather than six independent
  stalls. Finding what that constant is may be the most informative clue.

  The 16.9-minute one spawns `agent --role X` for all 9 roles — a direct match
  for the bare-CLI observation: the same command has both succeeded (23 stdout
  lines, 7 agent events) and hung with stdout+stderr redirected to **FILES**
  (so not a blocked pipe), both **0 bytes after 7 minutes, process still alive**.

  Ruled out, with evidence — do not re-derive:
  - NOT a blocked pipe (output went to files).
  - NOT the `tsup` dist race below — that exits(1) with an ESM stack trace; this
    never exits and never writes.
  - NOT machine load — `packages/core/test/projection.test.ts` runs in **0.6s**
    on this machine, and `npm run build` exits 0.

  Probably the same bug as the longstanding `nexus ask -p mock -m mock-tools`
  hang; both involve `mock-tools`. Whether the tool loop is REQUIRED to
  reproduce is genuinely untested. A prime unexamined candidate: a stdin read
  that never receives EOF — the hanging invocations were given no stdin, which
  fits "zero output, still alive" exactly.

  **A silent indefinite hang is never acceptable, whatever the root cause.**
  Even if the trigger is environmental, the CLI must fail loudly.
- ✅ **Full-suite flakiness — root-caused and fixed.** It was never vitest
  scheduling, timeouts, pool sizing, or shared fixtures (every integration file
  already used per-file `mkdtempSync` dirs; vitest shares ONE fork pool across
  all ~44 projects, so there was no oversubscription to cap). The real
  mechanism: **`tsup`'s "clean output folder" step deletes and rewrites each
  package's `dist/*.js` non-atomically.** Every integration test spawns the real
  built `nexus` binary, which resolves ~20 workspace imports through Node's ESM
  loader; if any package's `dist/` is mid-rewrite during that resolution the
  child hard-crashes before running — empty stdout, raw ESM stack trace, exit 1.
  That is exactly the `expect(code).toBe(0)` → `1` signature, why a DIFFERENT
  test fails each run, and why isolated subsets stay green.

  Proved causally, not by correlation: racing a `npm run build` loop against 20
  concurrent CLI spawns failed **9/20 (45%)** unpatched and **0/20 across 6
  rounds** patched. Fix is `spawnCli()`, which fingerprints this exact race
  (empty stdout AND an ESM-loader stderr signature) and RE-SPAWNS — never
  re-asserts — up to 3× with 150/400/900ms backoff. Any other failure returns
  untouched on the first attempt, so no assertion is ever retried and nothing is
  weakened. 5/5 full-suite runs green with load samples bracketing each run.
  ⬜ Durable follow-up: make `tsup` writes atomic (temp-dir + rename) across the
  workspace. Correctly scoped OUT while every package is being live-edited.
  ⬜ 9 spawn-based test files were left unpatched (they drive long-lived
  streaming processes with custom readiness detection) — vulnerability unknown.
- ⬜ Directory picker opened on launch once, unreproduced — watch for it.

## C2. Visual verification WITHOUT a window — use this

macOS in this session refuses to show a window even for a minimal 4-line SwiftUI
app, so the screenshot gate was unavailable. It is available again by another
route: a headless `ImageRenderer` harness that compiles the REAL `Markdown.swift`
+ `DesignSystem.swift` against NexusKit and renders them to PNG with no window
server.

Harness: `<scratchpad>/uicheck`, PNGs in `<scratchpad>/shots/`.

**Known artifact:** `ImageRenderer` does not draw `ScrollView` CONTENT — verified
with a control (a bare `ScrollView { Text }` renders blank while the same `Text`
renders fine). So code blocks appear empty. That is the harness, not the app, and
sizes are still computed correctly, so measurements hold.

This is how the numbers in §C3 were obtained. **Prefer it to reasoning about
layout.** It has already disproved one suspicion (`CodeBlock` was thought to
force a fixed 260pt box; measurement showed 44pt for 2 lines, 260pt for 40) and
caught defects a read missed.

## C3. Review findings — open (2026-07-27)

Ordered worst first. Everything below was re-verified against disk at HEAD.

1. **HIGH — `Card` draws drop shadows** (`DesignSystem.swift:128`), contradicting
   the house rule documented 60 lines above it in the SAME file, which records
   shadows as the reason an earlier pass "looked flat rather than layered".
   Every dark theme gets opacity 0.16@r6 and 0.24@r12 → a grey smudge halo
   around every card over a near-black canvas. The border also silently moved
   from translucent `theme.hairline` to an opaque token.
2. **HIGH — the 660pt reading column made the layout read as two screens.** The
   transcript is capped and centered but the composer and control strip stay
   full-bleed: at 1280 (pane 1031pt) the text sits in ~186pt gutters while the
   composer spans full width, so **the placeholder starts ~165pt left of the
   user's own message directly above it.** My instruction to cap the column was
   incomplete, not wrong — the composer needs the same spine.
3. **MEDIUM — the control strip HIDES provider and model at 900pt.** Pane 651
   minus padding = 635 usable; trailing cluster needs ~290, leaving ~345 for a
   leading cluster needing ~636. Both pickers scroll out of sight with
   `showsIndicators: false` giving no hint. Pre-existing, but it would make the
   just-fixed picker bugs invisible at a common width.
4. **MEDIUM — assistant body copy renders in `textSecondary`** while headings are
   `textPrimary` (`Markdown.swift:327`) — washed out for long-form reading. And
   inline code fills `surfaceInset` on a `surfaceBase` canvas: **1.069:1**,
   imperceptible, despite a comment promising "a real, unmistakable departure".
5. **MEDIUM — 11.1ms per re-render on every token delta** (`Markdown.swift:321`).
   The PARSER is fine (1.1ms for a 10.6k message); `AttributedString(markdown:)`
   is rebuilt for every block on every body evaluation. Most of a 16ms frame
   budget, growing with message length. Same shape at `DesignSystem.swift:105`:
   `theme.appTheme` rebuilds 7 nested structs and copies 74 strings per access,
   and `Card` touches it 6× per body evaluation.
6. **MEDIUM — latent, fires exactly when theme wiring lands**
   (`DesignSystem.swift:116-122`): `Card` fills an opaque surface then overlays a
   `Material` ON TOP. A material blurs its backdrop — here the opaque fill
   beneath — so it renders as a flat scrim, never translucency. Inert only
   because the bridge forces `.solid`.
7. **LOW** — hover copy button overlaps the first line now that the card padding
   is gone (`ConversationView.swift:1007`).
8. **LOW** — constants bypassing the scale: `Space.xs + 2` IS `Space.sm`
   (`Markdown.swift:178`), plus `Space.lg + 4` and raw `3`/`4`/`6.5`.

**Correction to the earlier note on `CountPill`:** it is NOT purely pre-existing.
The shipping `nexus-noir` scores ~5.3 on `accentFg`/`accentMuted` — fine — while
all seven new themes land in 1.50–3.70. `paper-nexus` at 1.89 was already bad, so
it is pre-existing for SOME of the 16 and a genuine regression for others.

**Contrast test coverage is the real gap, not the palettes.** The WCAG helper is
real computed luminance, not hardcoded. Missing pairs: `textMuted` on
`surfaceBase` (fails at 3.15 Studio / 3.53 Daylight / 3.69 Basalt — and that
token is what markdown H3/H4, list markers, `SectionHeader` and `Metric` all
render in, all under 18pt), and anything on `surfaceRaised`/`surfaceOverlay`,
where cards actually put text.

### Verified good — do not churn
- **No greedy-frame/modifier-order bug in any new code.** Looked for specifically.
  `HeroEmptyState` still has padding before the flexible frame; the original fix
  is intact.
- Composition holds at 620pt and 360pt: hanging indents align under the first
  line's TEXT, nested lists indent, nothing clips.
- Streaming safety is real at BOTH levels — parser AND inline. `**bold`,
  `` `code ``, `[link](htt`, `*it`, `~~strike`, `100% **done` all return literal
  text; none throw.
- `@Environment` DOES resolve inside `SoftButton: ButtonStyle` — proven by
  histogramming rendered pixels under a non-default theme.
- Swift 6 + determinism clean: all `Sendable` value types, stateless parser, no
  formatters, no `UUID()`/clock reads in derived state.
- Zero `TODO`/`FIXME`/`XCTSkip`/stub tests across all five new/changed files.

## D. Verification standard

Nothing is marked ✅ without:
1. `swift build` clean,
2. `swift test` green (baseline 250),
3. `npx vitest run` green (baseline ~2125),
4. for UI: a render at two window sizes with every region confirmed present —
   via the §C2 headless harness when no window server is available, or a real
   screenshot when one is.

Rule 4 exists because it was violated: a `.frame(maxHeight:.infinity)` applied
BEFORE padding demanded available+88pt and silently evicted its siblings, and
screenshots were reported twice without noticing most of the UI wasn't drawing.
Look at every region of the image, not the region you changed.

Rule 5, learned the hard way this session: **a green test suite is not evidence
the feature works.** Three passing unit suites and a clean build described an
`agent` event stream that emitted nothing at all, because the CLI intercepted the
chunks before the projection ever saw them. Run the actual binary and read its
actual output. The same rule caught `plannedCommand` previewing one command while
another was spawned, and a real paid API call reporting `$0.000000`.

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

### Verification hygiene — every one of these cost real time today

- **`timeout` does not exist on macOS** (it is `gtimeout` via coreutils). A
  command wrapped in `timeout` **silently does not run at all and reports
  success**. This produced a confident wrong conclusion.
- **Never pipe a long-running command through `tail`.** The failure detail you
  need is discarded and you have to re-run — I lost a 46-minute suite run and a
  16-minute test run this way, twice. Redirect to a file and grep it.
- **For any claim about which STREAM output lands on, redirect stdout and stderr
  to SEPARATE FILES and count bytes.** `2>&1` and `2>&1 >/dev/null` under zsh
  MULTIOS each produced a wrong diagnosis in this session.
- **A green test suite is not evidence the feature works.** Three passing unit
  suites and a clean build described an `agent` event stream that emitted
  nothing, because the CLI intercepted the chunks before the projection saw
  them. Run the binary; read its real output.
- **Discriminate "slow" from "broken" with a cheap control.** Both toolchains
  appeared ~100× slow at one point; a single pure test file running in 0.6s
  proved the machine was fine and the slowness was specific hanging tests.
- **Do not fan out more parallel agents than the box can carry.** Six concurrent
  agents running full builds and suites drove load average to 47, starved
  unrelated work, and corrupted the measurements of the very agent that was
  characterising load-induced flakiness. Coordinate build/test windows instead.
- **An agent can die mid-task and leave compiling but unverified code in the
  tree.** Three did today (API errors). `npm run build` exiting 0 says only that
  it compiles. Re-audit everything such an agent touched, including the parts
  that look finished.

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
