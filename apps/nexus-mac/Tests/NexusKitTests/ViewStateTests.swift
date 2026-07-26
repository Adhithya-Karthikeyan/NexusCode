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

    func testUsageAccumulatesTotalsAndTracksTheLastRun() {
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
        XCTAssertEqual(state.runUsd, 0.02, accuracy: 1e-9)
        XCTAssertEqual(state.lastUsage.inputTokens, 20)
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
