import Foundation

/// How a raw line from `nexus`'s stderr should be treated once it reaches the UI.
///
/// The CLI's stderr is written for a person watching a terminal: session
/// bookkeeping (`[session] <uuid>`), reassurance (`[resume] …`) and genuine
/// failures all share the one stream, with no severity marker of their own.
/// Rendering every line as an amber warning banner — the old behaviour — got
/// this wrong twice over: the CONTENT (a raw UUID, a raw config key) means
/// nothing to a user, and the SEVERITY (amber) is wrong for lines that are the
/// success path, not a problem. This is the one place that decides, so the UI
/// never has to re-guess it per call site.
public enum DiagnosticPresentation: Equatable, Sendable {
    /// Pure lifecycle plumbing the app already has programmatically (the
    /// session id lives on `ConversationController.sessionId`). Showing the
    /// raw line teaches the user nothing a UUID on screen ever does.
    case hidden
    /// Worth knowing, calm — humanized text, never rendered amber.
    case quiet(String)
    /// A genuine problem. Rendered the way every diagnostic used to be.
    case warning(String)
}

/// Classifies one raw stderr line at a time.
///
/// Pure — string in, category out, no `Date`, no I/O — so it's trivial to
/// unit test and safe to call from a replay path where nondeterminism isn't
/// allowed.
public enum DiagnosticClassifier {
    public static func classify(_ line: String) -> DiagnosticPresentation {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .hidden }

        // A raw session UUID with no other content. The app already carries
        // this id on `ConversationController.sessionId` — printing it again
        // here would only be noise nobody can act on.
        if trimmed.hasPrefix("[session]") {
            return .hidden
        }

        // Resuming a conversation is the SUCCESS path, not a warning — but
        // the "tool calls aren't replayed" caveat is a real limitation worth
        // keeping visible, just stated calmly instead of raised as an alarm.
        if trimmed.hasPrefix("[resume]") {
            return .quiet(
                "Continuing your earlier conversation — only the text carries over; " +
                    "tool calls from before aren't replayed."
            )
        }

        // The sibling case: nothing was actually stored to resume, so the CLI
        // started fresh instead. Same situation as `[resume]` (a completed,
        // non-alarming outcome), so it gets the same calm treatment rather
        // than tripping the generic "nexus <cmd>: …" problem heuristic below
        // on its identical prefix.
        if trimmed.contains("no stored transcript to resume") {
            return .quiet("Nothing to resume — starting a fresh conversation.")
        }

        // A file-indexing limit. The line is written for someone editing
        // `nexus.config` — a raw config key and a byte count — never fit for
        // a user's screen as-is. Truncated indexing on a large project is
        // also routine enough that it doesn't warrant surfacing by default.
        if trimmed.hasPrefix("index:"), trimmed.contains("reached limit") {
            return .hidden
        }

        if looksLikeAGenuineProblem(trimmed) {
            return .warning(trimmed)
        }

        // Documented default: a line this classifier doesn't recognize is
        // shown, but quietly, never amber. Amber is reserved for lines this
        // classifier can actually confirm are a problem — failing to
        // recognize a line is not evidence one exists, and blanket-amber for
        // "anything unfamiliar" is exactly the bug this replaces.
        return .quiet(trimmed)
    }

    private static func looksLikeAGenuineProblem(_ line: String) -> Bool {
        let lowered = line.lowercased()
        if lowered.contains("error") || lowered.contains("fail") { return true }
        if lowered.hasPrefix("warning:") { return true }
        return hasNexusSubcommandErrorPrefix(line)
    }

    /// Matches the CLI's own usage/error convention, e.g.
    /// `"nexus ask: provider \"x\" is not available"` or
    /// `"nexus agent: unknown role \"y\""` — every one of these is a genuine
    /// problem, so the prefix alone is a reliable enough signal without
    /// pulling in a full regex dependency for one shape.
    private static func hasNexusSubcommandErrorPrefix(_ line: String) -> Bool {
        guard line.hasPrefix("nexus ") else { return false }
        guard let colon = line.firstIndex(of: ":") else { return false }
        let word = line[line.index(line.startIndex, offsetBy: 6)..<colon]
        return !word.isEmpty && !word.contains(" ") && word == word.lowercased()
    }
}
