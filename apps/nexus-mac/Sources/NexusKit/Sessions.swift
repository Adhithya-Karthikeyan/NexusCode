import Foundation
import Observation

/// Converts the CLI's epoch-millisecond timestamps to `Date`.
///
/// `SessionMeta`/`Task` stamp everything in epoch MILLIS (`Date.now()` on the
/// TypeScript side), not seconds — treating them as seconds would land every
/// date decades in the past, which is easy to miss in a quick glance at a
/// relative-time label.
enum NexusEpoch {
    static func date(_ value: JSONValue?) -> Date? {
        value?.doubleValue.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}

/// One row of `nexus session list -o json` (`SessionMeta` on the CLI side).
///
/// Decoded straight from the already-parsed `JSONValue` `NexusClient.runJSON`
/// hands back, the same way `OMCSessionHUD` is, rather than through
/// `Decodable` — the session store is a separate package on its own release
/// cadence, so a renamed or missing field must degrade that one property, not
/// the whole list.
public struct NexusSession: Sendable, Hashable, Identifiable {
    public let sessionId: String
    public let name: String?
    public let provider: String?
    public let model: String?
    public let turnCount: Int
    public let runCount: Int
    public let eventCount: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let costUsd: Double
    public let createdAt: Date?
    public let updatedAt: Date?

    public var id: String { sessionId }

    /// Plain memberwise construction — for previews and tests. Kept separate
    /// from `init?(json:)` below, which is the only one that talks to the CLI's
    /// wire format.
    public init(
        sessionId: String,
        name: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        turnCount: Int = 0,
        runCount: Int = 0,
        eventCount: Int = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        costUsd: Double = 0,
        createdAt: Date? = nil,
        updatedAt: Date? = nil
    ) {
        self.sessionId = sessionId
        self.name = name
        self.provider = provider
        self.model = model
        self.turnCount = turnCount
        self.runCount = runCount
        self.eventCount = eventCount
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.costUsd = costUsd
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// `nil` only when the row has no `sessionId` at all — every other field
    /// tolerates absence, but `sessionId` is the key `session show` and
    /// `replay` are looked up by, so a row without one is not displayable.
    public init?(json: JSONValue) {
        guard let sessionId = json["sessionId"]?.stringValue else { return nil }
        self.sessionId = sessionId
        self.name = json["name"]?.stringValue
        self.provider = json["provider"]?.stringValue
        self.model = json["model"]?.stringValue
        self.turnCount = json["turnCount"]?.intValue ?? 0
        self.runCount = json["runCount"]?.intValue ?? 0
        self.eventCount = json["eventCount"]?.intValue ?? 0
        self.inputTokens = json["inputTokens"]?.intValue ?? 0
        self.outputTokens = json["outputTokens"]?.intValue ?? 0
        self.costUsd = json["costUsd"]?.doubleValue ?? 0
        self.createdAt = NexusEpoch.date(json["createdAt"])
        self.updatedAt = NexusEpoch.date(json["updatedAt"])
    }
}

/// One row of the `runs` array in `nexus session show <id> -o json`.
public struct NexusSessionRun: Sendable, Hashable, Identifiable {
    public let runId: String
    public let adapterId: String?
    public let model: String?
    public let status: String?

    public var id: String { runId }

    public init(runId: String, adapterId: String? = nil, model: String? = nil, status: String? = nil) {
        self.runId = runId
        self.adapterId = adapterId
        self.model = model
        self.status = status
    }

    public init?(json: JSONValue) {
        guard let runId = json["run_id"]?.stringValue else { return nil }
        self.runId = runId
        self.adapterId = json["adapter_id"]?.stringValue
        self.model = json["model"]?.stringValue
        self.status = json["status"]?.stringValue
    }
}

/// The full decode of `nexus session show <id> -o json`: `{ session, runs }`.
public struct NexusSessionDetail: Sendable, Hashable {
    public let session: NexusSession?
    public let runs: [NexusSessionRun]

    /// `session` is `nil` rather than failing the whole decode when it is
    /// missing or shaped unexpectedly — the `runs` list can still render.
    public init(json: JSONValue) {
        self.session = json["session"].flatMap(NexusSession.init(json:))
        self.runs = json["runs"]?.arrayValue?.compactMap(NexusSessionRun.init(json:)) ?? []
    }
}

/// Loads and holds the Sessions tab's list, backed by `nexus session …`.
@MainActor
@Observable
public final class SessionsController {
    public private(set) var sessions: [NexusSession] = []
    public private(set) var isLoading = false
    public var error: String?

    private let client: NexusClient
    private let workingDirectory: URL?

    public init(client: NexusClient, workingDirectory: URL? = nil) {
        self.client = client
        self.workingDirectory = workingDirectory
    }

    /// Reloads from `nexus session list -o json`, most recently active first.
    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        switch await client.runJSON(.sessionList(cwd: workingDirectory)) {
        case .success(let value):
            guard let items = value.arrayValue else {
                error = "unexpected response shape from `nexus session list`"
                return
            }
            sessions = items.compactMap(NexusSession.init(json:))
                .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
            error = nil
        case .failure(let commandError):
            error = commandError.message
        }
    }

    /// Fetches one session's detail (`session show`) without touching the list.
    public func show(_ sessionId: String) async -> NexusSessionDetail? {
        switch await client.runJSON(.sessionShow(id: sessionId, cwd: workingDirectory)) {
        case .success(let value):
            return NexusSessionDetail(json: value)
        case .failure(let commandError):
            error = commandError.message
            return nil
        }
    }

    /// The command that streams a session's whole recorded event log — hand
    /// this to `ConversationController.ingest` to reopen it (see that
    /// method's doc for why replaying through the same fold matters).
    public func replayCommand(for sessionId: String) -> NexusCommand {
        .replay(sessionId: sessionId, cwd: workingDirectory)
    }
}
