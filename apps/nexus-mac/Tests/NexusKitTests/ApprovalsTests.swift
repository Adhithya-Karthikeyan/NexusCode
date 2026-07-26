import XCTest
@testable import NexusKit

/// `ApprovalsController` / `PendingApproval` / `ApprovalDecision` — the seam
/// between `nexus chat --persistent -t`'s real approval broker and the app.
///
/// The CLI's exact payload (see `packages/cli/src/commands.ts`'s
/// `ApprovalBroker`/`ApprovalDetailPayload` and `ChatCommand`'s usage text in
/// `packages/cli/src/index.ts`): a `{"t":"approval","lane":...,"id":...,
/// "action":"file"|"shell"|"tool","detail":"<json string>"}` `UiEvent`, whose
/// `detail` decodes to `{toolName, permission, mode, reason, input, diff?}`.
/// These fixtures are hand-written to that exact shape rather than pulled from
/// `Fixtures/events.ndjson`, because that shared fixture's `approval` line
/// (`{"path":"src/app.ts"}`) models the OLDER, unrelated wrapped-coding-CLI
/// file-edit approval — proving this controller correctly ignores that shape
/// is one of the tests below.
final class ApprovalsTests: XCTestCase {
    private func execLine(id: String = "appr_1") -> String {
        #"""
        {"t":"approval","lane":"main","id":"\#(id)","action":"shell","detail":"{\"toolName\":\"shell_exec\",\"permission\":\"exec\",\"mode\":\"ask\",\"reason\":\"exec requires approval in ask mode\",\"input\":{\"command\":\"echo\",\"args\":[\"hi\"]}}"}
        """#
    }

    private func writeLine(id: String = "appr_2") -> String {
        #"""
        {"t":"approval","lane":"main","id":"\#(id)","action":"file","detail":"{\"toolName\":\"fs_write\",\"permission\":\"write\",\"mode\":\"ask\",\"reason\":\"write requires approval in ask mode\",\"input\":{\"path\":\"a.txt\",\"content\":\"hello\"},\"diff\":\"--- a/a.txt\\n+++ b/a.txt\\n@@ -1,0 +1,1 @@\\n+hello\"}"}
        """#
    }

    /// The SECOND wire event for a given approval — its settlement. Matches
    /// `ApprovalBroker.request`'s `settle` on the CLI side exactly.
    private func resolutionLine(id: String = "appr_1", granted: Bool, cause: String) -> String {
        #"""
        {"t":"approval","lane":"main","id":"\#(id)","action":"shell","detail":"{\"toolName\":\"shell_exec\",\"permission\":\"exec\",\"mode\":\"ask\",\"reason\":\"exec requires approval in ask mode\",\"input\":{\"command\":\"echo\",\"args\":[\"hi\"]}}","resolution":{"granted":\#(granted),"cause":"\#(cause)"}}
        """#
    }

    // MARK: - PendingApproval decoding

    func testDecodesTheRealApprovalBrokerPayload() throws {
        guard case .approval(let raw)? = UiEventDecoder.decodeLine(execLine()) else {
            return XCTFail("expected an approval UiEvent")
        }
        let approval = try XCTUnwrap(PendingApproval(event: raw))
        XCTAssertEqual(approval.id, "appr_1")
        XCTAssertEqual(approval.lane, "main")
        XCTAssertEqual(approval.action, "shell")
        XCTAssertEqual(approval.toolName, "shell_exec")
        XCTAssertEqual(approval.permission, "exec")
        XCTAssertEqual(approval.mode, "ask")
        XCTAssertEqual(approval.reason, "exec requires approval in ask mode")
        XCTAssertEqual(approval.input?["command"]?.stringValue, "echo")
        XCTAssertNil(approval.diff, "a shell call has nothing file-shaped to diff")
    }

    func testDecodesAFileWriteApprovalIncludingItsDiff() throws {
        guard case .approval(let raw)? = UiEventDecoder.decodeLine(writeLine()) else {
            return XCTFail("expected an approval UiEvent")
        }
        let approval = try XCTUnwrap(PendingApproval(event: raw))
        XCTAssertEqual(approval.toolName, "fs_write")
        XCTAssertEqual(approval.permission, "write")
        XCTAssertEqual(approval.input?["path"]?.stringValue, "a.txt")
        let diff = try XCTUnwrap(approval.diff)
        XCTAssertTrue(diff.contains("+hello"), "the diff must show the actual proposed content")
        XCTAssertTrue(diff.hasPrefix("--- a/a.txt"))
    }

    func testIgnoresTheUnrelatedWrappedCliApprovalShape() throws {
        // The shared fixture's approval line — a DIFFERENT, older concept
        // (a wrapped coding CLI's file-edit proposal) with no toolName/
        // permission/mode. Must decode to nil, not crash or half-populate.
        let line = #"{"t":"approval","lane":"main","id":"ap-1","action":"write","detail":"{\"path\":\"src/app.ts\"}"}"#
        guard case .approval(let raw)? = UiEventDecoder.decodeLine(line) else {
            return XCTFail("expected an approval UiEvent")
        }
        XCTAssertNil(PendingApproval(event: raw))
    }

    func testMalformedDetailJsonDecodesToNil() throws {
        let line = #"{"t":"approval","lane":"main","id":"x","action":"tool","detail":"not json at all"}"#
        guard case .approval(let raw)? = UiEventDecoder.decodeLine(line) else {
            return XCTFail("expected an approval UiEvent")
        }
        XCTAssertNil(PendingApproval(event: raw))
    }

    // MARK: - Resolution decoding

    func testARequestEventHasNoResolution() throws {
        guard case .approval(let raw)? = UiEventDecoder.decodeLine(execLine()) else {
            return XCTFail("expected an approval UiEvent")
        }
        XCTAssertNil(raw.resolution, "the original request is still pending — nothing has settled it yet")
    }

    func testDecodesEveryResolutionCause() throws {
        let cases: [(String, UiEvent.Approval.Cause, Bool)] = [
            ("explicit", .explicit, true),
            ("timeout", .timeout, false),
            ("cancelled", .cancelled, false),
            ("stdin-closed", .stdinClosed, false),
        ]
        for (wire, expected, granted) in cases {
            guard case .approval(let raw)? = UiEventDecoder.decodeLine(resolutionLine(granted: granted, cause: wire)) else {
                XCTFail("expected an approval UiEvent for cause \(wire)")
                continue
            }
            let resolution = try XCTUnwrap(raw.resolution, "cause \(wire) must decode a resolution")
            XCTAssertEqual(resolution.cause, expected)
            XCTAssertEqual(resolution.granted, granted)
        }
    }

    // MARK: - ApprovalDecision wire format

    func testControlLineMatchesTheDocumentedProtocol() throws {
        let allow = ApprovalDecision(id: "appr_1", granted: true)
        XCTAssertEqual(allow.controlLine, #"{"type":"approval","id":"appr_1","decision":"allow"}"#)

        let deny = ApprovalDecision(id: "appr_1", granted: false)
        XCTAssertEqual(deny.controlLine, #"{"type":"approval","id":"appr_1","decision":"deny"}"#)

        // Must round-trip through JSON parsing regardless of exact formatting —
        // that's the actual contract, not the literal string.
        let data = try XCTUnwrap(allow.controlLine.data(using: .utf8))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(obj["type"], "approval")
        XCTAssertEqual(obj["id"], "appr_1")
        XCTAssertEqual(obj["decision"], "allow")
    }

    func testControlLineEscapesAwkwardIds() throws {
        let decision = ApprovalDecision(id: #"weird"id\here"#, granted: true)
        let data = try XCTUnwrap(decision.controlLine.data(using: .utf8))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(obj["id"], #"weird"id\here"#)
    }

    // MARK: - ApprovalsController

    @MainActor
    func testIngestAddsAnApprovalAndIgnoresUnrelatedEvents() throws {
        let controller = ApprovalsController()
        controller.ingest(.text(.init(lane: "main", delta: "hi")))
        XCTAssertNil(controller.current, "a non-approval event must not surface anything")

        guard case .approval(let raw)? = UiEventDecoder.decodeLine(execLine()) else {
            return XCTFail("expected an approval UiEvent")
        }
        controller.ingest(.approval(raw))
        XCTAssertEqual(controller.pending.count, 1)
        XCTAssertEqual(controller.current?.id, "appr_1")
    }

    @MainActor
    func testIngestIgnoresAMalformedApprovalWithoutCrashing() throws {
        let controller = ApprovalsController()
        let line = #"{"t":"approval","lane":"main","id":"ap-1","action":"write","detail":"{\"path\":\"src/app.ts\"}"}"#
        guard case .approval(let raw)? = UiEventDecoder.decodeLine(line) else {
            return XCTFail("expected an approval UiEvent")
        }
        controller.ingest(.approval(raw))
        XCTAssertNil(controller.current)
        XCTAssertTrue(controller.pending.isEmpty)
    }

    @MainActor
    func testDuplicateIdReplacesRatherThanDuplicates() throws {
        let controller = ApprovalsController()
        guard case .approval(let first)? = UiEventDecoder.decodeLine(execLine()),
              case .approval(let second)? = UiEventDecoder.decodeLine(execLine())
        else {
            return XCTFail("expected approval UiEvents")
        }
        controller.ingest(.approval(first))
        controller.ingest(.approval(second))
        XCTAssertEqual(controller.pending.count, 1)
    }

    @MainActor
    func testPendingQueueIsOldestFirstAndAllowPopsIt() throws {
        let controller = ApprovalsController()
        guard case .approval(let a)? = UiEventDecoder.decodeLine(execLine(id: "first")),
              case .approval(let b)? = UiEventDecoder.decodeLine(writeLine(id: "second"))
        else {
            return XCTFail("expected approval UiEvents")
        }
        controller.ingest(.approval(a))
        controller.ingest(.approval(b))
        XCTAssertEqual(controller.current?.id, "first")

        let decision = try XCTUnwrap(controller.allow())
        XCTAssertEqual(decision.id, "first")
        XCTAssertTrue(decision.granted)
        XCTAssertEqual(controller.pending.count, 1)
        XCTAssertEqual(controller.current?.id, "second")
    }

    @MainActor
    func testDenyByIdRemovesThatOneRegardlessOfQueuePosition() throws {
        let controller = ApprovalsController()
        guard case .approval(let a)? = UiEventDecoder.decodeLine(execLine(id: "first")),
              case .approval(let b)? = UiEventDecoder.decodeLine(writeLine(id: "second"))
        else {
            return XCTFail("expected approval UiEvents")
        }
        controller.ingest(.approval(a))
        controller.ingest(.approval(b))

        let decision = try XCTUnwrap(controller.deny("second"))
        XCTAssertEqual(decision.id, "second")
        XCTAssertFalse(decision.granted)
        XCTAssertEqual(controller.pending.map(\.id), ["first"])
    }

    @MainActor
    func testResolvingWithNothingPendingReturnsNil() {
        let controller = ApprovalsController()
        XCTAssertNil(controller.allow())
        XCTAssertNil(controller.deny("does-not-exist"))
    }

    @MainActor
    func testDiscardAndClear() throws {
        let controller = ApprovalsController()
        guard case .approval(let a)? = UiEventDecoder.decodeLine(execLine(id: "first")),
              case .approval(let b)? = UiEventDecoder.decodeLine(writeLine(id: "second"))
        else {
            return XCTFail("expected approval UiEvents")
        }
        controller.ingest(.approval(a))
        controller.ingest(.approval(b))

        controller.discard("first")
        XCTAssertEqual(controller.pending.map(\.id), ["second"])

        controller.clear()
        XCTAssertTrue(controller.pending.isEmpty)
    }

    // MARK: - Resolution ingestion

    @MainActor
    func testIngestingATimeoutResolutionRemovesItFromPendingAndRecordsIt() throws {
        let controller = ApprovalsController()
        guard case .approval(let request)? = UiEventDecoder.decodeLine(execLine()) else {
            return XCTFail("expected an approval UiEvent")
        }
        controller.ingest(.approval(request))
        XCTAssertEqual(controller.pending.count, 1)

        guard case .approval(let resolved)? = UiEventDecoder.decodeLine(resolutionLine(granted: false, cause: "timeout")) else {
            return XCTFail("expected an approval UiEvent")
        }
        controller.ingest(.approval(resolved))

        // The harness decided FOR the human — this must clear the pending
        // item (there is nothing left to show a sheet for) and surface WHY,
        // distinctly from an explicit "no".
        XCTAssertTrue(controller.pending.isEmpty)
        XCTAssertNil(controller.current)
        let last = try XCTUnwrap(controller.lastResolution)
        XCTAssertEqual(last.id, "appr_1")
        XCTAssertEqual(last.cause, .timeout)
        XCTAssertFalse(last.granted)
    }

    @MainActor
    func testAResolutionForAnAlreadyLocallyDecidedApprovalIsHarmless() throws {
        let controller = ApprovalsController()
        guard case .approval(let request)? = UiEventDecoder.decodeLine(execLine()) else {
            return XCTFail("expected an approval UiEvent")
        }
        controller.ingest(.approval(request))
        // The app already decided locally (e.g. the user tapped Allow) —
        // `allow()` already popped it from `pending` before the CLI's own
        // echo of that decision arrives back over the wire.
        _ = controller.allow()
        XCTAssertTrue(controller.pending.isEmpty)

        guard case .approval(let resolved)? = UiEventDecoder.decodeLine(resolutionLine(granted: true, cause: "explicit")) else {
            return XCTFail("expected an approval UiEvent")
        }
        controller.ingest(.approval(resolved))

        XCTAssertTrue(controller.pending.isEmpty, "must not resurrect an already-resolved approval")
        XCTAssertEqual(controller.lastResolution?.cause, .explicit)
    }

    @MainActor
    func testAResolutionEventNeverAddsANewPendingItem() throws {
        let controller = ApprovalsController()
        guard case .approval(let resolved)? = UiEventDecoder.decodeLine(resolutionLine(granted: false, cause: "cancelled")) else {
            return XCTFail("expected an approval UiEvent")
        }
        // A resolution arriving with no matching request in `pending` (e.g. a
        // reconnecting client that missed the original) must not be
        // misread as a brand-new approval to show a sheet for.
        controller.ingest(.approval(resolved))
        XCTAssertTrue(controller.pending.isEmpty)
        XCTAssertEqual(controller.lastResolution?.cause, .cancelled)
    }
}
