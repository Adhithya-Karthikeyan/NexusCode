import Foundation
import Observation

/// The tabs the app exposes. Each maps onto real `nexus` surfaces.
public enum WorkspaceTab: String, CaseIterable, Identifiable, Sendable {
    case chat
    case agents
    case sessions
    case tasks
    case accounts
    case integrations
    case git
    case settings

    public var id: String { rawValue }

    /// The tab a screenshot/verification run should open on, from
    /// `NEXUS_UI_TAB`.
    ///
    /// This exists because the alternative is worse. Driving navigation for a
    /// screenshot sweep otherwise needs either a synthetic click (which this
    /// project has banned outright — a coordinate click once typed into an
    /// unrelated document) or the accessibility API (which an ad-hoc-signed
    /// throwaway bundle is never granted, so `AXPress` silently no-ops and
    /// every capture comes back showing Chat — three such misleading captures
    /// were taken and discarded in an earlier pass). An env var read once at
    /// launch is deterministic, needs no permissions, and cannot touch
    /// anything outside this process.
    ///
    /// Unset or unrecognised means `nil` — the normal path, so a real launch
    /// is completely unaffected.
    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> WorkspaceTab? {
        environment["NEXUS_UI_TAB"].flatMap(WorkspaceTab.init(rawValue:))
    }

    public var title: String {
        switch self {
        case .chat: return "Chat"
        case .agents: return "Agents"
        case .sessions: return "Sessions"
        case .tasks: return "Tasks"
        case .accounts: return "Accounts"
        case .integrations: return "Integrations"
        case .git: return "Git"
        case .settings: return "Settings"
        }
    }

    /// Sidebar grouping.
    ///
    /// Eight ungrouped peers read as a list, not a hierarchy — and worse, they
    /// read as EQUAL: "Settings" (configured once) sits at the same visual
    /// weight as "Chat" (used every session). Grouping by how often you go
    /// there is what restores that distinction.
    public enum Group: String, CaseIterable, Identifiable, Sendable {
        /// Where time is actually spent.
        case work
        /// Records of what already happened.
        case history
        /// Configured once, revisited rarely.
        case setup

        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .work: return "Work"
            case .history: return "History"
            case .setup: return "Setup"
            }
        }
    }

    public var group: Group {
        switch self {
        case .chat, .agents, .tasks: return .work
        case .sessions, .git: return .history
        case .accounts, .integrations, .settings: return .setup
        }
    }

    /// Tabs in this group, in declaration order.
    public static func tabs(in group: Group) -> [WorkspaceTab] {
        allCases.filter { $0.group == group }
    }

    public var systemImage: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .agents: return "person.3.sequence"
        case .sessions: return "clock.arrow.circlepath"
        case .tasks: return "checklist"
        case .accounts: return "person.badge.key"
        case .integrations: return "puzzlepiece.extension"
        case .git: return "arrow.triangle.branch"
        case .settings: return "slider.horizontal.3"
        }
    }
}

/// How a turn is dispatched — mirrors the CLI's own modes so the control maps
/// 1:1 onto a command rather than inventing a concept.
public enum RunMode: String, CaseIterable, Identifiable, Sendable {
    /// `nexus ask` — a plain completion.
    case ask
    /// `nexus agent` — the native tool loop.
    case agent
    /// `nexus compare -b … -b …` — every backend answers, side by side.
    case compare
    /// `nexus race -b … -b …` — first (or best) answer wins.
    case race

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .ask: return "Ask"
        case .agent: return "Agent"
        case .compare: return "Compare"
        case .race: return "Race"
        }
    }

    public var detail: String {
        switch self {
        case .ask: return "One provider, one answer"
        case .agent: return "Tool loop until the goal is met"
        case .compare: return "Every backend answers, side by side"
        case .race: return "First usable answer wins"
        }
    }

    /// Whether this mode fans out across several backends.
    public var isMultiLane: Bool { self == .compare || self == .race }
}

/// The `--effort` flag's vocabulary — identical to the CLI's own
/// (`EffortLevel` in `packages/cli/src/commands.ts`) and to the TUI's
/// `/effort` picker.
///
/// No longer driven by a control on `ConversationController`: the app used
/// to expose an `effort` property and append `--effort` from it, but the
/// owner configures reasoning effort at the PROVIDER level (e.g. codex's
/// `model_reasoning_effort`), so an app-side value could only duplicate or
/// silently override that — see `ConversationController.persistentSessionArguments`'s
/// doc. This type survives as the shared vocabulary `ReasoningCapability`'s
/// decode and derived reads (`Providers.swift`: `NexusProvider
/// .reasoningLabel(for:)`, `.isUnsupported(_:reasoning:)`,
/// `.effortAfterProviderSwitch(from:to:)`) are expressed in, correct and
/// tested, for whoever next needs to surface per-provider effort in the UI.
public enum EffortLevel: String, CaseIterable, Identifiable, Sendable {
    case off, low, medium, high

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .off: return "Off"
        case .low: return "Low"
        case .medium: return "Med"
        case .high: return "High"
        }
    }
}

/// One provider/model switch request, ready to become the persistent stdin
/// control line `nexus chat --persistent` documents (`parseSwitchDecision`,
/// `packages/cli/src/commands.ts`): `{"type":"switch","provider":"…"}`, with
/// `model` present only when set.
///
/// Mirrors `ApprovalDecision.controlLine` (`Approvals.swift`) exactly — same
/// one-line, no-trailing-newline JSON-on-stdin shape (the caller appends
/// `\n`; see `PersistentSession.send`), just a different `type` and no `id`
/// to round-trip. This is the ESTABLISHED pattern for a persistent-session
/// control line in this app; nothing here invents a second mechanism.
struct SwitchRequest: Sendable, Hashable {
    let provider: String
    /// `nil` — never an empty string — when the caller wants the CLI to pick
    /// a default for `provider` itself (`resolveSwitchModel`). Omitting the
    /// key entirely is what signals that; sending `"model":""` would not.
    let model: String?

    var controlLine: String {
        var json = "{\"type\":\"switch\",\"provider\":\"\(Self.escaped(provider))\""
        if let model { json += ",\"model\":\"\(Self.escaped(model))\"" }
        json += "}"
        return json
    }

    private static func escaped(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}

/// Drives one conversation: builds the command, streams it, folds the events.
///
/// All the interpretation lives in `ViewState`; this type owns only the
/// lifecycle (which command, is it running, cancel it) plus the transcript of
/// prompts the user has submitted.
@MainActor
@Observable
public final class ConversationController {
    public private(set) var view = ViewState()
    public private(set) var isRunning = false
    /// Raw stderr lines, in arrival order. Kept unclassified here — see
    /// `presentedDiagnostics` for what the UI should actually do with them —
    /// so nothing about how a line reads is lost before it can be triaged.
    public private(set) var diagnostics: [String] = []

    /// `diagnostics`, classified for display: hidden lines dropped, the rest
    /// paired with how calm or urgent they should read. Computed rather than
    /// stored so `DiagnosticClassifier` is the only place that decision is
    /// made — a second, separately-updated copy here is how the two would
    /// eventually drift.
    public var presentedDiagnostics: [DiagnosticPresentation] {
        diagnostics.compactMap { line in
            let presentation = DiagnosticClassifier.classify(line)
            if case .hidden = presentation { return nil }
            return presentation
        }
    }

    /// Replays a scripted ndjson stream into this controller's view, for
    /// screenshot verification of the transcript.
    ///
    /// A transcript cannot be designed without being looked at, and the
    /// transcript is both the surface the user stares at all day and the one
    /// that is empty on a fresh launch. Every previous design pass reviewed it
    /// blank, which is a large part of why it shipped with no craft in it.
    ///
    /// Deliberately routed through the REAL `UiEventDecoder` and the REAL
    /// `ViewState.reduce` rather than assembling `Turn` values by hand: what
    /// gets screenshotted is then genuinely the production render path fed
    /// real events, not a mock view that could disagree with it. Nothing calls
    /// this unless `NEXUS_UI_DEMO` is set (see `WorkspaceModel.attach`).
    public func replayForPreview(ndjson: String) {
        view = ViewState.reduce(events: UiEventDecoder.decodeStream(ndjson))
    }

    /// A short scripted conversation covering every shape the transcript has
    /// to render well: a plain answer with markdown, a mid-conversation
    /// provider switch, a tool call with a result, a diff, and a failed turn.
    ///
    /// Lives in `NexusKit` rather than beside its one call site in the app so
    /// it is reachable from the test target — `PreviewSeamTests` asserts it
    /// still covers all six shapes, since a script that quietly decayed to
    /// three text deltas would keep screenshotting "fine" while proving
    /// nothing about the surfaces it was written to exercise.
    public static let demoTranscript = """
    {"t":"session","id":"run_demo_1","provider":"anthropic","model":"claude-opus-5","ts":1785088736427}
    {"t":"prompt","lane":"main","id":"p0","text":"Why is the sidebar rendering lighter than the canvas it sits next to?"}
    {"t":"text","lane":"main","delta":"Because the material is overruling the token. `surfaceSunken` is the darkest colour in the theme, but `.ultraThinMaterial` doesn't render the token — it renders **what's behind the window**, lightened.\\n\\nMeasured on the shipped build at 1440x900:\\n\\n- sidebar — relative luminance `0.0244`\\n- canvas panel — `0.0123`\\n- window floor — `0.0048`\\n\\nSo the surface that should be furthest back is twice as bright as the one in front of it. No token is wrong; the material is deciding value when it should only be adding texture."}
    {"t":"usage","lane":"main","inputTokens":1840,"outputTokens":212,"cacheRead":0,"cacheWrite":0,"costUsd":0.0184}
    {"t":"done","lane":"main","finishReason":"stop"}
    {"t":"switch","lane":"main","from":{"providerId":"anthropic","modelId":"claude-opus-5"},"to":{"providerId":"openai","modelId":"gpt-5-codex"},"accepted":true,"blockers":[],"warnings":[],"preserved":["conversation transcript","assembled project context"],"adaptations":[],"reason":"explicit switch requested by client"}
    {"t":"session","id":"run_demo_2","provider":"openai","model":"gpt-5-codex","ts":1785088836427}
    {"t":"prompt","lane":"main","id":"p1","text":"Fix it, then show me the diff."}
    {"t":"text","lane":"main","delta":"Tinting the material back to the token's own value keeps the translucency without letting it govern luminance."}
    {"t":"tool_call","lane":"main","id":"call-1","name":"read_file","args":{"path":"Sources/NexusApp/Components/DesignSystem.swift","limit":120}}
    {"t":"tool_result","lane":"main","id":"call-1","ok":true,"result":[{"type":"text","text":"@ViewBuilder\\nfunc themedFill<S: Shape>(_ color: Color, treatment: SurfaceTreatment, in shape: S) -> some View {"}]}
    {"t":"diff","lane":"main","path":"Sources/NexusApp/Components/DesignSystem.swift","patch":"@@ -132,7 +132,10 @@\\n     if let material = treatment.material {\\n-        shape.fill(material)\\n+        ZStack {\\n+            shape.fill(material)\\n+            shape.fill(color.opacity(isDark ? 0.82 : 0.55))\\n+        }\\n     } else {\\n         shape.fill(color)\\n     }"}
    {"t":"usage","lane":"main","inputTokens":2410,"outputTokens":388,"cacheRead":1792,"cacheWrite":0,"costUsd":0.0091}
    {"t":"done","lane":"main","finishReason":"stop"}
    {"t":"prompt","lane":"main","id":"p2","text":"Run the theme contrast suite."}
    {"t":"error","lane":"main","code":"quota_exhausted","message":"This provider is out of quota for the current billing period.","retryable":true}
    """

    /// Provider/model for single-lane modes.
    public var provider: String?
    public var model: String?
    /// Backends for compare/race.
    public var backends: [String] = []
    public var mode: RunMode = .ask
    /// Session to continue, so turns build on each other.
    public var sessionId: String?

    /// Specialized role for `.agent` mode — `nexus agent --role <role>`.
    ///
    /// `nil` (the default) is today's behaviour exactly: `.agent` runs the fast
    /// native tool loop, byte-identical to before this property existed. A
    /// non-nil value promotes the run to the CLI's full OODA framework
    /// (Observe→Reason→Plan→Act→Evaluate→Repeat). Deliberately a pass-through
    /// `String?` rather than a Swift enum of the nine shipped roles — the CLI
    /// owns that list (`AGENT_ROLES` in `packages/agent/src/roles.ts`) and
    /// validates it with a clear error; duplicating it here would be exactly
    /// the kind of stale copy that already bit the model picker.
    public var role: String?

    /// Pending tool approvals for this conversation.
    public let approvals = ApprovalsController()

    /// Whether tools run with a REAL approval gate.
    ///
    /// `true` launches the backend with `-t --ask`, so a write/exec/network tool
    /// call blocks and emits an approval event instead of proceeding. `false`
    /// leaves the backend tool-less, which is the safe default: a tool loop the
    /// user cannot see or gate should never start implicitly.
    public var approvalsEnabled = true

    private let client: NexusClient
    private let binary: NexusBinary
    private let workingDirectory: URL?
    private var task: Task<Void, Never>?
    private var ingestClock: Double = 0
    private var promptSequence = 0

    /// The long-lived conversation, started lazily on first submit.
    ///
    /// Single-lane modes (`ask`/`agent`) run through this so the engine holds
    /// ONE session across every turn — that is what carries the transcript,
    /// context budget and cost tally forward, and it means one process per
    /// conversation rather than one per message. Fan-out modes
    /// (`compare`/`race`) are inherently one-shot: they dispatch N providers for
    /// a single prompt and settle, so they keep using the one-shot client.
    private var session: PersistentSession?

    /// The provider/model/role the LIVE backend process was actually launched
    /// with.
    ///
    /// `-p`/`-m`/`--role` are baked into a process's argv at spawn time, so
    /// changing a picker cannot change what an already-running process is
    /// talking to. Without tracking this, switching provider mid-conversation
    /// silently kept answering from the ORIGINAL provider while the UI
    /// displayed the new one — the user is told they are talking to Codex and
    /// is in fact talking to Claude. Comparing against the current selection is
    /// what makes a switch real. `role` matters here too: setting a role moves
    /// a `.agent` run off the persistent session entirely (see
    /// `usesPersistentSession`), so a stale role-less session must not keep
    /// running invisibly once a role is picked.
    private var launchedWith: (provider: String?, model: String?, role: String?)?

    /// What the LIVE backend process is actually talking to, as opposed to what
    /// the picker currently shows. `nil` when no backend is running.
    ///
    /// Exposed because the difference is meaningful: argv is fixed at spawn, so
    /// a picker change only takes effect on the next launch. Surfacing the real
    /// value means the UI can never again claim one provider while another is
    /// answering — the defect this pair of properties exists to prevent.
    public var activeBackendProvider: String? { launchedWith?.provider }
    public var activeBackendModel: String? { launchedWith?.model ?? nil }

    public init(client: NexusClient, binary: NexusBinary, workingDirectory: URL? = nil) {
        self.client = client
        self.binary = binary
        self.workingDirectory = workingDirectory
    }

    /// The command a submit would run — surfaced in the UI so the user can
    /// always see exactly which `nexus` invocation the button maps to.
    ///
    /// This is the ONLY place that assembles argv, for every mode. `submit()`
    /// dispatches through the identical builder rather than assembling its own
    /// — either by handing this exact `NexusCommand` to `dispatchOneShot`, or
    /// by handing `persistentSessionArguments()` (the same helper this calls)
    /// to `PersistentSession`. A second, independently-drifting argv builder is
    /// the defect `activeBackendProvider` already exists to catch in the
    /// running-process case; this is that same fix applied to the preview.
    public func plannedCommand(for prompt: String) -> NexusCommand {
        let args = usesPersistentSession ? persistentSessionArguments() : oneShotArguments(for: prompt)
        return NexusCommand(args, workingDirectory: workingDirectory)
    }

    /// Whether `mode` runs through the long-lived `chat --persistent` process
    /// rather than a one-shot dispatch.
    ///
    /// `.agent` with a role cannot: `nexus agent --role` has no `--persistent`
    /// mode — it is one-shot per invocation, unlike `chat --persistent` — so a
    /// role run is dispatched like `compare`/`race` are (see
    /// `oneShotArguments`). `.agent` with no role is untouched: it is
    /// byte-identical to `.ask`.
    private var usesPersistentSession: Bool {
        !mode.isMultiLane && !(mode == .agent && role != nil)
    }

    /// argv for the persistent `chat --persistent` process — used by BOTH the
    /// preview and `submitToPersistentSession`'s actual spawn, so they cannot
    /// drift apart. The prompt itself is never part of this argv: it is
    /// written to the process's stdin turn by turn (see `PersistentSession`).
    ///
    /// Not `private`: `@testable import` needs to reach it directly, to assert
    /// the preview and the actual spawn are the identical array rather than
    /// two literals that merely happen to match (the Bug 1 regression guard).
    func persistentSessionArguments() -> [String] {
        var args = ["chat", "--persistent", "-o", "ndjson"]
        if let sessionId { args += ["--resume", sessionId] }
        if let provider { args += ["-p", provider] }
        if let model { args += ["-m", model] }
        // `-t` enables the tool loop, `--ask` makes write/exec/network require
        // a decision. Without `--ask` the gate would auto-allow, which is the
        // behaviour this whole path exists to remove.
        if approvalsEnabled { args += ["-t", "--ask"] }
        // No `--effort` here, deliberately: the app used to append it from a
        // picker on the control strip, but the owner configures reasoning
        // effort at the PROVIDER level (e.g. codex's `model_reasoning_effort`
        // in `~/.codex/config.toml`), so sending `--effort` from here would
        // silently override a value they deliberately set. `EffortLevel` and
        // `ReasoningCapability` (`Providers.swift`) still describe that
        // capability correctly for whoever next needs to surface it — this
        // argv builder just stops competing over it.
        return args
    }

    /// argv for a one-shot dispatch — `compare`/`race` (always) and `.agent`
    /// with a role (because the CLI has no persistent mode for it).
    private func oneShotArguments(for prompt: String) -> [String] {
        var args: [String]
        switch mode {
        case .ask:
            args = ["ask", prompt]
        case .agent:
            // Only reached when `role != nil` — see `usesPersistentSession`.
            args = ["agent", prompt]
            if let role { args += ["--role", role] }
        case .compare, .race:
            args = [mode == .compare ? "compare" : "race", prompt]
            for backend in backends { args += ["-b", backend] }
        }
        args += ["-o", "ndjson"]
        if !mode.isMultiLane {
            if let provider { args += ["-p", provider] }
            if let model { args += ["-m", model] }
        }
        // No `--effort` here either — see `persistentSessionArguments`'s doc;
        // the same reasoning applies uniformly across every one-shot
        // subcommand built above.
        // `nexus agent --role` DOES honor `--resume` — `runAgentOoda` threads
        // it through the same `resolveResumeTarget` resolver `chat
        // --persistent` uses (see `packages/cli/src/commands.ts`, and the
        // worked example at `packages/cli/src/index.ts`: `nexus agent --role
        // researcher --resume s_1234 …`). What resumes is the CONVERSATION
        // (text only — tool calls are not replayed, exactly like every other
        // resume path). What deliberately does NOT resume is plan/task state:
        // `runAgentOoda` opens a fresh `:memory:` TaskStore on every
        // invocation, never keyed by session id, so a resumed role run reasons
        // over the restored conversation but always plans afresh against THIS
        // invocation's own prompt. That's a real CLI behavior to know about,
        // not a reason to withhold the flag the way this used to.
        if let sessionId { args += ["--resume", sessionId] }
        return args
    }

    public var canSubmit: Bool {
        if isRunning { return false }
        if mode.isMultiLane { return backends.count >= 2 }
        return true
    }

    public func submit(_ prompt: String) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, canSubmit else { return }

        // Inject the prompt into the SAME log the assistant streams into, before
        // dispatch, so the prompt is stamped on the turn it started rather than
        // being paired positionally afterwards.
        let lanes = mode.isMultiLane ? backends : ["main"]
        for lane in lanes {
            view.reduce(
                .prompt(.init(lane: lane, id: "p\(promptSequence)", text: text)),
                ts: nextTick()
            )
        }
        promptSequence += 1

        isRunning = true
        diagnostics = []

        // A provider/model/role change means the LIVE backend (if any) no
        // longer matches what should be running. Two structurally different
        // fixes, not one:
        //
        // - A ROLE change crosses a process shape boundary a control line
        //   cannot represent: `nexus agent --role` has no `--persistent`
        //   mode (see `usesPersistentSession`), so moving into or out of a
        //   role always needs a different process. Tear the stale one down.
        // - A provider/model change on an otherwise-live persistent session
        //   instead rides the SAME process, via the `{"type":"switch",…}`
        //   control line `submitToPersistentSession` writes below —
        //   `stopLiveSession` is deliberately NOT called here. The old
        //   tear-down-and-`--resume` path silently orphaned the live
        //   conversation the instant the picker moved on (a new process,
        //   same transcript via `--resume`, but a full relaunch for what the
        //   CLI can now do in-process) — this is the fix for that.
        //
        // A provider/model change with nothing live to switch IN (no
        // persistent session ever started, or this dispatch isn't even
        // persistent-session-shaped — e.g. compare/race) falls through to
        // the same relaunch-on-next-dispatch behavior as before; there is no
        // live process to preserve.
        var pendingSwitch: SwitchRequest?
        if let launched = launchedWith {
            if launched.role != role {
                stopLiveSession()
            } else if launched.provider != provider || launched.model != model {
                if usesPersistentSession, session != nil, let targetProvider = provider {
                    pendingSwitch = SwitchRequest(provider: targetProvider, model: model)
                } else {
                    stopLiveSession()
                }
            }
        }

        if usesPersistentSession {
            submitToPersistentSession(text, switchRequest: pendingSwitch)
        } else {
            dispatchOneShot(plannedCommand(for: text))
        }
    }

    /// Fan-out: N providers answer one prompt, then the run settles. There is no
    /// conversation to keep open, so this stays a one-shot process.
    private func dispatchOneShot(_ command: NexusCommand) {
        task = Task { [weak self] in
            guard let self else { return }
            for await item in await self.client.stream(command) {
                if Task.isCancelled { break }
                self.absorb(item)
            }
            self.isRunning = false
        }
    }

    /// Single-lane: write the prompt to the conversation that is already open,
    /// starting it on first use. Any stale process from a ROLE change has
    /// already been stopped by `submit()` before this runs; a provider/model
    /// change on an otherwise-live session instead arrives here as
    /// `switchRequest`, non-nil.
    ///
    /// - Parameter switchRequest: when set, its control line is written to
    ///   stdin BEFORE `text` — in the SAME `Task`, not two separate ones, so
    ///   the two writes cannot reorder relative to each other no matter how
    ///   the scheduler interleaves concurrent `Task`s. The CLI processes a
    ///   `{"type":"switch",…}` control line to completion (emitting its
    ///   `switch` event) before reading the next stdin line, accepted or
    ///   refused either way (`performSwitch`, `packages/cli/src/commands.ts`)
    ///   — so `text` always dispatches against whichever target actually won.
    private func submitToPersistentSession(_ text: String, switchRequest: SwitchRequest? = nil) {
        if session == nil {
            let started = PersistentSession(
                binary: binary,
                workingDirectory: workingDirectory,
                arguments: persistentSessionArguments()
            )
            session = started
            launchedWith = (provider, model, role)
            task = Task { [weak self] in
                guard let self else { return }
                for await item in await started.start() {
                    if Task.isCancelled { break }
                    self.absorb(item)
                }
                // The backend exited; the next submit starts a fresh one rather
                // than writing into a dead pipe.
                self.session = nil
                self.launchedWith = nil
                self.isRunning = false
            }
        }
        Task { [session] in
            if let switchRequest { await session?.send(switchRequest.controlLine) }
            await session?.send(text)
        }
    }

    /// Stop and discard the currently live persistent backend, if any. Called
    /// before a provider/model/role change dispatches down whichever path is
    /// now correct — otherwise the old process keeps running invisibly.
    private func stopLiveSession() {
        guard session != nil else { return }
        let stale = session
        session = nil
        launchedWith = nil
        task?.cancel()
        task = nil
        Task { await stale?.stop() }
    }

    /// Answer the front-most approval. The decision travels on the SAME stdin
    /// the prompts do — the CLI distinguishes them by shape, so no second
    /// channel is needed.
    public func respondToApproval(allow: Bool) {
        guard let decision = allow ? approvals.allow() : approvals.deny() else { return }
        Task { [session] in await session?.send(decision.controlLine) }
    }

    /// Not `private`: `@testable import` needs to reach it directly to drive
    /// `reconcile(switchEvent:)` with a synthetic `.switch` `UiEvent` — the
    /// same reasoning `persistentSessionArguments()` documents for its own
    /// visibility. `ingest(_:)` below is the public replay entry point and
    /// deliberately does NOT run through here (see its doc): replaying a
    /// past log must not re-trigger live-session side effects like
    /// `reconcile`, only refold the transcript.
    func absorb(_ item: NexusStreamItem) {
        switch item {
        case .event(let event):
            view.reduce(event, ts: nextTick())
            // `sessionId` — NOT `id`, which is a per-run identifier. Passing a
            // run id to `--resume` silently starts a fresh session every time,
            // which is exactly the bug this replaces.
            if case .session(let session) = event, let id = session.sessionId, sessionId == nil {
                sessionId = id
            }
            // The CLI's real answer to a switch control line this app sent —
            // reconcile `launchedWith`/the picker with what actually happened
            // rather than trusting the request was honored.
            if case .switch(let e) = event { reconcile(switchEvent: e) }
            // A tool call is blocked waiting on the user; surface it.
            approvals.ingest(event)
            // A settled turn frees the composer; the process stays alive.
            if case .done = event { isRunning = false }
            if case .error = event { isRunning = false }
        case .diagnostic(let line):
            diagnostics.append(line)
        case .terminated(let reason):
            if case .failedToLaunch(let message) = reason {
                diagnostics.append("failed to launch nexus: \(message)")
            }
            isRunning = false
        }
    }

    /// Reconcile `launchedWith` and the provider/model PICKER with a real
    /// `switch` outcome — never trust the request that was sent, only the
    /// CLI's answer to it.
    ///
    /// Accepted: the live backend genuinely IS `e.to` now — no relaunch
    /// happened (`submit()` never called `stopLiveSession` for this path), so
    /// `launchedWith` needs to catch up to match, and the picker lands on
    /// whatever the CLI actually resolved (`e.to.modelId` can differ from
    /// what was requested when `model` was left for `resolveSwitchModel` to
    /// pick — see `SwitchRequest.model`'s doc).
    ///
    /// Refused: the live backend never moved off `e.from` — `launchedWith`
    /// is already untouched (same reason), so the PICKER is what needs to
    /// revert. Without this the UI keeps showing the rejected target while a
    /// different provider silently keeps answering underneath — the exact
    /// "picker claims a provider that isn't serving" defect this whole path
    /// exists to close, just reached from a different direction than the
    /// original bug report.
    ///
    /// Guarded on `launchedWith` being non-nil: a `.switch` event only ever
    /// arrives in response to a control line THIS controller wrote onto an
    /// already-live session (see `submit()`), so `launchedWith` is always set
    /// by the time one lands; the guard is defensive, not load-bearing.
    private func reconcile(switchEvent e: UiEvent.Switch) {
        guard let launched = launchedWith else { return }
        if e.accepted {
            let resolvedModel = e.to.modelId.isEmpty ? nil : e.to.modelId
            launchedWith = (e.to.providerId, resolvedModel, launched.role)
            provider = e.to.providerId
            model = resolvedModel
        } else {
            provider = launched.provider
            model = launched.model
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
        isRunning = false
    }

    /// End the conversation and its backing process. The durable session stays
    /// in the CLI store, reachable from the Sessions tab.
    public func endSession() {
        let ending = session
        session = nil
        launchedWith = nil
        Task { await ending?.stop() }
        cancel()
    }

    /// Fold one event in directly, without running a command.
    ///
    /// This is how a past session is re-opened: `nexus replay <id> -o ndjson`
    /// emits the session's whole event log, and feeding it through the same fold
    /// rebuilds the identical transcript — no second code path, and no
    /// "history looks different from live" class of bug.
    public func ingest(_ event: UiEvent) {
        view.reduce(event, ts: nextTick())
    }

    /// Replay a whole recorded log (see `ingest`).
    public func ingest(_ events: [UiEvent]) {
        for event in events { ingest(event) }
    }

    /// Points this conversation at a different, already-recorded session and
    /// drops whatever backend was live, so the NEXT submit starts fresh
    /// against it — picking up `--resume <sessionId>` the same way a brand
    /// new conversation picks up its first provider/model (see
    /// `persistentSessionArguments`).
    ///
    /// This is the shared seam both "Resume" and "Replay" build on in the
    /// Sessions tab: `endSession()` and `clear()` already exist for exactly
    /// this (stop the live process, reset the fold) — this just sequences
    /// them with the target id rather than adding a second, parallel way to
    /// open a session. Resume stops here, leaving the transcript empty for
    /// `--resume` to carry forward; Replay follows up with `ingest(_:)` to
    /// re-populate it immediately from the recorded log.
    ///
    /// - Parameters:
    ///   - provider: The session's OWN last-used adapter id (`NexusSession
    ///     .provider`, from `nexus session list -o json`'s `SessionMeta
    ///     .provider` — the most recent run's adapter), not whatever this
    ///     app run's picker currently holds. The picker's live value is
    ///     unreliable here: it could still be `nil` (nothing has auto-
    ///     selected yet — see `ChatTab`'s `.task`, which only fires once the
    ///     Chat tab itself has been shown) or it could hold a provider left
    ///     over from a completely unrelated conversation. Either way,
    ///     leaving `persistentSessionArguments()` to omit `-p`/`-m` on
    ///     resume hands the reopened conversation to whatever the CLI
    ///     defaults to right now, silently — a DIFFERENT backend than the
    ///     one that transcript was actually having, which is exactly the
    ///     "no tools" class of report this fixes. `nil` (the default) only
    ///     when the caller has no session metadata to offer; see the merge
    ///     policy below.
    ///   - model: Same reasoning, `NexusSession.model`.
    ///
    /// Merge policy: `provider ?? self.provider` (same for `model`), not a
    /// flat overwrite — an older session recorded before provider/model
    /// tracking existed reports `nil` for both, and a `nil` here must not
    /// clobber a value this controller already has.
    public func reopen(sessionId: String, provider: String? = nil, model: String? = nil) {
        endSession()
        clear()
        self.sessionId = sessionId
        self.provider = provider ?? self.provider
        self.model = model ?? self.model
    }

    /// Clear the transcript. Does not touch the durable session — history stays
    /// in the CLI's store, reachable from the Sessions tab.
    public func clear() {
        cancel()
        view = ViewState()
        diagnostics = []
        ingestClock = 0
        promptSequence = 0
    }

    /// Monotonic ingest clock. The fold must never read the wall clock, or
    /// replaying a log would produce different state than live streaming did.
    private func nextTick() -> Double {
        defer { ingestClock += 1 }
        return ingestClock
    }
}

/// Watches oh-my-claudecode's on-disk state and republishes it for the UI.
@MainActor
@Observable
public final class OMCController {
    public private(set) var snapshot = OMCSnapshot()
    public private(set) var isWatching = false
    /// `nil` when this project does not use OMC — a normal state, not an error.
    public private(set) var workspace: OMCWorkspace?

    private var task: Task<Void, Never>?

    public init(workspace: OMCWorkspace?) {
        self.workspace = workspace
    }

    public convenience init(discoveringFrom directory: URL) {
        self.init(workspace: OMCWorkspace.discover(from: directory))
    }

    public var isAvailable: Bool { workspace != nil }

    public func start(interval: Duration = .milliseconds(750)) {
        guard let workspace, task == nil else { return }
        isWatching = true
        task = Task { [weak self] in
            for await next in workspace.snapshots(interval: interval) {
                guard let self, !Task.isCancelled else { break }
                self.snapshot = next
            }
            self?.isWatching = false
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        isWatching = false
    }

    // No `deinit` cancellation: main-actor state is unreachable from a
    // nonisolated deinit, and it is not needed — the poll loop holds `self`
    // weakly, so once the controller is released the next iteration sees `nil`
    // and exits, which also tears down the underlying file-polling stream.
}

/// One row in the unified Agents view.
///
/// The tab shows THREE genuinely different kinds of concurrency, and
/// conflating any of them would be a lie: NexusCode's provider LANES (several
/// models answering the same prompt), NexusCode's own ROLE RUNS (one agent
/// iterating on its own output through the OODA loop, `nexus agent --role …`),
/// and OMC's SUBAGENTS (specialised agents doing separate work). A shared row
/// type lets one list render all three while keeping the origin explicit.
public struct AgentRow: Identifiable, Sendable, Hashable {
    public enum Origin: String, Sendable, Hashable {
        /// A provider lane inside a compare/race/consensus run.
        case lane
        /// NexusCode's own OODA agent loop (`nexus agent --role …`) — one
        /// agent, provider-agnostic, iterating on its own output.
        case roleRun
        /// An oh-my-claudecode subagent.
        case omc
    }

    public let id: String
    public let origin: Origin
    public let title: String
    public let subtitle: String
    public let isRunning: Bool
    public let isFailed: Bool
    public let detail: String?
    public let startedAt: Date?
    /// The role run's three-valued outcome, or `nil` while it is still
    /// running, or for origins with no verdict concept (lane/omc).
    ///
    /// `isRunning`/`isFailed` are booleans and cannot carry `.indeterminate`
    /// without squashing it into "succeeded" or "failed" — exactly the mistake
    /// `AgentVerdict` exists to prevent — so it lives in its own field rather
    /// than being folded into those two.
    public let verdict: AgentVerdict?

    /// The OODA step history, for a `.roleRun` row — empty for every other
    /// origin. What "expand this card" actually shows: real steps the loop
    /// took (`plan`/`observe`/`reflect`/…), never a fabricated progress log.
    public let steps: [AgentStep]
    /// Tool calls made on this turn, for a `.lane` row — empty for every
    /// other origin. Same idea as `steps`, for the kind of concurrency that
    /// doesn't have OODA phases: what a lane actually did is its tool calls.
    public let toolCalls: [ToolActivity]
    /// This agent's own slice of its mission's timeline, for an `.omc` row —
    /// empty for every other origin (and when this agent isn't part of a
    /// tracked mission at all).
    public let timeline: [OMCTimelineEvent]

    public init(
        id: String, origin: Origin, title: String, subtitle: String,
        isRunning: Bool, isFailed: Bool, detail: String? = nil, startedAt: Date? = nil,
        verdict: AgentVerdict? = nil,
        steps: [AgentStep] = [], toolCalls: [ToolActivity] = [], timeline: [OMCTimelineEvent] = []
    ) {
        self.id = id
        self.origin = origin
        self.title = title
        self.subtitle = subtitle
        self.isRunning = isRunning
        self.isFailed = isFailed
        self.detail = detail
        self.startedAt = startedAt
        self.verdict = verdict
        self.steps = steps
        self.toolCalls = toolCalls
        self.timeline = timeline
    }

    /// Whether this row has anything a disclosure control could actually
    /// reveal — the row model's own answer to "should the expand affordance
    /// even be offered", so `AgentsView` never has to guess or hardcode it
    /// per origin.
    public var hasExpandableDetail: Bool {
        !steps.isEmpty || !toolCalls.isEmpty || !timeline.isEmpty
    }
}

public enum AgentRowBuilder {
    /// Provider lanes from the live run, newest activity first.
    public static func lanes(from state: ViewState) -> [AgentRow] {
        state.orderedLanes.map { lane in
            let turn = lane.live ?? lane.finalized.last
            let toolCount = turn?.tools.count ?? 0
            return AgentRow(
                id: "lane:\(lane.lane)",
                origin: .lane,
                title: lane.lane,
                subtitle: lane.isStreaming
                    ? "streaming"
                    : (turn?.finishReason.map { "finished · \($0)" } ?? "idle"),
                isRunning: lane.isStreaming,
                isFailed: turn?.error != nil,
                detail: toolCount > 0 ? "\(toolCount) tool call\(toolCount == 1 ? "" : "s")" : nil,
                startedAt: turn.map { Date(timeIntervalSince1970: $0.startedTs) },
                toolCalls: turn?.tools ?? []
            )
        }
    }

    /// Lane names currently driving a role run (`nexus agent --role …`) — a
    /// lane whose current turn came through the OODA loop rather than an
    /// ordinary chat turn. Shared by `lanesExcludingRoleRuns` and `roleRuns`
    /// so both agree on exactly which lanes count as which.
    private static func roleRunLaneNames(from state: ViewState) -> Set<String> {
        Set(state.orderedLanes.compactMap { lane in
            (lane.live ?? lane.finalized.last)?.isAgentRun == true ? lane.lane : nil
        })
    }

    /// `lanes(from:)`, minus any lane currently driving a role run.
    ///
    /// A role run rides on a provider lane under the hood, so without this
    /// filter it would render twice — once as a plain `.lane` row and once as
    /// a `.roleRun` row from `roleRuns(from:)` — which is exactly the
    /// double-count the three-way origin split exists to prevent.
    public static func lanesExcludingRoleRuns(from state: ViewState) -> [AgentRow] {
        let roleRunLanes = roleRunLaneNames(from: state)
        return lanes(from: state).filter { !roleRunLanes.contains($0.title) }
    }

    /// NexusCode's own role runs (`nexus agent --role …`) — a THIRD kind of
    /// concurrency alongside a provider lane (several models racing the same
    /// prompt) and an OMC subagent (a specialised agent doing separate work):
    /// one agent iterating on its own output through a verified
    /// Observe → Plan → Act → Reflect → Evaluate loop. Provider-agnostic — the
    /// identical loop runs on anthropic, mock, or any registered adapter, so
    /// this reads the same regardless of backend.
    public static func roleRuns(from state: ViewState) -> [AgentRow] {
        state.orderedLanes.compactMap { lane in
            guard let turn = lane.live ?? lane.finalized.last, turn.isAgentRun else { return nil }

            let subtitle: String
            if lane.isStreaming {
                let lastStep = turn.agentSteps.last
                let phase = lastStep?.phase ?? "working"
                subtitle = "\(phase) · step \(lastStep?.step ?? 0)"
            } else {
                subtitle = turn.agentStopReason.map { "stopped · \($0)" } ?? "stopped"
            }

            var detailParts: [String] = []
            if let progress = turn.agentProgress { detailParts.append("\(progress)% progress") }
            let delegated = turn.delegatedRoles
            if !delegated.isEmpty { detailParts.append("delegated: \(delegated.joined(separator: ", "))") }

            return AgentRow(
                id: "role:\(lane.lane)",
                origin: .roleRun,
                title: turn.agentRole ?? lane.lane,
                subtitle: subtitle,
                isRunning: lane.isStreaming,
                isFailed: turn.error != nil,
                detail: detailParts.isEmpty ? nil : detailParts.joined(separator: " · "),
                startedAt: Date(timeIntervalSince1970: turn.startedTs),
                // `nil` only while running (mirrors `Turn.agentVerdict`); once
                // stopped this ALWAYS resolves to one of the three verdicts —
                // an unreadable outcome defaults to `.indeterminate`, same
                // rule as `Turn.agentVerdict`, never silently dropped.
                verdict: lane.isStreaming ? nil : (turn.agentVerdict ?? .indeterminate),
                steps: turn.agentSteps
            )
        }
    }

    /// OMC subagents, joined with mission detail for the current step.
    public static func omcAgents(from snapshot: OMCSnapshot) -> [AgentRow] {
        snapshot.agents.map { agent in
            let mission = snapshot.missionDetail(for: agent)
            // Which mission (if any) actually contains this agent — the same
            // `ownership == agent.agentId` join `missionDetail` already does,
            // kept separate here because that helper returns the AGENT row,
            // not the MISSION it came from, and the timeline lives on the
            // mission.
            let ownMission = snapshot.missions?.missions.first { candidate in
                candidate.agents.contains { $0.ownership == agent.agentId }
            }
            // This agent's own slice of that mission's timeline — newest
            // first, mirroring `OMCMission.reverseChronologicalTimeline`.
            let ownTimeline = (ownMission?.timeline ?? [])
                .filter { $0.agent == (mission?.name ?? "") }
                .sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
            return AgentRow(
                id: "omc:\(agent.agentId)",
                origin: .omc,
                title: agent.agentType,
                subtitle: agent.status == .running ? "running" : agent.status.rawValue,
                isRunning: agent.status == .running,
                isFailed: agent.status == .failed,
                detail: mission?.currentStep ?? mission?.latestUpdate,
                startedAt: agent.startedAt,
                timeline: ownTimeline
            )
        }
    }

    /// Everything working right now, running agents first.
    public static func combined(state: ViewState, snapshot: OMCSnapshot) -> [AgentRow] {
        (lanesExcludingRoleRuns(from: state) + roleRuns(from: state) + omcAgents(from: snapshot))
            .sorted { lhs, rhs in
                if lhs.isRunning != rhs.isRunning { return lhs.isRunning }
                return (lhs.startedAt ?? .distantPast) > (rhs.startedAt ?? .distantPast)
            }
    }
}
