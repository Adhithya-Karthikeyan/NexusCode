import XCTest
@testable import NexusKit

/// `NexusSession`/`NexusSessionDetail` decode straight from the `JSONValue`
/// `NexusClient.runJSON` hands back — driven by fixtures shaped exactly like
/// `nexus session list -o json` / `nexus session show <id> -o json`, each
/// deliberately including a row too malformed to display (no `sessionId` /
/// `run_id`) so the decode-drops-one-row-not-the-whole-list behavior has real
/// coverage, not just the happy path.
final class SessionsTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    }

    private func fixtureText(_ name: String) throws -> String {
        try String(contentsOf: try fixtureURL(name), encoding: .utf8)
    }

    private func fixtureJSON(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: try fixtureURL(name)))
    }

    // MARK: - NexusSession decode

    func testDecodesANormalSessionListEntry() throws {
        let items = try XCTUnwrap(try fixtureJSON("sessions-list").arrayValue)
        let sessions = items.compactMap(NexusSession.init(json:))

        let full = try XCTUnwrap(sessions.first { $0.sessionId == "s1" })
        XCTAssertEqual(full.name, "Fix auth bug")
        XCTAssertEqual(full.provider, "anthropic")
        XCTAssertEqual(full.model, "claude-sonnet-5")
        XCTAssertEqual(full.turnCount, 4)
        XCTAssertEqual(full.runCount, 4)
        XCTAssertEqual(full.eventCount, 22)
        XCTAssertEqual(full.inputTokens, 1200)
        XCTAssertEqual(full.outputTokens, 340)
        XCTAssertEqual(try XCTUnwrap(full.costUsd), 0.0123, accuracy: 0.00001)
        XCTAssertFalse(full.costIncomplete)
    }

    // MARK: - Unknown cost (`costUsd: null` / `costIncomplete`)
    //
    // The `?? 0` this used to do at decode time conflated "the CLI told us
    // this is unknown" with "the CLI told us this is free" — the same class
    // of bug fixed for `UiEvent.Usage.costUsd`. These cover the round trip
    // `NexusSession` is responsible for.

    func testCostUsdNullDecodesAsUnknownNotZero() throws {
        let json = JSONValue.object([
            "sessionId": .string("s-unpriced"),
            "costUsd": .null,
            "costIncomplete": .bool(true),
        ])
        let session = try XCTUnwrap(NexusSession(json: json))
        XCTAssertNil(session.costUsd, "a null costUsd on the wire must stay nil, never coerce to 0")
        XCTAssertTrue(session.costIncomplete)
    }

    func testCostUsdZeroAndAbsentCostUsdAreDistinctFromEachOtherAndFromIncomplete() throws {
        let zero = JSONValue.object(["sessionId": .string("s-zero"), "costUsd": .number(0)])
        let missing = JSONValue.object(["sessionId": .string("s-missing")])

        let zeroSession = try XCTUnwrap(NexusSession(json: zero))
        let missingSession = try XCTUnwrap(NexusSession(json: missing))

        XCTAssertEqual(zeroSession.costUsd, 0, "a real zero must round-trip as a definite zero, not nil")
        XCTAssertFalse(zeroSession.costIncomplete)

        XCTAssertNil(missingSession.costUsd, "an absent costUsd key is unknown, not a confirmed zero")
        XCTAssertFalse(missingSession.costIncomplete, "costIncomplete defaults false when the wire omits it")
    }

    func testMixedSessionWithAPartialSumStillReportsIncomplete() throws {
        // A session where some runs were priced and some were not: the CLI
        // reports a nonzero PARTIAL sum alongside costIncomplete: true — the
        // number is real, just not the whole story.
        let json = JSONValue.object([
            "sessionId": .string("s-mixed"),
            "costUsd": .number(0.05),
            "costIncomplete": .bool(true),
        ])
        let session = try XCTUnwrap(NexusSession(json: json))
        XCTAssertEqual(try XCTUnwrap(session.costUsd), 0.05, accuracy: 1e-9)
        XCTAssertTrue(session.costIncomplete)
    }

    func testMissingOptionalFieldsDegradeThatFieldRatherThanTheWholeRow() throws {
        let items = try XCTUnwrap(try fixtureJSON("sessions-list").arrayValue)
        let sessions = items.compactMap(NexusSession.init(json:))

        let minimal = try XCTUnwrap(sessions.first { $0.sessionId == "s2" })
        XCTAssertNil(minimal.name)
        XCTAssertNil(minimal.provider)
        XCTAssertNil(minimal.model)
        // Numeric fields still default sanely rather than propagating nil.
        XCTAssertEqual(minimal.turnCount, 1)
    }

    func testRowsWithNoSessionIdAreDroppedRatherThanCrashingTheWholeDecode() throws {
        let items = try XCTUnwrap(try fixtureJSON("sessions-list").arrayValue)
        XCTAssertEqual(items.count, 3, "fixture shape changed")

        let sessions = items.compactMap(NexusSession.init(json:))
        XCTAssertEqual(sessions.count, 2, "the row without sessionId must be dropped, not fail the array")
    }

    func testEpochMillisAreConvertedNotTreatedAsSeconds() throws {
        let items = try XCTUnwrap(try fixtureJSON("sessions-list").arrayValue)
        let session = try XCTUnwrap(items.compactMap(NexusSession.init(json:)).first { $0.sessionId == "s1" })

        // 1_750_000_000_000 ms is 1_750_000_000 s (mid-2025). Treating the wire
        // value as seconds directly would land somewhere in the year 57426 —
        // wrong by 1000x, and easy to miss at a glance.
        XCTAssertEqual(session.createdAt, Date(timeIntervalSince1970: 1_750_000_000))
        XCTAssertEqual(session.updatedAt, Date(timeIntervalSince1970: 1_750_003_600))
    }

    func testEmptyArrayProducesAnEmptyListNotAFailure() {
        XCTAssertTrue([JSONValue]().compactMap(NexusSession.init(json:)).isEmpty)
    }

    // MARK: - NexusSessionDetail (`session show`)

    func testDecodesSessionShowWithItsRunsList() throws {
        let detail = NexusSessionDetail(json: try fixtureJSON("session-show"))

        XCTAssertEqual(detail.session?.sessionId, "s1")
        XCTAssertEqual(detail.runs.count, 2, "the run with no run_id must be dropped")

        let full = try XCTUnwrap(detail.runs.first { $0.runId == "r1" })
        XCTAssertEqual(full.adapterId, "anthropic")
        XCTAssertEqual(full.model, "claude-sonnet-5")
        XCTAssertEqual(full.status, "completed")

        let degraded = try XCTUnwrap(detail.runs.first { $0.runId == "r2" })
        XCTAssertNil(degraded.adapterId)
        XCTAssertNil(degraded.model)
        XCTAssertEqual(degraded.status, "completed")
    }

    func testSessionShowDegradesToANilSessionRatherThanThrowing() {
        let detail = NexusSessionDetail(json: .object(["runs": .array([])]))
        XCTAssertNil(detail.session)
        XCTAssertTrue(detail.runs.isEmpty)
    }

    // MARK: - Command factories

    func testSessionListBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.sessionList().arguments, ["session", "list", "-o", "json"])
    }

    func testSessionShowBuildsAJsonCommandWithTheId() {
        XCTAssertEqual(NexusCommand.sessionShow(id: "s1").arguments, ["session", "show", "s1", "-o", "json"])
    }

    func testReplayBuildsAnNdjsonCommandNotAJsonOne() {
        // `replay` streams the whole `UiEvent` log, so it must NOT go through
        // `-o json` the way the other session commands do.
        XCTAssertEqual(NexusCommand.replay(sessionId: "s1").arguments, ["replay", "s1", "-o", "ndjson"])
    }

    // MARK: - NexusClient.runJSON + SessionsController, against a fake `nexus`
    //
    // A tiny shell script stands in for the real CLI so these stay hermetic
    // (no dependency on a built `nexus`, unlike `NexusClientIntegrationTests`)
    // while still exercising the real `Process`/pipe/`LineBuffer` plumbing
    // `runJSON` was added on top of.

    private func fakeNexusBinary(printing output: String, exitCode: Int32 = 0) throws -> NexusBinary {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-nexus-\(UUID().uuidString)")
        let contents = """
        #!/bin/sh
        cat <<'NEXUS_FIXTURE_EOF'
        \(output)
        NEXUS_FIXTURE_EOF
        exit \(exitCode)
        """
        try contents.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return NexusBinary(url: script)
    }

    func testRunJSONParsesTheProcesssSingleStdoutDocument() async throws {
        let binary = try fakeNexusBinary(printing: #"{"sessionId":"s1","turnCount":2}"#)
        let result = await NexusClient(binary: binary).runJSON(NexusCommand(["session", "list"]))

        guard case .success(let value) = result else {
            return XCTFail("expected success, got \(result)")
        }
        XCTAssertEqual(value["sessionId"]?.stringValue, "s1")
    }

    func testRunJSONSurfacesMalformedStdoutAsAFailureNotACrash() async throws {
        let binary = try fakeNexusBinary(printing: "this is not { json")
        let result = await NexusClient(binary: binary).runJSON(NexusCommand(["session", "list"]))

        guard case .failure(.malformedJSON(let text)) = result else {
            return XCTFail("expected .malformedJSON, got \(result)")
        }
        XCTAssertTrue(text.contains("this is not"))
    }

    func testRunJSONSurfacesANonZeroExitAsAFailure() async throws {
        let binary = try fakeNexusBinary(printing: "boom", exitCode: 1)
        let result = await NexusClient(binary: binary).runJSON(NexusCommand(["session", "list"]))

        guard case .failure(.nonZeroExit(let code, _)) = result else {
            return XCTFail("expected .nonZeroExit, got \(result)")
        }
        XCTAssertEqual(code, 1)
    }

    @MainActor
    func testSessionsControllerRefreshPopulatesFromRealProcessOutputNewestUpdatedFirst() async throws {
        let binary = try fakeNexusBinary(printing: try fixtureText("sessions-list"))
        let controller = SessionsController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertNil(controller.error)
        XCTAssertFalse(controller.isLoading)
        XCTAssertEqual(controller.sessions.count, 2, "the malformed row must be dropped")
        XCTAssertEqual(controller.sessions.first?.sessionId, "s2", "s2 was updated later than s1")
    }

    @MainActor
    func testSessionsControllerSurfacesRunJSONFailureAsItsError() async throws {
        let binary = try fakeNexusBinary(printing: "not json")
        let controller = SessionsController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertTrue(controller.sessions.isEmpty)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testReplayCommandForThreadsTheWorkingDirectoryAndSessionId() {
        let cwd = URL(fileURLWithPath: "/tmp")
        let controller = SessionsController(
            client: NexusClient(binary: NexusBinary(url: URL(fileURLWithPath: "/bin/echo"))),
            workingDirectory: cwd
        )
        let command = controller.replayCommand(for: "s1")
        XCTAssertEqual(command.arguments, ["replay", "s1", "-o", "ndjson"])
        XCTAssertEqual(command.workingDirectory, cwd)
    }

    // MARK: - replayEvents (Sessions tab "Replay" wiring)
    //
    // `SessionsView`'s Replay button hands `replayEvents(for:)`'s result
    // straight to `ConversationController.ingest(_:)` — these cover that it
    // collects the real `UiEvent`s a `nexus replay … -o ndjson` process
    // prints, in order, and drops nothing but genuine noise.

    @MainActor
    func testReplayEventsCollectsEveryEventFromTheProcessInOrder() async throws {
        let binary = try fakeNexusBinary(printing: """
        {"t":"prompt","lane":"main","id":"p0","text":"hi"}
        {"t":"text","lane":"main","delta":"hello there"}
        {"t":"done","lane":"main","finishReason":"stop"}
        """)
        let controller = SessionsController(client: NexusClient(binary: binary))

        let events = await controller.replayEvents(for: "s1")

        XCTAssertEqual(events.count, 3)
        guard case .prompt(let prompt) = events[0] else {
            return XCTFail("expected the first replayed event to be the prompt")
        }
        XCTAssertEqual(prompt.text, "hi")
        guard case .text(let delta) = events[1] else {
            return XCTFail("expected the second replayed event to be the text delta")
        }
        XCTAssertEqual(delta.delta, "hello there")
        guard case .done = events[2] else {
            return XCTFail("expected the third replayed event to be done")
        }
    }

    @MainActor
    func testReplayEventsFeedsConversationControllerIngestToRebuildTheTranscript() async throws {
        // The real point of `replayEvents`: its output is exactly what
        // `ConversationController.ingest(_:)` expects, so a replayed session
        // renders through the SAME fold a live run uses — no parallel
        // renderer.
        let binary = try fakeNexusBinary(printing: """
        {"t":"prompt","lane":"main","id":"p0","text":"hi"}
        {"t":"text","lane":"main","delta":"hello there"}
        """)
        let controller = SessionsController(client: NexusClient(binary: binary))
        let events = await controller.replayEvents(for: "s1")

        let conversation = ConversationController(
            client: NexusClient(binary: binary),
            binary: binary
        )
        conversation.ingest(events)

        XCTAssertFalse(conversation.view.lanes.isEmpty)
    }

    @MainActor
    func testReplayEventsIsEmptyWhenTheProcessPrintsNothing() async throws {
        let binary = try fakeNexusBinary(printing: "")
        let controller = SessionsController(client: NexusClient(binary: binary))

        let events = await controller.replayEvents(for: "s1")
        XCTAssertTrue(events.isEmpty)
    }
}
