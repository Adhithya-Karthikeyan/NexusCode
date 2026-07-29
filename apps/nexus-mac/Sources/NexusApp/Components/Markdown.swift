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
/// is presentation: it turns a `[MarkdownBlock]` into `Space`/`Type`-scaled,
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
                // `.equatable()` is what makes re-parsing on every streamed
                // token affordable: `MarkdownParser.parse` runs fresh each
                // render (1.1ms measured for a 10.6k-char message — not the
                // bottleneck), but naively that also rebuilds an
                // `AttributedString` for every UNCHANGED earlier block on
                // every single frame (measured 11.1ms for 60 blocks — most of
                // a 16ms budget). Only the LAST block actually differs
                // mid-stream; `ForEach`'s `id: \.offset` gives each position
                // stable identity, and since `MarkdownBlock` is structurally
                // `Equatable`, SwiftUI can skip re-invoking `body` — and so
                // skip rebuilding `InlineText.attributed` — for every block
                // whose content, `isFirst` and `trailingCaret` didn't
                // actually change from the previous render.
                .equatable()
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
private struct MarkdownBlockView: View, Equatable {
    @Environment(\.nexusTheme) private var theme
    let block: MarkdownBlock
    let isFirst: Bool
    var trailingCaret: Bool = false

    // Manual, not synthesized: `@Environment` storage isn't `Equatable`, so
    // auto-synthesis isn't available. Comparing only the three real inputs
    // is also exactly right, not just a workaround — a genuine theme change
    // still re-renders normally, because SwiftUI tracks the `@Environment`
    // read inside `body` independently of this check; `.equatable()` only
    // short-circuits re-invoking `body` when a PARENT re-render produced a
    // structurally identical view for the same `ForEach` identity, which is
    // exactly the "only the tail block changed" case during streaming.
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.block == rhs.block && lhs.isFirst == rhs.isFirst && lhs.trailingCaret == rhs.trailingCaret
    }

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
            // 3pt, not `Space.xs` (4pt): the caret should read as glued to
            // the last character it's riding the baseline of, not spaced
            // from it like two separate controls — a typographic detail
            // rather than a "gap between UI elements" the `Space` scale is
            // for, so it's deliberately a hair tighter than any `Space` stop.
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
            VStack(alignment: .leading, spacing: Space.xs) {
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
        case .heading: return Self.headingTopSpacing
        case .thematicBreak: return Space.lg
        default: return Space.md
        }
    }

    /// Roughly 1.6x the ordinary inter-block gap (`Space.md`) — a heading
    /// needs noticeably more air above it than below, so it reads as bound
    /// to the content that follows rather than floating between two
    /// paragraphs. `Space` has no stop that lands here directly, so this is
    /// named and derived rather than a bare `Space.lg + 4` at the call site.
    private static let headingTopSpacing = Space.lg + 4
}

// MARK: - Heading

/// A real size/weight ramp, distinct from body copy at every step — but built
/// entirely from sizes/weights `DesignSystem.swift` already defines and uses
/// elsewhere, rather than inventing a parallel scale next to it:
/// - `#`  -> `Type.title`      (15/semibold)
/// - `##` -> `Type.heading`    (13/semibold)
/// - `###`/`####` -> `Type.bodyStrong`/`Type.eyebrow`'s own (size, weight),
///   uppercased with the same tracking `SectionHeader` already uses for its
///   label row, since a level-3/4 heading in chat prose reads more like a
///   section label than a title.
private struct HeadingText: View {
    @Environment(\.nexusTheme) private var theme
    let level: Int
    let inline: String

    /// Mirrors `Type.title`/`heading`/`bodyStrong`/`eyebrow`'s own
    /// (size, weight) pairs. `DesignSystem.swift` is off-limits while
    /// `app-themes` is mid-wiring the theme system through it, and `Font` is
    /// opaque — there's no API to read a point size back out of an existing
    /// `Type.*` value — so these are named to make the correspondence to
    /// each `Type` stop explicit rather than restating unlabeled numbers.
    private enum Scale {
        static let h1: (size: CGFloat, weight: Font.Weight) = (15, .semibold)  // Type.title
        static let h2: (size: CGFloat, weight: Font.Weight) = (13, .semibold)  // Type.heading
        static let h3: (size: CGFloat, weight: Font.Weight) = (13, .medium)    // Type.bodyStrong
        static let h4: (size: CGFloat, weight: Font.Weight) = (11, .semibold)  // Type.eyebrow
    }

    var body: some View {
        switch level {
        case 1:
            let s = Scale.h1
            InlineText(inline, size: s.size, weight: s.weight, lineSpacing: 2, color: theme.color(\.textPrimary))
        case 2:
            let s = Scale.h2
            InlineText(inline, size: s.size, weight: s.weight, lineSpacing: 2, color: theme.color(\.textPrimary))
        case 3:
            let s = Scale.h3
            InlineText(inline, size: s.size, weight: s.weight, lineSpacing: 2, color: theme.color(\.textMuted))
                .tracking(0.5)
                .textCase(.uppercase)
        default:
            let s = Scale.h4
            InlineText(inline, size: s.size, weight: s.weight, lineSpacing: 2, color: theme.color(\.textMuted))
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
        VStack(alignment: .leading, spacing: Space.sm) {
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
                    MarkdownBlockView(block: block, isFirst: index == 0).equatable()
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
                    MarkdownBlockView(block: block, isFirst: index == 0).equatable()
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
        VStack(alignment: .leading, spacing: Space.xs) {
            if let language = code.language {
                Text(language.uppercased())
                    .textStyle(Type.micro)
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
        // `textPrimary`, not `textSecondary` — carried over from the old
        // plain-`Text(turn.text)` path, where secondary made some sense as a
        // "this is machine output" cue. It doesn't for a typeset answer:
        // washing out the ENTIRE body of every long-form reply is the
        // opposite of what "make it readable" asked for. Headings already
        // pass their own explicit `color:`, so this only affects the
        // fallback body/list/blockquote path.
        let baseColor = color ?? contextColor ?? theme.color(\.textPrimary)
        let linkColor = theme.color(\.textLink)

        for run in result.runs {
            let range = run.range
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    // Scaled relative to the CONTEXT it's in, not pinned to
                    // one flat size — `Type.monoMicro` (10.5pt) was fine for
                    // 13pt body text but tiny and off-baseline inside a 15pt
                    // H1. One step down from the surrounding size, floored at
                    // the documented 10pt minimum, keeps it legibly smaller
                    // than its context everywhere without ever going
                    // unreadable.
                    result[range].font = .system(size: max(size - 2, 10), design: .monospaced)
                    // `surfaceInset` on `surfaceBase` measured 1.02-1.07:1 —
                    // both this theme's near-black surface tokens are only a
                    // couple of RGB steps apart, so ANY flat surface-ladder
                    // token reads as invisible here (verified: `surfaceRaised`
                    // 1.12:1, `surfaceOverlay` 1.24:1 — none of them fix it).
                    // A translucent wash of `textPrimary` — the color THIS
                    // theme already chose to contrast maximally against its
                    // own surface — composites to ~2.4:1 against the page on
                    // nexus-noir and ~1.9:1 on paper-nexus, a real, measured,
                    // multiple-times improvement, and it's theme-adaptive by
                    // construction rather than a hardcoded hex tuned to one
                    // palette. Code text itself stays comfortably legible
                    // against the resulting chip (6.8:1 nexus-noir, 8.1:1
                    // paper-nexus — both well clear of the 4.5:1 AA floor).
                    result[range].backgroundColor = theme.color(\.textPrimary).opacity(0.3)
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
