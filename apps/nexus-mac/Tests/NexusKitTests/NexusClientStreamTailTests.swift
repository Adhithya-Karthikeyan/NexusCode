import XCTest
@testable import NexusKit

/// The STREAM half of the pipe-drain bug, pinned separately.
///
/// `runJSON` losing its tail at least announced itself — the truncated
/// document failed to parse and the screen showed an error. `stream` losing
/// its tail is SILENT: the events simply never arrive, the transcript is
/// quietly missing its ending, and nothing anywhere reports a problem. That
/// makes this the more dangerous side of the same defect and the one worth
/// its own regression test.
///
/// Both paths go through `launch`, so the fix is shared — but a shared fix
/// with only one side tested is one refactor away from silently regressing
/// the untested side.
///
/// HONEST LIMITATION, do not overstate this file: unlike
/// `NexusClientOutputTests`, this test **passes with the pipe-drain fix
/// disabled** — verified by actually disabling it, not assumed. So it does
/// NOT demonstrate that `stream` ever lost events, and nobody should cite it
/// as evidence that it did. The `runJSON` loss is reproduced exactly; the
/// streaming path was only ever *presumed* affected because it shares
/// `launch`, and that presumption did not survive being tested.
///
/// The likely reason is timing rather than a different code path: a `stream`
/// consumer is actively iterating while the child runs, so the pipe is being
/// drained continuously, whereas `runJSON`'s caller is suspended on a
/// continuation and the whole payload backs up in the pipe until exit.
///
/// Kept anyway, as a guard on an exact event count rather than a proof of a
/// past bug. The failure it would catch is a SHORT stream that looks
/// perfectly healthy — which is why it asserts `== count` and not `> 0`.
final class NexusClientStreamTailTests: XCTestCase {
    /// A script emitting `count` ndjson events and exiting immediately, with
    /// no trailing sleep — the exit races the pipe drain on purpose.
    private func eventEmittingBinary(count: Int) throws -> (NexusBinary, URL) {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nexus-stream-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("emit.sh")
        let body = """
        #!/bin/sh
        i=0
        while [ $i -lt \(count) ]; do
          printf '{"t":"text","lane":"main","delta":"chunk-%06d"}\\n' $i
          i=$((i+1))
        done
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (NexusBinary(url: script), dir)
    }

    func testTrailingStreamEventsAreNotLostWhenTheProcessExits() async throws {
        let count = 4000
        let (binary, dir) = try eventEmittingBinary(count: count)
        defer { try? FileManager.default.removeItem(at: dir) }
        let client = NexusClient(binary: binary)

        var events = 0
        for await item in client.stream(.sessionList()) {
            if case .event = item { events += 1 }
        }

        // An exact count, not "more than zero": the failure mode here is a
        // SHORT stream that looks perfectly healthy. Asserting non-empty is
        // precisely the assertion that would have let this ship.
        XCTAssertEqual(events, count, "the stream lost its tail — \(count - events) events dropped")
    }
}
