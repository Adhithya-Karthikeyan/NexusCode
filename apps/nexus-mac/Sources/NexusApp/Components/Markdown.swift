import SwiftUI
import NexusKit

/// Renders an assistant turn's text as typeset markdown instead of the raw
/// literal string the user was staring at (`**Objective**`, `# 📋 Session
/// Context`, `- bullet`, all rendered as-is) — the single most visible
/// quality bug in the app, per direct user report.
///
/// Block structure (headings, lists, fenced code, blockquotes, rules) comes
/// from `MarkdownParser` in NexusKit — pure, UI-free, unit-tested logic, kept
/// there rather than here so it can run headlessly. Everything in THIS file
/// is presentation: it turns a `[MarkdownBlock]` into `Space`/`Kind`-scaled,
/// theme-tokened SwiftUI, the same design-system vocabulary every other view
/// in the app uses, so an assistant answer reads as part of the product
/// rather than a debug dump of markdown source.
struct MarkdownView: View {
    let text: String
    /// While true, a blinking caret is appended after the last block —
    /// riding its last text baseline when that block is prose, or trailing
    /// it on its own line when it's a list/code block/quote, so the "still
    /// producing output" tell survives no matter what kind of content the
    /// model happens to be mid-way through.
    var isStreaming: Bool = false

    private var blocks: [MarkdownBlock] { MarkdownParser.parse(text) }

    var body: some View {
        let parsed = blocks
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(parsed.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(
                    block: block,
                    isFirst: index == 0,
                    trailingCaret: isStreaming && index == parsed.count - 1
                )
            }
            // A non-empty `text` that is pure whitespace mid-token (e.g. the
            // instant after a trailing "\n" arrives, before more text does)
            // parses to zero blocks. The caret must not disappear for that
            // one frame, so it gets its own fallback row.
            if isStreaming && parsed.isEmpty {
                StreamingCaret()
            }
        }
    }
}

// MARK: - Block spacing

/// Blocks are spaced apart deliberately, not left to whatever gap the
/// surrounding `VStack` happens to default to — a typeset document has more
/// air above a heading than below it (it belongs with what follows, not what
/// precedes), and more air around a rule than a paragraph.
private struct MarkdownBlockView: View {
    @Environment(\.nexusTheme) private var theme
    let block: MarkdownBlock
    let isFirst: Bool
    var trailingCaret: Bool = false

    var body: some View {
        content.padding(.top, spacingBefore)
    }

    @ViewBuilder
    private var content: some View {
        switch block {
        case .heading(let level, let inline):
            inlineWithCaret { HeadingText(level: level, inline: inline) }

        case .paragraph(let inline):
            inlineWithCaret {
                // 6.5pt of extra leading (~1.5x the tight default SwiftUI
                // would otherwise use at 13pt) is what actually fixes the
                // "cramped" complaint — long-form prose wants roughly a
                // 1.5-1.6 line-height multiple, not a UI label's tight single.
                InlineText(inline, size: 13, weight: .regular, lineSpacing: 6.5)
            }

        case .list(let list):
            trailingCaretWrapper { ListView(list: list) }

        case .codeBlock(let code):
            trailingCaretWrapper { MarkdownCodeBlockView(code: code) }

        case .blockquote(let quoted):
            trailingCaretWrapper { BlockquoteView(blocks: quoted) }

        case .thematicBreak:
            trailingCaretWrapper {
                Divider().overlay(theme.color(\.chromeDivider))
            }
        }
    }

    /// For prose (heading/paragraph): the caret rides the SAME baseline as
    /// the last line of text, exactly like the plain-text caret this
    /// replaces used to.
    @ViewBuilder
    private func inlineWithCaret<V: View>(@ViewBuilder _ inline: () -> V) -> some View {
        if trailingCaret {
            HStack(alignment: .lastTextBaseline, spacing: 3) {
                inline()
                StreamingCaret()
            }
        } else {
            inline()
        }
    }

    /// For non-prose blocks: no sensible single baseline to hang off, so the
    /// caret gets its own line directly beneath instead.
    @ViewBuilder
    private func trailingCaretWrapper<V: View>(@ViewBuilder _ block: () -> V) -> some View {
        if trailingCaret {
            VStack(alignment: .leading, spacing: 4) {
                block()
                StreamingCaret()
            }
        } else {
            block()
        }
    }

    private var spacingBefore: CGFloat {
        guard !isFirst else { return 0 }
        switch block {
        case .heading: return Space.lg + 4
        case .thematicBreak: return Space.lg
        default: return Space.md
        }
    }
}

// MARK: - Heading

/// A real size/weight ramp, distinct from body copy at every step — but built
/// entirely from sizes/weights `DesignSystem.swift` already defines and uses
/// elsewhere, rather than inventing a parallel scale next to it:
/// - `#`  -> `Kind.title`      (15/semibold)
/// - `##` -> `Kind.headline`   (13/semibold)
/// - `###`/`####` -> `Kind.bodyEmphasis`/`Kind.section`'s own (size, weight),
///   uppercased with the same tracking `SectionHeader` already uses for its
///   label row, since a level-3/4 heading in chat prose reads more like a
///   section label than a title.
private struct HeadingText: View {
    @Environment(\.nexusTheme) private var theme
    let level: Int
    let inline: String

    var body: some View {
        switch level {
        case 1:
            InlineText(inline, size: 15, weight: .semibold, lineSpacing: 2, color: theme.color(\.textPrimary))
        case 2:
            InlineText(inline, size: 13, weight: .semibold, lineSpacing: 2, color: theme.color(\.textPrimary))
        case 3:
            InlineText(inline, size: 13, weight: .medium, lineSpacing: 2, color: theme.color(\.textMuted))
                .tracking(0.5)
                .textCase(.uppercase)
        default:
            InlineText(inline, size: 11, weight: .semibold, lineSpacing: 2, color: theme.color(\.textMuted))
                .tracking(0.7)
                .textCase(.uppercase)
        }
    }
}

// MARK: - List

/// Marker in its own fixed-width column, content in a sibling column next to
/// it — a real hanging indent. A wrapped second line of item text lines up
/// under the FIRST line's text, not under the bullet, because it's laid out
/// in that same content column, never under the marker column.
private struct ListView: View {
    let list: MarkdownList

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs + 2) {
            ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
                ListItemRow(
                    marker: list.ordered ? "\(list.start + index)." : "•",
                    ordered: list.ordered,
                    item: item
                )
            }
        }
    }
}

private struct ListItemRow: View {
    @Environment(\.nexusTheme) private var theme
    let marker: String
    let ordered: Bool
    let item: MarkdownListItem

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Text(marker)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(theme.color(\.textMuted))
                .frame(minWidth: ordered ? 20 : 12, alignment: ordered ? .trailing : .center)
            // A nested list living in `item.blocks` recurses through
            // `MarkdownBlockView` -> `ListView` again, which is what makes
            // indented/nested lists just fall out of this structure for free
            // — every extra nesting level is one more marker+content column.
            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(Array(item.blocks.enumerated()), id: \.offset) { index, block in
                    MarkdownBlockView(block: block, isFirst: index == 0)
                }
            }
        }
    }
}

// MARK: - Blockquote

private struct BlockquoteView: View {
    @Environment(\.nexusTheme) private var theme
    let blocks: [MarkdownBlock]

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(theme.color(\.chromeBorderStrong))
                .frame(width: 3)
                .frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                    MarkdownBlockView(block: block, isFirst: index == 0)
                }
            }
            // Quoted text reads as muted commentary, not the primary voice —
            // an environment override rather than threading a `color:`
            // parameter through every block/list/heading variant above.
            .environment(\.markdownTextColor, theme.color(\.textMuted))
        }
        .padding(.vertical, 1)
    }
}

// MARK: - Fenced code

private struct MarkdownCodeBlockView: View {
    @Environment(\.nexusTheme) private var theme
    let code: MarkdownCodeBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let language = code.language {
                Text(language.uppercased())
                    .font(Kind.micro)
                    .tracking(0.5)
                    .foregroundStyle(theme.color(\.textMuted))
            }
            // An empty in-progress fence (the opening ``` has streamed in but
            // no code yet) still renders as a code block, not a blank gap —
            // `CodeBlock` needs at least a space to have a line to draw.
            CodeBlock(text: code.code.isEmpty ? " " : code.code)
        }
    }
}

// MARK: - Inline text

/// Threads a colour override down to every `InlineText` beneath a
/// blockquote without every intermediate block view needing a `color:`
/// parameter it would just be forwarding.
private struct MarkdownTextColorKey: EnvironmentKey {
    static let defaultValue: Color? = nil
}

private extension EnvironmentValues {
    var markdownTextColor: Color? {
        get { self[MarkdownTextColorKey.self] }
        set { self[MarkdownTextColorKey.self] = newValue }
    }
}

/// Renders one block's text with real inline formatting — bold, italic,
/// inline code, links, strikethrough — via `AttributedString(markdown:)`
/// rather than a hand-rolled inline parser.
///
/// `interpretedSyntax = .inlineOnlyPreservingWhitespace` was verified
/// directly (not assumed) against the exact cases this app hits: it parses
/// bold/italic/code/links/strikethrough correctly, and — critically for
/// streaming text that grows one token at a time — it does NOT throw or
/// mangle an unterminated span like a `**bold` with no closing `**` yet; it
/// falls back to rendering the literal asterisks until the close arrives.
/// `try?` below is a second line of defense for any input it genuinely can't
/// parse, so a bad string degrades to plain text instead of blanking the
/// whole turn.
private struct InlineText: View {
    @Environment(\.nexusTheme) private var theme
    @Environment(\.markdownTextColor) private var contextColor
    let raw: String
    var size: CGFloat = 13
    var weight: Font.Weight = .regular
    var lineSpacing: CGFloat = 6.5
    var color: Color?

    init(_ raw: String, size: CGFloat = 13, weight: Font.Weight = .regular, lineSpacing: CGFloat = 6.5, color: Color? = nil) {
        self.raw = raw
        self.size = size
        self.weight = weight
        self.lineSpacing = lineSpacing
        self.color = color
    }

    var body: some View {
        Text(attributed)
            .font(.system(size: size, weight: weight))
            .lineSpacing(lineSpacing)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var attributed: AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        let result = (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
        return styled(result)
    }

    private func styled(_ input: AttributedString) -> AttributedString {
        var result = input
        let baseColor = color ?? contextColor ?? theme.color(\.textSecondary)
        let linkColor = theme.color(\.textLink)

        for run in result.runs {
            let range = run.range
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    // `Kind.monoSmall` (10.5pt monospaced) on `surfaceInset` —
                    // the same size `Chip`/`Metric` use and the same surface
                    // token the fenced `CodeBlock` sits on, so inline code
                    // reads as "the same kind of thing" as a real code block,
                    // just smaller, rather than body text that merely
                    // switched fonts. A per-run background can't carry its
                    // own padding (`Text` concatenation has no `.padding`),
                    // so this is a tight highlight, not a padded pill —
                    // still a real, unmistakable departure from body copy.
                    result[range].font = Kind.monoSmall
                    result[range].backgroundColor = theme.color(\.surfaceInset)
                } else {
                    var runFont = Font.system(size: size, weight: intent.contains(.stronglyEmphasized) ? .bold : weight)
                    if intent.contains(.emphasized) { runFont = runFont.italic() }
                    result[range].font = runFont
                    if intent.contains(.strikethrough) { result[range].strikethroughStyle = .single }
                }
            }
            if run.link != nil {
                result[range].foregroundColor = linkColor
                result[range].underlineStyle = .single
            } else if result[range].foregroundColor == nil {
                result[range].foregroundColor = baseColor
            }
        }
        return result
    }
}
