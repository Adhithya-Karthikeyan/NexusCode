import XCTest
@testable import NexusKit

/// End-to-end: spawn the REAL `nexus` CLI and fold its real event stream.
///
/// This is the test that proves the whole premise — that the app can be a pure
/// renderer over the terminal. Everything else in this suite runs against
/// fixtures; this one runs against the actual binary, with the offline `mock`
/// provider so it needs no credentials and no network.
///
/// Skips (rather than fails) when the CLI has not been built, so a fresh clone
/// can still run `swift test`.
final class NexusClientIntegrationTests: XCTestCase {
    /// Walk up from this source file to the monorepo root.
    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // NexusKitTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // nexus-mac
            .deletingLastPathComponent()  // apps
    }

    private func makeClient() throws -> NexusClient {
        guard let binary = NexusBinary.discover(repoRoot: repoRoot) else {
            throw XCTSkip("nexus CLI not found — run `npm run build` at the repo root")
        }
        return NexusClient(binary: binary)
    }

    func testDiscoversTheRepoLocalCliBuild() throws {
        guard let binary = NexusBinary.discover(repoRoot: repoRoot) else {
            throw XCTSkip("nexus CLI not found")
        }
        XCTAssertTrue(
            FileManager.default.isExecutableFile(atPath: binary.url.path),
            "discovered path must actually be executable"
        )
    }

    func testStreamsARealRunAndFoldsItIntoViewState() async throws {
        let client = try makeClient()
        let command = NexusCommand.ask(
            prompt: "hello from the mac app",
            provider: "mock",
            model: "mock-fast",
            cwd: repoRoot
        )

        let (state, diagnostics) = await client.collect(command)

        // A real session was opened on the real engine.
        XCTAssertEqual(state.session?.provider, "mock", "diagnostics: \(diagnostics)")
        XCTAssertEqual(state.session?.model, "mock-fast")

        // The assistant's answer streamed in and the turn finalized.
        let turn = try XCTUnwrap(state.lanes["main"]?.finalized.first)
        XCTAssertTrue(turn.finished)
        XCTAssertEqual(turn.finishReason, "stop")
        XCTAssertTrue(
            turn.text.contains("hello from the mac app"),
            "the mock provider echoes the prompt; got: \(turn.text)"
        )

        // Usage was accounted, and nothing is left streaming.
        XCTAssertGreaterThan(state.totals.inputTokens, 0)
        XCTAssertFalse(state.streaming)
        XCTAssertEqual(state.providerHealth["mock"]?.status, .ok)
    }

    func testUnknownProviderSurfacesAsADiagnosticRatherThanASilentFailure() async throws {
        let client = try makeClient()
        let command = NexusCommand.ask(
            prompt: "hi",
            provider: "definitely-not-a-provider",
            cwd: repoRoot
        )

        let (state, diagnostics) = await client.collect(command)

        // The run produced no session, and the reason is visible — the app can
        // show WHY instead of an empty pane.
        XCTAssertNil(state.session)
        XCTAssertFalse(diagnostics.isEmpty, "stderr must be surfaced, not swallowed")
    }

    func testTerminationIsReportedWithAnExitCode() async throws {
        let client = try makeClient()
        var termination: NexusTermination?
        for await item in client.stream(.ask(prompt: "bye", provider: "mock", cwd: repoRoot)) {
            if case .terminated(let reason) = item { termination = reason }
        }
        guard case .finished(let code)? = termination else {
            return XCTFail("expected a clean termination, got \(String(describing: termination))")
        }
        XCTAssertEqual(code, 0)
    }
}
