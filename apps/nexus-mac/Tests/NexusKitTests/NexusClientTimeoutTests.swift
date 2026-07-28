import XCTest
@testable import NexusKit

/// `runJSON` must be BOUNDED.
///
/// The bug these pin: `IntegrationsController.refresh()` awaits three
/// `runJSON` calls, and `mcp tools` STARTS every enabled MCP server in order
/// to report their tools. One wedged server — or a pending macOS
/// permission prompt sitting in front of one — left the Integrations screen
/// on "Loading integrations…" forever, with no failure state and no way out
/// but quitting the app. There was no timeout anywhere in `NexusClient` or
/// `IntegrationsController`.
///
/// These spawn a REAL process that really hangs, rather than a fixture that
/// pretends to. A fixture cannot prove the thing that actually mattered here:
/// that the child is *killed*, not merely abandoned.
final class NexusClientTimeoutTests: XCTestCase {
    /// A script that hangs far longer than any deadline under test.
    private func hangingBinary() throws -> (NexusBinary, URL) {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nexus-timeout-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("hang.sh")
        try "#!/bin/sh\nsleep 120\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (NexusBinary(url: script), dir)
    }

    func testRunJSONFailsWithTimedOutRatherThanHangingForever() async throws {
        let (binary, dir) = try hangingBinary()
        defer { try? FileManager.default.removeItem(at: dir) }
        let client = NexusClient(binary: binary)

        let started = Date()
        let result = await client.runJSON(.mcpList(), timeoutSeconds: 1)
        let elapsed = Date().timeIntervalSince(started)

        guard case .failure(let error) = result else {
            return XCTFail("expected a failure, got \(result)")
        }
        // The specific case matters as much as the failure: `cancelled` would
        // claim the USER stopped this, and `nonZeroExit` would claim the
        // process answered. Neither happened — nothing ever answered.
        guard case .timedOut(let seconds) = error else {
            return XCTFail("expected .timedOut, got \(error)")
        }
        XCTAssertEqual(seconds, 1)
        // Bounded in real wall-clock, not just in principle. Generous upper
        // bound so a loaded CI box doesn't flake, but far below the script's
        // own 120s — the only way to pass is for the deadline to have fired.
        XCTAssertLessThan(elapsed, 20, "runJSON did not return promptly after its deadline")
    }

    func testTimedOutMessageNamesTheDeadlineRatherThanBlamingTheUser() {
        // This string is what the Integrations screen puts in front of a user
        // via `InlineBanner`, so it has to say what actually happened.
        XCTAssertEqual(NexusCommandError.timedOut(seconds: 20).message,
                       "nexus did not respond within 20s")
        XCTAssertNotEqual(NexusCommandError.timedOut(seconds: 20).message,
                          NexusCommandError.cancelled.message)
    }

    /// The child must be REAPED, not merely abandoned. Abandoning the
    /// continuation would leave a live `nexus` process — and for `mcp tools`,
    /// every MCP server it had already started — running for the lifetime of
    /// the app, invisibly, once per visit to the screen.
    func testTheTimedOutProcessIsActuallyKilled() async throws {
        let (binary, dir) = try hangingBinary()
        defer { try? FileManager.default.removeItem(at: dir) }
        let client = NexusClient(binary: binary)

        let before = try runningHangScriptCount(scriptPath: binary.url.path)
        _ = await client.runJSON(.mcpList(), timeoutSeconds: 1)
        // SIGTERM delivery and reaping are not instantaneous.
        try await Task.sleep(for: .seconds(2))
        let after = try runningHangScriptCount(scriptPath: binary.url.path)

        XCTAssertEqual(after, before, "the timed-out child was left running")
    }

    /// Count live processes whose command line mentions this exact script.
    /// Scoped to a UUID-named path so it can never see another test's child,
    /// another agent's build, or the developer's own shell.
    private func runningHangScriptCount(scriptPath: String) throws -> Int {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-Ao", "command"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        return text.split(separator: "\n").filter { $0.contains(scriptPath) }.count
    }
}
