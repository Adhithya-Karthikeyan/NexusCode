import XCTest
@testable import NexusKit

/// Which directory a window opens on. Every case here is one the app actually
/// hits: launched from Finder, launched from a terminal inside a checkout, or
/// reopened after the remembered folder was moved or deleted.
final class ProjectLocationTests: XCTestCase {
    private func resolve(
        remembered: String? = nil,
        cwd: String = "/Users/x/project",
        home: String = "/Users/x",
        existing: Set<String> = ["/Users/x/project", "/Users/x", "/Users/x/other"]
    ) -> String {
        ProjectLocation.resolve(
            remembered: remembered,
            workingDirectory: cwd,
            home: home,
            directoryExists: { existing.contains($0) }
        ).path
    }

    func testPrefersTheDirectoryTheUserLastChose() {
        XCTAssertEqual(resolve(remembered: "/Users/x/other"), "/Users/x/other")
    }

    func testFallsBackToTheWorkingDirectoryWhenNothingRemembered() {
        XCTAssertEqual(resolve(remembered: nil), "/Users/x/project")
    }

    func testRejectsRootBecauseAFinderLaunchReportsIt() {
        // Launched from Finder the working directory is "/", which can never be
        // a project — opening there makes the app look broken. The fallback is
        // a dedicated workspace folder, not home — see
        // `testRejectsTheHomeDirectoryItselfAsAWorkingDirectory` for why.
        XCTAssertEqual(resolve(remembered: nil, cwd: "/"), "/Users/x/Library/Application Support/NexusCode/Workspace")
    }

    func testRejectsAnEmptyWorkingDirectory() {
        XCTAssertEqual(resolve(remembered: nil, cwd: ""), "/Users/x/Library/Application Support/NexusCode/Workspace")
    }

    func testIgnoresARememberedDirectoryThatNoLongerExists() {
        // The folder was moved or deleted between launches.
        XCTAssertEqual(resolve(remembered: "/Users/x/deleted"), "/Users/x/project")
    }

    func testIgnoresAnEmptyRememberedValue() {
        XCTAssertEqual(resolve(remembered: ""), "/Users/x/project")
    }

    func testFallsBackToADedicatedWorkspaceRatherThanHomeWhenNothingElseIsUsable() {
        // The home directory itself must never be the answer here — see
        // `testRejectsTheHomeDirectoryItselfAsAWorkingDirectory` for why.
        let result = resolve(remembered: "/gone", cwd: "/", existing: ["/Users/x"])
        XCTAssertNotEqual(result, "/Users/x")
        XCTAssertEqual(result, "/Users/x/Library/Application Support/NexusCode/Workspace")
    }

    func testRejectsTheHomeDirectoryItselfAsAWorkingDirectory() {
        // Launched from a Terminal sitting at `~` (or `swift run` from a login
        // shell), the working directory IS the home directory — non-empty and
        // not "/", so it used to pass `isPlausibleProject` and become the
        // project root. That is exactly the bug: a fresh window silently
        // file-indexing the user's entire home folder and tripping a macOS
        // "access your Documents folder" prompt on launch.
        XCTAssertEqual(
            resolve(remembered: nil, cwd: "/Users/x", home: "/Users/x"),
            "/Users/x/Library/Application Support/NexusCode/Workspace"
        )
    }

    func testPlausibilityRule() {
        XCTAssertFalse(ProjectLocation.isPlausibleProject("/"))
        XCTAssertFalse(ProjectLocation.isPlausibleProject(""))
        XCTAssertTrue(ProjectLocation.isPlausibleProject("/Users/x/project"))
    }

    func testRealFileSystemOverloadResolvesSomethingUsable() {
        // Whatever the machine's state, the result must be an existing directory.
        let url = ProjectLocation.resolve(remembered: nil)
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
    }
}
