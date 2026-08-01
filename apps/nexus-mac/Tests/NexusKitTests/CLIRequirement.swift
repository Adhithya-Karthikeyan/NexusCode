import XCTest
@testable import NexusKit

/// Shared gate for tests that spawn the real, repo-local `nexus` CLI build.
///
/// Locally (`NEXUS_REQUIRE_CLI` unset) a missing CLI is an expected gap on a
/// fresh clone that hasn't run `npm run build` yet, so these tests SKIP —
/// preserving the original behavior. CI's `swift-test` job builds the CLI
/// first and sets `NEXUS_REQUIRE_CLI=1`, so there a missing binary is a real
/// regression (a broken build step, or a `NexusBinary.discover` bug), not an
/// expected gap — this turns that case into a clearly-labeled hard failure
/// instead of a silent skip that would let the regression through CI unseen.
func requireCLI(
    _ binary: NexusBinary?,
    _ message: String,
    file: StaticString = #filePath,
    line: UInt = #line
) throws -> NexusBinary {
    if let binary {
        return binary
    }
    guard ProcessInfo.processInfo.environment["NEXUS_REQUIRE_CLI"] == "1" else {
        throw XCTSkip(message)
    }
    XCTFail("NEXUS_REQUIRE_CLI=1 but \(message)", file: file, line: line)
    throw CLIRequirementError.missing
}

private enum CLIRequirementError: Error {
    case missing
}
