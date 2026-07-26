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
        XCTAssertEqual(events.count, 18, "every fixture line must decode to an event")

        let types = Set(events.map(\.wireType))
        for expected in [
            "session", "route", "prompt", "reasoning", "text", "tool_call",
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
        XCTAssertEqual(unwrapped.costUsd, 0.0042, accuracy: 1e-9)
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
