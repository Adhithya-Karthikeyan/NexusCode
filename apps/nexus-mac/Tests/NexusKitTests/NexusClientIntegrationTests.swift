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

    /// Proves the actual GUI-launch failure end to end: a `.app` launched
    /// from Finder/Spotlight gets the OS-minimal `PATH`
    /// (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell profile — and
    /// before the fix this made every SCRIPT-shaped `nexus` (a `.js`
    /// entrypoint run via `#!/usr/bin/env node`, or a `/bin/sh` wrapper doing
    /// `exec node …`) unable to find `node` and fail every single command.
    ///
    /// Deliberately does NOT use `makeClient()` / the repo-local `.js` dist
    /// build: that path resolves `node` through `NexusBinary.launch`'s own
    /// hardcoded 3-path list, independent of `PATH`, so it would pass even
    /// with the bug present and prove nothing. This targets a REAL globally
    /// installed `nexus` — the shape that actually broke — via
    /// `NexusClient`'s injectable `environment`, which is what lets a test
    /// force a real spawn down to a GUI-minimal environment without
    /// mutating this test process's own real environment.
    ///
    /// Skips (never fails) when nothing is installed at any location this
    /// app knows to look, so a fresh clone without a global `nexus` install
    /// can still run `swift test`.
    func testAScriptShapedNexusInstallStillRunsUnderAGuiMinimalEnvironment() async throws {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        let guiMinimalEnvironment: [String: String] = [
            "HOME": home,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        let installLocations = ["/opt/homebrew/bin/nexus", "/usr/local/bin/nexus", "\(home)/.local/bin/nexus"]
        guard let installedPath = installLocations.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw XCTSkip("no globally-installed nexus at any known location — nothing to prove here")
        }

        let client = NexusClient(
            binary: NexusBinary(url: URL(fileURLWithPath: installedPath)),
            environment: { guiMinimalEnvironment }
        )

        let result = await client.runJSON(.providers())

        switch result {
        case .failure(let error):
            XCTFail(
                """
                expected the GUI-minimal environment's augmented PATH to still \
                resolve node for \(installedPath); got: \(error.message)
                """
            )
        case .success(let value):
            // Real decoded output from a REAL process, not just "didn't
            // throw" — `providers list` always includes the offline `mock`
            // provider, so this is checkable without credentials or network.
            guard case .array(let providers) = value else {
                return XCTFail("expected a JSON array of providers, got \(value)")
            }
            let hasMockProvider = providers.contains {
                if case .object(let fields) = $0, case .string("mock") = fields["id"] { return true }
                return false
            }
            XCTAssertTrue(hasMockProvider, "expected the offline mock provider in the list; got \(value)")
        }
    }
}
