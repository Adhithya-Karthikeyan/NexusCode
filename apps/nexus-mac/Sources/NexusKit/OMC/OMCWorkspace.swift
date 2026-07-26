import Foundation

/// A combined snapshot of what OMC is doing right now, in one project.
public struct OMCSnapshot: Sendable, Hashable {
    public var sessionId: String?
    public var hud: OMCSessionHUD?
    public var registry: OMCAgentRegistry?
    public var missions: OMCMissionState?
    /// Paths that could not be read this pass, so the UI can say "stale" rather
    /// than silently showing nothing.
    public var unreadable: [String] = []

    public init() {}

    /// Agents actually running, newest first — the Agents tab's live list.
    public var runningAgents: [OMCAgent] { registry?.running ?? [] }

    /// Every agent that really ran this session, newest first.
    public var agents: [OMCAgent] { registry?.realAgents ?? [] }

    /// Richer per-agent detail from the mission file, keyed by `agent_id`.
    ///
    /// The two files describe the same agents from different angles: the
    /// registry knows lifecycle, the mission file knows what the agent is
    /// currently doing. Joining on `ownership` is what lets a row show both.
    public func missionDetail(for agent: OMCAgent) -> OMCMissionAgent? {
        missions?.missions
            .flatMap(\.agents)
            .first { $0.ownership == agent.agentId }
    }

    public var isEmpty: Bool { registry == nil && missions == nil && hud == nil }
}

/// Reads oh-my-claudecode's state for a project directory.
///
/// Read-only by construction — there is no write path in this type. OMC owns
/// these files; the app observes them, the same way it observes `nexus` output.
public struct OMCWorkspace: Sendable {
    public let root: URL

    /// `root` is the project directory containing `.omc/`.
    public init(root: URL) {
        self.root = root
    }

    /// Walk up from `start` looking for a `.omc` directory, the way a tool finds
    /// a `.git` root. Returns `nil` when the project does not use OMC — a
    /// perfectly normal state the UI must handle without complaint.
    public static func discover(
        from start: URL,
        fileManager: FileManager = .default
    ) -> OMCWorkspace? {
        var directory = start.standardizedFileURL
        while true {
            var isDirectory: ObjCBool = false
            let candidate = directory.appendingPathComponent(".omc")
            if fileManager.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
               isDirectory.boolValue {
                return OMCWorkspace(root: directory)
            }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { return nil }
            directory = parent
        }
    }

    public var stateDirectory: URL { root.appendingPathComponent(".omc/state") }

    public func sessionDirectory(_ sessionId: String) -> URL {
        stateDirectory.appendingPathComponent("sessions/\(sessionId)")
    }

    /// The session id OMC currently considers active.
    public func currentSessionId(fileManager: FileManager = .default) -> String? {
        let url = stateDirectory.appendingPathComponent("hud-stdin-cache.json")
        guard let data = fileManager.contents(atPath: url.path),
              let json = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return nil }
        return json["session_id"]?.stringValue
    }

    /// Read everything for `sessionId` (defaults to the active session).
    ///
    /// Never throws: each file is independent, and a missing or half-written one
    /// is recorded in `unreadable` instead of failing the whole snapshot. These
    /// files are rewritten live by another process, so a torn read is expected
    /// and must degrade to "keep the last good value".
    public func snapshot(
        sessionId explicitSession: String? = nil,
        fileManager: FileManager = .default
    ) -> OMCSnapshot {
        var snapshot = OMCSnapshot()

        let hudURL = stateDirectory.appendingPathComponent("hud-stdin-cache.json")
        if let data = fileManager.contents(atPath: hudURL.path),
           let json = try? JSONDecoder().decode(JSONValue.self, from: data) {
            snapshot.hud = OMCSessionHUD(json: json)
        } else if fileManager.fileExists(atPath: hudURL.path) {
            snapshot.unreadable.append(hudURL.lastPathComponent)
        }

        guard let sessionId = explicitSession ?? snapshot.hud?.sessionId else {
            return snapshot
        }
        snapshot.sessionId = sessionId
        let directory = sessionDirectory(sessionId)

        let registryURL = directory.appendingPathComponent("subagent-tracking-state.json")
        if let data = fileManager.contents(atPath: registryURL.path) {
            if let decoded = try? JSONDecoder().decode(OMCAgentRegistry.self, from: data) {
                snapshot.registry = decoded
            } else {
                snapshot.unreadable.append(registryURL.lastPathComponent)
            }
        }

        let missionURL = directory.appendingPathComponent("mission-state.json")
        if let data = fileManager.contents(atPath: missionURL.path) {
            if let decoded = try? JSONDecoder().decode(OMCMissionState.self, from: data) {
                snapshot.missions = decoded
            } else {
                snapshot.unreadable.append(missionURL.lastPathComponent)
            }
        }

        return snapshot
    }

    /// Poll for changes.
    ///
    /// Polling rather than FSEvents on purpose: these files are rewritten
    /// whole-file several times a second during a fan-out, so change
    /// notifications arrive in bursts and often mid-write. A steady poll with
    /// tolerant decoding is both simpler and steadier, and identical snapshots
    /// are suppressed so SwiftUI only re-renders on real change.
    public func snapshots(
        interval: Duration = .milliseconds(750),
        sessionId: String? = nil
    ) -> AsyncStream<OMCSnapshot> {
        AsyncStream { continuation in
            let task = Task {
                var previous: OMCSnapshot?
                while !Task.isCancelled {
                    let next = snapshot(sessionId: sessionId)
                    if next != previous {
                        continuation.yield(next)
                        previous = next
                    }
                    try? await Task.sleep(for: interval)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
