import XCTest
@testable import NexusKit

/// `NexusBinary.discover`'s resolution order — `explicit` and `fileExists`
/// are both injectable, so these run without spawning anything or touching
/// the real filesystem.
///
/// This suite exists because it didn't before: `NEXUS_BIN` is a documented
/// escape hatch (the app's own "could not find nexus" message tells a user to
/// set it) with zero prior coverage — the exact gap that let an unrelated
/// live investigation burn real time on an anomaly a green assertion here
/// would have explained immediately.
final class NexusBinaryTests: XCTestCase {
    /// A `fileExists` fake that only answers true for an exact set of paths
    /// — never "anything under this prefix" — so a test can prove ONE
    /// specific candidate won without every other candidate accidentally
    /// also resolving and masking the real assertion.
    private func exists(only paths: Set<String>) -> @Sendable (String) -> Bool {
        { paths.contains($0) }
    }

    private let repoRoot = URL(fileURLWithPath: "/repo")
    private var repoDistPath: String { repoRoot.appendingPathComponent("packages/cli/dist/index.js").path }

    // MARK: - Documented ordering: explicit > NEXUS_BIN > repo dist > install locations > PATH

    func testExplicitWinsOverEverythingElseIncludingAValidNexusBin() {
        let explicitURL = URL(fileURLWithPath: "/explicit/nexus")
        let result = NexusBinary.discover(
            explicit: explicitURL,
            repoRoot: repoRoot,
            environment: ["NEXUS_BIN": "/env/nexus"],
            fileExists: exists(only: [explicitURL.path, "/env/nexus", repoDistPath])
        )
        XCTAssertEqual(result?.url.path, explicitURL.path)
    }

    func testExplicitThatDoesNotResolveFallsThroughRatherThanFailing() {
        // Unlike `NEXUS_BIN` below, `explicit` has no real caller today (see
        // `NexusClient.swift`'s doc) — it degrades to the normal candidate
        // chain rather than failing closed, matching its existing behavior;
        // this pins that so a future caller doesn't get a surprise change.
        let explicitURL = URL(fileURLWithPath: "/explicit/missing")
        let result = NexusBinary.discover(
            explicit: explicitURL,
            repoRoot: repoRoot,
            environment: [:],
            fileExists: exists(only: [repoDistPath])
        )
        XCTAssertEqual(result?.url.path, repoDistPath)
    }

    func testNexusBinWinsOverTheRepoLocalDistBuild() {
        let result = NexusBinary.discover(
            repoRoot: repoRoot,
            environment: ["NEXUS_BIN": "/env/nexus"],
            fileExists: exists(only: ["/env/nexus", repoDistPath])
        )
        XCTAssertEqual(result?.url.path, "/env/nexus")
    }

    func testNexusBinWinsOverEveryHardcodedInstallLocation() {
        let result = NexusBinary.discover(
            environment: ["NEXUS_BIN": "/env/nexus", "HOME": "/Users/x"],
            fileExists: exists(only: [
                "/env/nexus",
                "/opt/homebrew/bin/nexus",
                "/usr/local/bin/nexus",
                "/Users/x/.local/bin/nexus",
            ])
        )
        XCTAssertEqual(result?.url.path, "/env/nexus")
    }

    func testRepoLocalDistBuildWinsOverInstallLocationsWhenNexusBinIsUnset() {
        let result = NexusBinary.discover(
            repoRoot: repoRoot,
            environment: [:],
            fileExists: exists(only: [repoDistPath, "/opt/homebrew/bin/nexus"])
        )
        XCTAssertEqual(result?.url.path, repoDistPath)
    }

    func testInstallLocationsWinOverPathSearch() {
        let result = NexusBinary.discover(
            environment: ["PATH": "/some/bin", "HOME": "/Users/x"],
            fileExists: exists(only: ["/opt/homebrew/bin/nexus", "/some/bin/nexus"])
        )
        XCTAssertEqual(result?.url.path, "/opt/homebrew/bin/nexus")
    }

    func testFallsBackToPathSearchWhenNothingElseResolves() {
        let result = NexusBinary.discover(
            environment: ["PATH": "/usr/bin:/custom/tools", "HOME": "/Users/x"],
            fileExists: exists(only: ["/custom/tools/nexus"])
        )
        XCTAssertEqual(result?.url.path, "/custom/tools/nexus")
    }

    func testReturnsNilWhenNothingResolvesAnywhereInTheChain() {
        let result = NexusBinary.discover(
            repoRoot: repoRoot,
            environment: ["PATH": "/usr/bin", "HOME": "/Users/x"],
            fileExists: exists(only: [])
        )
        XCTAssertNil(result)
    }

    // MARK: - `NEXUS_BIN`: blank/whitespace is unset, anything else is a hard commitment
    //
    // `NEXUS_BIN` is the one candidate here that is a DELIBERATE user
    // override rather than a best-effort guess (install locations, `PATH`) —
    // see `NexusBinary.discover`'s doc for why that earns different treatment.

    func testEmptyNexusBinIsIgnoredNotTreatedAsAPath() {
        let result = NexusBinary.discover(
            repoRoot: repoRoot,
            environment: ["NEXUS_BIN": ""],
            fileExists: exists(only: [repoDistPath])
        )
        XCTAssertEqual(result?.url.path, repoDistPath, "an empty override must fall through, not be tried as a literal path")
    }

    func testWhitespaceOnlyNexusBinIsIgnoredNotTreatedAsAPath() {
        let result = NexusBinary.discover(
            repoRoot: repoRoot,
            environment: ["NEXUS_BIN": "   "],
            fileExists: exists(only: [repoDistPath])
        )
        XCTAssertEqual(result?.url.path, repoDistPath, "whitespace-only must fall through exactly like empty, never resolve to a literal '   ' path")
    }

    func testNexusBinPointingAtSomethingThatDoesNotExistFailsClosedRatherThanFallingThrough() {
        // The finding, not just the fix: before this, an explicit `NEXUS_BIN`
        // that didn't resolve silently fell through to the repo-local build
        // (or an install location) — the user set it, got a DIFFERENT
        // `nexus` than the one they pointed at, and nothing said so. That is
        // the same class of quiet substitution this app spent tonight
        // removing everywhere else. Failing closed here means the existing
        // "could not find nexus" setup state fires instead of a silent swap.
        let result = NexusBinary.discover(
            repoRoot: repoRoot,
            environment: ["NEXUS_BIN": "/env/does-not-exist"],
            // The repo dist build genuinely exists — a pre-fix `discover`
            // would have quietly returned it instead of `nil`.
            fileExists: exists(only: [repoDistPath, "/opt/homebrew/bin/nexus"])
        )
        XCTAssertNil(result, "an explicit NEXUS_BIN that does not resolve must fail closed, never silently substitute a different nexus")
    }

    func testNexusBinTrimsSurroundingWhitespaceBeforeResolving() {
        // A real way an env var ends up with stray whitespace: an unquoted
        // shell substitution or a `.env` file with trailing spaces. The
        // trimmed value must be what actually gets checked/opened.
        let result = NexusBinary.discover(
            environment: ["NEXUS_BIN": "  /env/nexus  "],
            fileExists: exists(only: ["/env/nexus"])
        )
        XCTAssertEqual(result?.url.path, "/env/nexus")
    }

    // MARK: - `launch`: `.js` routes through node, a native binary runs directly

    func testJsEntrypointLaunchesThroughNodeWithTheScriptPathAsItsSoleLeadingArgument() {
        let binary = NexusBinary(url: URL(fileURLWithPath: "/repo/packages/cli/dist/index.js"))
        let launch = binary.launch
        XCTAssertEqual(launch.leadingArguments, ["/repo/packages/cli/dist/index.js"])
        // The exact node path depends on what's actually installed on the
        // machine running this test (not injectable — see the property's
        // doc) — assert it resolved to SOME member of the documented
        // fallback chain rather than pinning one, which would make this test
        // fail on any machine with a different node install layout.
        let possibleExecutables: Set<String> = [
            "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/usr/bin/env",
        ]
        XCTAssertTrue(possibleExecutables.contains(launch.executable.path), "unexpected node executable: \(launch.executable.path)")
    }

    func testNativeBinaryLaunchesDirectlyWithNoLeadingArguments() {
        let binary = NexusBinary(url: URL(fileURLWithPath: "/opt/homebrew/bin/nexus"))
        let launch = binary.launch
        XCTAssertEqual(launch.executable, binary.url)
        XCTAssertTrue(launch.leadingArguments.isEmpty)
    }

    // MARK: - `explainMissing`: the one place that explains a `nil` from `discover`
    //
    // This is what every "no nexus executable" state in the app now reads
    // instead of independently guessing — `WorkspaceModel` and six view-level
    // fallbacks all point here.

    func testExplainMissingNamesTheExactNexusBinValueWhenOneIsSet() {
        let message = NexusBinary.explainMissing(environment: ["NEXUS_BIN": "/env/does-not-exist"])
        XCTAssertTrue(message.contains("/env/does-not-exist"), "the whole value of this message is naming the exact path — got: \(message)")
        XCTAssertTrue(message.contains("NEXUS_BIN"))
    }

    func testExplainMissingUsesTheGenericMessageWhenNexusBinIsUnset() {
        let message = NexusBinary.explainMissing(environment: [:])
        XCTAssertTrue(message.contains("Install it"))
        XCTAssertTrue(message.contains("NEXUS_BIN"), "still mentions the escape hatch, just not as the diagnosed cause")
    }

    func testExplainMissingTreatsBlankNexusBinAsUnsetTooJustLikeDiscoverDoes() {
        // Same trim-then-check rule as `discover` itself — the two must never
        // disagree about what counts as "set."
        for blank in ["", "   "] {
            let message = NexusBinary.explainMissing(environment: ["NEXUS_BIN": blank])
            XCTAssertTrue(message.contains("Install it"), "blank (\"\(blank)\") must read as unset, not as a literal empty path")
        }
    }
}
