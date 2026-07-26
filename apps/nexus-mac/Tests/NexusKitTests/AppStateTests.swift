import XCTest
@testable import NexusKit

/// Presentation logic lives in NexusKit precisely so it can be tested without a
/// window. These cover the two things the UI can get quietly wrong: building the
/// wrong `nexus` command, and misrepresenting what is running.
@MainActor
final class AppStateTests: XCTestCase {
    private func controller() -> ConversationController {
        let binary = NexusBinary(url: URL(fileURLWithPath: "/bin/echo"))
        return ConversationController(
            client: NexusClient(binary: binary),
            binary: binary,
            workingDirectory: URL(fileURLWithPath: "/tmp")
        )
    }

    // MARK: - Command construction

    func testAskBuildsASingleProviderNdjsonCommand() {
        let c = controller()
        c.mode = .ask
        c.provider = "anthropic"
        c.model = "claude-sonnet-4-5"

        let args = c.plannedCommand(for: "hello").arguments
        XCTAssertEqual(args.first, "ask")
        XCTAssertTrue(args.contains("hello"))
        // ndjson is what makes the app a renderer rather than a screen-scraper.
        XCTAssertTrue(args.contains("-o") && args.contains("ndjson"))
        XCTAssertTrue(args.contains("-p") && args.contains("anthropic"))
        XCTAssertTrue(args.contains("-m") && args.contains("claude-sonnet-4-5"))
    }

    func testAgentModeUsesTheAgentSubcommand() {
        let c = controller()
        c.mode = .agent
        XCTAssertEqual(c.plannedCommand(for: "do it").arguments.first, "agent")
    }

    func testCompareFansOutAcrossBackendsAndOmitsProviderFlags() {
        let c = controller()
        c.mode = .compare
        c.backends = ["anthropic", "openai"]
        // A stale single-provider selection must not leak into a fan-out run.
        c.provider = "should-be-ignored"

        let args = c.plannedCommand(for: "compare this").arguments
        XCTAssertEqual(args.first, "compare")
        XCTAssertEqual(args.filter { $0 == "-b" }.count, 2)
        XCTAssertTrue(args.contains("anthropic") && args.contains("openai"))
        XCTAssertFalse(args.contains("should-be-ignored"))
        XCTAssertFalse(args.contains("-p"))
    }

    func testRaceUsesTheRaceSubcommand() {
        let c = controller()
        c.mode = .race
        c.backends = ["a", "b"]
        XCTAssertEqual(c.plannedCommand(for: "x").arguments.first, "race")
    }

    func testResumeIsThreadedSoFollowUpTurnsKeepContext() {
        let c = controller()
        c.sessionId = "s_123"
        let args = c.plannedCommand(for: "again").arguments
        XCTAssertTrue(args.contains("--resume"))
        XCTAssertTrue(args.contains("s_123"))
    }

    // MARK: - Submit guards

    func testFanOutRequiresAtLeastTwoBackends() {
        let c = controller()
        c.mode = .compare
        XCTAssertFalse(c.canSubmit, "comparing one backend is not a comparison")
        c.backends = ["only-one"]
        XCTAssertFalse(c.canSubmit)
        c.backends = ["one", "two"]
        XCTAssertTrue(c.canSubmit)
    }

    func testSingleLaneModesCanSubmitWithNoExplicitProvider() {
        let c = controller()
        c.mode = .ask
        // The CLI resolves its own default provider; the app must not require one.
        XCTAssertTrue(c.canSubmit)
    }

    func testClearResetsTheTranscriptDeterministically() {
        let c = controller()
        c.ingest([
            .prompt(.init(lane: "main", id: "p0", text: "hi")),
            .text(.init(lane: "main", delta: "answer")),
        ])
        XCTAssertFalse(c.view.lanes.isEmpty)

        c.clear()
        XCTAssertTrue(c.view.lanes.isEmpty)
        XCTAssertEqual(c.view.eventCount, 0)
        XCTAssertFalse(c.isRunning)
    }

    // MARK: - Agent rows

    func testLaneRowsReportStreamingAndToolCounts() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "anthropic", id: "p", text: "x")), ts: 0)
        state.reduce(.toolCall(.init(lane: "anthropic", id: "c1", name: "bash", args: nil)), ts: 1)
        state.reduce(.prompt(.init(lane: "openai", id: "p", text: "x")), ts: 2)
        state.reduce(.done(.init(lane: "openai", finishReason: "stop")), ts: 3)

        let rows = AgentRowBuilder.lanes(from: state)
        XCTAssertEqual(rows.count, 2)

        let anthropic = try XCTUnwrap(rows.first { $0.title == "anthropic" })
        XCTAssertTrue(anthropic.isRunning)
        XCTAssertEqual(anthropic.detail, "1 tool call")
        XCTAssertEqual(anthropic.origin, .lane)

        let openai = try XCTUnwrap(rows.first { $0.title == "openai" })
        XCTAssertFalse(openai.isRunning)
        XCTAssertEqual(openai.subtitle, "finished · stop")
    }

    func testLaneRowSurfacesFailure() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "gemini", id: "p", text: "x")), ts: 0)
        state.reduce(.error(.init(lane: "gemini", code: "auth", message: "no key", retryable: false)), ts: 1)

        let row = try XCTUnwrap(AgentRowBuilder.lanes(from: state).first)
        XCTAssertTrue(row.isFailed)
    }

    func testCombinedListSortsRunningAgentsFirst() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "busy", id: "p", text: "x")), ts: 0)
        state.reduce(.prompt(.init(lane: "idle", id: "p", text: "x")), ts: 1)
        state.reduce(.done(.init(lane: "idle", finishReason: "stop")), ts: 2)

        var snapshot = OMCSnapshot()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(
                agentId: "a1", agentType: "executor",
                startedAt: Date(timeIntervalSince1970: 100), completedAt: nil, status: .running
            ),
            OMCAgent(
                agentId: "a2", agentType: "verifier",
                startedAt: Date(timeIntervalSince1970: 50),
                completedAt: Date(timeIntervalSince1970: 60), status: .completed
            ),
        ])

        let rows = AgentRowBuilder.combined(state: state, snapshot: snapshot)
        // Everything working sorts above everything finished, whatever its origin.
        let runningPrefix = rows.prefix { $0.isRunning }
        XCTAssertEqual(runningPrefix.count, 2)
        XCTAssertTrue(runningPrefix.contains { $0.origin == .lane })
        XCTAssertTrue(runningPrefix.contains { $0.origin == .omc })
    }

    func testOmcRowsExcludePhantomAgents() {
        var snapshot = OMCSnapshot()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(
                agentId: "real", agentType: "explore",
                startedAt: Date(), completedAt: nil, status: .running
            ),
            OMCAgent(
                agentId: "ghost", agentType: "untracked-native-fork",
                startedAt: Date(), completedAt: Date(), status: .completed, synthetic: true
            ),
        ])
        let rows = AgentRowBuilder.omcAgents(from: snapshot)
        XCTAssertEqual(rows.map(\.title), ["explore"])
    }

    // MARK: - Modes

    func testOnlyFanOutModesAreMultiLane() {
        XCTAssertFalse(RunMode.ask.isMultiLane)
        XCTAssertFalse(RunMode.agent.isMultiLane)
        XCTAssertTrue(RunMode.compare.isMultiLane)
        XCTAssertTrue(RunMode.race.isMultiLane)
    }

    func testEveryTabHasAnIconAndTitle() {
        for tab in WorkspaceTab.allCases {
            XCTAssertFalse(tab.title.isEmpty)
            XCTAssertFalse(tab.systemImage.isEmpty)
        }
    }

    // MARK: - OMC controller

    func testOMCControllerReportsUnavailableForANonOMCProject() {
        let controller = OMCController(workspace: nil)
        XCTAssertFalse(controller.isAvailable)
        XCTAssertTrue(controller.snapshot.isEmpty)
        // Starting a watch on a project without OMC must be a no-op, not a crash.
        controller.start()
        XCTAssertFalse(controller.isWatching)
    }
}
