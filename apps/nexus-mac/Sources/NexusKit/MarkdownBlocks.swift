import Foundation

/// A block-level element of a parsed markdown document.
///
/// This models structure only — no fonts, no colours, no `Text`. `NexusApp`
/// renders it; this file never imports SwiftUI, so the parser is testable
/// headlessly (see `Tests/NexusKitTests/MarkdownTests.swift`) with no window,
/// no simulator, and no dependency on `AttributedString`'s block behaviour
/// (which doesn't exist — see the note on `inline` below).
public enum MarkdownBlock: Sendable, Hashable {
    case heading(level: Int, inline: String)
    case paragraph(inline: String)
    case list(MarkdownList)
    case codeBlock(MarkdownCodeBlock)
    case blockquote([MarkdownBlock])
    case thematicBreak
}

/// One list, either bulleted or numbered. `start` is the first item's number
/// (relevant only when `ordered`); items after it are numbered sequentially
/// from there, matching how every mainstream renderer treats a numbered list
/// rather than trusting each line's own (possibly wrong, possibly repeated
/// "1.") number.
public struct MarkdownList: Sendable, Hashable {
    public let ordered: Bool
    public let start: Int
    public let items: [MarkdownListItem]

    public init(ordered: Bool, start: Int, items: [MarkdownListItem]) {
        self.ordered = ordered
        self.start = start
        self.items = items
    }
}

/// A list item's content is itself a block list, not a single string — an
/// item is usually one paragraph, but may contain a nested list (see
/// `parseList`), which is what makes indented/nested lists representable at
/// all.
public struct MarkdownListItem: Sendable, Hashable {
    public let blocks: [MarkdownBlock]

    public init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }
}

/// A fenced code block. `isComplete` is false while the opening fence has no
/// matching close yet — the normal state for a fence mid-stream, since tokens
/// arrive one at a time and the closing ``` may be seconds away. The renderer
/// uses this to show the block as "in progress" rather than, say, waiting for
/// completion before rendering anything (which would flash a huge wall of
/// plain, un-code-styled text for however long the model takes to close it).
public struct MarkdownCodeBlock: Sendable, Hashable {
    public let language: String?
    public let code: String
    public let isComplete: Bool

    public init(language: String?, code: String, isComplete: Bool) {
        self.language = language
        self.code = code
        self.isComplete = isComplete
    }
}

/// Parses markdown TEXT into `[MarkdownBlock]`. Block structure only —
/// headings, paragraphs, lists, fenced code, blockquotes, thematic breaks.
///
/// Inline formatting (bold/italic/code/links/strikethrough) is deliberately
/// NOT handled here: `AttributedString(markdown:)` (available since macOS 12)
/// already parses those correctly, including graceful fallback to literal
/// text for unterminated spans like a `**bold` that hasn't been closed yet —
/// verified directly against the real API rather than assumed, since that's
/// exactly the streaming case this app hits constantly. What it does NOT do
/// is block structure: fed a whole message, it has no concept of "this line
/// is a heading" or "these three lines are a list" — hence this hand-rolled
/// parser. Each block's text is handed to `AttributedString(markdown:)` at
/// render time in `NexusApp/Components/Markdown.swift`.
///
/// This is intentionally NOT a full CommonMark implementation — no reference
/// links, no HTML blocks, no setext headings, no lazy blockquote continuation.
/// It covers what LLM chat output actually produces, and it is
/// streaming-safe: called again on every token as `turn.text` grows, it must
/// never throw, never infinite-loop, and never let a dangling construct (an
/// unterminated fence, chiefly) eat or misrender content that arrived before it.
public enum MarkdownParser {
    public static func parse(_ text: String) -> [MarkdownBlock] {
        guard !text.isEmpty else { return [] }
        return parseBlocks(splitLines(text))
    }

    // MARK: - Lines

    /// One line, pre-split of its leading spaces: `content` never has a
    /// leading space, `indent` is how many were removed. Every recursive
    /// context (inside a list item, inside a blockquote) rebuilds its own
    /// array of `Line`s with `indent` renumbered relative to that container,
    /// so indentation comparisons are always local, simple subtraction —
    /// never absolute-column arithmetic threaded through every call site.
    private struct Line {
        let indent: Int
        let content: Substring
    }

    private static func stripLeadingSpaces(_ text: Substring) -> (indent: Int, rest: Substring) {
        var indent = 0
        var idx = text.startIndex
        while idx < text.endIndex, text[idx] == " " {
            indent += 1
            idx = text.index(after: idx)
        }
        return (indent, text[idx...])
    }

    private static func splitLines(_ text: String) -> [Line] {
        // Tabs are rare in chat text but would otherwise desync indent-based
        // comparisons against space-indented siblings; expand them like most
        // renderers do.
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\t", with: "    ")
        return normalized.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            let (indent, rest) = stripLeadingSpaces(line)
            return Line(indent: indent, content: rest)
        }
    }

    // MARK: - Block dispatch

    private static func parseBlocks(_ lines: [Line]) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.content.isEmpty {
                i += 1
                continue
            }

            if matchThematicBreak(line.content) {
                blocks.append(.thematicBreak)
                i += 1
                continue
            }

            if let (level, inline) = matchHeading(line.content) {
                blocks.append(.heading(level: level, inline: inline))
                i += 1
                continue
            }

            if let fence = matchFenceOpen(line.content) {
                let (code, next) = consumeFencedCode(lines, start: i + 1, fence: fence)
                blocks.append(.codeBlock(code))
                i = next
                continue
            }

            if line.content.hasPrefix(">") {
                let (quoted, next) = consumeBlockquote(lines, start: i)
                blocks.append(.blockquote(parseBlocks(quoted)))
                i = next
                continue
            }

            if matchListMarker(line.content) != nil {
                let (list, next) = consumeList(lines, start: i, containerIndent: line.indent)
                blocks.append(.list(list))
                i = next
                continue
            }

            let (paragraph, next) = consumeParagraph(lines, start: i)
            blocks.append(.paragraph(inline: paragraph))
            i = next
        }
        return blocks
    }

    // MARK: - Thematic break

    /// `---`, `***`, `___`, with or without interior spaces — three or more
    /// of the same character and nothing else. Checked before list markers so
    /// a bare `---` (extremely common as a section divider in LLM output)
    /// never gets misread as an empty-content list item.
    private static func matchThematicBreak(_ content: Substring) -> Bool {
        let compact = content.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    // MARK: - Heading

    /// ATX-style `#` headings only (no setext `===`/`---` underlines — those
    /// are indistinguishable from a thematic break or a paragraph without
    /// look-ahead this renderer doesn't need for chat text). Levels are
    /// capped at 4: the design system's type ramp (`Kind.title` down to
    /// `Kind.section`) has four distinct steps, and a `#####` in the wild
    /// reads as "still a heading", not as a reason to add a fifth size.
    private static func matchHeading(_ content: Substring) -> (level: Int, inline: String)? {
        var count = 0
        var idx = content.startIndex
        while idx < content.endIndex, content[idx] == "#", count < 6 {
            count += 1
            idx = content.index(after: idx)
        }
        guard count >= 1 else { return nil }
        if idx < content.endIndex {
            guard content[idx] == " " else { return nil }
        }
        var rest = content[idx...].trimmingCharacters(in: .whitespaces)
        while rest.hasSuffix("#") {
            rest.removeLast()
        }
        rest = rest.trimmingCharacters(in: .whitespaces)
        return (min(count, 4), rest)
    }

    // MARK: - List markers

    private struct ListMarker {
        let ordered: Bool
        let start: Int
        /// Column width of the marker itself (e.g. `"- "` is 2, `"12. "` is
        /// 4) — the content column continuation lines must reach to belong
        /// to this item rather than end it.
        let width: Int
        let firstLineText: Substring
    }

    private static func matchListMarker(_ content: Substring) -> ListMarker? {
        if let first = content.first, "-*+".contains(first) {
            let afterMarker = content.index(after: content.startIndex)
            if afterMarker == content.endIndex {
                return ListMarker(ordered: false, start: 1, width: 1, firstLineText: content[afterMarker...])
            }
            guard content[afterMarker] == " " else { return nil }
            let textStart = content.index(after: afterMarker)
            return ListMarker(
                ordered: false, start: 1,
                width: content.distance(from: content.startIndex, to: textStart),
                firstLineText: content[textStart...]
            )
        }

        var idx = content.startIndex
        var digits = 0
        while idx < content.endIndex, content[idx].isNumber, digits < 9 {
            idx = content.index(after: idx)
            digits += 1
        }
        guard digits > 0, idx < content.endIndex, content[idx] == "." || content[idx] == ")" else { return nil }
        let start = Int(content[content.startIndex..<idx]) ?? 1
        let afterDelim = content.index(after: idx)
        if afterDelim == content.endIndex {
            return ListMarker(
                ordered: true, start: start,
                width: content.distance(from: content.startIndex, to: afterDelim),
                firstLineText: content[afterDelim...]
            )
        }
        guard content[afterDelim] == " " else { return nil }
        let textStart = content.index(after: afterDelim)
        return ListMarker(
            ordered: true, start: start,
            width: content.distance(from: content.startIndex, to: textStart),
            firstLineText: content[textStart...]
        )
    }

    // MARK: - List

    private static func consumeList(_ lines: [Line], start: Int, containerIndent: Int) -> (MarkdownList, Int) {
        guard let firstMarker = matchListMarker(lines[start].content) else {
            // Unreachable: callers only invoke this after confirming a marker.
            return (MarkdownList(ordered: false, start: 1, items: []), start + 1)
        }
        let ordered = firstMarker.ordered
        var items: [MarkdownListItem] = []
        var i = start

        while i < lines.count {
            let line = lines[i]

            if line.content.isEmpty {
                // A blank line only continues the list if what follows is a
                // sibling marker at this exact indent; anything else — dedent,
                // more-indented orphan content, or end of input — ends it
                // here rather than guessing.
                var j = i
                while j < lines.count, lines[j].content.isEmpty { j += 1 }
                if j < lines.count, lines[j].indent == containerIndent,
                   let marker = matchListMarker(lines[j].content), marker.ordered == ordered {
                    i = j
                    continue
                }
                break
            }

            guard line.indent == containerIndent,
                  let marker = matchListMarker(line.content), marker.ordered == ordered
            else { break }

            let contentColumn = line.indent + marker.width
            let (itemLines, next) = collectItemLines(
                lines, start: i, firstLineText: marker.firstLineText, contentColumn: contentColumn
            )
            items.append(MarkdownListItem(blocks: parseBlocks(itemLines)))
            i = next
        }

        return (MarkdownList(ordered: ordered, start: firstMarker.start, items: items), i)
    }

    /// Gathers every line belonging to one item: its own first line, plus any
    /// following lines indented at or past the item's content column —
    /// continuation text and/or a nested list. A blank line doesn't
    /// necessarily end the item: if content past the blank is still indented
    /// enough, the blank becomes a paragraph break inside the item instead.
    private static func collectItemLines(
        _ lines: [Line], start: Int, firstLineText: Substring, contentColumn: Int
    ) -> ([Line], Int) {
        var itemLines: [Line] = [Line(indent: 0, content: firstLineText)]
        var i = start + 1
        while i < lines.count {
            let line = lines[i]
            if line.content.isEmpty {
                var j = i
                while j < lines.count, lines[j].content.isEmpty { j += 1 }
                guard j < lines.count, lines[j].indent >= contentColumn else { break }
                itemLines.append(Line(indent: 0, content: ""))
                i += 1
                continue
            }
            guard line.indent >= contentColumn else { break }
            itemLines.append(Line(indent: line.indent - contentColumn, content: line.content))
            i += 1
        }
        return (itemLines, i)
    }

    // MARK: - Fenced code

    private struct Fence {
        let char: Character
        let length: Int
        let language: String?
    }

    private static func matchFenceOpen(_ content: Substring) -> Fence? {
        var s = content
        var skipped = 0
        while s.first == " ", skipped < 3 {
            s = s.dropFirst()
            skipped += 1
        }
        guard let first = s.first, first == "`" || first == "~" else { return nil }
        var count = 0
        var idx = s.startIndex
        while idx < s.endIndex, s[idx] == first {
            count += 1
            idx = s.index(after: idx)
        }
        guard count >= 3 else { return nil }
        let info = s[idx...].trimmingCharacters(in: .whitespaces)
        // A backtick fence's info string can't itself contain a backtick
        // (that would make the fence ambiguous with inline code) — fall back
        // to no language rather than mis-tagging the block.
        if first == "`", info.contains("`") { return Fence(char: first, length: count, language: nil) }
        let language = info.split(separator: " ").first.map(String.init)
        return Fence(char: first, length: count, language: language?.isEmpty == false ? language : nil)
    }

    private static func matchFenceClose(_ content: Substring, fence: Fence) -> Bool {
        var s = content
        var skipped = 0
        while s.first == " ", skipped < 3 {
            s = s.dropFirst()
            skipped += 1
        }
        guard let first = s.first, first == fence.char else { return false }
        var count = 0
        var idx = s.startIndex
        while idx < s.endIndex, s[idx] == first {
            count += 1
            idx = s.index(after: idx)
        }
        guard count >= fence.length else { return false }
        return s[idx...].trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Consumes lines verbatim until a matching close fence — crucially,
    /// WITHOUT interpreting them as markdown, so a fenced example that itself
    /// contains `**bold**` or `# heading` stays literal text inside the code
    /// block instead of being (wrongly) rendered as formatting. Hitting the
    /// end of input with no close yields `isComplete: false`: the fence is
    /// still open, everything gathered so far is genuinely inside it (there
    /// is nothing "after" the fence yet), so the right rendering is a code
    /// block in progress — never silently reverting to plain text and never
    /// dropping what came before the fence.
    private static func consumeFencedCode(_ lines: [Line], start: Int, fence: Fence) -> (MarkdownCodeBlock, Int) {
        var codeLines: [String] = []
        var i = start
        while i < lines.count {
            if matchFenceClose(lines[i].content, fence: fence) {
                return (
                    MarkdownCodeBlock(language: fence.language, code: codeLines.joined(separator: "\n"), isComplete: true),
                    i + 1
                )
            }
            codeLines.append(String(lines[i].content))
            i += 1
        }
        return (
            MarkdownCodeBlock(language: fence.language, code: codeLines.joined(separator: "\n"), isComplete: false),
            i
        )
    }

    // MARK: - Blockquote

    private static func consumeBlockquote(_ lines: [Line], start: Int) -> ([Line], Int) {
        var quoted: [Line] = []
        var i = start
        while i < lines.count {
            let line = lines[i]
            guard !line.content.isEmpty, line.content.hasPrefix(">") else { break }
            var rest = line.content.dropFirst()
            if rest.first == " " { rest = rest.dropFirst() }
            let (indent, text) = stripLeadingSpaces(rest)
            quoted.append(Line(indent: indent, content: text))
            i += 1
        }
        return (quoted, i)
    }

    // MARK: - Paragraph

    /// Consecutive non-blank lines, joined with a single space each — a
    /// "soft break" collapses to a space the same way every markdown renderer
    /// treats mid-paragraph line wraps, rather than preserving the source's
    /// arbitrary line-wrap width. Stops as soon as a line would start any
    /// other block, so e.g. a heading immediately following prose (no blank
    /// line between them, which streamed text produces constantly) still
    /// reads as a heading rather than being swallowed into the paragraph above it.
    private static func consumeParagraph(_ lines: [Line], start: Int) -> (String, Int) {
        var parts: [String] = []
        var i = start
        while i < lines.count {
            let line = lines[i]
            if line.content.isEmpty { break }
            if i > start {
                if matchThematicBreak(line.content) { break }
                if matchHeading(line.content) != nil { break }
                if matchFenceOpen(line.content) != nil { break }
                if line.content.hasPrefix(">") { break }
                if matchListMarker(line.content) != nil { break }
            }
            parts.append(line.content.trimmingCharacters(in: .whitespaces))
            i += 1
        }
        return (parts.joined(separator: " "), i)
    }
}
