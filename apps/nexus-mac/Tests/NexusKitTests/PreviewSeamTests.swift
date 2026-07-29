import XCTest
@testable import NexusKit

/// The two seams the screenshot sweep drives the app through.
///
/// Both exist because the alternatives are worse: driving navigation for a
/// verification pass otherwise needs a synthetic click (banned in this project
/// — one once typed into an unrelated document) or the accessibility API
/// (never granted to an ad-hoc-signed throwaway bundle, so `AXPress` silently
/// no-ops and every capture comes back showing the same screen).
///
/// What matters most here is the NEGATIVE case: a normal launch, with neither
/// variable set, must be completely unaffected. A seam that leaks into
/// ordinary use is worse than no seam.
final class PreviewSeamTests: XCTestCase {

    // MARK: - Tab override

    func testUnsetEnvironmentSelectsNoTab() {
        XCTAssertNil(WorkspaceTab.fromEnvironment([:]))
    }

    func testUnrelatedEnvironmentSelectsNoTab() {
        XCTAssertNil(WorkspaceTab.fromEnvironment(["PATH": "/usr/bin", "HOME": "/Users/x"]))
    }

    func testEveryTabIsReachableByItsOwnRawValue() {
        for tab in WorkspaceTab.allCases {
            XCTAssertEqual(
                WorkspaceTab.fromEnvironment(["NEXUS_UI_TAB": tab.rawValue]),
                tab,
                "\(tab.rawValue) is not reachable through NEXUS_UI_TAB, so it can never be screenshotted"
            )
        }
    }

    func testAnUnrecognisedTabNameIsIgnoredRatherThanCrashing() {
        XCTAssertNil(WorkspaceTab.fromEnvironment(["NEXUS_UI_TAB": "nope"]))
        XCTAssertNil(WorkspaceTab.fromEnvironment(["NEXUS_UI_TAB": ""]))
        // Case matters: the raw values are lowercase, and quietly accepting
        // "Chat" would make the seam's contract ambiguous.
        XCTAssertNil(WorkspaceTab.fromEnvironment(["NEXUS_UI_TAB": "Chat"]))
    }

    // MARK: - Transcript replay

    @MainActor
    func testReplayFoldsAScriptedStreamIntoRealTurns() {
        let controller = ConversationController(
            client: NexusClient(binary: NexusBinary(url: URL(fileURLWithPath: "/nonexistent"))),
            binary: NexusBinary(url: URL(fileURLWithPath: "/nonexistent")),
            workingDirectory: URL(fileURLWithPath: NSTemporaryDirectory())
        )
        XCTAssertTrue(controller.view.orderedLanes.isEmpty, "a fresh controller should have no lanes")

        controller.replayForPreview(ndjson: """
        {"t":"session","id":"r1","provider":"anthropic","model":"claude-opus-5","ts":1785088736427}
        {"t":"prompt","lane":"main","id":"p0","text":"hello"}
        {"t":"text","lane":"main","delta":"hi there"}
        {"t":"done","lane":"main","finishReason":"stop"}
        """)

        // Asserted through the same accessors the transcript view reads, so
        // this fails if replay stops producing something renderable — not
        // merely if the string changed.
        let turns = controller.view.timeline(forLane: "main")
        XCTAssertEqual(turns.count, 1, "expected one folded turn")
        guard case .turn(let turn, _) = turns[0] else {
            return XCTFail("expected a turn entry, got \(turns[0])")
        }
        XCTAssertEqual(turn.prompt, "hello")
        XCTAssertEqual(turn.text, "hi there")
        XCTAssertEqual(turn.provider, "anthropic", "provenance is what the attribution row renders")
        XCTAssertEqual(turn.model, "claude-opus-5")
        XCTAssertTrue(turn.finished)
    }

    /// The demo script is only useful if it exercises the shapes the
    /// transcript has to render well — a plain answer, a provider switch, a
    /// tool call, a diff, and a failure. A script that quietly decayed to
    /// three text deltas would still screenshot "fine" while proving nothing.
    @MainActor
    func testTheDemoTranscriptCoversEveryShapeTheTranscriptMustRender() {
        let events = UiEventDecoder.decodeStream(ConversationController.demoTranscript)
        XCTAssertFalse(events.isEmpty)

        func contains(_ predicate: (UiEvent) -> Bool, _ what: String) {
            XCTAssertTrue(events.contains(where: predicate), "demo transcript no longer contains \(what)")
        }
        contains({ if case .prompt = $0 { return true }; return false }, "a prompt")
        contains({ if case .text = $0 { return true }; return false }, "an answer")
        contains({ if case .switch = $0 { return true }; return false }, "a provider switch")
        contains({ if case .toolCall = $0 { return true }; return false }, "a tool call")
        contains({ if case .diff = $0 { return true }; return false }, "a diff")
        contains({ if case .error = $0 { return true }; return false }, "an error")

        // And it must actually fold — a script that decodes but reduces to
        // nothing would render a blank transcript.
        let state = ViewState.reduce(events: events)
        XCTAssertGreaterThanOrEqual(state.timeline(forLane: "main").count, 3)

        XCTAssertFalse(
            events.contains(where: { if case .unknown = $0 { return true }; return false }),
            "the demo transcript has a malformed line — it would render as a silent gap"
        )
    }
}
