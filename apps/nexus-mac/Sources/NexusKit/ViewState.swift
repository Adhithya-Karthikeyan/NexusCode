import Foundation

/// Health of one provider, derived passively from real run outcomes.
public enum ProviderStatus: String, Sendable, Hashable {
    case ok, warm, degraded, down
}

public struct ProviderHealth: Sendable, Hashable {
    public let provider: String
    public var status: ProviderStatus
    public var lastTs: Double
    public var note: String
}

/// A single tool invocation on a lane.
public struct ToolActivity: Sendable, Hashable, Identifiable {
    public let id: String
    public let lane: String
    public let name: String
    public let args: JSONValue?
    public var status: Status
    public var result: JSONValue?

    public enum Status: String, Sendable, Hashable {
        case running, ok, error
    }
}

public struct TurnDiff: Sendable, Hashable {
    public let path: String
    public let patch: String
}

/// The outcome of an agent run — THREE-valued, deliberately not a `Bool`.
///
/// `indeterminate` is a first-class result in this design, not an error and not
/// a soft failure: a run with no declared success criteria stops after one
/// unverified step and says so. Collapsing that into "succeeded" (a green check)
/// or "failed" (a red cross) would silently break the loop's core honesty
/// guarantee — the same class of mistake as rendering a timed-out approval as a
/// human refusal.
public enum AgentVerdict: String, Sendable, Hashable {
    case met, unmet, indeterminate
}

/// One step of NexusCode's OODA agent loop, recorded on the turn that produced
/// it. Provider-agnostic: the identical loop runs on any registered adapter, so
/// this renders the same whether the backend is anthropic, codex, or a mock.
public struct AgentStep: Sendable, Hashable, Identifiable {
    public let lane: String
    /// Open vocabulary — see `UiEvent.Agent.phase` for why this is not an enum.
    public let phase: String
    public let role: String
    public let step: Int
    /// Human-readable narration. The paired `reasoning` event carries the same
    /// text; it is copied here so an agent view is self-contained.
    public let narration: String
    public let data: JSONValue?
    public let ts: Double

    /// Derived from position in the log, never a fresh `UUID()` — a random id
    /// would make two folds of the same log unequal and destroy replay
    /// determinism. Same reasoning as `NotificationItem.id`.
    public var id: String { "\(lane)-\(step)-\(phase)-\(ts)" }
}

public struct TurnError: Sendable, Hashable {
    public let code: String
    public let message: String
    public let retryable: Bool
}

/// One assistant-side turn on a lane: text + reasoning + tools, delimited by `done`.
public struct Turn: Sendable, Hashable, Identifiable {
    public let id: String
    public let lane: String
    /// The user prompt that started this turn, stamped at creation so the
    /// pairing is intrinsic and survives interruption and replay.
    public var prompt: String?
    public var text: String = ""
    public var reasoning: String = ""
    public var tools: [ToolActivity] = []
    public var diffs: [TurnDiff] = []
    /// Empty for an ordinary chat turn; populated only when the backend was run
    /// through the agent loop (`nexus agent --role …`).
    public var agentSteps: [AgentStep] = []
    public var finished: Bool = false
    public var finishReason: String?
    public var error: TurnError?
    /// `nil` until a `cache` event arrives for this turn (the ordinary,
    /// live-provider-call path — no `usage` event is missing or unknown,
    /// there's simply nothing cache-related to report). Once set, it carries
    /// the event's `hit` verbatim — `true` today always (a miss never emits
    /// this event; see `UiEvent.Cache`), kept as `Bool?` rather than
    /// collapsing to a plain `Bool` so a future "checked and missed" `false`
    /// is still distinguishable from "never checked" `nil`.
    ///
    /// This is genuinely useful, not just structural bookkeeping: a cache hit
    /// never produces a `usage` event at all (short-circuits before the
    /// engine, so there's no cost to report), which would otherwise leave a
    /// turn indistinguishable from one where cost tracking simply failed.
    /// Knowing `cacheHit == true` is what lets a view confidently say "$0.00,
    /// confirmed — this answer came from cache" rather than "cost unknown".
    public var cacheHit: Bool?
    public let startedTs: Double

    /// Whether this turn came from the agent loop at all.
    public var isAgentRun: Bool { !agentSteps.isEmpty }

    /// The role driving this turn (`coder`, `reviewer`, …).
    public var agentRole: String? { agentSteps.last?.role }

    /// Latest self-reported progress percentage, if the loop has reflected yet.
    public var agentProgress: Int? {
        agentSteps.last(where: { $0.phase == "progress" })?.data?["percent"]?.intValue
    }

    /// Why the loop stopped (`goal-met`, `indeterminate`, `max-steps`, …).
    public var agentStopReason: String? {
        agentSteps.last(where: { $0.phase == "stop" })?.data?["stopReason"]?.stringValue
    }

    /// The run's verdict, or `nil` while it is still running.
    ///
    /// A finished run whose verdict is missing or unrecognized resolves to
    /// `.indeterminate` — NEVER to `.met`. An unreadable outcome is exactly the
    /// case this three-valued type exists for, so defaulting optimistically
    /// would defeat the point.
    public var agentVerdict: AgentVerdict? {
        guard let stop = agentSteps.last(where: { $0.phase == "stop" }) else { return nil }
        guard let raw = stop.data?["verdict"]?.stringValue else { return .indeterminate }
        return AgentVerdict(rawValue: raw) ?? .indeterminate
    }

    /// Roles this turn delegated subtasks to, in order.
    public var delegatedRoles: [String] {
        agentSteps
            .filter { $0.phase == "delegate" }
            .compactMap { $0.data?["role"]?.stringValue }
    }
}

/// Per-lane conversation state: the live (streaming) turn + finalized history.
public struct LaneState: Sendable, Hashable, Identifiable {
    public let lane: String
    public var live: Turn?
    public var finalized: [Turn] = []
    public var id: String { lane }

    /// Whether this lane is currently producing output — the "agent is working"
    /// signal the Agents view renders.
    public var isStreaming: Bool { live != nil }
}

public struct UsageTotals: Sendable, Hashable {
    public var inputTokens: Int = 0
    public var outputTokens: Int = 0
    public var cacheRead: Int = 0
    public var cacheWrite: Int = 0
    /// Sum of the `usage` events with KNOWN pricing only — see `costIncomplete`.
    public var costUsd: Double = 0
    /// True once at least one `usage` event this session had `costUsd: nil`
    /// (no pricing data for that model) — `costUsd` above is then a PARTIAL
    /// sum, not the session's true spend, and must be shown as such.
    public var costIncomplete: Bool = false
}

public struct SessionInfo: Sendable, Hashable {
    public let id: String
    public let provider: String
    public let model: String
    public let ts: Double
}

public struct RouteInfo: Sendable, Hashable {
    public let chosen: String
    public let reason: UiEvent.RouteReason
    public let candidates: [String]
}

public struct NotificationItem: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable { case error, approval, failover }
    public let kind: Kind
    public let lane: String
    public let ts: Double
    public let title: String
    public let detail: String
    public var retryable: Bool?

    /// Derived from content, NOT a fresh `UUID()`.
    ///
    /// SwiftUI needs `Identifiable`, but a random id would make two folds of the
    /// same event log unequal — silently destroying the determinism that lets
    /// the app rebuild its entire state by replaying a session's events. The
    /// ingest `ts` is the event's position in the log, so this is stable across
    /// replays and still unique per notification.
    public var id: String { "\(kind.rawValue)-\(lane)-\(ts)-\(title)" }
}

/// The outcome of one `nexus chat --persistent` in-process provider/model
/// switch request — accepted (with a receipt) or refused (with `blockers`),
/// NEVER a silent no-op; the CLI emits exactly one of these per request. Kept
/// as its OWN structured type rather than flattened into a
/// `NotificationItem` string, deliberately: `blockers`/`warnings`/
/// `preserved`/`adaptations` are each doing different work, and a view
/// rendering this needs the structure to get `preserved`'s caveat right (see
/// its doc below) — the same reasoning `AgentStep` keeps its own structured
/// `data` rather than only the paired `reasoning` prose.
public struct SwitchReceipt: Sendable, Hashable, Identifiable {
    public let lane: String
    public let from: UiEvent.Switch.Target
    public let to: UiEvent.Switch.Target
    public let accepted: Bool
    public let blockers: [String]
    public let warnings: [String]
    /// What the switch machinery claims survived. Read literally, NOT as a
    /// blanket "nothing was lost": this is a fixed 4-item list describing
    /// what the TRANSCRIPT AS IT EXISTS carries forward, not a claim that
    /// tool-call history survives — it never did, switch or not (see
    /// `UiEvent.Switch.preserved`'s doc for the full reasoning). A view MUST
    /// NOT render an accepted switch as lossless on the strength of this list.
    public let preserved: [String]
    public let adaptations: [String]
    public let reason: String
    public let ts: Double

    /// Derived from position in the log, never a fresh `UUID()` — same
    /// determinism requirement as every other derived id in this file.
    public var id: String { "switch-\(lane)-\(ts)" }
}

/// The derived projection every view reads.
///
/// A faithful port of `packages/tui/src/store/viewState.ts`. Kept a pure
/// `(state, event, ts) -> state` fold with no wall-clock reads, exactly like the
/// original, so replaying the same log always produces byte-identical state —
/// which is what lets the app reconnect to a session and rebuild the whole UI
/// from the event log alone.
public struct ViewState: Sendable, Hashable {
    public var session: SessionInfo?
    public var route: RouteInfo?
    public var lanes: [String: LaneState] = [:]
    public var laneOrder: [String] = []
    public var totals = UsageTotals()
    /// Cost attributed to the most recent `usage` event. `nil` when that
    /// run's pricing is genuinely unknown — distinct from a real free run.
    public var runUsd: Double?
    public var lastUsage: (inputTokens: Int, outputTokens: Int) = (0, 0)
    /// Health per provider, derived PASSIVELY from run outcomes observed THIS
    /// SESSION ONLY (a failure marks `.degraded`/`.down`, a success or
    /// failover target marks `.ok`) — no persistence, no reason, no retry
    /// time.
    ///
    /// This is a DIFFERENT signal from `ProviderCircuit`
    /// (`NexusKit/Providers.swift`), the CLI's own cross-process, PERSISTED
    /// circuit-breaker state surfaced in the provider picker: that one is
    /// authoritative — it is what actually gates a real dispatch — and
    /// carries a reason plus a retry time this passive signal cannot. They
    /// are not wired to the same view today (`providerHealth` has no UI
    /// consumer yet, so there is no on-screen place they could currently
    /// contradict each other), but if one ever renders both for the same
    /// provider, `ProviderCircuit` must win: it answers "would a request be
    /// allowed right now", which is the question that actually matters,
    /// where this is only a same-session breadcrumb that resets on relaunch.
    public var providerHealth: [String: ProviderHealth] = [:]
    public var notifications: [NotificationItem] = []
    /// Every `switch` request this session, accepted or refused, in order —
    /// append-only, like `notifications`, and for the same reason: a refused
    /// switch is exactly as much a real event as an accepted one, not a
    /// non-event to be dropped.
    public var switches: [SwitchReceipt] = []
    public var streaming: Bool = false
    public var eventCount: Int = 0

    public init() {}

    public static func == (lhs: ViewState, rhs: ViewState) -> Bool {
        lhs.session == rhs.session
            && lhs.route == rhs.route
            && lhs.lanes == rhs.lanes
            && lhs.laneOrder == rhs.laneOrder
            && lhs.totals == rhs.totals
            && lhs.runUsd == rhs.runUsd
            && lhs.lastUsage == rhs.lastUsage
            && lhs.providerHealth == rhs.providerHealth
            && lhs.notifications == rhs.notifications
            && lhs.switches == rhs.switches
            && lhs.streaming == rhs.streaming
            && lhs.eventCount == rhs.eventCount
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(eventCount)
        hasher.combine(laneOrder)
        hasher.combine(streaming)
    }

    /// Lanes in first-seen order — the stable ordering the Agents view renders.
    public var orderedLanes: [LaneState] {
        laneOrder.compactMap { lanes[$0] }
    }

    /// Lanes currently producing output.
    public var activeLanes: [LaneState] {
        orderedLanes.filter(\.isStreaming)
    }
}

// MARK: - The fold

extension ViewState {
    /// A turn's id is derived from `(lane, finalized-count)` — deterministic
    /// given the log, so replaying a prefix yields identical ids.
    private static func newTurn(lane: String, ts: Double, index: Int) -> Turn {
        Turn(id: "turn-\(lane)-\(index)", lane: lane, startedTs: ts)
    }

    private mutating func ensureLane(_ lane: String) {
        if lanes[lane] == nil {
            lanes[lane] = LaneState(lane: lane)
            laneOrder.append(lane)
        }
    }

    private mutating func withLiveTurn(_ lane: String, ts: Double, _ mutate: (inout Turn) -> Void) {
        ensureLane(lane)
        var state = lanes[lane]!
        var turn = state.live ?? Self.newTurn(lane: lane, ts: ts, index: state.finalized.count)
        mutate(&turn)
        state.live = turn
        lanes[lane] = state
        recomputeStreaming()
    }

    private mutating func recomputeStreaming() {
        streaming = lanes.values.contains { $0.live != nil }
    }

    private var hasAnyLiveTurn: Bool { lanes.values.contains { $0.live != nil } }

    private func hasLiveTurn(_ lane: String) -> Bool { lanes[lane]?.live != nil }

    /// Commit a lane's live turn to its finalized history. The single delimiter
    /// used by `done`, by `error`, and by the next `prompt` — so a dangling turn
    /// can never silently merge into the next prompt's turn.
    private mutating func finalizeLive(_ lane: String, finishReason: String) {
        guard var state = lanes[lane], var live = state.live else { return }
        live.finished = true
        live.finishReason = finishReason
        state.finalized.append(live)
        state.live = nil
        lanes[lane] = state
    }

    /// The provider a lane's health is attributed to. In fan-out the lane key IS
    /// the adapter id; only the single-run `"main"` lane falls back to the
    /// session's provider.
    private func providerFor(_ lane: String) -> String {
        lane == "main" ? (session?.provider ?? lane) : lane
    }

    private mutating func setHealth(_ provider: String, _ status: ProviderStatus, _ note: String, _ ts: Double) {
        providerHealth[provider] = ProviderHealth(provider: provider, status: status, lastTs: ts, note: note)
    }

    /// Fold one event into the view. Pure: `ts` is the ingest timestamp the
    /// caller stamps, never read from the clock here.
    public mutating func reduce(_ event: UiEvent, ts: Double) {
        switch event {
        case .session(let e):
            session = SessionInfo(id: e.id, provider: e.provider, model: e.model, ts: e.ts)
            setHealth(e.provider, .ok, "ok", e.ts)
            eventCount += 1

        case .route(let e):
            route = RouteInfo(chosen: e.chosen, reason: e.reason, candidates: e.candidates)
            eventCount += 1

        case .prompt(let e):
            // Finalize any dangling live turn FIRST so this prompt starts fresh.
            finalizeLive(e.lane, finishReason: "interrupted")
            ensureLane(e.lane)
            var state = lanes[e.lane]!
            var turn = Self.newTurn(lane: e.lane, ts: ts, index: state.finalized.count)
            turn.prompt = e.text
            state.live = turn
            lanes[e.lane] = state
            recomputeStreaming()
            eventCount += 1

        case .text(let e):
            withLiveTurn(e.lane, ts: ts) { $0.text += e.delta }
            eventCount += 1

        case .reasoning(let e):
            withLiveTurn(e.lane, ts: ts) { $0.reasoning += e.delta }
            eventCount += 1

        case .toolCall(let e):
            withLiveTurn(e.lane, ts: ts) {
                $0.tools.append(
                    ToolActivity(id: e.id, lane: e.lane, name: e.name, args: e.args, status: .running)
                )
            }
            eventCount += 1

        case .toolResult(let e):
            // A stray/late result with no live turn cannot belong to anything in
            // view; ignore it rather than minting a blank turn.
            guard hasLiveTurn(e.lane) else { eventCount += 1; return }
            withLiveTurn(e.lane, ts: ts) { turn in
                for index in turn.tools.indices where turn.tools[index].id == e.id {
                    turn.tools[index].status = e.ok ? .ok : .error
                    turn.tools[index].result = e.result
                }
            }
            eventCount += 1

        case .diff(let e):
            withLiveTurn(e.lane, ts: ts) { $0.diffs.append(TurnDiff(path: e.path, patch: e.patch)) }
            eventCount += 1

        case .agent(let e):
            // The CLI emits `agent` immediately before the `reasoning` event
            // carrying the same narration, so the narration is not in hand yet.
            // It arrives on the very next event and is folded into `reasoning`
            // there; what this records is the STRUCTURE, which is the part a
            // plan tree or progress bar cannot recover from prose.
            withLiveTurn(e.lane, ts: ts) {
                $0.agentSteps.append(
                    AgentStep(
                        lane: e.lane,
                        phase: e.phase,
                        role: e.role,
                        step: e.step,
                        narration: e.text ?? "",
                        data: e.data,
                        ts: ts
                    )
                )
            }
            eventCount += 1

        case .approval(let e):
            notifications.append(
                NotificationItem(
                    kind: .approval, lane: e.lane, ts: ts,
                    title: "approval: \(e.action)", detail: e.detail
                )
            )
            eventCount += 1

        case .usage(let e):
            totals.inputTokens += e.inputTokens
            totals.outputTokens += e.outputTokens
            totals.cacheRead += e.cacheRead ?? 0
            totals.cacheWrite += e.cacheWrite ?? 0
            // A partial sum over only the priced turns — `costIncomplete`
            // below is what tells a consumer this is not the session's true
            // total. Token counts above are unconditional: an unpriced turn
            // still happened and still used tokens.
            totals.costUsd += e.costUsd ?? 0
            totals.costIncomplete = totals.costIncomplete || e.costUsd == nil
            runUsd = e.costUsd
            lastUsage = (e.inputTokens, e.outputTokens)
            setHealth(providerFor(e.lane), .ok, "ok", ts)
            eventCount += 1

        case .cache(let e):
            // A cache hit never comes with a `usage` event (see `Cache`'s
            // doc) — `totals`/`runUsd` are deliberately untouched here, not
            // zeroed. The turn itself is the only thing that changes.
            withLiveTurn(e.lane, ts: ts) { $0.cacheHit = e.hit }
            eventCount += 1

        case .switch(let e):
            // Recorded either way — a refused switch is exactly as real an
            // event as an accepted one (see `SwitchReceipt`'s doc).
            switches.append(
                SwitchReceipt(
                    lane: e.lane, from: e.from, to: e.to, accepted: e.accepted,
                    blockers: e.blockers, warnings: e.warnings, preserved: e.preserved,
                    adaptations: e.adaptations, reason: e.reason, ts: ts
                )
            )
            if e.accepted, let current = session {
                // The dispatch target genuinely changed in-process — keep
                // `session` truthful so the rest of the app (the status
                // bar's "model" readout) does not show a stale
                // provider/model after a real switch. Mirrors the CLI's own
                // `providerId = targetProvider; model = resolvedModel;`
                // reassignment in `performSwitch`
                // (`packages/cli/src/commands.ts`). `id`/`ts` stay the
                // session's own — this is an update to WHO is serving it,
                // not a new session.
                session = SessionInfo(id: current.id, provider: e.to.providerId, model: e.to.modelId, ts: current.ts)
                // Only the NEW target's health is touched — moving TO a
                // provider by choice says nothing bad about the one left
                // behind, unlike `.failover` below, which is error-driven.
                setHealth(e.to.providerId, .ok, "ok", ts)
            }
            eventCount += 1

        case .failover(let e):
            notifications.append(
                NotificationItem(
                    kind: .failover, lane: e.lane, ts: ts,
                    title: "failover: \(e.from) → \(e.to)",
                    detail: "\(e.code): \(e.message)", retryable: true
                )
            )
            setHealth(e.from, .degraded, "degraded", ts)
            setHealth(e.to, .ok, "ok", ts)
            eventCount += 1

        case .error(let e):
            // Attach the failure to the turn before committing it: a collapsed
            // side panel must never make a failure look like an empty answer.
            if hasLiveTurn(e.lane) {
                withLiveTurn(e.lane, ts: ts) {
                    $0.error = TurnError(code: e.code, message: e.message, retryable: e.retryable)
                }
            }
            finalizeLive(e.lane, finishReason: "error:\(e.code)")
            notifications.append(
                NotificationItem(
                    kind: .error, lane: e.lane, ts: ts,
                    title: "error: \(e.code)", detail: e.message, retryable: e.retryable
                )
            )
            setHealth(providerFor(e.lane), e.retryable ? .degraded : .down, e.retryable ? "degraded" : "down", ts)
            recomputeStreaming()
            eventCount += 1

        case .done(let e):
            // A stray/late `done` would otherwise mint a blank turn and flash
            // streaming on. Ignore it.
            guard hasLiveTurn(e.lane) else { eventCount += 1; return }
            finalizeLive(e.lane, finishReason: e.finishReason)
            setHealth(providerFor(e.lane), .ok, "ok", ts)
            recomputeStreaming()
            eventCount += 1

        case .unknown:
            eventCount += 1
        }
    }

    /// Fold a whole log (replay / initial derivation). The ingest `ts` is the
    /// event's position, never the wall clock, so folding twice is identical.
    public static func reduce(events: [UiEvent], base: ViewState = ViewState()) -> ViewState {
        var state = base
        for (index, event) in events.enumerated() {
            state.reduce(event, ts: Double(index))
        }
        return state
    }
}
