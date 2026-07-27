import XCTest
@testable import NexusKit

/// The CONTRACT test between this app and the `nexus` CLI.
///
/// `Fixtures/events.ndjson` contains one line per `UiEvent` variant, captured
/// from a real `nexus ask -p mock -o ndjson` run and extended with the variants
/// the mock provider never emits. If the CLI ever renames a field or changes a
/// shape, these decodes fail loudly here instead of the app silently rendering
/// an empty panel — which is exactly the drift the repo already warns about for
/// its own CLI/TUI projection copies.
final class UiEventDecodingTests: XCTestCase {
    private func fixture(_ name: String) throws -> String {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "ndjson"),
            "missing fixture \(name).ndjson"
        )
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testDecodesEveryEventVariant() throws {
        let events = UiEventDecoder.decodeStream(try fixture("events"))
        XCTAssertEqual(events.count, 19, "every fixture line must decode to an event")

        let types = Set(events.map(\.wireType))
        for expected in [
            "session", "route", "prompt", "agent", "reasoning", "text", "tool_call",
            "tool_result", "diff", "approval", "usage", "failover", "done", "error",
        ] {
            XCTAssertTrue(types.contains(expected), "no \(expected) event decoded")
        }
    }

    func testSessionCarriesProviderAndModel() throws {
        let events = UiEventDecoder.decodeStream(try fixture("events"))
        guard case .session(let session)? = events.first else {
            return XCTFail("first event should be a session")
        }
        XCTAssertEqual(session.provider, "mock")
        XCTAssertEqual(session.model, "mock-fast")
        XCTAssertEqual(session.id, "run_a7bc6786-7086-4d7b-b3ef-ffa2560ed343")
    }

    func testAgentEventCarriesTheOodaStepStructure() throws {
        let events = UiEventDecoder.decodeStream(try fixture("events"))
        let agent = events.compactMap { event -> UiEvent.Agent? in
            if case .agent(let value) = event { return value }
            return nil
        }.first
        let unwrapped = try XCTUnwrap(agent)
        XCTAssertEqual(unwrapped.phase, "plan")
        XCTAssertEqual(unwrapped.role, "coder")
        XCTAssertEqual(unwrapped.step, 0)
        // Phase detail keeps its structure so a view can draw a plan tree rather
        // than re-parsing narration prose.
        XCTAssertEqual(unwrapped.data?["steps"]?.arrayValue?.count, 2)
    }

    func testAgentEventAccompaniesRatherThanReplacesItsNarration() throws {
        let events = UiEventDecoder.decodeStream(try fixture("events"))
        // The CLI emits the pair back to back: the structured event is a HEADER
        // for the reasoning text, not a substitute for it. A plain chat renderer
        // that ignores `agent` must still show the prose.
        let index = try XCTUnwrap(events.firstIndex { $0.wireType == "agent" })
        XCTAssertEqual(events[index + 1].wireType, "reasoning")
    }

    func testAgentEventToleratesAPhaseThisBuildDoesNotKnow() {
        // `phase` is a String, not an enum, precisely so a phase added later in
        // the agent package degrades to "shown verbatim" instead of failing to
        // decode and blanking the event.
        let event = UiEventDecoder.decodeLine(
            #"{"t":"agent","lane":"main","phase":"time-travel","role":"coder","step":4}"#
        )
        guard case .agent(let agent)? = event else {
            return XCTFail("an unknown phase must still decode as an agent event")
        }
        XCTAssertEqual(agent.phase, "time-travel")
        XCTAssertNil(agent.data, "absent phase detail is normal, not an error")
    }

    func testToolCallPreservesStructuredArguments() throws {
        let events = UiEventDecoder.decodeStream(try fixture("events"))
        let call = events.compactMap { event -> UiEvent.ToolCall? in
            if case .toolCall(let value) = event { return value }
            return nil
        }.first
        let unwrapped = try XCTUnwrap(call)
        XCTAssertEqual(unwrapped.name, "read_file")
        // Structure is preserved, not flattened to a string — the tool inspector
        // renders this as a tree.
        XCTAssertEqual(unwrapped.args?["path"]?.stringValue, "config.json")
        XCTAssertEqual(unwrapped.args?["limit"], .number(100))
    }

    func testUsageDecodesOptionalCacheFields() throws {
        let events = UiEventDecoder.decodeStream(try fixture("events"))
        let usage = events.compactMap { event -> UiEvent.Usage? in
            if case .usage(let value) = event { return value }
            return nil
        }.first
        let unwrapped = try XCTUnwrap(usage)
        XCTAssertEqual(unwrapped.cacheRead, 128)
        XCTAssertEqual(unwrapped.cacheWrite, 16)
        XCTAssertEqual(try XCTUnwrap(unwrapped.costUsd), 0.0042, accuracy: 1e-9)
    }

    func testUsageToleratesAbsentCacheFields() {
        // The real capture omits cacheRead/cacheWrite entirely.
        let line = #"{"t":"usage","lane":"main","inputTokens":3,"outputTokens":8,"costUsd":0}"#
        guard case .usage(let usage)? = UiEventDecoder.decodeLine(line) else {
            return XCTFail("usage without cache fields must still decode")
        }
        XCTAssertNil(usage.cacheRead)
        XCTAssertNil(usage.cacheWrite)
    }

    // MARK: - Unpriced usage (costUsd: null)
    //
    // The bug this guards against: an unpriced model's real `usage` event has
    // `costUsd: null` on the wire (see `Usage.costUsd`'s doc). Before this
    // fix, `costUsd` was non-optional `Double`, so decoding `null` into it
    // THREW, and `decodeLine`'s catch turned the WHOLE event into
    // `.unknown(type: "malformed", …)` — silently dropping the token counts
    // along with the cost. This is the assertion that would have caught it.

    func testUsageWithNullCostDecodesAsUsageNotAsAMalformedUnknownEvent() throws {
        // These exact bytes were captured live from the CLI's real
        // `chunkToUiEvents` (`packages/core/src/projection.ts`), not
        // hand-typed: `node -e 'require("./packages/core/dist").chunkToUiEvents({type:"usage",usage:{inputTokens:42,outputTokens:17}}, "main")'`
        // — i.e. exactly what a real paid call with no pricing-table entry
        // for its model puts on the wire.
        let line = #"{"t":"usage","lane":"main","inputTokens":42,"outputTokens":17,"costUsd":null}"#
        let event = UiEventDecoder.decodeLine(line)
        guard case .usage(let usage)? = event else {
            return XCTFail(
                "a usage event with costUsd: null must decode as .usage — got \(String(describing: event)) "
                    + "instead, meaning it silently degraded to .unknown and its token counts vanished"
            )
        }
        XCTAssertNil(usage.costUsd, "null means UNKNOWN pricing, never a coerced 0")
        // The whole point: the token counts must survive even though the
        // price is unknown — they must not vanish along with the cost.
        XCTAssertEqual(usage.inputTokens, 42)
        XCTAssertEqual(usage.outputTokens, 17)
    }

    func testUsageWithZeroCostIsGenuinelyFreeAndDistinctFromNullCost() throws {
        // Shape verified live against `node packages/cli/dist/index.js ask -p
        // mock -m mock-fast "hi" -o ndjson </dev/null`, which prints exactly
        // `{"t":"usage","lane":"main","inputTokens":1,"outputTokens":5,"costUsd":0}`
        // — no cacheRead/cacheWrite keys at all, costUsd a definite 0.
        let line = #"{"t":"usage","lane":"main","inputTokens":3,"outputTokens":8,"costUsd":0}"#
        guard case .usage(let usage)? = UiEventDecoder.decodeLine(line) else {
            return XCTFail("expected a usage event")
        }
        // A real `0` (mock provider, local models) must decode as a definite
        // zero, not as nil — the two states must stay distinguishable end to
        // end, not just at the type level.
        XCTAssertEqual(usage.costUsd, 0)
        XCTAssertNotNil(usage.costUsd)
    }

    func testUnknownEventTypeSurvivesAsUnknown() throws {
        let events = UiEventDecoder.decodeStream(try fixture("events"))
        let unknown = events.compactMap { event -> String? in
            if case .unknown(let type, _) = event { return type }
            return nil
        }
        // A newer CLI emitting an event this build predates must not vanish.
        XCTAssertEqual(unknown, ["some_future_event_type"])
    }

    func testMalformedLineBecomesUnknownRatherThanBeingDropped() {
        let event = UiEventDecoder.decodeLine("this is not json")
        guard case .unknown(let type, _)? = event else {
            return XCTFail("a malformed line must surface, not disappear")
        }
        XCTAssertEqual(type, "malformed")
    }

    func testBlankLinesAreIgnored() {
        XCTAssertNil(UiEventDecoder.decodeLine("   "))
        XCTAssertNil(UiEventDecoder.decodeLine(""))
    }

    func testLaneIsExposedForLaneScopedEvents() {
        let text = UiEventDecoder.decodeLine(#"{"t":"text","lane":"openai","delta":"hi"}"#)
        XCTAssertEqual(text?.lane, "openai")
        let session = UiEventDecoder.decodeLine(
            #"{"t":"session","id":"a","provider":"p","model":"m","ts":1}"#
        )
        XCTAssertNil(session?.lane, "session is not lane-scoped")
    }
}
