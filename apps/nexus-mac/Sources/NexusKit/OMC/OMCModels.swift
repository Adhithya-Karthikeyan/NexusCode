import Foundation

/// Models for oh-my-claudecode's on-disk session state.
///
/// OMC records what its subagents are doing under
/// `.omc/state/sessions/{sessionId}/`. Nothing here writes to those files — the
/// app is a read-only observer, exactly as it is for the `nexus` CLI.
///
/// Three things about the REAL data shape the models below, and none of them are
/// obvious from the file names:
///
/// 1. The registry contains PHANTOM entries. Roughly two thirds of a live
///    session's rows are `synthetic: true` with `agent_type:
///    "untracked-native-fork"` and `telemetry_status: "unmatched_stop"` — an
///    agent stop observed with no matching start. Rendering them would fill the
///    Agents view with entries that never corresponded to anything.
/// 2. The roll-up counters disagree with the array (a real sample read
///    `total_spawned: 3` beside seven entries). They are not a reliable display
///    source, so counts are derived from the rows.
/// 3. The two files use different vocabularies for the same idea — the registry
///    says `running`/`completed`, the mission file says `running`/`done`. Both
///    normalize onto one `OMCAgentStatus`.
public enum OMCAgentStatus: String, Sendable, Hashable, Codable {
    case running
    case completed
    case failed
    case unknown

    /// Normalizes both files' vocabularies onto one status.
    public init(wire: String?) {
        switch wire?.lowercased() {
        case "running", "in_progress", "inprogress": self = .running
        case "completed", "done", "complete": self = .completed
        case "failed", "error": self = .failed
        default: self = .unknown
        }
    }
}

/// One row of `.omc/state/sessions/{id}/subagent-tracking-state.json`.
public struct OMCAgent: Sendable, Hashable, Identifiable, Codable {
    public let agentId: String
    public let agentType: String
    public let startedAt: Date?
    public let completedAt: Date?
    public let status: OMCAgentStatus
    /// Reconstructed from an unmatched stop event — never a real spawn.
    public let synthetic: Bool
    public let telemetryStatus: String?
    public let telemetryNote: String?

    public var id: String { agentId }

    /// Whether this row represents an agent that actually ran.
    ///
    /// Filters the reconstructed placeholders described above. The Agents view
    /// shows these; a "diagnostics" toggle can reveal the rest.
    public var isReal: Bool {
        !synthetic && agentType != "untracked-native-fork"
    }

    /// How long the agent ran, or has been running.
    public func duration(now: Date = Date()) -> TimeInterval? {
        guard let startedAt else { return nil }
        return (status == .running ? now : (completedAt ?? now)).timeIntervalSince(startedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case agentId = "agent_id"
        case agentType = "agent_type"
        case startedAt = "started_at"
        case completedAt = "completed_at"
        case status
        case synthetic
        case telemetryStatus = "telemetry_status"
        case telemetryNote = "telemetry_note"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId) ?? UUID().uuidString
        agentType = try c.decodeIfPresent(String.self, forKey: .agentType) ?? "unknown"
        startedAt = OMCDate.parse(try c.decodeIfPresent(String.self, forKey: .startedAt))
        completedAt = OMCDate.parse(try c.decodeIfPresent(String.self, forKey: .completedAt))
        status = OMCAgentStatus(wire: try c.decodeIfPresent(String.self, forKey: .status))
        synthetic = try c.decodeIfPresent(Bool.self, forKey: .synthetic) ?? false
        telemetryStatus = try c.decodeIfPresent(String.self, forKey: .telemetryStatus)
        telemetryNote = try c.decodeIfPresent(String.self, forKey: .telemetryNote)
    }

    public init(
        agentId: String, agentType: String, startedAt: Date?, completedAt: Date?,
        status: OMCAgentStatus, synthetic: Bool = false,
        telemetryStatus: String? = nil, telemetryNote: String? = nil
    ) {
        self.agentId = agentId
        self.agentType = agentType
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.status = status
        self.synthetic = synthetic
        self.telemetryStatus = telemetryStatus
        self.telemetryNote = telemetryNote
    }
}

/// The decoded subagent registry.
public struct OMCAgentRegistry: Sendable, Hashable, Codable {
    public let agents: [OMCAgent]
    public let lastUpdated: Date?

    private enum CodingKeys: String, CodingKey {
        case agents
        case lastUpdated = "last_updated"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = try c.decodeIfPresent([OMCAgent].self, forKey: .agents) ?? []
        lastUpdated = OMCDate.parse(try c.decodeIfPresent(String.self, forKey: .lastUpdated))
    }

    public init(agents: [OMCAgent], lastUpdated: Date? = nil) {
        self.agents = agents
        self.lastUpdated = lastUpdated
    }

    /// Agents that actually ran, newest first.
    public var realAgents: [OMCAgent] {
        agents.filter(\.isReal).sorted {
            ($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast)
        }
    }

    /// Currently working — the headline number for the Agents tab.
    public var running: [OMCAgent] { realAgents.filter { $0.status == .running } }

    /// Counts DERIVED from the rows, because the file's own roll-ups disagree
    /// with its array contents.
    public var counts: (running: Int, completed: Int, failed: Int) {
        let real = realAgents
        return (
            real.filter { $0.status == .running }.count,
            real.filter { $0.status == .completed }.count,
            real.filter { $0.status == .failed }.count
        )
    }

    /// Placeholder rows, kept for a diagnostics view rather than discarded.
    public var syntheticAgents: [OMCAgent] { agents.filter { !$0.isReal } }
}

// MARK: - Missions

public struct OMCTaskCounts: Sendable, Hashable, Codable {
    public var total = 0
    public var pending = 0
    public var blocked = 0
    public var inProgress = 0
    public var completed = 0
    public var failed = 0
}

public struct OMCMissionAgent: Sendable, Hashable, Identifiable, Codable {
    public let name: String
    public let role: String
    /// The `agent_id` this row corresponds to — the join key back to the registry.
    public let ownership: String?
    public let status: OMCAgentStatus
    public let currentStep: String?
    public let latestUpdate: String?
    public let completedSummary: String?
    public let updatedAt: Date?

    public var id: String { ownership ?? name }

    private enum CodingKeys: String, CodingKey {
        case name, role, ownership, status, currentStep, latestUpdate, completedSummary, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "agent"
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "unknown"
        ownership = try c.decodeIfPresent(String.self, forKey: .ownership)
        status = OMCAgentStatus(wire: try c.decodeIfPresent(String.self, forKey: .status))
        currentStep = try c.decodeIfPresent(String.self, forKey: .currentStep)
        latestUpdate = try c.decodeIfPresent(String.self, forKey: .latestUpdate)
        completedSummary = try c.decodeIfPresent(String.self, forKey: .completedSummary)
        updatedAt = OMCDate.parse(try c.decodeIfPresent(String.self, forKey: .updatedAt))
    }
}

public struct OMCTimelineEvent: Sendable, Hashable, Identifiable, Codable {
    public let id: String
    public let at: Date?
    public let kind: String
    public let agent: String
    public let detail: String

    private enum CodingKeys: String, CodingKey { case id, at, kind, agent, detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        at = OMCDate.parse(try c.decodeIfPresent(String.self, forKey: .at))
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "update"
        agent = try c.decodeIfPresent(String.self, forKey: .agent) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
    }
}

public struct OMCMission: Sendable, Hashable, Identifiable, Codable {
    public let id: String
    public let name: String
    public let objective: String
    public let status: OMCAgentStatus
    public let workerCount: Int
    public let taskCounts: OMCTaskCounts
    public let agents: [OMCMissionAgent]
    public let timeline: [OMCTimelineEvent]
    public let updatedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, name, objective, status, workerCount, taskCounts, agents, timeline, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "mission"
        objective = try c.decodeIfPresent(String.self, forKey: .objective) ?? ""
        status = OMCAgentStatus(wire: try c.decodeIfPresent(String.self, forKey: .status))
        workerCount = try c.decodeIfPresent(Int.self, forKey: .workerCount) ?? 0
        taskCounts = try c.decodeIfPresent(OMCTaskCounts.self, forKey: .taskCounts) ?? OMCTaskCounts()
        agents = try c.decodeIfPresent([OMCMissionAgent].self, forKey: .agents) ?? []
        timeline = try c.decodeIfPresent([OMCTimelineEvent].self, forKey: .timeline) ?? []
        updatedAt = OMCDate.parse(try c.decodeIfPresent(String.self, forKey: .updatedAt))
    }

    /// Timeline newest-first.
    ///
    /// Status must come from the LATEST event, never assumed monotonic: an agent
    /// can complete and then start again (resuming a named agent re-runs it), so
    /// a real timeline contains a completion followed by a later start for the
    /// same agent.
    public var reverseChronologicalTimeline: [OMCTimelineEvent] {
        timeline.sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
    }

    /// The most recent event per agent name.
    public func latestEvent(forAgent name: String) -> OMCTimelineEvent? {
        reverseChronologicalTimeline.first { $0.agent == name }
    }
}

public struct OMCMissionState: Sendable, Hashable, Codable {
    public let missions: [OMCMission]
    public let updatedAt: Date?

    private enum CodingKeys: String, CodingKey { case missions, updatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        missions = try c.decodeIfPresent([OMCMission].self, forKey: .missions) ?? []
        updatedAt = OMCDate.parse(try c.decodeIfPresent(String.self, forKey: .updatedAt))
    }

    public var activeMissions: [OMCMission] { missions.filter { $0.status == .running } }
}

// MARK: - Session HUD

/// `.omc/state/hud-stdin-cache.json` — live session facts: which model, how much
/// it has cost, how full the context window is, and where the rate limits stand.
public struct OMCSessionHUD: Sendable, Hashable {
    public let sessionId: String
    public let modelDisplayName: String?
    public let modelId: String?
    public let cwd: String?
    public let version: String?
    public let totalCostUsd: Double?
    public let contextUsedPercentage: Int?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let fiveHourLimitPercentage: Int?
    public let sevenDayLimitPercentage: Int?

    /// Decoded defensively: this file is written by a separate tool on its own
    /// release cadence, so a missing or renamed field must degrade to `nil`
    /// rather than blanking the whole HUD.
    public init?(json: JSONValue) {
        guard let sessionId = json["session_id"]?.stringValue else { return nil }
        self.sessionId = sessionId
        self.modelDisplayName = json["model"]?["display_name"]?.stringValue
        self.modelId = json["model"]?["id"]?.stringValue
        self.cwd = json["cwd"]?.stringValue
        self.version = json["version"]?.stringValue
        self.totalCostUsd = Self.number(json["cost"]?["total_cost_usd"])
        self.contextUsedPercentage = Self.int(json["context_window"]?["used_percentage"])
        self.inputTokens = Self.int(json["context_window"]?["total_input_tokens"])
        self.outputTokens = Self.int(json["context_window"]?["total_output_tokens"])
        self.fiveHourLimitPercentage = Self.int(json["rate_limits"]?["five_hour"]?["used_percentage"])
        self.sevenDayLimitPercentage = Self.int(json["rate_limits"]?["seven_day"]?["used_percentage"])
    }

    private static func number(_ value: JSONValue?) -> Double? {
        guard case .number(let n)? = value else { return nil }
        return n
    }

    private static func int(_ value: JSONValue?) -> Int? {
        number(value).map(Int.init)
    }
}

// MARK: - Dates

enum OMCDate {
    /// OMC writes ISO-8601 with fractional seconds; be tolerant of both forms.
    ///
    /// `Date.ISO8601FormatStyle` rather than `ISO8601DateFormatter`: the
    /// formatter is a reference type with shared mutable state, so a shared
    /// static instance is a data race the moment the poll task and the main
    /// actor both parse a timestamp. The format style is a `Sendable` value
    /// type, so this is safe to share by construction.
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return (try? withFraction.parse(text)) ?? (try? plain.parse(text))
    }
}
