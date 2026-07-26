import XCTest
@testable import NexusKit

/// OMC state decoding, driven by fixtures copied verbatim from a REAL live
/// session (only machine-specific paths scrubbed). Synthetic fixtures would have
/// hidden the three things that actually make this hard: phantom rows,
/// roll-up counters that disagree with the array, and two files describing the
/// same agents with different status vocabularies.
final class OMCTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: try fixtureURL(name)))
    }

    // MARK: - Registry

    func testFiltersPhantomAgentsOutOfTheLiveRoster() throws {
        let registry = try decode(OMCAgentRegistry.self, "omc-subagents")

        // The raw file mixes real agents with reconstructed placeholders.
        XCTAssertEqual(registry.agents.count, 7, "fixture shape changed")
        XCTAssertEqual(registry.syntheticAgents.count, 5)

        // Only the agents that actually ran reach the UI.
        let real = registry.realAgents
        XCTAssertEqual(real.count, 2)
        XCTAssertEqual(Set(real.map(\.agentType)), ["nexus-surface", "omc-surface"])
        XCTAssertFalse(
            real.contains { $0.agentType == "untracked-native-fork" },
            "an unmatched-stop placeholder must never render as a real agent"
        )
    }

    func testDerivesCountsFromRowsNotTheUnreliableRollups() throws {
        let registry = try decode(OMCAgentRegistry.self, "omc-subagents")
        // The file's own totals (spawned 3 / completed 7) disagree with its
        // seven-entry array, so counts come from the rows instead.
        let counts = registry.counts
        XCTAssertEqual(counts.running, 1)
        XCTAssertEqual(counts.completed, 1)
        XCTAssertEqual(counts.failed, 0)
    }

    func testRunningAgentsAreExposedForTheAgentsTab() throws {
        let registry = try decode(OMCAgentRegistry.self, "omc-subagents")
        XCTAssertEqual(registry.running.map(\.agentType), ["nexus-surface"])
    }

    func testParsesFractionalSecondTimestamps() throws {
        let registry = try decode(OMCAgentRegistry.self, "omc-subagents")
        let agent = try XCTUnwrap(registry.realAgents.first { $0.agentType == "omc-surface" })
        XCTAssertNotNil(agent.startedAt, "ISO-8601 with fractional seconds must parse")
        XCTAssertNotNil(agent.duration(now: Date()))
    }

    func testRunningAgentDurationGrowsFromNow() throws {
        let started = Date(timeIntervalSince1970: 1_000)
        let agent = OMCAgent(
            agentId: "a", agentType: "executor", startedAt: started,
            completedAt: nil, status: .running
        )
        let duration = try XCTUnwrap(agent.duration(now: Date(timeIntervalSince1970: 1_060)))
        XCTAssertEqual(duration, 60, accuracy: 0.001)
    }

    // MARK: - Status vocabulary

    func testNormalizesBothFilesStatusVocabularies() {
        // The registry says "completed"; the mission file says "done".
        XCTAssertEqual(OMCAgentStatus(wire: "completed"), .completed)
        XCTAssertEqual(OMCAgentStatus(wire: "done"), .completed)
        XCTAssertEqual(OMCAgentStatus(wire: "running"), .running)
        XCTAssertEqual(OMCAgentStatus(wire: "failed"), .failed)
        XCTAssertEqual(OMCAgentStatus(wire: nil), .unknown)
        XCTAssertEqual(OMCAgentStatus(wire: "something-new"), .unknown)
    }

    // MARK: - Missions

    func testDecodesMissionWithAgentsAndTimeline() throws {
        let state = try decode(OMCMissionState.self, "omc-mission")
        let mission = try XCTUnwrap(state.missions.first)

        XCTAssertEqual(mission.status, .running)
        XCTAssertEqual(mission.workerCount, 2)
        XCTAssertEqual(mission.taskCounts.total, 2)
        XCTAssertEqual(mission.taskCounts.inProgress, 1)
        XCTAssertEqual(mission.agents.count, 2)

        // "done" in the file normalizes onto .completed.
        let finished = try XCTUnwrap(mission.agents.first { $0.role == "omc-surface" })
        XCTAssertEqual(finished.status, .completed)
    }

    func testStatusComesFromTheLatestTimelineEventNotAssumedMonotonic() throws {
        let state = try decode(OMCMissionState.self, "omc-mission")
        let mission = try XCTUnwrap(state.missions.first)

        // The real timeline contains a completion for this agent FOLLOWED by a
        // later start (resuming a named agent re-runs it). Treating completion
        // as terminal would show a working agent as finished.
        let latest = try XCTUnwrap(mission.latestEvent(forAgent: "nexus-surface:anexus-"))
        XCTAssertEqual(latest.kind, "update")
        XCTAssertTrue(latest.detail.contains("started"))

        let ordered = mission.reverseChronologicalTimeline
        XCTAssertEqual(ordered.first?.id, latest.id, "timeline must be newest-first")
    }

    func testActiveMissionsFiltersToRunning() throws {
        let state = try decode(OMCMissionState.self, "omc-mission")
        XCTAssertEqual(state.activeMissions.count, 1)
    }

    // MARK: - HUD

    func testDecodesLiveSessionHUD() throws {
        let data = try Data(contentsOf: try fixtureURL("omc-hud"))
        let json = try JSONDecoder().decode(JSONValue.self, from: data)
        let hud = try XCTUnwrap(OMCSessionHUD(json: json))

        XCTAssertFalse(hud.sessionId.isEmpty)
        XCTAssertNotNil(hud.modelDisplayName)
        XCTAssertNotNil(hud.totalCostUsd)
        XCTAssertNotNil(hud.contextUsedPercentage)
        XCTAssertNotNil(hud.fiveHourLimitPercentage)
    }

    func testHUDDegradesFieldByFieldRatherThanFailingWhole() throws {
        // Written by a separate tool on its own release cadence: a renamed or
        // absent field must blank one readout, not the entire HUD.
        let json = JSONValue.object(["session_id": .string("abc")])
        let hud = try XCTUnwrap(OMCSessionHUD(json: json))
        XCTAssertEqual(hud.sessionId, "abc")
        XCTAssertNil(hud.totalCostUsd)
        XCTAssertNil(hud.modelDisplayName)
    }

    func testHUDRequiresASessionId() {
        XCTAssertNil(OMCSessionHUD(json: .object(["cost": .object([:])])))
    }

    // MARK: - Workspace discovery

    func testDiscoversWorkspaceByWalkingUpToTheOmcDirectory() throws {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omc-discover-\(UUID().uuidString)")
        let nested = temp.appendingPathComponent("packages/cli/src")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: temp.appendingPathComponent(".omc/state"), withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: temp) }

        let workspace = try XCTUnwrap(OMCWorkspace.discover(from: nested))
        // Compare paths, not URLs: a directory URL may carry a trailing slash
        // that makes two equivalent locations compare unequal.
        XCTAssertEqual(
            workspace.root.resolvingSymlinksInPath().path,
            temp.resolvingSymlinksInPath().path
        )
    }

    func testDiscoveryReturnsNilForAProjectWithoutOMC() throws {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("no-omc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        // Not using OMC is a normal state, not an error.
        XCTAssertNil(OMCWorkspace.discover(from: temp))
    }

    func testSnapshotOfAnEmptyWorkspaceIsEmptyRatherThanThrowing() throws {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("empty-omc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: temp.appendingPathComponent(".omc/state"), withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: temp) }

        let snapshot = OMCWorkspace(root: temp).snapshot()
        XCTAssertTrue(snapshot.isEmpty)
        XCTAssertTrue(snapshot.runningAgents.isEmpty)
    }

    // MARK: - Live

    func testReadsThisRepositoriesRealOMCState() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        guard let workspace = OMCWorkspace.discover(from: repoRoot) else {
            throw XCTSkip("this checkout has no .omc directory")
        }
        let snapshot = workspace.snapshot()
        // Deliberately a SKIP, not a failure, when the live state has no session
        // id yet. This reads `.omc/` while another process owns it: the HUD cache
        // is rewritten whole-file many times a second during a fan-out, so a
        // torn or not-yet-written read is expected rather than a defect. Asserting
        // on it made this test fail intermittently for reasons that had nothing
        // to do with the code under test. What IS worth asserting is below: if we
        // parsed a file, we must not also be reporting it as unreadable.
        guard (snapshot.sessionId ?? snapshot.hud?.sessionId) != nil else {
            throw XCTSkip("live .omc state has no session id right now")
        }
        // Whatever it read, it must not report unreadable files it did parse.
        XCTAssertFalse(
            snapshot.unreadable.contains("subagent-tracking-state.json")
                && snapshot.registry != nil
        )
    }
}
