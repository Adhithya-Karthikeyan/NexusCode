import XCTest
@testable import NexusKit

/// End-to-end coverage for the in-process `{"type":"switch",…}` control line
/// wired in `ConversationController.submit`/`submitToPersistentSession` —
/// spawns the REAL `nexus` CLI (offline `mock` provider, no credentials, no
/// network) exactly the way `NexusClientIntegrationTests` does, and drives it
/// through the SAME `ConversationController` the app uses, rather than
/// hand-typed ndjson fixtures. A fixture-driven unit test (see
/// `AppStateTests`'s "Switch reconciliation" section) can prove the
/// RECONCILE logic is correct given some event; only a real process proves
/// the wire format actually round-trips through the real CLI at all — the
/// discipline that already caught `to.modelId` decoding as `""` rather than
/// being omitted on an immediate rejection (see `UiEvent.Switch.Target`'s
/// doc), which both tests below reproduce with real bytes.
///
/// Skips (rather than fails) when the CLI has not been built, matching
/// `NexusClientIntegrationTests`.
@MainActor
final class SwitchWiringTests: XCTestCase {
    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // NexusKitTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // nexus-mac
            .deletingLastPathComponent()  // apps
    }

    private func makeController() throws -> ConversationController {
        guard let binary = NexusBinary.discover(repoRoot: repoRoot) else {
            throw XCTSkip("nexus CLI not found — run `npm run build` at the repo root")
        }
        return ConversationController(client: NexusClient(binary: binary), binary: binary, workingDirectory: repoRoot)
    }

    /// Poll `isRunning` rather than a fixed sleep — the offline mock
    /// provider is fast but not instant, and a fixed delay would either
    /// flake under load or waste time otherwise.
    private func waitUntilSettled(_ c: ConversationController, timeout: TimeInterval = 15) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while c.isRunning {
            if Date() > deadline {
                XCTFail("turn did not settle within \(timeout)s — diagnostics: \(c.diagnostics)")
                return
            }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
    }

    func testAcceptedSwitchRidesTheSameProcessAndUpdatesEverything() async throws {
        let c = try makeController()
        c.mode = .ask
        c.provider = "mock"
        c.model = "mock-fast"
        c.approvalsEnabled = false

        c.submit("hello")
        try await waitUntilSettled(c)
        XCTAssertEqual(c.activeBackendProvider, "mock", "diagnostics: \(c.diagnostics)")
        XCTAssertEqual(c.activeBackendModel, "mock-fast")
        let sessionIdAfterFirstTurn = try XCTUnwrap(c.sessionId)

        // Switch MODEL on the same provider — the mock adapter needs no
        // second credential, and `performSwitch` accepts this regardless of
        // whether the provider itself changed too.
        c.model = "mock-smart"
        c.submit("after switch")
        try await waitUntilSettled(c)

        // A real, accepted switch was recorded.
        let receipt = try XCTUnwrap(c.view.switches.last)
        XCTAssertTrue(receipt.accepted, "blockers: \(receipt.blockers)")
        XCTAssertEqual(receipt.to.providerId, "mock")
        XCTAssertEqual(receipt.to.modelId, "mock-smart")

        // The SAME engine session carried the switch — never a new one.
        XCTAssertEqual(c.sessionId, sessionIdAfterFirstTurn)
        // No relaunch: the CLI announces `[session] <id>` exactly once per
        // process lifetime (`cmdChat`, `packages/cli/src/commands.ts`) — a
        // SECOND line would mean a second process actually started.
        XCTAssertEqual(
            c.diagnostics.filter { $0.contains("[session]") }.count, 1,
            "a second `[session]` line would mean the backend was relaunched instead of switched in-process"
        )

        // The picker and the live backend both reflect the new target.
        XCTAssertEqual(c.provider, "mock")
        XCTAssertEqual(c.model, "mock-smart")
        XCTAssertEqual(c.activeBackendProvider, "mock")
        XCTAssertEqual(c.activeBackendModel, "mock-smart")

        // The SECOND turn's actual answer came from the new target, not a
        // stale process still answering as mock-fast.
        let secondTurn = try XCTUnwrap(c.view.lanes["main"]?.finalized.last)
        XCTAssertTrue(secondTurn.text.contains("mock-smart"), "got: \(secondTurn.text)")

        // And turn attribution (Cause 2) survived the switch: the FIRST turn
        // still says it came from mock-fast even though `session`/the
        // picker have both moved on to mock-smart by the time this reads.
        let firstTurn = try XCTUnwrap(c.view.lanes["main"]?.finalized.first)
        XCTAssertEqual(firstTurn.provider, "mock")
        XCTAssertEqual(firstTurn.model, "mock-fast")
        XCTAssertEqual(secondTurn.provider, "mock")
        XCTAssertEqual(secondTurn.model, "mock-smart", "a turn started AFTER the switch belongs to the new target")
    }

    /// The exact edge case the team's earlier manual verification found: on
    /// an immediate rejection (target provider unusable at all), `to.modelId`
    /// decodes as an EMPTY STRING, not an omitted key — reproduced here by
    /// mimicking the real UI flow (`ControlStrip`'s provider dropdown clears
    /// `model` the instant `provider` changes), not a hand-typed fixture.
    func testRefusedSwitchLeavesConversationAndPickerOnTheOriginalProviderWithRealBytes() async throws {
        let c = try makeController()
        c.mode = .ask
        c.provider = "mock"
        c.model = "mock-fast"
        c.approvalsEnabled = false

        c.submit("hello")
        try await waitUntilSettled(c)
        XCTAssertEqual(c.activeBackendProvider, "mock")

        // Mirrors the real dropdown exactly: picking a new provider clears
        // `model` until the user picks one for it (`ControlStrip.singleLaneControls`).
        c.provider = "definitely-not-a-provider"
        c.model = nil
        c.submit("should stay on mock")
        try await waitUntilSettled(c)

        let receipt = try XCTUnwrap(c.view.switches.last)
        XCTAssertFalse(receipt.accepted)
        XCTAssertFalse(receipt.blockers.isEmpty)
        XCTAssertEqual(receipt.to.providerId, "definitely-not-a-provider")
        // The documented edge case, verified live: empty, not omitted.
        XCTAssertEqual(receipt.to.modelId, "", "an immediate rejection must decode modelId as empty, not omit it")
        XCTAssertEqual(receipt.to.label, "definitely-not-a-provider", "must not render a bare trailing slash for an empty modelId")

        // The picker reverted to what's actually live...
        XCTAssertEqual(c.provider, "mock")
        XCTAssertEqual(c.model, "mock-fast")
        XCTAssertEqual(c.activeBackendProvider, "mock")
        XCTAssertEqual(c.activeBackendModel, "mock-fast")

        // ...and the conversation kept going on that same original process —
        // no relaunch was ever attempted just because the switch failed.
        XCTAssertEqual(c.diagnostics.filter { $0.contains("[session]") }.count, 1)
        let secondTurn = try XCTUnwrap(c.view.lanes["main"]?.finalized.last)
        XCTAssertFalse(secondTurn.text.isEmpty, "the prompt after a refused switch must still get answered")
        XCTAssertNil(secondTurn.error, "a refused SWITCH must not be reported as a TURN error")
        XCTAssertEqual(secondTurn.provider, "mock", "a refused switch must not relabel who actually answered")
        XCTAssertEqual(secondTurn.model, "mock-fast")
    }
}
