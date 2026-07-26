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
        // a project — opening there makes the app look broken.
        XCTAssertEqual(resolve(remembered: nil, cwd: "/"), "/Users/x")
    }

    func testRejectsAnEmptyWorkingDirectory() {
        XCTAssertEqual(resolve(remembered: nil, cwd: ""), "/Users/x")
    }

    func testIgnoresARememberedDirectoryThatNoLongerExists() {
        // The folder was moved or deleted between launches.
        XCTAssertEqual(resolve(remembered: "/Users/x/deleted"), "/Users/x/project")
    }

    func testIgnoresAnEmptyRememberedValue() {
        XCTAssertEqual(resolve(remembered: ""), "/Users/x/project")
    }

    func testFallsAllTheWayToHomeWhenNothingElseIsUsable() {
        XCTAssertEqual(
            resolve(remembered: "/gone", cwd: "/", existing: ["/Users/x"]),
            "/Users/x"
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
