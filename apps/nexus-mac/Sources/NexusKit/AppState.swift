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
    public private(set) var diagnostics: [String] = []

    /// Provider/model for single-lane modes.
    public var provider: String?
    public var model: String?
    /// Backends for compare/race.
    public var backends: [String] = []
    public var mode: RunMode = .ask
    /// Session to continue, so turns build on each other.
    public var sessionId: String?

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

    public init(client: NexusClient, binary: NexusBinary, workingDirectory: URL? = nil) {
        self.client = client
        self.binary = binary
        self.workingDirectory = workingDirectory
    }

    /// The command a submit would run — surfaced in the UI so the user can
    /// always see exactly which `nexus` invocation the button maps to.
    public func plannedCommand(for prompt: String) -> NexusCommand {
        var args: [String]
        switch mode {
        case .ask:
            args = ["ask", prompt]
        case .agent:
            args = ["agent", prompt]
        case .compare, .race:
            args = [mode == .compare ? "compare" : "race", prompt]
            for backend in backends { args += ["-b", backend] }
        }
        args += ["-o", "ndjson"]
        if !mode.isMultiLane {
            if let provider { args += ["-p", provider] }
            if let model { args += ["-m", model] }
        }
        if let sessionId { args += ["--resume", sessionId] }
        return NexusCommand(args, workingDirectory: workingDirectory)
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

        if mode.isMultiLane {
            dispatchOneShot(plannedCommand(for: text))
        } else {
            submitToPersistentSession(text)
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
    /// starting it on first use.
    private func submitToPersistentSession(_ text: String) {
        if session == nil {
            var extras: [String] = []
            if let provider { extras += ["-p", provider] }
            if let model { extras += ["-m", model] }
            let started = PersistentSession(
                binary: binary,
                workingDirectory: workingDirectory,
                resume: sessionId,
                extraArguments: extras
            )
            session = started
            task = Task { [weak self] in
                guard let self else { return }
                for await item in await started.start() {
                    if Task.isCancelled { break }
                    self.absorb(item)
                }
                // The backend exited; the next submit starts a fresh one rather
                // than writing into a dead pipe.
                self.session = nil
                self.isRunning = false
            }
        }
        Task { [session] in await session?.send(text) }
    }

    private func absorb(_ item: NexusStreamItem) {
        switch item {
        case .event(let event):
            view.reduce(event, ts: nextTick())
            // `sessionId` — NOT `id`, which is a per-run identifier. Passing a
            // run id to `--resume` silently starts a fresh session every time,
            // which is exactly the bug this replaces.
            if case .session(let session) = event, let id = session.sessionId, sessionId == nil {
                sessionId = id
            }
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
/// The tab shows two genuinely different kinds of concurrency, and conflating
/// them would be a lie: NexusCode's provider LANES (several models answering the
/// same prompt) and OMC's SUBAGENTS (specialised agents doing separate work).
/// A shared row type lets one list render both while keeping the origin explicit.
public struct AgentRow: Identifiable, Sendable, Hashable {
    public enum Origin: String, Sendable, Hashable {
        /// A provider lane inside a compare/race/consensus run.
        case lane
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

    public init(
        id: String, origin: Origin, title: String, subtitle: String,
        isRunning: Bool, isFailed: Bool, detail: String? = nil, startedAt: Date? = nil
    ) {
        self.id = id
        self.origin = origin
        self.title = title
        self.subtitle = subtitle
        self.isRunning = isRunning
        self.isFailed = isFailed
        self.detail = detail
        self.startedAt = startedAt
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
                startedAt: turn.map { Date(timeIntervalSince1970: $0.startedTs) }
            )
        }
    }

    /// OMC subagents, joined with mission detail for the current step.
    public static func omcAgents(from snapshot: OMCSnapshot) -> [AgentRow] {
        snapshot.agents.map { agent in
            let mission = snapshot.missionDetail(for: agent)
            return AgentRow(
                id: "omc:\(agent.agentId)",
                origin: .omc,
                title: agent.agentType,
                subtitle: agent.status == .running ? "running" : agent.status.rawValue,
                isRunning: agent.status == .running,
                isFailed: agent.status == .failed,
                detail: mission?.currentStep ?? mission?.latestUpdate,
                startedAt: agent.startedAt
            )
        }
    }

    /// Everything working right now, running agents first.
    public static func combined(state: ViewState, snapshot: OMCSnapshot) -> [AgentRow] {
        (lanes(from: state) + omcAgents(from: snapshot))
            .sorted { lhs, rhs in
                if lhs.isRunning != rhs.isRunning { return lhs.isRunning }
                return (lhs.startedAt ?? .distantPast) > (rhs.startedAt ?? .distantPast)
            }
    }
}
