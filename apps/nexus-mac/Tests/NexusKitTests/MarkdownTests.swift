import XCTest
@testable import NexusKit

/// `MarkdownParser` is the block-structure half of the markdown renderer —
/// see `Sources/NexusApp/Components/Markdown.swift` for the SwiftUI half and
/// why the split exists. These tests only cover block structure: whether a
/// span of `**bold**` or `` `code` `` inside a heading/paragraph/list item
/// gets turned into actual bold/monospace glyphs is `AttributedString`'s job
/// at render time in `NexusApp`, which has no headless test target here — so
/// "inline formatting inside headings/list items" below asserts the parser
/// carries that raw markup through UNCHANGED rather than stripping or
/// mangling it, which is the contract the renderer depends on.
final class MarkdownTests: XCTestCase {
    private func parse(_ text: String) -> [MarkdownBlock] {
        MarkdownParser.parse(text)
    }

    // MARK: - Base cases

    func testEmptyInputProducesNoBlocks() {
        XCTAssertEqual(parse(""), [])
    }

    func testPlainTextWithNoMarkdownIsExactlyOneUnchangedParagraph() {
        let text = "Just plain text with no special syntax at all."
        XCTAssertEqual(parse(text), [.paragraph(inline: text)])
    }

    func testConsecutiveLinesWithNoBlankJoinIntoOneParagraph() {
        let text = "Line one\nLine two\nLine three"
        XCTAssertEqual(parse(text), [.paragraph(inline: "Line one Line two Line three")])
    }

    // MARK: - Headings

    func testHeadingLevelsOneThroughFour() {
        XCTAssertEqual(parse("# H1"), [.heading(level: 1, inline: "H1")])
        XCTAssertEqual(parse("## H2"), [.heading(level: 2, inline: "H2")])
        XCTAssertEqual(parse("### H3"), [.heading(level: 3, inline: "H3")])
        XCTAssertEqual(parse("#### H4"), [.heading(level: 4, inline: "H4")])
    }

    func testHeadingWithEmojiAndEmDash() {
        XCTAssertEqual(
            parse("# 📋 Session Context — llm_handler"),
            [.heading(level: 1, inline: "📋 Session Context — llm_handler")]
        )
    }

    func testHeadingRequiresASpaceAfterHashes() {
        // `#no-space` is a paragraph, not a heading — matches every other
        // ATX-heading markdown implementation, and stops a stray hashtag-ish
        // token from mid-stream text being misread as a heading.
        XCTAssertEqual(parse("#no-space"), [.paragraph(inline: "#no-space")])
    }

    func testHeadingImmediatelyFollowingProseWithNoBlankLineIsStillAHeading() {
        // Streamed text routinely has no blank line before the next
        // structural element yet — a heading token can arrive right after a
        // paragraph's last token.
        XCTAssertEqual(
            parse("Some prose.\n## A heading"),
            [.paragraph(inline: "Some prose."), .heading(level: 2, inline: "A heading")]
        )
    }

    // MARK: - Paragraphs & blank-line separation

    func testBlankLineSeparatesTwoParagraphs() {
        XCTAssertEqual(
            parse("First paragraph.\n\nSecond paragraph."),
            [.paragraph(inline: "First paragraph."), .paragraph(inline: "Second paragraph.")]
        )
    }

    // MARK: - Lists

    func testUnorderedList() {
        let blocks = parse("- alpha\n- beta\n- gamma")
        XCTAssertEqual(blocks, [
            .list(MarkdownList(ordered: false, start: 1, items: [
                MarkdownListItem(blocks: [.paragraph(inline: "alpha")]),
                MarkdownListItem(blocks: [.paragraph(inline: "beta")]),
                MarkdownListItem(blocks: [.paragraph(inline: "gamma")]),
            ])),
        ])
    }

    func testOrderedListPreservesStartNumberAndAutoIncrementsAfter() {
        let blocks = parse("5. five\n6. six\n7. seven")
        XCTAssertEqual(blocks, [
            .list(MarkdownList(ordered: true, start: 5, items: [
                MarkdownListItem(blocks: [.paragraph(inline: "five")]),
                MarkdownListItem(blocks: [.paragraph(inline: "six")]),
                MarkdownListItem(blocks: [.paragraph(inline: "seven")]),
            ])),
        ])
    }

    func testNestedIndentedList() {
        let text = """
        - Item 1
          - Nested A
          - Nested B
        - Item 2
        """
        let blocks = parse(text)
        XCTAssertEqual(blocks, [
            .list(MarkdownList(ordered: false, start: 1, items: [
                MarkdownListItem(blocks: [
                    .paragraph(inline: "Item 1"),
                    .list(MarkdownList(ordered: false, start: 1, items: [
                        MarkdownListItem(blocks: [.paragraph(inline: "Nested A")]),
                        MarkdownListItem(blocks: [.paragraph(inline: "Nested B")]),
                    ])),
                ]),
                MarkdownListItem(blocks: [.paragraph(inline: "Item 2")]),
            ])),
        ])
    }

    func testDeeplyNestedList() {
        let text = """
        - a
          - b
            - c
        """
        let blocks = parse(text)
        guard case .list(let outer) = blocks.first, blocks.count == 1 else {
            return XCTFail("expected a single top-level list, got \(blocks)")
        }
        XCTAssertEqual(outer.items.count, 1)
        guard case .list(let middle) = outer.items[0].blocks.last else {
            return XCTFail("expected item 'a' to contain a nested list")
        }
        XCTAssertEqual(middle.items.count, 1)
        guard case .list(let inner) = middle.items[0].blocks.last else {
            return XCTFail("expected item 'b' to contain a nested list")
        }
        XCTAssertEqual(inner.items, [MarkdownListItem(blocks: [.paragraph(inline: "c")])])
    }

    func testInlineFormattingInsideAListItemIsPreservedUnchanged() {
        let blocks = parse("- Item with **bold** and `code`")
        XCTAssertEqual(blocks, [
            .list(MarkdownList(ordered: false, start: 1, items: [
                MarkdownListItem(blocks: [.paragraph(inline: "Item with **bold** and `code`")]),
            ])),
        ])
    }

    // MARK: - Fenced code

    func testFencedCodeBlockCapturesLanguage() {
        let text = "```swift\nlet x = 1\nlet y = 2\n```"
        XCTAssertEqual(
            parse(text),
            [.codeBlock(MarkdownCodeBlock(language: "swift", code: "let x = 1\nlet y = 2", isComplete: true))]
        )
    }

    func testFencedCodeBlockWithNoLanguage() {
        let text = "```\nplain\n```"
        XCTAssertEqual(
            parse(text),
            [.codeBlock(MarkdownCodeBlock(language: nil, code: "plain", isComplete: true))]
        )
    }

    /// The common streaming case: text arrives token by token, so an opening
    /// ``` fence with no closing fence yet is the NORMAL mid-stream state,
    /// not a malformed edge case. It must render as an in-progress code
    /// block and must not swallow or corrupt anything that came before it.
    func testUnterminatedFenceMidStreamRendersAsCodeBlockInProgress() {
        let text = "Some text before.\n\n```python\ndef foo():\n    return 1"
        XCTAssertEqual(parse(text), [
            .paragraph(inline: "Some text before."),
            .codeBlock(MarkdownCodeBlock(language: "python", code: "def foo():\n    return 1", isComplete: false)),
        ])
    }

    /// Content inside a fence must never be re-interpreted as markdown, even
    /// when it looks exactly like markdown — otherwise a code sample that
    /// happens to demonstrate `**bold**` or `# heading` syntax would render
    /// as actual formatting instead of the literal characters the fence
    /// promises.
    func testFenceContentIsNeverParsedAsMarkdown() {
        let text = "```\n# Not a heading\n**not bold**\n- not a list\n> not a quote\n```"
        XCTAssertEqual(
            parse(text),
            [.codeBlock(MarkdownCodeBlock(
                language: nil,
                code: "# Not a heading\n**not bold**\n- not a list\n> not a quote",
                isComplete: true
            ))]
        )
    }

    // MARK: - Blockquote

    func testBlockquote() {
        XCTAssertEqual(
            parse("> quoted line one\n> quoted line two"),
            [.blockquote([.paragraph(inline: "quoted line one quoted line two")])]
        )
    }

    func testBlockquoteContainsRealBlockStructureNotJustText() {
        XCTAssertEqual(
            parse("> # Quoted heading\n> - quoted item"),
            [.blockquote([
                .heading(level: 1, inline: "Quoted heading"),
                .list(MarkdownList(ordered: false, start: 1, items: [
                    MarkdownListItem(blocks: [.paragraph(inline: "quoted item")]),
                ])),
            ])]
        )
    }

    // MARK: - Thematic break

    func testThematicBreakVariants() {
        XCTAssertEqual(parse("---"), [.thematicBreak])
        XCTAssertEqual(parse("***"), [.thematicBreak])
        XCTAssertEqual(parse("___"), [.thematicBreak])
    }

    func testThematicBreakSeparatesSurroundingParagraphs() {
        XCTAssertEqual(
            parse("Above\n\n---\n\nBelow"),
            [.paragraph(inline: "Above"), .thematicBreak, .paragraph(inline: "Below")]
        )
    }

    // MARK: - Inline formatting preserved in headings

    func testInlineFormattingInsideAHeadingIsPreservedUnchanged() {
        XCTAssertEqual(
            parse("## Header with **bold** and `code`"),
            [.heading(level: 2, inline: "Header with **bold** and `code`")]
        )
    }

    // MARK: - Streaming performance

    /// `MarkdownView` re-parses a turn's FULL accumulated text on every
    /// render while it's live-streaming (SwiftUI has no good way to
    /// incrementally patch a `[MarkdownBlock]` tree), which is only safe if
    /// one parse stays cheap even for a long message. This guards against a
    /// future change accidentally making a line-scan quadratic and silently
    /// turning "re-parse per token" into real dropped frames — a regression
    /// a functional test would never catch.
    func testParsingStaysFastEnoughForPerTokenReparsingDuringStreaming() {
        let paragraph = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 20)
        let longMessage = (0..<60).map { i -> String in
            switch i % 5 {
            case 0: return "## Section \(i)"
            case 1: return "- item \(i) with **bold** and `code`"
            default: return paragraph
            }
        }.joined(separator: "\n\n")
        XCTAssertGreaterThan(longMessage.count, 10_000, "fixture should be a realistically large streamed message")

        let start = Date()
        for _ in 0..<50 { _ = parse(longMessage) }
        let elapsed = Date().timeIntervalSince(start)

        // Measured ~0.055s on dev hardware; 2.0s was a 36x-loose bound that
        // would only ever catch genuine quadratic blowup. 0.3s still leaves
        // ~5.5x headroom for slower CI machines without being so loose it
        // stops meaning anything.
        XCTAssertLessThan(
            elapsed, 0.3,
            "50 parses of a \(longMessage.count)-char message took \(elapsed)s — too slow for per-token reparsing"
        )
    }

    // MARK: - The real user-reported fixture

    /// The exact text from the user's bug report screenshot: headers,
    /// bold labels, and bullets all rendered as literal characters instead
    /// of formatted output. This is the regression this whole file exists to
    /// prevent.
    func testUserReportedFixtureParsesIntoRealBlockStructure() {
        let text = """
        # 📋 Session Context — llm_handler

        **Objective**
        - Build a lightweight Claude Code-like CLI assistant for **local LLMs**, with MCP support, token budgeting, context compression, and memory integration.

        **Next**
        - What would you like to work on today? I can pull deeper project context from `kyp-mem` if you want a refresher.
        """

        XCTAssertEqual(parse(text), [
            .heading(level: 1, inline: "📋 Session Context — llm_handler"),
            .paragraph(inline: "**Objective**"),
            .list(MarkdownList(ordered: false, start: 1, items: [
                MarkdownListItem(blocks: [.paragraph(inline:
                    "Build a lightweight Claude Code-like CLI assistant for **local LLMs**, with MCP support, token budgeting, context compression, and memory integration."
                )]),
            ])),
            .paragraph(inline: "**Next**"),
            .list(MarkdownList(ordered: false, start: 1, items: [
                MarkdownListItem(blocks: [.paragraph(inline:
                    "What would you like to work on today? I can pull deeper project context from `kyp-mem` if you want a refresher."
                )]),
            ])),
        ])
    }
}
