# NexusCode for macOS — UI Inventory & Interface Design Review

**Scope:** every control on all eight screens, plus the sidebar, the top control strip, the composer, the status bar, and every sheet / popover / menu.
**Method:** read of every file under `Sources/NexusApp/` and `Sources/NexusKit/` at the state of the working tree, plus the eight screenshots captured at 2880×1800 (1440×900 pt).
**Read-only pass.** No Swift file was modified.

---

## 0. Read this before you trust a line number

Two agents were actively editing `RootView.swift`, `ConversationView.swift`, `DesignSystem.swift` and the feature views while this was written. Line numbers are accurate against the working tree as read; re-grep before applying an edit.

**The screenshots are already stale in two ways.** Both are fixed in code, not yet re-captured:

| Screenshot shows | Code now does | Where |
|---|---|---|
| Sidebar nav selection = solid full-strength `accentDefault` periwinkle block | `accentMuted` wash + 3pt `accentDefault` rail on the leading edge, label colour computed by `Color.readableText` | `RootView.swift:294-296`, `:321-337` |
| Two bottom status readouts — sidebar footer ("OMC watching" / "no agents running") **and** a bottom strip ("ready") | `SidebarFooter` deleted; one full-width `StatusBar` carries both facts | `RootView.swift:13-20`, `:164-171`, `:377-389` |

So the brief's "loudest object on every screen" and "TWO status bars" findings are **already resolved in the working tree**. Sections 10.4 and 10.5 below verify the fixes and name what is still wrong about each.

---

# PART A — THE COMPLETE CONTROL INVENTORY

## Legend

- **CLI** — the `nexus` command or flag the control resolves to. `⚠️ NO CLI BACKING` flags a control with no command behind it.
- **AX** — accessibility label status. `✅` explicit `.accessibilityLabel`; `⚠️ implicit` named only by its own visible `Text`; `❌ none` icon-only or gesture-only, reads as an unnamed / unrolled element.

The full `nexus` command surface, for reference (from `packages/cli/src/index.ts:289-964`):
`ask|run|q`, `agent`, `plan`, `roles`, `task|tasks`, `jobs`, `tools`, `code`, `chat`, `mcp`, `tui`, `memory`, `compare`, `race`, `consensus`, `chain`, `route`, `providers`, `models`, `keys`, `login`, `logout`, `auth`, `config`, `history`, `doctor`, `serve`, `plugin|plugins`, `index`, `search`, `lsp`, `cache`, `session`, `replay`, `receipt`, `trace`, `commit`, `review`, `explain`, `pr`, `rbac`, `policy`, `usage`, `audit`, `budget|budgets`.

---

## A.1 — Persistent sidebar — 9 controls

`RootView.swift:119-193`. Fixed 248pt wide (`:34`), `.listStyle(.sidebar)` with hidden background, `materials.sidebar` treatment bleeding under the title bar (`:182-185`).

| # | Label / icon | file:line | Type | What it does | CLI / state | States | AX |
|---|---|---|---|---|---|---|---|
| 1 | Hexagon mark + "NexusCode" | `RootView.swift:198-217` | Static brand header | Identity only | — | Always | ⚠️ `hexagon.fill` at `:207` is **not** `.accessibilityHidden` — leaks "hexagon.fill" into the tree |
| 2 | 📁 `<project name>` + ⌃⌄ | `RootView.swift:222-267` | Button → `NSOpenPanel` | Opens native folder picker; sets `workspace.projectDirectory`, which re-runs `attach()` and rebuilds every controller | State: `WorkspaceModel.projectDirectory` (`NexusApp.swift:107-112`). Becomes `--cwd` on every spawned command | default / hover (`surfaceOverlay` 0.55→1.0) | ✅ `"Project: <name>"` + hint (`:264-265`) |
| 3 | 💬 **Chat** | `RootView.swift:281-349` | Nav row button | `workspace.tab = .chat` | `nexus chat --persistent` (single-lane) / `ask` / `compare` / `race` | normal / hover / selected | ✅ `:346` |
| 4 | 👥 **Agents** (+ count badge) | same | Nav row button | `workspace.tab = .agents` | Read-only view over live lanes + `.omc/state` | normal / hover / selected / **badge > 0** when `runningCount()` > 0 (`:189-192`) | ✅ `"Agents, N running"` |
| 5 | ☑️ **Tasks** | same | Nav row button | `workspace.tab = .tasks` | `nexus task list` | normal / hover / selected | ✅ |
| 6 | 🕐 **Sessions** | same | Nav row button | `workspace.tab = .sessions` | `nexus session list` | normal / hover / selected | ✅ |
| 7 | ⑂ **Git** | same | Nav row button | `workspace.tab = .git` | `nexus commit / review / explain / pr` | normal / hover / selected | ✅ |
| 8 | 🔑 **Accounts** | same | Nav row button | `workspace.tab = .accounts` | `nexus auth status / login / logout / keys set` | normal / hover / selected | ✅ |
| 9 | 🧩 **Integrations** | same | Nav row button | `workspace.tab = .integrations` | `nexus mcp list`, `nexus tools list`, `nexus config get hooks` | normal / hover / selected | ✅ |
| 10 | 🎚 **Settings** | same | Nav row button | `workspace.tab = .settings` | ⚠️ **Partly unbacked** — theme is app-local `UserDefaults` (`NexusApp.swift:92-94`); the CLI's own theme lives at `tui.theme` in `packages/config/src/schema.ts:146` and is never written | normal / hover / selected | ✅ |

**Section headers** WORK / HISTORY / SETUP (`RootView.swift:141-145`) — static, grouping from `WorkspaceTab.Group` (`AppState.swift:36-60`).

**Icon set actually used** (`AppState.swift:67-78`):
`bubble.left.and.bubble.right`, `person.3.sequence`, `clock.arrow.circlepath`, `checklist`, `person.badge.key`, `puzzlepiece.extension`, `arrow.triangle.branch`, `slider.horizontal.3`.

---

## A.2 — Bottom status bar — 0 controls, 7 readouts

`RootView.swift:390-467`. Full window width, `surfaceSunken`, 1px `chromeDivider` on top, `.lineLimit(1)`, never wraps.

| Readout | file:line | Source | Notes |
|---|---|---|---|
| Hexagon + "NexusCode" | `:403-411` | static | `hexagon.fill` **is** hidden here (`:407`) — inconsistent with `:207` |
| "OMC watching" / "OMC idle" | `:413-421` | `workspace.omc.isWatching` | Only rendered when `omc.isAvailable` |
| `MODEL <id>` | `:423-426` | `conversation.view.session.model` | accent-emphasised |
| `COST $0.0000` | `:428-430` | `view.totals.costUsd` | only when > 0 |
| `CTX N%` | `:434-436` | `omc.snapshot.hud.contextUsedPercentage` | `.warning` tone past 80% |
| `SESSION $0.00` | `:437-439` | `hud.totalCostUsd` | |
| "N working" / "ready" | `:444-458` | `runningCount()` | pulsing `StatusDot` when > 0 |

`StatusDot` carries `.accessibilityLabel("running"/"idle")` (`DesignSystem.swift:314`) — a bare, context-free word in the AX tree.

---

## A.3 — Chat — 21 control definitions

### A.3.1 Top control strip — `ConversationView.swift:360-500`

Leading cluster sits in a horizontal `ScrollView` (`:372`); trailing cluster is fixed outside it (`:386-411`).

| # | Label | file:line | Type | What it does | CLI | States | AX |
|---|---|---|---|---|---|---|---|
| 1 | **Ask** | `:374`, `:809-844` | Segment 1/4 | `controller.mode = .ask` | `nexus chat --persistent -o ndjson` (long-lived) | selected = `accentDefault` fill + semibold | ⚠️ implicit; **`.isSelected` trait not set** |
| 2 | **Agent** | same | Segment 2/4 | `controller.mode = .agent` | `nexus chat --persistent` when `role == nil`; `nexus agent --role <r>` when set | same | ⚠️ implicit |
| 3 | **Compare** | same | Segment 3/4 | `controller.mode = .compare` | `nexus compare -b … -b …` | same | ⚠️ implicit |
| 4 | **Race** | same | Segment 4/4 | `controller.mode = .race` | `nexus race -b … -b …` | same | ⚠️ implicit |
| 5-8 | **Off / Low / Med / High** | `:377`, `:523-559` | 4-way segmented | Sets `@State effort` | ⚠️ **NO CLI BACKING — see A.9** | selected = accent fill | ⚠️ implicit |
| 9 | ● `provider` ▾ | `:439-450`, `:654-710` | Custom dropdown → popover | Sets `controller.provider`, clears `model`, triggers `onLoadModels` | `-p <id>` in `persistentSessionArguments()` (`AppState.swift:263`) | placeholder (muted) / selected / leading dot coloured by provider kind | ⚠️ implicit |
| 10 | `model` ▾ | `:457-476` | Custom dropdown → popover | Sets `controller.model` | `-m <id>` (`AppState.swift:264`) | **disabled + 0.5 opacity when `provider == nil`** (`:468-469`); inline `ProgressView` while `isLoadingModels` (`:680-684`) | ⚠️ implicit |
| 11 | `+ add` ▾ | `:425-433` | Dropdown (Compare/Race only) | Appends to `controller.backends` | `-b <id>` (repeatable) | empty hint differs: "No providers loaded yet" vs "All providers already added" | ⚠️ implicit |
| 12 | `<backend>` ✕ | `:420-423`, `:913-932` | Removable chip (Compare/Race only, N of them) | Removes from `controller.backends` | drops a `-b` | always enabled | ❌ **none** — bare `xmark`, `.buttonStyle(.plain)`, no label, no `.help` |
| — | ✋ **Ask first** | `:482-499` | **Static readout, NOT a control** | Nothing. Displays that approval gating is inert | `-t --ask` *is* passed (`AppState.swift:268`) but the readout is decorative | Always dimmed | n/a — but it *looks* like a control |
| — | `SESSION <8 chars>` | `:390-393` | Readout | — | `--resume <id>` | only when `sessionId != nil` | n/a |
| 13 | 🧠 brain glyph | `:395-402` | Icon toggle button | Toggles `showsReasoning` → shows/hides `turn.reasoning` in every `TurnView` | Renders `UiEvent` reasoning deltas already in the stream | on = `.accent` tone + `.fill` variant; off = `.neutral` | ❌ **none** — `.help()` only |
| 14 | 🗑 trash | `:404-411` | Icon button | `controller.clear()` — wipes the transcript, keeps the durable session | Local only; session store untouched | always enabled | ❌ **none** — `.help()` only. **No confirmation** despite being destructive to on-screen work |

### A.3.2 Empty state — `ConversationView.swift:177-207`

| # | Label | file:line | Type | What it does | CLI | AX |
|---|---|---|---|---|---|---|
| 15 | "Explain this codebase" | `:178`, `:847-870` | Suggestion chip | Fills composer, focuses it — deliberately does **not** submit (`:209-215`) | becomes the prompt | ⚠️ implicit |
| 16 | "Review my staged diff" | `:179` | same | same | same | ⚠️ implicit |
| 17 | "Compare two models on one prompt" | `:180` | same | same | same | ⚠️ implicit |
| 18 | "Find the bug in the last commit" | `:181` | same | same | same | ⚠️ implicit |

`⌘N new` / `⌘. stop` / `⏎ send` (`:200-204`) are `KeyHint` labels, not controls (`DesignSystem.swift:539-557`).

### A.3.3 Composer — `ConversationView.swift:217-325`

| # | Label | file:line | Type | What it does | CLI | States | AX |
|---|---|---|---|---|---|---|---|
| 19 | "Message NexusCode…" | `:273-279` | Multiline `TextField`, `lineLimit(1...8)` | Holds `draft`; `.onSubmit(send)` | Written to the persistent process's **stdin**, never argv (`AppState.swift:252-256`) | unfocused (1px `chromeBorderSubtle`) / focused (2px `chromeBorderFocus` + accent glow, `:296-301`) | ⚠️ implicit (placeholder) |
| 20 | ↑ arrow | `:316-324` | Primary submit button | `controller.submit(draft)` | spawns / writes the turn | **disabled** when `!canSend` (`:327-329`) → tone drops `.accent`→`.neutral` | ❌ **none** — `.help("Send (⏎)")` only |
| 21 | ⏹ stop.fill | `:308-314` | Cancel button (replaces #20 while running) | `controller.cancel()` | terminates the child process | only exists when `isRunning` | ❌ **none** — `.help("Stop the run (⌘.)")` only |

**Command preview** (`:229-243`): live `nexus …` string. **See A.9 — it can lie.**

### A.3.4 Transcript — `ConversationView.swift:997-1277`

| # | Label | file:line | Type | What it does | States | AX |
|---|---|---|---|---|---|---|
| 22 | 📄 copy / ✓ | `:1072-1084` | Copy-answer button | Writes `turn.text` to `NSPasteboard` | **Only rendered on hover** (`:1058`); flips to `checkmark` after copy, resets on hover-out | ❌ **none**, and **unreachable without a mouse** |
| 23 | ▸ `<toolName> <args>` | `:1206-1231` | Disclosure row | Expands to pretty-printed args + result `CodeBlock`s | collapsed / expanded (chevron rotates 90°); `StatusDot` running/error | ⚠️ implicit via `tool.name` |

Non-interactive transcript states: `ThinkingIndicator` (`:1174-1193`), `StreamingCaret` (`:1155-1170`), `errorBlock` (`:1126-1148`), `DiagnosticsStrip` (`:1287-1330`), `UsageReadout` (`:785-804`), diff `CodeBlock`s (`:1111-1118`).

**`Markdown.swift` contains zero `Button`s** (verified: `grep -c Button` → 0). A fenced code block inside an answer (`MarkdownCodeBlockView:299`) has **no copy button** — only the whole-answer copy at #22.

---

## A.4 — Agents — **0 controls**

`AgentsView.swift`. Entirely read-only. Nothing is clickable, hoverable, expandable, or focusable.

| Element | file:line | Type | Source | States |
|---|---|---|---|---|
| `HeaderStrip` — "N running" / "Idle" + 3 count pills | `:152-227` | Readout card | `lanes` / `roleRuns` / `omcAgents` | pills go `.accent` when > 0 |
| HUD row — session $, context %, 5h %, 7d % | `:200-223` | Readout | `omc.snapshot.hud` | `.neutral` / `.warning` ≥80% / `.danger` ≥95% (`:167-172`) |
| `AgentSection` ×3 | `:268-295` | Adaptive grid, min 300 max 460 | — | headers only render when the section is non-empty |
| `AgentCard` | `:301-373` | Card | one lane / role run / OMC agent | running = accent border 1.4pt + glow shadow; failed = `errorBorder`; idle = no border |
| `OriginBadge` LANE / AGENT / OMC | `:380-413` | Chip | `row.origin` | three distinct colour families |
| `VerdictBadge` verified / not met / unverified | `:426-454` | Chip | `AgentVerdict` | success / error / warning |
| `MissionPanel` + `ProgressView` | `:457-515` | Card | `omc.snapshot.missions` | only when a mission is active |
| `TimelineRail` | `:520-566` | Vertical rail, newest 8 | `mission.timeline` | index 0 dot in accent |
| `UnreadableNotice` | `:570-583` | Warning line | `snapshot.unreadable` | |
| Hero: "Nothing running" | `:80-84` | Empty state | `isFullyEmpty` (`:61`) | |

**This is the app's flagship screen and it has not one actionable affordance.** See Recommendation R4.

---

## A.5 — Tasks — 9 controls

`TasksView.swift`. `PageScaffold` header pinned (`:24-39`), list fills-or-scrolls below.

| # | Label | file:line | Type | What it does | CLI | States | AX |
|---|---|---|---|---|---|---|---|
| 1 | ↻ **Refresh** | `:106-112` | Button (`Label` — has text) | `controller.refresh()` | `nexus task list` | always enabled | ⚠️ implicit |
| 2 | "Add a task…" | `:190-201` | `TextField` | Binds `newTitle`; `.onSubmit(submit)` | — | | ⚠️ implicit |
| 3 | **Add** | `:203-205` | Button, `.accent` compact | Submits the title | `nexus task add "<title>"` | **disabled when trimmed title empty** (`:205`) | ⚠️ implicit |
| 4 | **Start** | `:357-360` | Row action | → `.inProgress` | `nexus task` status transition | rendered only when not already in that status (`:309-311`) | ⚠️ implicit |
| 5 | **Block** | same | Row action | → `.blocked` | same | same | ⚠️ implicit |
| 6 | **Done** | same | Row action, `.accent` tone | → `.done` | `nexus task done` | same | ⚠️ implicit |
| 7 | **Cancel** | same | Row action | → `.cancelled` | same | same | ⚠️ implicit |
| 8 | 🗑 trash | `:362-369` | Row action, `.danger` | Opens confirmation | `nexus task` remove | always | ✅ `"Delete task"` (`:369`) |
| 8a | **Delete** (destructive) | `:373-375` | `confirmationDialog` | Actually deletes | same | modal | ⚠️ implicit |
| 9 | ✕ | `:231-238` | Banner dismiss | `controller.error = nil` | — | only when `error != nil` **and** list non-empty | ✅ `"Dismiss"` (`:238`) |

Non-interactive: `ProgressSummary` bar (`:155-177`), `EmptyStatusRow` "TO DO — Empty" (`:252-267`), `CountPill` per bucket, `StatusDot` per row, strikethrough on settled titles (`:330`), relative timestamp (`:350`).

States: `loadingState` spinner (`:116-124`), `errorState` + **Retry** (`:126-140`, an extra button in the error branch only), hero "No tasks yet" (`:47-51`), hero "No nexus executable" (`:90-94`).

---

## A.6 — Sessions — 4 control definitions

`SessionsView.swift`. Master/detail: 340pt list pane + hairline + flexible detail pane (`:140-150`).

| # | Label | file:line | Type | What it does | CLI | States | AX |
|---|---|---|---|---|---|---|---|
| 1 | ↻ **Refresh** | `:81-86` | Button | `controller.refresh()` | `nexus session list` | | ⚠️ implicit |
| 2 | Session card (×N) | `:222-306`, tap at `:242` | Row button | `selectedSessionId = session.id`; detail pane reloads via `.task(id:)` (`:189-197`) | `nexus session show <id>` | selected = 1.4pt `accentDefault` @0.6 border | ⚠️ implicit (name + metrics) |
| 3 | **Resume** | `:334-335` | Button, `.accent` | **`{}` — DOES NOTHING** | would be `chat --resume <id>` | always enabled, always inert | ⚠️ implicit |
| 4 | **Replay** | `:336-337` | Button, `.neutral` | **`{}` — DOES NOTHING** | `nexus replay` exists (`index.ts:777`) | always enabled, always inert | ⚠️ implicit |

Non-interactive: count pill (`:79`), per-row `Metric`s turns/tok/cost, provider dot, `SessionDetailCard` metric grid (`:341-369`), `RunRow` list (`:395-428`), `formatCount` k/m abbreviation (`:432-441`).

States: loading (`:96-104`), error + **Retry** (`:106-121`), non-fatal stale banner (`:123-136`), hero "No sessions yet" (`:53-57`), hero "Select a session" (`:177-181`), hero "No nexus executable" (`:33-37`).

**#3 and #4 are the two most prominent buttons on the screen and both are no-ops.** The screenshot shows "Resume" rendered as the loudest accent-filled control on screen. See R1.

---

## A.7 — Git — 8 controls

`GitView.swift`. Header pinned via `PageScaffold` (`:38-42`); four action cards stack in a `ScrollView`.

| # | Label | file:line | Type | What it does | CLI | States | AX |
|---|---|---|---|---|---|---|---|
| 1 | ↻ **Refresh** | `:91-97` | Button | Re-reads staged/working state | local `git rev-parse` / `diff --quiet` / `diff` (`:175-200`) — **not** `nexus` | | ⚠️ implicit |
| 2 | **Explain diff** | `:308` | `RunButton`, `.accent` | Runs, renders `explanation` | `nexus explain -o json` (`:325`) | idle / **spinner while running** (`:262-267`) / success `CodeBlock` / failure red text; **whole card hidden when tree is clean** (`:300-303`) | ⚠️ implicit |
| 3 | **Review changes** | `:379` | `RunButton`, `.accent` | Runs, renders summary + severity-tagged comments | `nexus review -o json` (`:414`) | same four states; "No issues flagged." when comments empty | ⚠️ implicit |
| 4 | **Generate message** | `:509` | `RunButton`, `.accent` | Produces a Conventional Commit message | `nexus commit -o json` (`:558`) | same four states | ⚠️ implicit |
| 5 | **Commit** | `:521-527` | `RunButton`, `.danger` | Opens confirmation | — | **disabled when nothing staged** (`:525`) | ⚠️ implicit |
| 5a | **Commit** (destructive) | `:548-552` | `confirmationDialog` | Regenerates the message from the staged diff and applies it | `nexus commit --approve` (`:570`) | modal; the honesty note at `:531` warns the applied message may differ from the one shown | ⚠️ implicit |
| 6 | "main (optional)" | `:607-618` | `TextField`, max 200pt | Binds `baseRef` | `--base <ref>` (`:645`) | | ⚠️ implicit |
| 7 | **Generate PR description** | `:622` | `RunButton`, `.accent` | Renders title + body | `nexus pr -o json` (`:647`) | four states | ⚠️ implicit |

Non-interactive: repo status card `staged` / `working tree` metrics + "clean" pill (`:111-129`), diff preview `CodeBlock`s capped at 160pt with 2-axis scroll, per-comment severity pills (`:430-436`).

States: hero "Not a git repository" (`:47-51`), hero "No nexus executable" (`:73-77`), "Checking repository state…" spinner (`:101-109`).

---

## A.8 — Accounts — 7 control definitions (× N providers)

`AuthView.swift`. `ProviderRow` renders exactly one action set per `provider.kind` (`:294-356`) — never a generic "sign in".

| # | Label | file:line | Type | Shown when | What it does | CLI | States | AX |
|---|---|---|---|---|---|---|---|---|
| 1 | **Sign in with browser** | `:311` | Button, `.accent` compact | `.oauth`, signed out | Starts streaming login | `nexus login <provider>` | | ⚠️ implicit |
| 2 | **Connect** | `:311` (same Button, title varies) | Button, `.accent` compact | `.cloudSso`, signed out | same | delegates to `aws sso login` / `gcloud auth login` | | ⚠️ implicit |
| 3 | **Sign out** | `:361-362` | Button, `role: .destructive`, `.danger` | `.oauth`/`.cloudSso`/`.apiKey`, signed in | Revokes | `nexus logout <provider>` | | ⚠️ implicit |
| 4 | "API key" | `:327-329` | **`SecureField`**, `.roundedBorder` | `.apiKey`, signed out | Binds `keyDraft` | key written to child stdin only (`keys set --stdin`) | | ⚠️ implicit |
| 5 | **Save** | `:330-332` | Button, `.accent` compact | with #4 | Writes the key | `nexus keys set --stdin` | **disabled when draft empty or already saving** (`:332`); sibling `ProgressView` while saving (`:333-335`) | ⚠️ implicit |
| 6 | "Paste the code shown in your browser, if asked" | `:393-396` | `TextField`, `.roundedBorder` | During an in-flight OAuth flow | Binds `pastedCode` | fed to the live login process | | ⚠️ implicit |
| 7 | **Submit** | `:397-399` | Button compact | with #6 | Submits the pasted code | | **disabled when empty** | ⚠️ implicit |
| 8 | **Cancel** | `:400-401` | Button, `role: .cancel`, `.danger` | during an in-flight flow | Cancels **both** the stream task and the controller's record (`:184-188`) | kills the `nexus login` process | | ⚠️ implicit |

`.cliDelegate` providers (claude-code, codex) get **no controls at all** — only a ✓/✗ status line (`:339-351`). Correct: there is nothing to do here.

Non-interactive: `KindBadge` OAUTH / API KEY / CLI SESSION / CLOUD SSO (`:409-425`), `expires ~8h` pill (`:267-269`), the CLI's verbatim `detail` line (`:275-280`), `OAuthProgress` `CodeBlock` of streamed lines capped at 140pt (`:389`), signing-in accent border (`:285-291`), fatal `ErrorBanner` (`:427-444`).

States: "Loading auth status…" (`:87-93`), hero "No providers found" (`:94-99`), hero "No nexus executable" (`:29-33`).

---

## A.9 — Integrations — **1 control**

`IntegrationsView.swift`.

| # | Label | file:line | Type | What it does | CLI | AX |
|---|---|---|---|---|---|---|
| 1 | ↻ **Refresh** | `:73-79` | Button | Reloads MCP + tools + hooks concurrently (`:246-252`) | `nexus mcp list`, `nexus mcp tools`, `nexus tools list`, `nexus config get hooks` | ⚠️ implicit |

Everything else is read-only:

| Element | file:line | States |
|---|---|---|
| `McpServerRow` | `:351-390` | connected (accent "N tools" pill) / **enabled-but-failed** (danger "failed" pill + `StatusDot` failed + verbatim error) / **declared-but-disabled** (neutral "disabled" pill, 0.55 opacity, never an error) |
| `ToolGroupSection` | `:406-435` | count pill `.neutral` when enabled, `.warning` when not |
| `IntegrationHintRow` | `:439-456` | explains *why* a group is greyed — missing package / binary not on PATH |
| `NexusToolRow` | `:458-494` | dimmed to 0.55 if group disabled **or** integration unavailable; permission pill read=neutral, network=accent, write=warning, **exec=danger** (`:485-493`) |
| `HookRow` | `:311-339` | event pill, command+args, matcher, `fail-open` warning pill, timeout ms |
| Hooks states | `:187-226` | `.loading` / `.loaded` / `.notExposed` (honest fallback, `:193-198`) / `.failed` |

**The screenshot for this tab shows only a macOS Documents-access permission dialog** — the content never loaded. That dialog is a system TCC prompt triggered by `NSOpenPanel`/file access, not app UI.

There are **no toggles** to enable/disable an MCP server, a tool group, or a hook — even though the CLI exposes `nexus config set` and `nexus mcp` mutations. Everything on this screen is a dead end. See R5.

---

## A.10 — Settings — 24 controls

`RootView.swift:514-589`.

| # | Label | file:line | Type | What it does | CLI | States | AX |
|---|---|---|---|---|---|---|---|
| 1-7 | Meridian, Studio, Cinder, Daylight, Basalt, Vantage, Nightfall | `:532-540`; swatch `:614-661` | **`.onTapGesture` on a `VStack`** | `workspace.themeId = candidate.id` | ⚠️ App-local `UserDefaults` only — never written to `tui.theme` | selected = 2pt `accentDefault` border + ✓ badge; unselected = 1pt subtle | ❌ **NO ROLE AT ALL** — not a `Button`, no `AXButton`, no keyboard focus, no VoiceOver name |
| 8-23 | Nexus Noir, Paper Nexus, Solarized…, Contrast Max AAA, Synthwave Grid, Neon, Midnight, Vampire, Retro Amber, Pastel, Frost, Matrix, Vivid, Rose, Forest (16 total) | `:547-558` | same | same | mirrors the CLI's 16 palettes | same | ❌ **same** |
| 24 | **Change Directory…** | `:563-569` | Button, `SoftButton(.compact)` | Same `presentDirectoryPicker` as sidebar #2 | sets `--cwd` for everything | | ⚠️ implicit |

Non-interactive: the Project `Card` with `Directory` / `nexus` / `OMC` rows (`:572-583`, `LabeledLine:591-609`), text-selectable, monospaced.

**23 theme swatches are `onTapGesture` on a plain `VStack`.** That is strictly worse than an unnamed `AXButton`: assistive tech sees *no control at all*, and the entire theme picker is unreachable by keyboard.

---

## A.11 — Sheets, popovers, dialogs, menus

| Surface | file:line | Controls | AX |
|---|---|---|---|
| **Approval sheet** | `ApprovalSheet.swift:13-184` | **Deny** (`:127`, `role: .destructive`, `.danger`) · **Allow** (`:129`, `.accent`, `.keyboardShortcut(.defaultAction)`) | ⚠️ implicit ×2 |
| | | Sized `minWidth 480 / ideal 560 × minHeight 320 / ideal 440` (`:42`). Action bar is a `safeAreaInset` so a long diff can never push it off-window (`:47-49`). Permission tier drives icon + colour + verb (`:140-174`). | |
| **Dropdown popover** (provider / model / + add) | `ConversationView.swift:714-780` | One row per option (`:742-779`); `minWidth 220`, `maxHeight 260` | ⚠️ implicit |
| | | Unavailable options stay **visible, dimmed to 0.45, `.disabled`, with the reason on `.help`** (`:770-778`) — the documented reason a native `Menu` was rejected (`:648-653`). Empty state text varies by caller. | |
| **Directory picker** | `RootView.swift:100-112` | Native `NSOpenPanel`, directories only, prompt "Open" | System-provided |
| **Delete-task confirmation** | `TasksView.swift:373-375` | **Delete** (destructive) | ⚠️ implicit |
| **Commit confirmation** | `GitView.swift:548-552` | **Commit** (destructive) + explanatory message | ⚠️ implicit |
| **File menu** | `NexusApp.swift:31-34` | **New Conversation** ⌘N → `conversation.clear()` | System |
| **Run menu** | `NexusApp.swift:35-43` | **Stop** ⌘. (disabled when not running) · divider · 8 tab items (Chat…Settings) | System |
| **Setup banner** | `RootView.swift:355-375` | None — warning strip when the `nexus` binary is missing | ⚠️ icon not hidden |

---

## A.12 — Totals

| Screen | Interactive controls | Missing an explicit AX label |
|---|---:|---:|
| Sidebar | 9 | 0 ✅ |
| Status bar | 0 | — |
| Chat (strip + empty state + composer + transcript) | 23 | 23 (5 are ❌ **none**: chip-remove, reasoning, clear, send, stop, copy → 6) |
| Agents | **0** | — |
| Tasks | 9 | 7 |
| Sessions | 4 | 4 |
| Git | 8 | 8 |
| Accounts | 8 | 8 |
| Integrations | 1 | 1 |
| Settings | 24 | 24 (**23 have no control role at all**) |
| Sheets / dialogs / menus | 6 + 10 menu items | 6 |
| **TOTAL** | **≈ 102 control definitions** | **≈ 92 without an explicit label** |

**Explicit `.accessibilityLabel` exists on exactly 4 call sites** covering 10 controls:
`RootView.swift:264` (project switcher), `:346` (all 8 nav rows), `TasksView.swift:238` (banner dismiss), `:369` (delete task). Plus `DesignSystem.swift:314` on the non-interactive `StatusDot`.

**Icon-only buttons with no name whatsoever (7):**
1. `ConversationView.swift:921-924` — chip remove ✕
2. `ConversationView.swift:395-402` — reasoning toggle 🧠
3. `ConversationView.swift:404-411` — clear transcript 🗑
4. `ConversationView.swift:316-324` — send ↑
5. `ConversationView.swift:308-314` — stop ⏹
6. `ConversationView.swift:1072-1084` — copy answer 📄
7. `TasksView.swift:231-238` — (has a label; listed for completeness)

**29 of 34 `Image(systemName:)` instances are neither `.accessibilityHidden(true)` nor labelled** — all 5 hidden ones are in `RootView.swift`. Every decorative glyph elsewhere (hero icons, badge icons, banner triangles, status dots, `KindBadge`, `IntegrationHintRow`) is announced by its raw SF Symbol name.

---

## A.13 — Controls with no CLI backing (the house rule violations)

The project rule is: *every capability must exist as a CLI command first.*

| Control | file:line | Problem | Severity |
|---|---|---|---|
| **Effort picker (Off/Low/Med/High)** | `ConversationView.swift:377`, `:506-559` | `--effort` **is not a flag**. It is absent from `FLAG_SPEC.value` (`packages/cli/src/index.ts:68-128`). Reasoning effort exists in the CLI **only** as an interactive `/effort` picker inside `nexus tui` (`packages/cli/src/commands.ts:3766`, `:3872-3878` `onEffortChange`), which `chat --persistent` never mounts. | 🔴 **Fabricated capability** |
| ↳ **and the preview lies** | `ConversationView.swift:331-341` | `commandPreview` splices `--effort <level>` into the displayed string, but `persistentSessionArguments()` (`AppState.swift:260-270`) and `oneShotArguments()` never add it. The user is shown a command that is **not** the command that runs. This defeats the entire stated purpose of the preview ("the UI can never feel like a black box relative to the terminal", `:18-19`). | 🔴 **Preview is dishonest** |
| **Sessions → Resume** | `SessionsView.swift:334-335` | `Button("Resume") {}` — empty closure. Styled `.accent`, the loudest control on the screen. | 🔴 **Dead primary action** |
| **Sessions → Replay** | `SessionsView.swift:336-337` | `Button("Replay") {}` — empty closure. `nexus replay` exists (`index.ts:777`). | 🔴 **Dead action** |
| **"Ask first" readout** | `ConversationView.swift:482-499` | Correctly documented as inert *in code*, but rendered as a bordered, padded, rounded pill in the exact position a toggle would occupy. Nothing visually distinguishes it from control #13/#14 beside it. | 🟠 **Reads as a control** |
| **Theme picker** | `RootView.swift:532-558` | Writes only `UserDefaults["nexus.themeId"]`. The CLI has `tui.theme` (`packages/config/src/schema.ts:146`) and `nexus config set`. GUI and terminal will always disagree. | 🟠 **Divergent state** |
| **Git → Refresh** | `GitView.swift:91-97` | Reads repo state via a **local `git` subprocess** (`LocalGit:206-236`), not `nexus`. Documented and defensible (there is no read-only `nexus git status`), but it is a second execution path the CLI does not own. | 🟡 **Documented exception** |

### CLI capabilities with no UI at all

| CLI command | Exists at | GUI surface |
|---|---|---|
| `nexus agent --role <r>` | `index.ts:299`; `ConversationController.role` exists at `AppState.swift:164` | **None.** The property is settable but no control sets it. Agent mode can never reach the OODA framework from the GUI. |
| `nexus roles` | `index.ts:327` | None — the role list is never fetched |
| `nexus consensus` | `index.ts:521` | None — `RunMode` has only ask/agent/compare/race |
| `nexus chain` | `index.ts:532` | None |
| `nexus route explain\|test` | `index.ts:546` | None |
| `nexus plan` | `index.ts:316` | None |
| `nexus search` / `index` | `index.ts:704`, `:720` | None |
| `nexus memory` | `index.ts:491` | None |
| `nexus doctor` | `index.ts:663` | None — would be the natural fix path for the "No nexus executable" hero |
| `nexus history` | `index.ts:655` | None |
| `nexus cache stats\|clear` | `index.ts:748` | None |
| `nexus receipt` / `trace` | `index.ts:788`, `:804` | None |
| `nexus rbac/policy/usage/audit/budget` | `index.ts:871-935` | None |

---

# PART B — DESIGN ANALYSIS

## B.1 — The rule that should govern vertical composition

The dead-space symptom is being fixed elsewhere. Here is the **rule** it should be fixed *to*, so the fix survives the next screen anyone adds.

> **A screen is a fixed-height header, plus exactly one region that owns all remaining height.
> That region either scrolls (it has more content than fits) or it centres (it has less).
> It never top-aligns short content inside a tall scroll view.**

The mechanism already exists — `PageScaffold` (`DesignSystem.swift:519-536`) — and its doc comment states the rule precisely. Adoption is what is incomplete:

| Screen | Uses `PageScaffold` | Notes |
|---|---|---|
| Tasks | ✅ `:24` | correct |
| Git | ✅ `:38` | correct |
| Integrations | ✅ `:30` | correct |
| Agents | ✅ `:71` | correct |
| **Sessions** | ❌ | hand-rolled `VStack` + `headerBar` + `Group` (`:21-41`) |
| **Accounts** | ❌ | hand-rolled `VStack` + banner + `Group` (`:78-125`) |
| **Settings** | ❌ | bare `ScrollView` with everything inside (`:521-587`) — the classic failure the scaffold exists to prevent |
| **Chat** | ❌ by design | uses `safeAreaInset` top + bottom (`:65-81`) — a legitimately different and correct pattern |

Three corollaries the rule implies, all currently violated somewhere:

1. **Padding goes before the flexible frame, never after.** `.frame(maxHeight: .infinity).padding(32)` requests *all available space plus 64pt* and silently evicts siblings. `HeroEmptyState` gets this right (`DesignSystem.swift:489-495`) and says why.
2. **A pinned header must be the thing you need while scrolling.** Tasks pins the add-field (right). Agents pins the running-count HUD (right). Sessions pins a title + a Refresh button (a title is not worth pinning).
3. **An empty state is content, not an absence.** It should occupy the region, not sit at the top of it. Chat additionally bottom-aligns its hero (`:115-118`) so the void lands *above* it rather than between hero and composer — a genuinely good detail worth generalising.

---

## B.2 — Information hierarchy

**What works.** Sidebar grouping into WORK / HISTORY / SETUP (`AppState.swift:30-60`) is the single best structural decision in the app. Its rationale — Settings must not carry the same weight as Chat — is exactly right, and the three-group split maps to real usage frequency.

**What breaks.**

- **Every screen opens on chrome, not content.** Tasks: `TASKS` label → subtitle → progress card → add field → six status headers → *then* one task. Sessions: `SESSIONS` → subtitle → count → Refresh → *then* the list. The user's actual object is fourth or fifth in reading order.
- **`SectionHeader` is used at three incompatible altitudes** with identical styling (11pt semibold uppercase, muted): as a page title (`TasksView:102` "TASKS"), as a section title (`AuthView:136` "Signed in"), and as a sub-section title (`GitView:298` "Explain"). Three levels of hierarchy rendered identically means there is effectively one level. `Kind.title` (15pt) exists and is used 8 times; `Kind.headline` (13pt) exists and is used **twice**. The ramp is defined and unused.
- **Uppercase micro-caps everywhere.** `SectionHeader` uppercases (`:227`), `Metric` uppercases (`:337`), `StatusMetric` uppercases, `ReadoutMetric` uppercases, `KindBadge` uppercases, `OriginBadge` and `VerdictBadge` are micro. On the Sessions screenshot, `TURNS`/`TOK` appear ~24 times. When everything is a small-caps label, small-caps stops meaning "label".
- **Settings inverts the app's own rule.** It is the one screen that uses a real 15pt `Kind.title` for its heading ("Theme", `:524-526`) — and it is the one screen that reads correctly. Every other screen uses the 11pt uppercase treatment for the same job.

---

## B.3 — Spacing rhythm

The `Space` scale (4/6/8/12/20/32) is HIG-derived and correct. Usage is not.

| Token | Uses | Verdict |
|---|---:|---|
| `Space.sm` (6) | **120** | Massively over-used — it is the default for *everything* |
| `Space.md` (8) | 52 | |
| `Space.xs` (4) | 32 | |
| `Space.lg` (12) | 32 | |
| `Space.xl` (20) | 25 | |
| `Space.xxl` (32) | 3 | |

`Space.sm` at 120 uses against `Space.lg` at 32 means the app has **one gap size**. HIG's own distinction — 6pt *within* a group, 8pt *between* groups — is not being expressed, so groups do not read as groups. `ConversationView.swift:137` already discovered this independently and hardcoded `24` between transcript turns with a comment explaining that `Space.lg` was wrong for that job — which is the correct diagnosis and the wrong fix. **The scale needs a seventh step (a real "between sections" value, 16 or 24) rather than a magic number at one call site.**

**Off-scale type is worse.** 43 raw `.system(size:)` literals live outside `DesignSystem.swift`:

```
10 × size 11      8 × size 10      7 × size 9       4 × size 12
 3 × size 8       3 × size 12.5    2 × size 7       2 × size 26
 1 × size 16      1 × size 14      1 × size 13      1 × size 11.5
```

Twelve of these (sizes 7, 8, 9) are **below the 10pt floor that `Kind.micro`'s own doc comment declares must never be crossed** (`DesignSystem.swift:53`). The 7pt chevron (`ConversationView.swift:687`) and the 7pt chip-remove ✕ (`:922`) are the worst — a 7pt glyph is not a legible control target on any display.

`Radius.pill` is defined and used **zero** times (`Capsule()` is used directly instead).

---

## B.4 — Control grouping, and exactly where the top strip breaks

The strip's stated logic (`ConversationView.swift:350-359`) is: *scrollable leading cluster (things with unbounded count), fixed trailing cluster (things that must never scroll out of reach).*

**The logic is inverted in practice.**

Measured against the app's own 900pt minimum width (`NexusApp.swift:17`):

```
content column          = 900 − 248 (sidebar) − 1 (hairline)        = 651 pt
horizontal padding      = Space.md × 2                              =  16 pt
fixed trailing cluster  ≈ "Ask first" 73 + SESSION 101
                          + brain 24 + trash 23 + 4 gaps 32         = 253 pt
Spacer(minLength:)                                                  =   6 pt
                                                          ─────────────────
available to the scrolling leading cluster                          = 376 pt

leading cluster intrinsic width
  ModePicker  (Ask|Agent|Compare|Race)                              ≈ 224 pt
  EffortPicker (Off|Low|Med|High)                                   ≈ 162 pt
  provider picker (fixed width 104)                                 = 104 pt
  model picker    (fixed width 136)                                 = 136 pt
  three Space.md gaps                                               =  24 pt
                                                          ─────────────────
                                                                    ≈ 650 pt
```

**~274pt overflows.** In scroll order that means the **provider picker and the model picker — the two controls that determine which model answers, and the only two that change the actual command — are the first things to scroll out of sight.** What stays pinned instead:

- **"Ask first"** — a static, non-functional readout (73pt)
- **`SESSION a1b2c3d4`** — a truncated id you can neither click nor copy (101pt)

This holds anywhere below roughly 1170pt. At the 1280pt default (`NexusApp.swift:28`) there is ~756pt available and nothing clips — which is why it has not been caught. **The screen is broken at its own declared minimum width and fine at its default.**

Two further grouping problems:

- **Effort sits between Mode and Provider.** Mode and provider/model are one decision ("what runs this prompt"); effort is a tuning parameter. It splits the group it should follow. And it is the one control with no CLI backing.
- **Mode and Effort are two segmented controls of different heights sitting adjacent** — Mode uses `Space.md`/5pt padding at 11.5pt with `Radius.control + 2`; Effort uses 6/4.5pt padding at 10pt with `Radius.control`. The file's own comment claims they share "the same visual language" (`:520-522`). They do not: different type size, different padding, different corner radius, different container inset (2 vs 1.5).

---

## B.5 — Colour and accent weight

**The periwinkle problem is fixed.** `SidebarNavRow` now fills with `accentMuted` (`#35406B` in Meridian) and carries a 3pt `accentDefault` rail, with the label colour *computed* by `Color.readableText` rather than assumed (`RootView.swift:294-296`). That is the correct technique and it is the second time this file has been burned by assuming `accentFg` pairs with `accentMuted` — the comment at `DesignSystem.swift:254-260` documents the 1.5–3.7:1 measurement that caused it. Good.

**What accent still over-claims.** `accentDefault` (`#6E9BFF`) currently means all of:

| Meaning | Where |
|---|---|
| selected nav item | `RootView.swift:332` (rail) |
| selected segment (Mode) | `ConversationView.swift:828` |
| selected segment (Effort) | `ConversationView.swift:542` |
| primary action | `SoftButton(.accent)` — Add, Save, Retry, Allow, Resume, all four Git run buttons |
| focus ring | `chromeBorderFocus`, composer `:292` |
| "running" | `StatusDot` `:292`, `AgentCard` border `:316`, glow `:369` |
| "selected session" | `SessionsView.swift:286` |
| an emphasised number | `Metric(emphasis: true)` — cost, percentages |
| progress fill | `ProgressView().tint` ×2 |
| the assistant's gutter rule | `ConversationView.swift:1054` |
| hero glyph gradient | `HeroEmptyState:472` |
| link colour | `textLink` (a near-neighbour, `#7EA2FF`) |

Eleven distinct meanings on one hue. On the Sessions screenshot the selected card border, the "Resume" button fill, and the cost figures all read as the same signal — and one of those three is a no-op.

**The discipline that already exists and should be extended:** `OriginBadge` (`AgentsView.swift:392-403`) deliberately refuses the primary accent for role runs and reaches for `accentSecondary`, with a comment stating exactly why ("the theme's primary accent already means *running* everywhere else on this screen"). That reasoning applies app-wide and is applied in one place.

**Contrast.** All recommendations below respect the floors asserted in `Tests/NexusKitTests/AppThemeTests.swift` — body ≥ 4.5:1 on `surfaceBase` (`:85-90`), secondary ≥ 3:1 (`:92-97`), `SoftButton` neutral and accent ≥ 4.5:1 (`:187-199`), danger and warning pills ≥ 4.5:1 (`:201-212`). Nothing here proposes a new colour value; every recommendation is a *reassignment* of existing tokens.

---

## B.6 — Button shapes and sizes

One primitive, `SoftButton` (`DesignSystem.swift:359-408`), two sizes, three tones. Hover/pressed opacities come from `AppTheme.stateLayers` rather than eyeballed constants — good.

**Problems.**

- **Only two sizes, and the app needs three.** `.compact` (5pt vertical) and `.regular` (7pt vertical). A 5pt-vertical button at `Kind.caption` (11pt) yields roughly a 21pt tall hit target. **macOS HIG asks for 28pt minimum for a primary control**; Apple's own accessibility guidance asks 44×44 for touch. The Tasks row actions (Start / Block / Done / Cancel, `TasksView.swift:359`) and both header Refresh buttons are all `.compact`.
- **Bypassed entirely 9 times.** `.buttonStyle(.plain)` is used for: both segmented controls, `DropdownPicker`, `SuggestionChip`, `SessionRow`, `ToolRow`, `Chip`'s remove ✕, `ErrorBanner`'s dismiss, `ProjectSwitcherRow`, `SidebarNavRow`. Several of these are legitimately custom; `Chip`'s ✕ (7pt glyph, no padding, no hover state, no label) is not.
- **Radius is inconsistent at the same altitude.** `Radius.control` = 6 for buttons and fields; `ModePicker`'s container uses `Radius.control + 2` = 8 (`:837`) while `EffortPicker`'s uses 6 (`:551`); `ModePicker`'s selected segment uses 6 while `EffortPicker`'s uses `Radius.control - 2` = 4 (`:541`). Four different radii across two controls that sit 8pt apart.
- **No focus ring on any custom button.** `SoftButton`'s doc comment promises "a focus-visible border" (`:352`); `makeBody` never reads `@FocusState` or `isFocused`, and draws only a static `chromeBorderSubtle` stroke on `.neutral`. Keyboard focus is invisible everywhere except the composer.
- **Destructive weight is uneven.** "Clear transcript" (`ConversationView.swift:404-411`) is `.neutral` with no confirmation. "Delete task" is `.danger` *with* confirmation. "Sign out" is `.danger` with **no** confirmation. "Commit" is `.danger` with confirmation. The pattern should be predictable and is not.

---

## B.7 — Iconography

The brief is right that the sidebar mixes metaphors and weights. Concretely (`AppState.swift:67-78`):

| Tab | Symbol | Family | Weight in the render |
|---|---|---|---|
| Chat | `bubble.left.and.bubble.right` | outline, 2 overlapping shapes | light |
| Agents | `person.3.sequence` | outline, 3 figures + implied motion | very light, visually busiest |
| Tasks | `checklist` | outline, lines + marks | light |
| Sessions | `clock.arrow.circlepath` | outline, clock + arrow | medium |
| Git | `arrow.triangle.branch` | **pure geometry**, no object | medium |
| Accounts | `person.badge.key` | outline, figure + badge | light |
| Integrations | `puzzlepiece.extension` | **metaphor** (puzzle piece = plugin) | medium |
| Settings | `slider.horizontal.3` | **control affordance** | medium |

Four different conceptual registers — literal object (clock, checklist), abstract geometry (branch), metaphor (puzzle), and control affordance (sliders). `person.3.sequence` and `person.badge.key` both lead with a human figure for two unrelated concepts (concurrency, credentials). All are rendered at `.system(size: 12, weight: .medium)` in a 16pt frame (`RootView.swift:302-303`), which is correct and consistent — the inconsistency is in symbol *choice*, not rendering.

**Elsewhere the same glyph carries different meanings, and different glyphs carry the same meaning:**

- `exclamationmark.triangle` appears in 7 places at 4 sizes (9, 10, 26pt, and `.fill` at default) meaning variously: fatal error, non-fatal warning, stale-data caveat, missing integration, and "not a git repository".
- Error uses `exclamationmark.octagon.fill` in the transcript (`:1129`) but `exclamationmark.triangle.fill` in the setup banner (`RootView.swift:361`) and Auth's `ErrorBanner` (`:433`).
- `terminal` is the hero icon for "No nexus executable" on four screens but also the inline glyph for the command preview (`:231`) and the `.cliDelegate` auth kind (`AuthView.swift:230`).

---

## B.8 — Empty states

**The strongest part of the app.** `HeroEmptyState` (`DesignSystem.swift:453-497`) is a genuine hero: 190pt radial `accentGlow`, a 34pt light-weight glyph in the theme's `accentGradient`, `Kind.hero` title, body message capped at 430pt. Every empty state uses it. Every message names the actual `nexus` command that would populate the screen. That is excellent and rare.

**Two gaps.**

1. **Only Chat's empty state offers an action.** Chat has four suggestion chips + three key hints (`ConversationView.swift:191-206`). Every other empty state is `HeroEmptyState` with `Actions == EmptyView` — the convenience init at `:499-503`. "Not a git repository" cannot offer `git init`. "No tasks yet" says *"Add one above"* while pointing at a field that is above the fold in a pinned header (fine) but offers no button. "No nexus executable" appears on **five** screens and never offers `nexus doctor`, a "Locate…" picker, or a docs link — despite that being the one state the user genuinely cannot resolve without help.
2. **Empty-state message tone drifts.** "Nothing running" (Agents) vs "No sessions yet" (Sessions) vs "No tasks yet" (Tasks) vs "No providers found" (Accounts) vs "Not a git repository" (Git) vs "Select a session" (Sessions detail). Six phrasings for what is structurally one category. The "No nexus executable" message is verbatim-duplicated in **five** files.

---

## B.9 — Loading and error states

**Loading** is handled in four visually different ways:

| Pattern | Where |
|---|---|
| Centred `ProgressView` + caption, fills the region | `TasksView:116-124`, `SessionsView:96-104`, `GitView:101-109`, `IntegrationsView:83-91` — **4 near-identical copies** |
| Inline `HStack` spinner + text, does *not* fill | `AuthView:87-93` |
| Bare `ProgressView().controlSize(.small)` with no text | `SessionsView:377`, `IntegrationsView:191`, `AuthView:333` |
| Spinner *inside* the button that triggered it | `GitView` `RunButton:262-267` — the best of the four |
| Mini spinner inside a picker | `ConversationView:680-684` |

**There is no skeleton or shimmer anywhere.** Sessions loads 610 rows (per the screenshot's count pill) behind a single centred spinner.

**Errors** are handled in five different ways, with **three separately-defined `ErrorBanner` types**:

| Type | file:line | Style | Dismissible |
|---|---|---|---|
| `ErrorBanner` (Tasks) | `TasksView.swift:218-245` | warning colours, rounded, ✕ button | ✅ |
| `ErrorBanner` (Integrations) | `IntegrationsView.swift:502-520` | warning colours, rounded, **no ✕** | ❌ |
| `ErrorBanner` (Auth) | `AuthView.swift:427-444` | **error** colours, card radius, `.fill` icon | ❌ |
| `errorBanner` (Sessions) | `SessionsView.swift:123-136` | warning, full-bleed, no radius | ❌ |
| `errorState` + Retry | `TasksView:126-140`, `SessionsView:106-121` | 26pt glyph + message + Retry | n/a |
| `ActionErrorText` | `GitView.swift:273-283` | bare red text, no container | ❌ |
| `SetupBanner` | `RootView.swift:355-375` | warning bg, full-bleed, bottom hairline | ❌ |

`IntegrationsView`'s own comment (`:498-501`) acknowledges the duplication and declines to fix it as out of scope. It is now four copies.

**The one genuinely excellent error decision:** `DiagnosticClassifier` (`NexusKit/DiagnosticClassifier.swift`) triages stderr into hidden / quiet / warning so amber only appears when something is actually wrong (`ConversationView.swift:1279-1330`). That is the right model and nothing else in the app uses it.

---

## B.10 — Density

Reading the eight screenshots at 1440×900 pt:

| Screen | Information density | Note |
|---|---|---|
| Chat (empty) | Very low | one hero, four chips |
| Agents (empty) | Very low | one hero |
| Tasks (1 task) | Very low | ~5 rows of chrome, 1 row of content |
| Sessions (610) | **Appropriate** | the only screen at native density |
| Git (not a repo) | Very low | one hero |
| Accounts (8 providers) | **Appropriate**, trending crowded | 3 signed-in + 5 available cards |
| Integrations | (blocked by TCC dialog) | |
| Settings (23 swatches) | **Appropriate** | |

The screens that *have* data are correctly dense. The problem is that the shell adds a fixed ~120pt of header chrome before any content, which is invisible at 610 sessions and dominant at 1 task. **Header chrome should scale with content, not be constant** — a title + subtitle + count + Refresh button above a single task is 5:1 chrome-to-content.

`SessionRow` (`SessionsView.swift:222-306`) is the density model to copy: name, provider dot + model, relative time, and three metrics in ~72pt of height, all legible.

---

## B.11 — Behaviour at ~900pt width

The window's declared minimum is 900×560 (`NexusApp.swift:17`). At that width the content column is **651pt**.

| Screen | At 651pt | Verdict |
|---|---|---|
| **Chat strip** | Provider + model pickers scroll out of reach (B.4) | 🔴 **Broken** |
| **Chat transcript** | `readingColumnWidth` = 660 > 651 → the cap never engages, text runs edge-to-edge minus 40pt padding | 🟠 Degraded — the cap silently stops working at exactly the declared minimum |
| **Sessions** | List pane is a **hard-coded 340pt** (`:143`). Detail pane gets 651 − 340 − 1 = **310pt**. A 36-char session UUID at `Kind.title` cannot fit; the metric rows (`turns`/`runs`/`events` then `in`/`out`/`cost`) will wrap or clip | 🔴 **Broken** — the pane is unusable |
| **Agents** | Grid `.adaptive(minimum: 300, maximum: 460)` → 2 columns at 611pt usable. Cards at 300pt with monospaced titles + 2 badges + elapsed time will truncate hard | 🟠 Degraded |
| **Settings** | `.adaptive(minimum: 168, maximum: 220)` → 3 columns. Fine | ✅ |
| **Tasks** | Row actions are 4 compact buttons + trash — roughly 240pt against 611pt available. Fine | ✅ |
| **Git** | `CodeBlock` scrolls both axes; cards are full-width. Fine | ✅ |
| **Accounts** | API-key row: `SecureField` + Save + spinner. Fine | ✅ |
| **Status bar** | `.lineLimit(1)` with `Spacer(minLength: Space.sm)`. With model + cost + ctx + session all present, the fixed `Metric`s (all `.fixedSize()`, `:346`) cannot compress — they will overflow rather than truncate | 🟠 **Untested risk** |

**Nothing in the app adapts its layout to width.** There is no `ViewThatFits`, no size-class branch, no `GeometryReader`-driven reflow. The two `.adaptive` grids are the only responsive behaviour, and both are on screens that were already fine.

---

## B.12 — What makes Settings work (the standard)

The brief is right that Settings is the best screen. Precisely why:

1. **A real title at a real size.** `Text("Theme").font(Kind.title)` — 15pt semibold, `textPrimary` (`RootView.swift:524-526`). The only screen that does this. Everywhere else the page title is 11pt uppercase muted.
2. **The subtitle earns its place.** *"7 themes designed for this window — material, elevation and gradient a terminal palette can't express."* It explains **why two catalogues exist**, which is the one thing a user would otherwise have to guess. Compare Tasks' subtitle — *"The durable task queue — nexus task list"* — which restates the title and adds a command.
3. **The content is the control.** `ThemeSwatch` (`:614-661`) renders each theme *in that theme's own tokens*: the outer wrapper previews its `surfaceSunken`, the inner tile its `surfaceRaised`, and four chips show `accentDefault`/`successFg`/`warningFg`/`errorFg`. You are not reading a list of names; you are looking at 23 live previews. This is the single best idea in the app.
4. **Selection is proportionate.** A 2pt `accentDefault` border plus a `checkmark.circle.fill` — not a fill, not a highlight. Legible without shouting. It is exactly the treatment the sidebar has now (correctly) adopted.
5. **The grid earns the full width.** `.adaptive(minimum: 168, maximum: 220)` gives 6 columns at 1280pt and 3 at 900pt with no branching.
6. **Elevation is honest.** Swatch → 4pt inset → `surfaceSunken` wrapper (`:657-658`) is a two-step surface ladder with a hairline, exactly the house rule. No shadows.
7. **It admits its own limits.** *"Kept selectable for parity with the terminal, not because they suit a window."* The UI tells you which option is the compromise.

**The transferable rule:** *show the thing, not a label for the thing; give the page one real title; let the subtitle answer the question the title raises; and make the whole tile the target.*

Applied elsewhere this would mean: Agents cards previewing live output rather than metadata; provider pickers showing the provider's dot + auth state inline (they partly do); session rows previewing the first prompt rather than a hash; tool rows showing the permission tier before you expand.

---

# PART C — PRIORITISED RECOMMENDATIONS

## C.1 — WRONG, AND MUST CHANGE

Ranked by user harm.

---

### R1 — Sessions "Resume" and "Replay" are no-ops rendered as primary actions
**`SessionsView.swift:334-337`**

```swift
Button("Resume") {}      // ← empty closure, styled .accent
Button("Replay") {}      // ← empty closure
```

The accent-filled "Resume" is the loudest control on the Sessions screen (visible in `4-sessions.png`). Clicking it does nothing, silently. A user with 610 sessions has no way to open any of them.

**Fix:** wire `Resume` to set `workspace.conversation.sessionId = session.id` + `workspace.tab = .chat` (the CLI path already exists — `--resume` at `AppState.swift:262`), and `Replay` to `nexus replay <id>`. **If wiring is genuinely out of scope for this pass, `.disabled(true)` them with `.help("Not wired up yet")` today** — an inert-looking control is honest; an accent-filled dead one is not.

---

### R2 — The effort picker fabricates a CLI flag, and the command preview lies about it
**`ConversationView.swift:337`, `:506-559`, `:377`**

`--effort` does not exist in `FLAG_SPEC` (`packages/cli/src/index.ts:68-128`). Reasoning effort is a `nexus tui`-only interactive picker (`packages/cli/src/commands.ts:3872-3878`), unreachable from `chat --persistent`. Worse, `commandPreview` splices the flag into the displayed string (`:337`) while `persistentSessionArguments()` (`AppState.swift:260-270`) never sends it — so the preview shows a command that differs from the one that runs.

This breaks the app's foundational promise, stated in its own header comment at `ConversationView.swift:18-19`: *"the exact invocation is shown in the composer, so the UI can never feel like a black box relative to the terminal."*

**Fix, in order of preference:**
1. Remove `EffortPicker` (`:377`, `:506-559`) and the splice at `:337` until the CLI grows a real `--effort` flag. Frees ~162pt in the strip, which also helps R3.
2. Or add `effort` to `FLAG_SPEC.value` and plumb it through `persistentSessionArguments()` — then the picker is real.

**Non-negotiable either way:** delete line `:337`. The preview must never show a flag the spawn does not send.

---

### R3 — At the app's own 900pt minimum, the provider and model pickers scroll out of reach
**`ConversationView.swift:370-412`**

Full arithmetic in B.4. At 651pt of content column, the leading cluster needs ~650pt and gets ~376pt. The provider and model pickers — the controls that determine which model answers — clip first. The static "Ask first" readout (73pt) and an unclickable session id (101pt) stay pinned.

**Fix (three edits, no new tokens):**
1. Move `approvalControl` (`:482-499`) out of the strip entirely — it is a status fact, and `StatusBar` is where status facts live.
2. Move the `SESSION` metric (`:390-393`) to `StatusBar` beside `MODEL`, or drop it (the session id is already in the composer's command preview).
3. Move `provider` and `model` pickers into the **fixed** trailing cluster and leave only Mode + backend chips in the scroll. Backend chips are the only genuinely unbounded element; they are the only thing that should scroll.

That returns ~174pt to the leading cluster and puts the unbounded thing in the scrollable region — which is what the file's own comment (`:350-359`) says it intended.

---

### R4 — 23 theme swatches have no control role and no keyboard access
**`RootView.swift:538`, `:556`**

```swift
ThemeSwatch(...).onTapGesture { workspace.themeId = candidate.id }
```

`.onTapGesture` on a `VStack` produces **no `AXButton`, no name, no focus ring, no keyboard activation**. The entire theme picker is invisible to VoiceOver and unreachable by Tab. This is worse than the bare unnamed `AXButton` the audit found on the nav rows, because there is no element at all.

**Fix:** wrap in `Button { workspace.themeId = candidate.id } label: { ThemeSwatch(...) }.buttonStyle(.plain)`, add `.accessibilityLabel("\(candidate.name), \(candidate.isDark ? "dark" : "light")")` and `.accessibilityAddTraits(isSelected ? .isSelected : [])`. The `.contentShape(Rectangle())` already at `:659` makes the whole tile the target once it is a real button.

---

### R5 — Six icon-only buttons have no accessible name
**`ConversationView.swift:316-324`, `:308-314`, `:395-402`, `:404-411`, `:1072-1084`, `:921-924`**

`.help()` produces a tooltip, **not** an accessibility label. Send, Stop, Reasoning toggle, Clear transcript, Copy answer, and the backend chip's remove ✕ all read as unnamed buttons. Send and Stop are the app's two most-used controls.

**Fix:** add `.accessibilityLabel(…)` to each — "Send message", "Stop the run", "Show reasoning traces" / "Hide reasoning traces", "Clear transcript", "Copy answer", "Remove \(backend) backend". Add `.accessibilityAddTraits(showsReasoning ? .isSelected : [])` to the reasoning toggle. This is the exact fix already applied at `RootView.swift:346`, applied six more times.

---

### R6 — 29 of 34 decorative SF Symbols pollute the accessibility tree
**All feature views; only `RootView.swift` hides any (5 instances)**

Every hero glyph, badge icon, warning triangle, status dot, and `KindBadge` symbol announces its raw SF Symbol name ("exclamationmark.triangle.fill", "hexagon.fill", "person.3.sequence"). `RootView.swift:304-309` documents this exact failure mode and fixes it in one place.

**Fix:** `.accessibilityHidden(true)` on every `Image(systemName:)` that sits beside text which already names it. Start with `RootView.swift:207` (the one unhidden symbol in the file that fixed the rest), `HeroEmptyState:470`, `SetupBanner:361`, all three `ErrorBanner`s, `KindBadge:416`, `IntegrationHintRow:445`, `UnreadableNotice:576`, `DiagnosticsStrip:1316`, `TurnView.errorBlock:1129`.

---

### R7 — Twelve controls render type below the app's own 10pt floor
**`ConversationView.swift:687` (7pt), `:922` (7pt), `:318`/`:404`/`:922` (8-9pt), `:399`, `:1079`, `:1211`, `AgentsView.swift:577`, `IntegrationsView.swift:446`, `AuthView.swift:416`, `TasksView.swift:235`**

`Kind.micro`'s doc comment is explicit: *"10pt is the documented minimum readable size on macOS — never go below"* (`DesignSystem.swift:53`). Forty-three raw `.system(size:)` literals bypass the scale; twelve land at 7, 8, or 9pt. The 7pt dropdown chevron and 7pt chip-remove ✕ are not legible or clickable targets.

**Fix:** raise every sub-10pt glyph to 10pt minimum. Where a glyph must read as small, use `Kind.micro` and let the *container* shrink, not the type.

---

### R8 — `SoftButton` promises a focus ring and never draws one
**`DesignSystem.swift:352`, `:385-407`**

The doc comment advertises "a focus-visible border". `makeBody` never reads focus state. Combined with R4 (23 controls with no focus at all) and the nine `.buttonStyle(.plain)` bypasses, **keyboard focus is invisible everywhere in the app except the composer**, which does it correctly (`ConversationView.swift:289-301`).

**Fix:** add `@FocusState`-driven or `isFocused`-driven `chromeBorderFocus` stroke at 2pt in `SoftButton.makeBody`, mirroring the composer's treatment. No new token needed — `chromeBorderFocus` exists in all 23 themes.

---

### R9 — Destructive actions are inconsistently gated
**`ConversationView.swift:404-411` vs `TasksView.swift:362-375` vs `AuthView.swift:361-362` vs `GitView.swift:521-552`**

| Action | Tone | Confirmed? |
|---|---|---|
| Clear transcript | `.neutral` | ❌ |
| Delete task | `.danger` | ✅ |
| Sign out | `.danger` | ❌ |
| Commit | `.danger` | ✅ |

Clear transcript destroys visible work with a `.neutral` icon button and no confirmation. Sign out invalidates credentials with no confirmation.

**Fix:** one rule — *anything that destroys work or state the user cannot trivially recreate gets `.danger` tone **and** a `confirmationDialog`.* Add confirmation to Clear transcript and Sign out; keep the other two.

---

### R10 — Four duplicated loading states and four duplicated error banners
**`TasksView:116-124` / `SessionsView:96-104` / `GitView:101-109` / `IntegrationsView:83-91`; `TasksView:218-245` / `IntegrationsView:502-520` / `AuthView:427-444` / `SessionsView:123-136`**

Four near-identical `loadingState` bodies differing only in one caption string. Four `ErrorBanner` types with three different colour treatments (`AuthView`'s uses **error** colours where the others use **warning**), and only one is dismissible. `IntegrationsView.swift:498-501` explicitly acknowledges the duplication.

**Fix:** two primitives in `DesignSystem.swift` beside `HeroEmptyState`:
```swift
struct LoadingState: View { let message: String }
struct InlineBanner: View { let message: String; var tone: Tone = .warning; var onDismiss: (() -> Void)? = nil }
```
Then delete eight local copies. This is the same consolidation `PageScaffold` already performed for layout.

---

## C.2 — A MATTER OF TASTE

Judgement calls. Reasonable people will disagree; none of these is a defect.

---

### T1 — Give the `Space` scale a seventh step
`Space.sm` (6pt) is used **120** times against `Space.lg` (12pt) at 32. Groups do not read as groups. `ConversationView.swift:137` already hardcoded `24` for between-turn spacing with a comment explaining `Space.lg` was wrong. Adding `Space.section: CGFloat = 24` (or 16) and using it between page sections would make the rhythm audible. *Taste, because the current spacing is not broken — just monotone.*

---

### T2 — Give each page one real title
Adopt Settings' pattern: `Kind.title` (15pt semibold, `textPrimary`) for page titles, `Kind.section` (11pt uppercase muted) reserved for sections **within** a page. Today `SectionHeader` serves three altitudes identically (`TasksView:102` page, `AuthView:136` section, `GitView:298` sub-section). *Taste, because the current uppercase-everything treatment is internally consistent — it just has one level where it needs three.*

---

### T3 — Give the sidebar one icon register
Pick a register and hold it. Suggested: all outline, all object-or-geometry, no metaphors, no control affordances. `puzzlepiece.extension` (metaphor) → `powerplug` or `app.connected.to.app.below.fill`; `slider.horizontal.3` (affordance) → `gearshape`; `person.3.sequence` and `person.badge.key` should not both lead with a figure. *Taste, because all eight are legible and correctly rendered — the inconsistency is conceptual, not functional.*

---

### T4 — Narrow `accentDefault` from eleven meanings to three
Proposed split, using only existing tokens: **accent = interactive/primary** (buttons, selection, focus); **`accentSecondary` = running/live** (`StatusDot`, `AgentCard` border, glow — `AgentsView.swift:400` already reasons exactly this way); **`textLink` = links only**. Emphasised numbers drop to `textPrimary`. *Taste, because the current scheme is legible and passes every contrast test — it is just over-loaded.*

---

### T5 — Unify `ModePicker` and `EffortPicker`, or delete one
They claim shared visual language (`ConversationView.swift:520-522`) and share none: 11.5 vs 10pt type, `Space.md`/5 vs 6/4.5 padding, `Radius.control + 2` vs `Radius.control` containers, `Radius.control` vs `Radius.control - 2` selected fills, 2 vs 1.5pt container inset. If R2 removes the effort picker this resolves itself; otherwise extract one generic `SegmentedPicker<T>`. *Taste, but the "same visual language" comment is currently false either way.*

---

### T6 — Make empty states actionable
Only Chat offers actions. `HeroEmptyState` already takes an `@ViewBuilder actions` slot (`DesignSystem.swift:458`) that five call sites bypass via the convenience init (`:499-503`). "No nexus executable" (5 duplicated copies) should offer **Locate `nexus`…** and **Run `nexus doctor`**. "Not a git repository" should offer **`git init`**. *Taste, because the messages are already unusually good at naming the fix in prose.*

---

### T7 — Standardise empty-state and error voice
Six phrasings for one category ("Nothing running" / "No sessions yet" / "No tasks yet" / "No providers found" / "Not a git repository" / "Select a session"). Pick one shape — suggested `No <plural noun> yet`. Extract the 5× duplicated "No nexus executable" message to one constant. *Taste, because each string reads well on its own.*

---

### T8 — Add a copy button to markdown code blocks
`Markdown.swift` has zero buttons. A fenced code block in an answer (`MarkdownCodeBlockView:299`) cannot be copied except by selecting text or copying the entire answer (`ConversationView.swift:1072`). Given that this is a coding tool, per-block copy is the higher-frequency action. *Taste, because text selection is enabled and the whole-answer copy exists.*

---

### T9 — Make the copy button keyboard-reachable
`ConversationView.swift:1058` gates the copy button on `hoveringAnswer`. It cannot be reached without a mouse. The file already made the correct trade once (moving it out of a `.topTrailing` overlay so it never occludes text, `:1038-1045`); reveal on focus as well as hover would finish the job. *Taste, because hover-reveal is a defensible density choice.*

---

### T10 — Let Sessions' list pane flex
`SessionsView.swift:143` hard-codes 340pt, leaving 310pt for detail at the 900pt minimum. `.frame(minWidth: 260, idealWidth: 340, maxWidth: 400)` would let the detail pane breathe. *Listed as taste rather than defect only because Sessions is the one screen already at appropriate density — but at 900pt it is genuinely broken (B.11), so this sits close to the line.*

---

## C.3 — The top 10, in order

| # | Recommendation | Kind | Primary file:line |
|---|---|---|---|
| 1 | **R1** — Wire or disable Sessions Resume/Replay | 🔴 Must | `SessionsView.swift:334-337` |
| 2 | **R2** — Delete the fabricated `--effort` flag from the preview | 🔴 Must | `ConversationView.swift:337`, `:506-559` |
| 3 | **R3** — Stop the provider/model pickers clipping at 900pt | 🔴 Must | `ConversationView.swift:370-412` |
| 4 | **R4** — Make the 23 theme swatches real buttons | 🔴 Must | `RootView.swift:538`, `:556` |
| 5 | **R5** — Name the six icon-only buttons | 🔴 Must | `ConversationView.swift:308-324`, `:395-411`, `:921`, `:1072` |
| 6 | **R6** — Hide 29 decorative SF Symbols from the AX tree | 🔴 Must | all feature views |
| 7 | **R8** — Draw the focus ring `SoftButton` promises | 🔴 Must | `DesignSystem.swift:385-407` |
| 8 | **R7** — Raise 12 sub-10pt glyphs to the documented floor | 🔴 Must | `ConversationView.swift:687`, `:922`, + 10 more |
| 9 | **R9** — Gate Clear transcript and Sign out | 🔴 Must | `ConversationView.swift:404`, `AuthView.swift:361` |
| 10 | **R10** — Consolidate 4 loading states + 4 error banners | 🔴 Must | `DesignSystem.swift` (new), 8 deletions |

Taste items T1-T10 follow, with **T2** (one real title per page) the highest-leverage of them — it is the single change that would most make the other seven screens meet the standard Settings already sets.
