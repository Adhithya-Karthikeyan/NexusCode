import XCTest
@testable import NexusKit

/// The three real lines a user actually saw rendered as amber warnings, plus
/// a genuine error that must stay visible — `DiagnosticClassifier` exists so
/// none of the first three are ever amber again, without also silencing the
/// fourth.
final class DiagnosticClassifierTests: XCTestCase {
    func testSessionLineIsHidden() {
        let result = DiagnosticClassifier.classify(
            "[session] s_88ca706f-636c-4adb-9540-b864cda661fa"
        )
        XCTAssertEqual(result, .hidden)
    }

    func testResumeLineIsQuietNotAWarning() {
        let result = DiagnosticClassifier.classify(
            "[resume] s_88ca706f-636c-4adb-9540-b864cda661fa — restored 2 messages " +
                "(text only; tool calls are not replayed)"
        )
        guard case .quiet(let text) = result else {
            return XCTFail("expected .quiet, got \(result)")
        }
        // The raw session id must not leak into the humanized text, and the
        // "tool calls aren't replayed" caveat must survive in some form —
        // it's a real limitation, not noise.
        XCTAssertFalse(text.contains("88ca706f"))
        XCTAssertTrue(text.localizedCaseInsensitiveContains("tool calls"))
    }

    func testIndexLimitLineIsHiddenNotShownAsRawConfigKeys() {
        let result = DiagnosticClassifier.classify(
            "index: reached limit (9557 of 20000 files / 128.0 MiB) — indexed a subset; " +
                "raise fileintel.maxTotalFiles / fileintel.maxTotalBytes to include more."
        )
        XCTAssertEqual(result, .hidden)
    }

    func testGenuineErrorStaysAWarning() {
        let result = DiagnosticClassifier.classify(
            "nexus ask: provider \"anthropic\" is not available (try -p mock)"
        )
        guard case .warning(let text) = result else {
            return XCTFail("expected .warning, got \(result)")
        }
        XCTAssertEqual(text, "nexus ask: provider \"anthropic\" is not available (try -p mock)")
    }

    func testEffortUnsupportedByProviderStaysAWarning() {
        // The exact stderr line `applyEffort` writes when the resolved
        // provider cannot honor `--effort` (`packages/cli/src/commands.ts`)
        // — now reachable from the app since `ConversationController.effort`
        // actually sends the flag instead of only decorating the preview.
        // This must stay a warning: it is telling the user their setting had
        // no effect, not routine plumbing like `[session]`/`[resume]`.
        let result = DiagnosticClassifier.classify(
            "nexus chat: provider \"claude-code\" does not support reasoning effort — " +
                "\"--effort high\" is ignored for this request"
        )
        guard case .warning(let text) = result else {
            return XCTFail("expected .warning, got \(result)")
        }
        XCTAssertTrue(text.contains("does not support reasoning effort"))
    }

    func testLaunchFailureStaysAWarning() {
        // Generated client-side (`ConversationController.absorb`), not by the
        // CLI — must survive classification exactly like a CLI-sourced error.
        let result = DiagnosticClassifier.classify(
            "failed to launch nexus: No such file or directory"
        )
        guard case .warning = result else {
            return XCTFail("expected .warning, got \(result)")
        }
    }

    func testNoStoredTranscriptToResumeIsQuietLikeItsResumeSibling() {
        let result = DiagnosticClassifier.classify(
            "nexus chat: no stored transcript to resume for session \"s_gone\" " +
                "(nothing stored, or no completed exchange yet) — starting a fresh conversation"
        )
        guard case .quiet = result else {
            return XCTFail("expected .quiet, got \(result)")
        }
    }

    func testUnrecognizedLineDefaultsToQuietNotWarning() {
        // Documented default: unknown lines are shown, but never amber — amber
        // is reserved for lines this classifier can actually confirm are a
        // problem.
        let result = DiagnosticClassifier.classify("some future CLI line nobody wrote a rule for yet")
        guard case .quiet(let text) = result else {
            return XCTFail("expected .quiet, got \(result)")
        }
        XCTAssertEqual(text, "some future CLI line nobody wrote a rule for yet")
    }

    func testBlankLineIsHidden() {
        XCTAssertEqual(DiagnosticClassifier.classify("   "), .hidden)
    }
}
