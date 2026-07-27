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
        // `.ask` is single-lane, so `submit()` actually runs this through the
        // persistent `chat --persistent` process (see `submitToPersistentSession`)
        // rather than a one-shot `nexus ask` — the preview must say so, not the
        // subcommand name a one-shot dispatch would use. The prompt itself is
        // never in this argv: it travels over stdin once the backend is ready.
        XCTAssertEqual(args.first, "chat")
        XCTAssertTrue(args.contains("--persistent"))
        XCTAssertFalse(args.contains("hello"))
        // ndjson is what makes the app a renderer rather than a screen-scraper.
        XCTAssertTrue(args.contains("-o") && args.contains("ndjson"))
        XCTAssertTrue(args.contains("-p") && args.contains("anthropic"))
        XCTAssertTrue(args.contains("-m") && args.contains("claude-sonnet-4-5"))
    }

    func testAgentModeWithNoRoleAlsoRunsThroughThePersistentSession() {
        let c = controller()
        c.mode = .agent
        // `.agent` with no role is byte-identical to `.ask` (see
        // `testAgentWithNilRoleIsByteIdenticalToTodaysBehaviour`), so it too
        // previews and runs the persistent `chat --persistent` invocation —
        // never the one-shot `nexus agent` subcommand.
        let args = c.plannedCommand(for: "do it").arguments
        XCTAssertEqual(args.first, "chat")
        XCTAssertFalse(args.contains("do it"))
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

    // MARK: - Preview/spawn parity (Bug 1 regression guard)

    /// `plannedCommand` claims to show "exactly which `nexus` invocation the
    /// button maps to". For single-lane modes that used to be false: the
    /// preview showed `["ask", prompt, …]` while `submit()` actually spawned
    /// `chat --persistent …` via `PersistentSession`, which built its OWN argv
    /// from `extraArguments`. This asserts the preview is the identical array
    /// `submitToPersistentSession` hands to `PersistentSession` — not two
    /// literals that merely happen to match — so it fails under the old
    /// two-builder code, where the preview started with `"ask"`/the prompt and
    /// the real spawn started with `"chat"`/`"--persistent"`/no prompt at all.
    func testPreviewArgvMatchesWhatIsActuallySpawnedForASingleLaneSubmit() {
        let c = controller()
        c.mode = .ask
        c.provider = "anthropic"
        c.model = "claude-sonnet-4-5"
        c.sessionId = "s_1"

        let preview = c.plannedCommand(for: "hello").arguments
        let spawned = c.persistentSessionArguments()
        XCTAssertEqual(preview, spawned)
        // The persistent path never puts the prompt in argv — it is written to
        // the process's stdin turn by turn once the backend is ready.
        XCTAssertFalse(spawned.contains("hello"))
        XCTAssertEqual(spawned.first, "chat")
        XCTAssertTrue(spawned.contains("--persistent"))

        c.submit("hello")
        // What actually got spawned matches what was previewed.
        XCTAssertEqual(c.activeBackendProvider, "anthropic")
        XCTAssertEqual(c.activeBackendModel, "claude-sonnet-4-5")
    }

    // MARK: - Role (Bug 2 / Bug 3)

    func testAgentWithNilRoleIsByteIdenticalToTodaysBehaviour() {
        let withRole = controller()
        withRole.mode = .agent
        withRole.provider = "anthropic"
        withRole.model = "claude-sonnet-4-5"
        withRole.role = nil

        let withoutRoleProperty = controller()
        withoutRoleProperty.mode = .agent
        withoutRoleProperty.provider = "anthropic"
        withoutRoleProperty.model = "claude-sonnet-4-5"

        // `role == nil` must produce the exact same argv as before this
        // property existed: the persistent `chat --persistent` invocation,
        // with no `--role` anywhere in it.
        let args = withRole.plannedCommand(for: "do it").arguments
        XCTAssertEqual(args, withoutRoleProperty.plannedCommand(for: "do it").arguments)
        XCTAssertFalse(args.contains("--role"))
        XCTAssertEqual(args.first, "chat")
    }

    func testAgentWithARoleInvokesTheRoleFlagAsAOneShotDispatch() {
        let c = controller()
        c.mode = .agent
        c.provider = "mock"
        c.model = "mock-tools"
        c.role = "coder"

        let args = c.plannedCommand(for: "fix the bug").arguments
        XCTAssertEqual(args.first, "agent")
        XCTAssertTrue(args.contains("fix the bug"))
        XCTAssertEqual(args.filter { $0 == "--role" }.count, 1)
        XCTAssertTrue(args.contains("--role") && args.contains("coder"))
        XCTAssertTrue(args.contains("-o") && args.contains("ndjson"))
        XCTAssertTrue(args.contains("-p") && args.contains("mock"))
        XCTAssertTrue(args.contains("-m") && args.contains("mock-tools"))
        // `nexus agent --role` has no `--persistent` mode — it is one-shot per
        // invocation, unlike `chat --persistent` — so a role run must dispatch
        // like `compare`/`race` do, never through the persistent session.
        XCTAssertFalse(args.contains("--persistent"))

        c.submit("fix the bug")
        // A role run is one-shot: it must never touch the persistent backend.
        XCTAssertNil(c.activeBackendProvider)
    }

    func testRoleRunsDoNotClaimResumeSupportTheCliDoesNotHave() {
        let c = controller()
        c.mode = .agent
        c.role = "reviewer"
        c.sessionId = "s_999"

        // The OODA framework opens a fresh engine session on every invocation
        // and never reads `--resume` — attaching the flag would claim a
        // continuity the CLI does not provide.
        let args = c.plannedCommand(for: "review this").arguments
        XCTAssertFalse(args.contains("--resume"))
    }

    func testUnknownRoleStringIsPassedThroughUnmodified() {
        let c = controller()
        c.mode = .agent
        c.role = "totally-not-a-real-role"

        // Validation belongs to the CLI, which already returns a clear error;
        // duplicating a role allowlist here would be a stale copy waiting to
        // happen, exactly like the model picker.
        let args = c.plannedCommand(for: "x").arguments
        XCTAssertTrue(args.contains("--role") && args.contains("totally-not-a-real-role"))
    }

    /// Mirrors `testSwitchingProviderRelaunchesTheBackend`: a role change is
    /// exactly as spawn-affecting as a provider/model change, because setting
    /// a role moves the run off the persistent session entirely.
    func testSwitchingRoleRelaunchesTheBackend() {
        let c = controller()
        c.mode = .agent
        c.provider = "alpha"
        c.model = "alpha-1"
        // role == nil here: identical to `.ask`, runs the persistent session.
        c.submit("first")
        XCTAssertEqual(c.activeBackendProvider, "alpha")

        c.cancel()
        c.role = "coder"
        c.submit("second")

        // REGRESSION GUARD. Setting a role moves the run onto the one-shot
        // `agent --role` path. The stale role-less persistent backend must be
        // stopped rather than left running invisibly while a second, role-aware
        // process also starts — so the reported active backend must no longer
        // be the persistent one.
        XCTAssertNil(c.activeBackendProvider)
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

    // MARK: - Provider switching (regression)

    func testSwitchingProviderRelaunchesTheBackend() async throws {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"
        c.model = "alpha-1"

        c.submit("first")
        // The backend is spawned with `-p alpha` baked into argv.
        XCTAssertEqual(c.activeBackendProvider, "alpha")
        XCTAssertEqual(c.activeBackendModel, "alpha-1")

        // Settle the turn WITHOUT ending the session — `cancel()` frees the
        // composer but deliberately leaves the backend alive, which is exactly
        // the state a real user switches provider in.
        c.cancel()

        // The user picks a different provider and sends again.
        c.provider = "beta"
        c.model = "beta-1"
        c.submit("second")

        // REGRESSION GUARD. The original implementation only spawned when
        // `session == nil`, so a switch left the ORIGINAL process running: the
        // picker said Codex while Claude kept answering. The backend must now
        // be relaunched against the new selection.
        XCTAssertEqual(c.activeBackendProvider, "beta")
        XCTAssertEqual(c.activeBackendModel, "beta-1")
    }

    func testSameProviderDoesNotRelaunchTheBackend() {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"

        c.submit("first")
        let before = c.activeBackendProvider
        c.cancel()
        c.submit("second")

        // Restarting on every turn would throw away the conversation's process
        // (and its warm state) for nothing — only a CHANGE justifies it.
        XCTAssertEqual(c.activeBackendProvider, before)
    }

    func testFanOutModesDoNotTouchThePersistentBackend() {
        let c = controller()
        c.mode = .compare
        c.backends = ["one", "two"]
        c.submit("compare this")

        // compare/race are one-shot dispatches, not a held conversation, so they
        // must never spawn or disturb the persistent session.
        XCTAssertNil(c.activeBackendProvider)
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

    // MARK: - Role runs (`nexus agent --role …`)

    private func agentStep(
        lane: String = "main", _ phase: String, step: Int = 0, role: String = "coder", data: JSONValue? = nil
    ) -> UiEvent {
        .agent(.init(lane: lane, phase: phase, role: role, step: step, text: "narration", data: data))
    }

    func testRoleRunRowExposesRolePhaseStepAndProgress() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p", text: "build the thing")), ts: 0)
        state.reduce(agentStep("step-start", step: 0, role: "coder"), ts: 1)
        state.reduce(agentStep("delegate", step: 1, role: "coder", data: .object(["role": .string("reviewer")])), ts: 2)
        state.reduce(agentStep("progress", step: 1, role: "coder", data: .object(["percent": .number(40)])), ts: 3)

        let row = try XCTUnwrap(AgentRowBuilder.roleRuns(from: state).first)
        XCTAssertEqual(row.origin, .roleRun)
        XCTAssertEqual(row.title, "coder")
        XCTAssertTrue(row.isRunning)
        XCTAssertNil(row.verdict, "still running -> no verdict yet")
        XCTAssertEqual(row.subtitle, "progress · step 1")
        XCTAssertEqual(row.detail, "40% progress · delegated: reviewer")
    }

    func testRoleRunDoesNotAlsoAppearAsAPlainLaneRow() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p", text: "go")), ts: 0)
        state.reduce(agentStep("plan"), ts: 1)

        let rows = AgentRowBuilder.combined(state: state, snapshot: OMCSnapshot())
        XCTAssertTrue(rows.contains { $0.origin == .roleRun })
        XCTAssertFalse(rows.contains { $0.origin == .lane }, "a role run's lane must not double-count as a plain lane row")
        XCTAssertTrue(AgentRowBuilder.lanesExcludingRoleRuns(from: state).isEmpty)
    }

    func testAnOrdinaryChatTurnProducesNoRoleRunRow() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p", text: "hi")), ts: 0)
        state.reduce(.text(.init(lane: "main", delta: "hello")), ts: 1)

        XCTAssertTrue(AgentRowBuilder.roleRuns(from: state).isEmpty)
        // An ordinary chat turn keeps rendering as a plain lane, unaffected.
        XCTAssertEqual(AgentRowBuilder.lanesExcludingRoleRuns(from: state).map(\.origin), [.lane])
    }

    func testFourVerdictStatesMapToFourVisiblyDistinctRowStates() throws {
        func finishedRow(_ verdictData: JSONValue) throws -> AgentRow {
            var state = ViewState()
            state.reduce(.prompt(.init(lane: "main", id: "p", text: "go")), ts: 0)
            state.reduce(agentStep("stop", step: 1, data: verdictData), ts: 1)
            state.reduce(.done(.init(lane: "main", finishReason: "stop")), ts: 2)
            return try XCTUnwrap(AgentRowBuilder.roleRuns(from: state).first)
        }

        var running = ViewState()
        running.reduce(.prompt(.init(lane: "main", id: "p", text: "go")), ts: 0)
        running.reduce(agentStep("plan"), ts: 1)
        let runningRow = try XCTUnwrap(AgentRowBuilder.roleRuns(from: running).first)

        let metRow = try finishedRow(.object(["stopReason": .string("goal-met"), "verdict": .string("met")]))
        let unmetRow = try finishedRow(.object(["stopReason": .string("goal-unmet"), "verdict": .string("unmet")]))
        // No declared success criteria -> nothing to verify against. This is
        // the honest "we don't know" outcome, not a crash and not a soft fail.
        let indeterminateRow = try finishedRow(.object(["stopReason": .string("max-steps")]))

        XCTAssertTrue(runningRow.isRunning)
        XCTAssertNil(runningRow.verdict)

        XCTAssertFalse(metRow.isRunning)
        XCTAssertEqual(metRow.verdict, .met)

        XCTAssertFalse(unmetRow.isRunning)
        XCTAssertEqual(unmetRow.verdict, .unmet)

        XCTAssertFalse(indeterminateRow.isRunning)
        XCTAssertEqual(indeterminateRow.verdict, .indeterminate)

        // The assertion that matters most: an unverified run must never read
        // as either a success or a failure.
        XCTAssertNotEqual(indeterminateRow.verdict, metRow.verdict)
        XCTAssertNotEqual(indeterminateRow.verdict, unmetRow.verdict)

        // Running + the three verdicts are four pairwise-distinct signatures —
        // exactly the four states the card must render differently.
        let signatures = [runningRow, metRow, unmetRow, indeterminateRow].map {
            "\($0.isRunning)-\($0.verdict?.rawValue ?? "running")"
        }
        XCTAssertEqual(Set(signatures).count, 4)
    }

    func testCombinedStillReturnsLanesAndOmcAgentsExactlyAsBeforeWhenNoRoleRunIsPresent() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "anthropic", id: "p", text: "x")), ts: 0)
        state.reduce(.prompt(.init(lane: "openai", id: "p", text: "x")), ts: 1)
        state.reduce(.done(.init(lane: "openai", finishReason: "stop")), ts: 2)

        var snapshot = OMCSnapshot()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(agentId: "a1", agentType: "executor", startedAt: Date(), completedAt: nil, status: .running),
        ])

        let rows = AgentRowBuilder.combined(state: state, snapshot: snapshot)
        XCTAssertEqual(Set(rows.map(\.origin)), [.lane, .omc])
        XCTAssertEqual(rows.filter { $0.origin == .lane }.count, 2)
        XCTAssertEqual(rows.filter { $0.origin == .omc }.count, 1)
    }

    // MARK: - Modes

    func testOnlyFanOutModesAreMultiLane() {
        XCTAssertFalse(RunMode.ask.isMultiLane)
        XCTAssertFalse(RunMode.agent.isMultiLane)
        XCTAssertTrue(RunMode.compare.isMultiLane)
        XCTAssertTrue(RunMode.race.isMultiLane)
    }

    func testEveryTabBelongsToExactlyOneGroupAndNoneAreOrphaned() {
        // A tab added later but left out of `group`'s switch would vanish from
        // the sidebar entirely — the switch is exhaustive so that cannot
        // compile, but this also guards the reverse: a group with no tabs would
        // render an empty header.
        let grouped = WorkspaceTab.Group.allCases.flatMap { WorkspaceTab.tabs(in: $0) }
        XCTAssertEqual(Set(grouped), Set(WorkspaceTab.allCases))
        XCTAssertEqual(grouped.count, WorkspaceTab.allCases.count, "a tab appears in two groups")
        for group in WorkspaceTab.Group.allCases {
            XCTAssertFalse(WorkspaceTab.tabs(in: group).isEmpty, "\(group) renders an empty header")
        }
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
