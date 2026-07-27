import XCTest
@testable import NexusKit

/// The view-state fold — a port of `packages/tui/src/store/viewState.ts`.
///
/// These mirror the invariants the TypeScript reducer is tested on, because the
/// app inherits its correctness from that design: prompts delimit turns, stray
/// terminal events never mint blank turns, failures attach to the turn, and
/// replaying a log is deterministic.
final class ViewStateTests: XCTestCase {
    private func fixture(_ name: String) throws -> [UiEvent] {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "ndjson")
        )
        return UiEventDecoder.decodeStream(try String(contentsOf: url, encoding: .utf8))
    }

    func testFoldIsDeterministic() throws {
        let events = try fixture("events")
        XCTAssertEqual(ViewState.reduce(events: events), ViewState.reduce(events: events))
    }

    func testStreamingTextAccumulatesOntoTheLiveTurn() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "hi")), ts: 0)
        state.reduce(.text(.init(lane: "main", delta: "Hello, ")), ts: 1)
        state.reduce(.text(.init(lane: "main", delta: "world")), ts: 2)

        XCTAssertTrue(state.streaming)
        XCTAssertEqual(state.lanes["main"]?.live?.text, "Hello, world")
        XCTAssertEqual(state.lanes["main"]?.live?.prompt, "hi")
    }

    func testDoneFinalizesTheTurnAndStopsStreaming() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "hi")), ts: 0)
        state.reduce(.text(.init(lane: "main", delta: "answer")), ts: 1)
        state.reduce(.done(.init(lane: "main", finishReason: "stop")), ts: 2)

        XCTAssertFalse(state.streaming)
        XCTAssertNil(state.lanes["main"]?.live)
        XCTAssertEqual(state.lanes["main"]?.finalized.count, 1)
        XCTAssertEqual(state.lanes["main"]?.finalized.first?.finishReason, "stop")
    }

    func testStrayDoneDoesNotMintABlankTurn() {
        var state = ViewState()
        state.reduce(.done(.init(lane: "main", finishReason: "stop")), ts: 0)
        // A late/duplicate terminal event must not create a phantom bubble or
        // flash the streaming indicator on.
        XCTAssertNil(state.lanes["main"]?.live)
        XCTAssertEqual(state.lanes["main"]?.finalized.count ?? 0, 0)
        XCTAssertFalse(state.streaming)
    }

    func testStrayToolResultIsIgnored() {
        var state = ViewState()
        state.reduce(.toolResult(.init(lane: "main", id: "x", ok: true, result: nil)), ts: 0)
        XCTAssertNil(state.lanes["main"]?.live)
    }

    func testAPromptFinalizesADanglingTurnAsInterrupted() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "first")), ts: 0)
        state.reduce(.text(.init(lane: "main", delta: "partial")), ts: 1)
        // No `done` — the user submits again.
        state.reduce(.prompt(.init(lane: "main", id: "p1", text: "second")), ts: 2)

        XCTAssertEqual(state.lanes["main"]?.finalized.count, 1)
        XCTAssertEqual(state.lanes["main"]?.finalized.first?.finishReason, "interrupted")
        XCTAssertEqual(state.lanes["main"]?.live?.prompt, "second")
    }

    func testErrorAttachesToTheTurnAndFinalizesIt() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "hi")), ts: 0)
        state.reduce(
            .error(.init(lane: "main", code: "quota_exhausted", message: "out", retryable: true)),
            ts: 1
        )

        let turn = state.lanes["main"]?.finalized.first
        // The failure lives ON the turn, so a collapsed notification rail can
        // never make a failure look like an empty answer.
        XCTAssertEqual(turn?.error?.code, "quota_exhausted")
        XCTAssertEqual(turn?.finishReason, "error:quota_exhausted")
        XCTAssertFalse(state.streaming)
        XCTAssertEqual(state.providerHealth["main"]?.status, .degraded)
    }

    func testToolCallAndResultPair() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "go")), ts: 0)
        state.reduce(.toolCall(.init(lane: "main", id: "c1", name: "bash", args: nil)), ts: 1)
        XCTAssertEqual(state.lanes["main"]?.live?.tools.first?.status, .running)

        state.reduce(
            .toolResult(.init(lane: "main", id: "c1", ok: false, result: .string("boom"))),
            ts: 2
        )
        XCTAssertEqual(state.lanes["main"]?.live?.tools.first?.status, .error)
        XCTAssertEqual(state.lanes["main"]?.live?.tools.first?.result, .string("boom"))
    }

    func testUsageAccumulatesTotalsAndTracksTheLastRun() throws {
        var state = ViewState()
        state.reduce(
            .usage(.init(lane: "main", inputTokens: 10, outputTokens: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.01)),
            ts: 0
        )
        state.reduce(
            .usage(.init(lane: "main", inputTokens: 20, outputTokens: 7, cacheRead: nil, cacheWrite: nil, costUsd: 0.02)),
            ts: 1
        )
        XCTAssertEqual(state.totals.inputTokens, 30)
        XCTAssertEqual(state.totals.outputTokens, 12)
        XCTAssertEqual(state.totals.cacheRead, 2)
        XCTAssertEqual(state.totals.costUsd, 0.03, accuracy: 1e-9)
        XCTAssertFalse(state.totals.costIncomplete, "both runs were priced — the total is complete")
        XCTAssertEqual(try XCTUnwrap(state.runUsd), 0.02, accuracy: 1e-9)
        XCTAssertEqual(state.lastUsage.inputTokens, 20)
    }

    // MARK: - Unpriced usage (costUsd: nil)
    //
    // `unknown cost is not zero cost` — same rule the codebase already
    // applies to a timed-out approval (not a refusal) and an `indeterminate`
    // agent verdict (not success). See `UsageTotals.costIncomplete`.

    func testUnpricedUsageIsUnknownNotZeroAndMarksTheTotalIncomplete() {
        var state = ViewState()
        state.reduce(
            .usage(.init(lane: "main", inputTokens: 10, outputTokens: 5, cacheRead: nil, cacheWrite: nil, costUsd: nil)),
            ts: 0
        )
        XCTAssertNil(state.runUsd, "unpriced pricing must surface as nil, never as a confident $0")
        XCTAssertEqual(state.totals.costUsd, 0, "nothing to add to the partial sum for an unpriced turn")
        XCTAssertTrue(state.totals.costIncomplete)
        // The rest of the event is unaffected — token counts are never lost
        // just because the price is unknown.
        XCTAssertEqual(state.totals.inputTokens, 10)
        XCTAssertEqual(state.totals.outputTokens, 5)
    }

    func testGenuineZeroCostStaysCompleteAndDistinctFromUnpriced() {
        var state = ViewState()
        state.reduce(
            .usage(.init(lane: "main", inputTokens: 3, outputTokens: 8, cacheRead: nil, cacheWrite: nil, costUsd: 0)),
            ts: 0
        )
        XCTAssertEqual(state.runUsd, 0, "a real free run (mock, local models) must read as a definite zero")
        XCTAssertFalse(state.totals.costIncomplete, "a confirmed zero is not incomplete pricing")
    }

    func testMixedKnownAndUnpricedUsageReportsIncompleteWithAPartialSum() {
        var state = ViewState()
        state.reduce(
            .usage(.init(lane: "main", inputTokens: 10, outputTokens: 5, cacheRead: nil, cacheWrite: nil, costUsd: 0.02)),
            ts: 0
        )
        state.reduce(
            .usage(.init(lane: "main", inputTokens: 4, outputTokens: 2, cacheRead: nil, cacheWrite: nil, costUsd: nil)),
            ts: 1
        )
        XCTAssertEqual(state.totals.costUsd, 0.02, accuracy: 1e-9, "partial sum over the one priced turn")
        XCTAssertTrue(state.totals.costIncomplete, "the second, unpriced turn taints the whole total")
        XCTAssertNil(state.runUsd, "the LATEST run is the unpriced one, even though an earlier run was priced")
    }

    // MARK: - Multi-agent lanes

    func testConcurrentLanesStayIndependent() throws {
        let state = ViewState.reduce(events: try fixture("multi-lane"))

        // Three agents ran in parallel; each keeps its own transcript.
        XCTAssertEqual(state.laneOrder, ["anthropic", "openai", "gemini"])
        XCTAssertEqual(state.lanes["anthropic"]?.finalized.first?.text, "Claude says hello")
        XCTAssertEqual(state.lanes["openai"]?.finalized.first?.text, "GPT says hi")
        // Gemini failed; its turn carries the error rather than looking empty.
        XCTAssertEqual(state.lanes["gemini"]?.finalized.first?.error?.code, "auth")
    }

    func testLaneHealthIsAttributedPerProviderInFanOut() throws {
        let state = ViewState.reduce(events: try fixture("multi-lane"))
        // In fan-out the lane key IS the adapter id, so health is per-provider.
        XCTAssertEqual(state.providerHealth["anthropic"]?.status, .ok)
        XCTAssertEqual(state.providerHealth["gemini"]?.status, .down)
    }

    func testActiveLanesReportsOnlyStreamingAgents() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "a", id: "p", text: "x")), ts: 0)
        state.reduce(.prompt(.init(lane: "b", id: "p", text: "x")), ts: 1)
        XCTAssertEqual(state.activeLanes.map(\.lane), ["a", "b"])

        state.reduce(.done(.init(lane: "a", finishReason: "stop")), ts: 2)
        XCTAssertEqual(state.activeLanes.map(\.lane), ["b"])
        XCTAssertTrue(state.streaming, "one agent still working keeps the session live")
    }

    // MARK: - Agent loop (`nexus agent --role …`)

    private func agentStep(
        _ phase: String, step: Int = 0, role: String = "coder", data: JSONValue? = nil
    ) -> UiEvent {
        .agent(.init(lane: "main", phase: phase, role: role, step: step, text: "narration", data: data))
    }

    func testAgentStepsAttachToTheLiveTurn() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "add a function")), ts: 0)
        state.reduce(agentStep("step-start"), ts: 1)
        state.reduce(agentStep("plan"), ts: 2)

        let turn = state.lanes["main"]?.live
        XCTAssertEqual(turn?.agentSteps.map(\.phase), ["step-start", "plan"])
        XCTAssertEqual(turn?.agentRole, "coder")
        XCTAssertTrue(turn?.isAgentRun == true)
    }

    func testAnOrdinaryChatTurnIsNotMistakenForAnAgentRun() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "hi")), ts: 0)
        state.reduce(.text(.init(lane: "main", delta: "hello")), ts: 1)
        // No agent events -> the Agents view must not invent a run.
        XCTAssertFalse(state.lanes["main"]?.live?.isAgentRun == true)
        XCTAssertNil(state.lanes["main"]?.live?.agentVerdict)
    }

    func testProgressReportsTheLatestPercentage() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "go")), ts: 0)
        state.reduce(agentStep("progress", data: .object(["percent": .number(30)])), ts: 1)
        state.reduce(agentStep("progress", step: 1, data: .object(["percent": .number(75)])), ts: 2)
        XCTAssertEqual(state.lanes["main"]?.live?.agentProgress, 75)
    }

    func testVerdictIsNilWhileTheRunIsStillGoing() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "go")), ts: 0)
        state.reduce(agentStep("plan"), ts: 1)
        // Nothing has been decided yet — a view must show "working", not an outcome.
        XCTAssertNil(state.lanes["main"]?.live?.agentVerdict)
    }

    func testVerdictSurvivesAsThreeValuedRatherThanCollapsingToABool() {
        for (raw, expected) in [
            ("met", AgentVerdict.met), ("unmet", .unmet), ("indeterminate", .indeterminate),
        ] {
            var state = ViewState()
            state.reduce(.prompt(.init(lane: "main", id: "p0", text: "go")), ts: 0)
            state.reduce(
                agentStep("stop", data: .object(["stopReason": .string("x"), "verdict": .string(raw)])),
                ts: 1
            )
            XCTAssertEqual(state.lanes["main"]?.live?.agentVerdict, expected, "verdict \(raw)")
        }
    }

    func testAnUnreadableVerdictFallsBackToIndeterminateNeverToSuccess() {
        // The single most important assertion here. A finished run whose verdict
        // is missing or unrecognized is precisely the uncertainty this type
        // exists to express — defaulting it to `.met` would render a green check
        // over an outcome nothing verified.
        for data in [JSONValue.object(["stopReason": .string("x")]), .object(["verdict": .string("👍")])] {
            var state = ViewState()
            state.reduce(.prompt(.init(lane: "main", id: "p0", text: "go")), ts: 0)
            state.reduce(agentStep("stop", data: data), ts: 1)
            XCTAssertEqual(state.lanes["main"]?.live?.agentVerdict, .indeterminate)
        }
    }

    func testStopReasonAndDelegatedRolesAreExposed() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "go")), ts: 0)
        state.reduce(agentStep("delegate", data: .object(["role": .string("reviewer")])), ts: 1)
        state.reduce(agentStep("delegate", step: 1, data: .object(["role": .string("tester")])), ts: 2)
        state.reduce(
            agentStep("stop", step: 2, data: .object(["stopReason": .string("goal-met"), "verdict": .string("met")])),
            ts: 3
        )

        let turn = state.lanes["main"]?.live
        XCTAssertEqual(turn?.delegatedRoles, ["reviewer", "tester"])
        XCTAssertEqual(turn?.agentStopReason, "goal-met")
        XCTAssertEqual(turn?.agentVerdict, .met)
    }

    func testAgentStepsSurviveTurnFinalizationAndReplay() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p0", text: "go")), ts: 0)
        state.reduce(agentStep("plan"), ts: 1)
        state.reduce(.done(.init(lane: "main", finishReason: "stop")), ts: 2)

        let finalized = try XCTUnwrap(state.lanes["main"]?.finalized.first)
        XCTAssertEqual(finalized.agentSteps.count, 1)

        // Ids are derived from position in the log, so replaying is identical.
        var replay = ViewState()
        for (index, event) in [
            UiEvent.prompt(.init(lane: "main", id: "p0", text: "go")),
            agentStep("plan"),
            .done(.init(lane: "main", finishReason: "stop")),
        ].enumerated() {
            replay.reduce(event, ts: Double(index))
        }
        XCTAssertEqual(state, replay)
    }

    func testFailoverMarksTheDepartedProviderDegraded() {
        var state = ViewState()
        state.reduce(
            .failover(.init(lane: "main", from: "anthropic", to: "openai", code: "quota", message: "m")),
            ts: 0
        )
        XCTAssertEqual(state.providerHealth["anthropic"]?.status, .degraded)
        XCTAssertEqual(state.providerHealth["openai"]?.status, .ok)
        XCTAssertEqual(state.notifications.first?.kind, .failover)
    }
}
