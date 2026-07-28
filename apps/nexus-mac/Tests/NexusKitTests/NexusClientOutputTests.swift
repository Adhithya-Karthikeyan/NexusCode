import XCTest
@testable import NexusKit

/// Output must survive process exit INTACT.
///
/// The bug these pin: `readabilityHandler` is delivered asynchronously, so
/// when a child exits there is routinely unread data still sitting in the OS
/// pipe. `terminationHandler` cleared the handler and flushed only the
/// in-process line buffer, so those bytes were dropped silently.
///
/// It presented as `Sessions` intermittently showing "nexus did not print
/// valid JSON:" followed by raw text ending mid-object. Nothing was ever
/// malformed — the document was cut off. It only showed up on the session
/// list because that payload (1000+ sessions) is large enough that its last
/// chunks are usually still in flight at exit; small payloads almost always
/// land in a single read first, which is exactly why this survived every
/// other screen and the whole test suite.
final class NexusClientOutputTests: XCTestCase {
    /// A script printing `count` JSON objects — far more than one pipe buffer,
    /// so the tail CANNOT have been delivered before exit.
    private func bigJSONBinary(count: Int) throws -> (NexusBinary, URL) {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nexus-output-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("big.sh")
        // Single-line JSON: the line buffer only emits on a newline, so this
        // also proves the final unterminated line survives.
        let body = """
        #!/bin/sh
        printf '['
        i=0
        while [ $i -lt \(count) ]; do
          if [ $i -gt 0 ]; then printf ','; fi
          printf '{"sessionId":"s_%08d","createdAt":1785268747530,"costIncomplete":false}' $i
          i=$((i+1))
        done
        printf ']'
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (NexusBinary(url: script), dir)
    }

    func testLargeStdoutIsNotTruncatedAtProcessExit() async throws {
        let count = 8000  // ~700KB, many times any pipe buffer
        let (binary, dir) = try bigJSONBinary(count: count)
        defer { try? FileManager.default.removeItem(at: dir) }
        let client = NexusClient(binary: binary)

        let result = await client.runJSON(.sessionList())

        switch result {
        case .failure(let error):
            // Before the fix this is `.malformedJSON` with text ending
            // mid-object — the exact symptom seen on the Sessions screen.
            XCTFail("large payload did not survive process exit: \(error.message.prefix(160))")
        case .success(let value):
            XCTAssertEqual(value.arrayValue?.count, count,
                           "decoded a valid but SHORT array — the tail was still lost")
        }
    }

    /// Run it repeatedly: the loss is a race, and a single green run proves
    /// very little about a race. Before the fix this fails well within 5.
    func testLargeStdoutSurvivesRepeatedRuns() async throws {
        let count = 4000
        let (binary, dir) = try bigJSONBinary(count: count)
        defer { try? FileManager.default.removeItem(at: dir) }
        let client = NexusClient(binary: binary)

        for attempt in 1...5 {
            let result = await client.runJSON(.sessionList())
            guard case .success(let value) = result else {
                return XCTFail("attempt \(attempt) lost output: \(result)")
            }
            XCTAssertEqual(value.arrayValue?.count, count, "attempt \(attempt) came back short")
        }
    }
}
