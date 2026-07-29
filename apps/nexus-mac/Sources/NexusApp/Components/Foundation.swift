import SwiftUI
import NexusKit

/// The visual language.
///
/// This file replaces a thesis that failed four review rounds. The old one
/// ("instrument, not chat toy": ration the accent to three uses, hairlines
/// never shadows, restraint everywhere) was not wrong about taste — Linear
/// runs a near-identical rulebook — but it was incomplete in a way that
/// guaranteed the result. **Restraint only reads as expensive when there is
/// something underneath it to restrain.** Linear looks costly because beneath
/// the restraint sit a display face tracked to -3px, a 96px section rhythm,
/// and a surface ladder whose steps are genuinely visible. The old thesis
/// copied the subtractions and none of the substance, so what shipped was not
/// restrained, it was *empty* — which is exactly the word the owner keeps
/// reaching for.
///
/// So this language ADDS. Three mechanisms carry it:
///
/// 1. **Type earns its scale.** The old ramp topped out at one 28pt hero per
///    screen with everything else at 11–13pt and default tracking, so there
///    was no editorial contrast anywhere. Here the scale is used top to
///    bottom, display sizes carry negative tracking (the single most reliable
///    "this was designed" signal in a UI face), UI labels sit at `.medium`
///    rather than `.regular` — the weight Linear's own system is most
///    recognised for — and transcript prose moves to 15pt on generous
///    leading, because that is the surface a user reads all day and 13pt with
///    default leading is why it read as a debug dump.
///
/// 2. **Depth is lit, not merely stacked.** Surfaces still rise by luminance,
///    but a raised surface now also carries a specular top edge (see
///    `Depth.specular`) — the bright 1px line real material shows where it
///    turns toward the light. It is not the "cheap glow" that was rejected
///    before: a glow is a coloured halo bled around an element to make it
///    shout, this is an achromatic one-pixel edge that only describes the
///    surface's own geometry.
///
/// 3. **Colour says who answered.** The one thing this product knows that no
///    other chat app does is provenance — which backend replied, on what
///    model, at what cost. Those identity colours already existed as tokens
///    and were used in exactly two places. Here they become the app's
///    signature (see `ProviderIdentity`), which is also what stops the result
///    from being a Linear tribute act: it is the one axis where NexusCode has
///    more to say than its references do.
///
/// What is deliberately KEPT from the old thesis, because it was independently
/// re-derived rather than inherited: one structural accent per theme, used for
/// selection / focus / primary action / live state and nothing decorative; a
/// bounded content region rather than full-bleed text; and determinism (no
/// `UUID()` or clock reads in derived view state).

// MARK: - Type

/// A complete text style — face, tracking and leading in one value.
///
/// Tracking and line spacing are the two properties the previous system had
/// no way to express: the previous ramp (`Kind`, now deleted) handed back a
/// bare `Font`, so every call site got
/// SwiftUI's defaults, and default tracking at 28pt is the difference between
/// "a headline" and "some big text". Bundling all three means a style is
/// applied as one decision instead of three that drift apart.
struct TextStyle {
    let font: Font
    var tracking: CGFloat = 0
    var lineSpacing: CGFloat = 0
}

extension View {
    /// Applies a `TextStyle`'s face, tracking and leading together.
    func textStyle(_ style: TextStyle) -> some View {
        self.font(style.font)
            .tracking(style.tracking)
            .lineSpacing(style.lineSpacing)
    }
}

/// The type ramp.
///
/// Sizes stay anchored to real macOS metrics (Body 13, Title3 15, Title2 17,
/// Title1 22) rather than invented ones — that part of the old system was
/// correct and survives. What changes is that the ramp is now USED across its
/// full range, and that the large end is tracked negatively: at 32pt, SwiftUI's
/// default letter spacing reads loose and amateur, and −0.9 is what makes the
/// same string read as typeset.
enum Type {
    /// The one big statement per screen. Tracked hard — this is where the
    /// "designed vs. default" difference is most visible.
    static let display = TextStyle(font: .system(size: 32, weight: .bold), tracking: -0.9)
    /// A screen's own name.
    static let title = TextStyle(font: .system(size: 20, weight: .semibold), tracking: -0.4)
    /// A heading inside a screen.
    static let heading = TextStyle(font: .system(size: 15, weight: .semibold), tracking: -0.15)

    /// Transcript and long-form reading, the one style tuned for sustained
    /// reading rather than glanceability: 15pt with 5.5pt extra leading lands
    /// near the 1.55 line-height that every long-form source converges on,
    /// and matches the register Claude and ChatGPT both read at. The old
    /// 13pt/default-leading body is the single biggest reason the transcript
    /// felt like output rather than writing.
    static let prose = TextStyle(font: .system(size: 15), tracking: -0.05, lineSpacing: 5.5)

    /// Dense UI text — rows, values, secondary content.
    static let body = TextStyle(font: .system(size: 13))
    /// A control's own name. `.medium`, not `.regular`: the half-step between
    /// regular and semibold is what makes a label read as deliberate without
    /// the density of a true bold, and it is the most-copied single decision
    /// in Linear's type system.
    static let label = TextStyle(font: .system(size: 12, weight: .medium))
    /// Metadata, hints, timestamps.
    static let caption = TextStyle(font: .system(size: 11.5))
    /// A small tracked all-caps label introducing a group. Uppercasing is the
    /// caller's job (`Text(x.uppercased())`) so the string stays readable to
    /// VoiceOver in its original case where that matters.
    static let eyebrow = TextStyle(font: .system(size: 10.5, weight: .semibold), tracking: 0.8)

    /// The smallest sans label — badge text, pill contents, inline markers.
    ///
    /// Distinct from `monoMicro`, which is the same size but MONOSPACED. They
    /// are easy to conflate and doing so is not cosmetic: collapsing this into
    /// `monoMicro` during the migration silently turned 22 sans labels
    /// (`CountPill` contents, status markers, key hints) into monospaced ones.
    /// Machine output gets mono; a badge that says "expires ~7h" is prose.
    static let micro = TextStyle(font: .system(size: 10.5, weight: .semibold))

    /// Literal machine output only — the `nexus` command line, model ids, raw
    /// JSON, diffs. Never plain English control copy, which is the "terminal
    /// wearing a window" failure.
    static let mono = TextStyle(font: .system(size: 12, design: .monospaced))
    /// 10.5pt is the readable floor this app allows; nothing goes below it.
    static let monoMicro = TextStyle(font: .system(size: 10.5, weight: .medium, design: .monospaced))
}

// MARK: - Space

/// Spacing, on the AppKit HIG baseline (6pt within a group, 8pt between
/// groups, 20pt window margins).
///
/// The scale itself is NOT the problem this redesign is fixing and is kept:
/// 4/6/8/12/20/32 is well-grounded and swapping 6 for 8 would not make
/// anything read as modern. What was missing is the LARGE end — with nothing
/// between 20 and 32, every screen had to choose between cramped and
/// cavernous, which is why the app reads as tight chrome around enormous dead
/// canvas. `section` and `page` are the steps that were absent.
enum Space {
    /// Optical nudges inside a control.
    static let xxs: CGFloat = 2
    /// Hairline gaps inside a control.
    static let xs: CGFloat = 4
    /// Between stacked controls in the same group (HIG: 6pt).
    static let sm: CGFloat = 6
    /// Between distinct control groups (HIG: 8pt).
    static let md: CGFloat = 8
    /// Inside a card.
    static let lg: CGFloat = 12
    /// Window margin (HIG: 20pt).
    static let xl: CGFloat = 20
    /// Between hero elements.
    static let xxl: CGFloat = 32
    /// Between distinct SECTIONS of one screen — the step that did not exist.
    static let section: CGFloat = 28
    /// The generous outer margin a content page gets at wide window sizes.
    static let page: CGFloat = 40
    /// Between whole conversation turns. A turn boundary is the largest
    /// structural break the transcript has, and it needs to outrank every gap
    /// inside a turn by a clear margin or the transcript reads as one wall.
    static let turn: CGFloat = 34
}

enum Radius {
    /// Buttons, fields, chips.
    static let control: CGFloat = 7
    /// Cards, rows, the user's own turn in the transcript.
    static let card: CGFloat = 11
    /// Sheets, popovers, and the one large framing element per screen.
    static let panel: CGFloat = 16
    static let pill: CGFloat = 999
}

// MARK: - Motion

/// Motion communicates a state change and nothing else.
///
/// Kept deliberately small — four durations, no springs. A spring on a
/// developer tool's dismissal is what makes it feel like a toy; Linear and
/// Warp both read as instant because nothing moves that does not have to.
/// What is new versus the old thesis is `enter`: content arriving (a turn, a
/// screen) now rises 6pt as it fades in, which is the difference between a UI
/// that redraws and one that responds.
enum Motion {
    /// Hover and press feedback on real controls.
    static let state = Animation.easeOut(duration: 0.12)
    /// Content arriving — a new turn, a screen change.
    static let enter = Animation.easeOut(duration: 0.18)
    /// A sheet or popover appearing or dismissing.
    static let overlay = Animation.easeOut(duration: 0.22)
    /// How far content rises as it enters.
    static let enterOffset: CGFloat = 6
}

// MARK: - Depth

/// The depth model: luminance stacking plus a specular top edge.
///
/// A dark UI has no overhead light to cast a shadow downward, so elevation
/// cannot be expressed the way it is on a white canvas — a drop shadow over
/// near-black renders as a grey smudge, which this project has already
/// reverted once and which stays banned for surfaces at rest. Elevation is
/// therefore carried by two things:
///
/// * **Luminance** — each rung is measurably lighter than the one below it.
/// * **A specular edge** — the 1px line along a raised surface's TOP where it
///   turns toward the ambient light. This is the mechanism the old system was
///   missing entirely, and it is the one that separates a dark UI that looks
///   like real material from one that looks like flat swatches. It is
///   achromatic and one pixel tall, so it cannot become the coloured halo the
///   owner rejected.
///
/// A light theme has the opposite physics — a raised white surface is defined
/// by the shadow it casts, not by a highlight — so `specular` returns a
/// bottom-weighted dark edge there instead, rather than a white line that
/// would be invisible on white.
enum Depth {
    /// The specular border for a raised surface: bright at the top edge,
    /// falling off to the level's own border colour by the bottom.
    ///
    /// `strength` scales the highlight for how raised the surface is — a
    /// popover floating over everything catches more light than a row lifting
    /// slightly off its list.
    static func specular(_ theme: AppTheme, level: Int, strength: Double = 1) -> LinearGradient {
        let border = theme.elevation.step(level).borderColor
        if theme.isDark {
            return LinearGradient(
                stops: [
                    .init(color: .white.opacity(0.11 * strength), location: 0),
                    .init(color: .white.opacity(0.030 * strength), location: 0.30),
                    .init(color: border, location: 0.75),
                    .init(color: border, location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        return LinearGradient(
            stops: [
                .init(color: border, location: 0),
                .init(color: border, location: 0.55),
                .init(color: .black.opacity(0.06 * strength), location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

/// A surface at a given rung of the ladder: fill, specular edge, and (only
/// where the theme asks for one) a contact shadow.
///
/// Every background+border pair in the app goes through this, so a surface
/// declares *how elevated it is* rather than naming a token and hoping it
/// reads right beside its neighbours — the same intent the old `Card` had,
/// generalised to any shape and any level, and now carrying the specular edge
/// automatically.
struct SurfaceStyle: ViewModifier {
    @Environment(\.nexusTheme) private var theme
    let level: Int
    var radius: CGFloat = Radius.card
    /// Scales the specular highlight. A large calm panel wants less of it
    /// than a small floating control.
    var specularStrength: Double = 1
    /// Whether to draw the border at all. A surface that meets its
    /// neighbours edge-to-edge (a full-bleed bar) wants the fill without a
    /// rectangle drawn around it.
    var bordered: Bool = true

    private var step: ElevationStep { theme.elevation.step(level) }

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(step.surfaceColor)
            }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                if bordered {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(Depth.specular(theme, level: level, strength: specularStrength), lineWidth: 1)
                }
            }
            .shadow(color: shadow.color, radius: shadow.radius, y: shadow.y)
    }

    /// Explicitly zeroed rather than trusted to draw nothing at
    /// `opacity(0)` — the house convention, kept from the previous system.
    /// Shadows survive here only for the themes that opted into one on
    /// purpose (Cinder, Nightfall render real material over it) and for light
    /// themes, where a cast shadow is the correct and uncontroversial physics.
    private var shadow: (color: Color, radius: CGFloat, y: CGFloat) {
        guard step.shadowOpacity > 0 else { return (.clear, 0, 0) }
        return (.black.opacity(step.shadowOpacity), step.shadowRadius, step.shadowRadius * 0.35)
    }
}

extension View {
    /// Renders this content as a surface at `level` of the theme's ladder.
    func surface(_ level: Int, radius: CGFloat = Radius.card, specular: Double = 1, bordered: Bool = true) -> some View {
        modifier(SurfaceStyle(level: level, radius: radius, specularStrength: specular, bordered: bordered))
    }
}

// MARK: - Speaker slab

/// The user's own turn in the transcript: raised on dark, recessed on light.
///
/// The single treatment that cannot be shared between the two modes, because
/// the ladder is not symmetric. On a dark theme a raised surface is lighter
/// than its canvas and there is plenty of room upward. On BOTH light themes,
/// `elevation.level1` and `level2` are the identical `#FFFFFF` — the canvas is
/// already pure white, so "raised" has nowhere to go, and a level-2 slab
/// rendered white-on-white separated only by a hairline. That is the light-mode
/// mirror of the material inversion this redesign started with: a structural
/// gap in the ladder, not a styling preference.
///
/// Light themes do have room DOWNWARD (`surfaceInset` is `#F3EDE3` on Daylight,
/// `#EEF0F2` on Studio against a white canvas), so on light the slab recesses
/// instead. This is not a compromise — it is the convention Claude and ChatGPT
/// both use in light mode, and it is the correct physics either way: the block
/// reads as a distinct speaker by stepping off the canvas, in whichever
/// direction that mode actually affords.
struct SpeakerSlab: ViewModifier {
    @Environment(\.nexusTheme) private var theme

    func body(content: Content) -> some View {
        if theme.isDark {
            content.surface(2, radius: Radius.card, specular: 0.9)
        } else {
            content
                .background {
                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                        .fill(theme.color(\.surfaceInset))
                }
                .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                        .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                }
        }
    }
}

// MARK: - Page measure

extension View {
    /// Caps a settings-style page's content to a readable measure and pins it
    /// to the leading edge.
    ///
    /// At 1440pt every list screen stretched its cards edge to edge, so a
    /// provider row with ~400pt of content drew a 1600pt rectangle with a
    /// trailing button stranded a screen-width away from the label it belongs
    /// to. Full-bleed is right for a transcript (which fills its measure) and
    /// wrong for forms and lists (which do not).
    ///
    /// Leading-aligned rather than centred: the page header above it starts at
    /// the window's left margin, and centring the body under a left-aligned
    /// title makes the two read as unrelated layouts.
    func pageMeasure(_ width: CGFloat = 900) -> some View {
        frame(maxWidth: width, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Provider identity

/// Which backend answered, as a colour.
///
/// This is the app's signature. NexusCode's whole reason to exist is that
/// many providers are interchangeable behind one surface — so "who answered"
/// is the highest-value fact on screen, and it is the one thing a generic
/// chat UI has no need to express. Per-provider tokens
/// (`providerAnthropic`, `providerOpenai`, …) have existed in every theme
/// since the theme model was written and were referenced in exactly two
/// places; everywhere else provenance was rendered as grey text.
///
/// Following Raycast's rule — colour belongs to category identity, never to
/// structural chrome — these hues are allowed anywhere provenance is shown
/// and nowhere else. They cannot collide with the structural accent's meaning
/// ("this is live / yours to act on") because they never appear on a control.
///
/// Centralised here rather than duplicated per feature: `ConversationView`
/// and `SessionsView` each had their own copy of this switch, already drifting
/// (one handled `grok`, the other did not).
enum ProviderIdentity {
    /// The identity colour for a provider id or kind string. Unrecognised
    /// values get the generic "custom" token rather than a guess, so a local
    /// or future backend still reads as *a* provider instead of falling back
    /// to grey.
    static func color(_ name: String?, theme: AppTheme) -> Color {
        guard let name else { return theme.color(\.providerCustom) }
        switch normalised(name) {
        case "anthropic", "claude", "claude-code": return theme.color(\.providerAnthropic)
        case "openai", "codex", "gpt": return theme.color(\.providerOpenai)
        case "google", "gemini", "vertex": return theme.color(\.providerGoogle)
        case "xai", "grok": return theme.color(\.providerXai)
        case "ollama", "lmstudio", "vllm", "local": return theme.color(\.providerOllama)
        case "mistral": return theme.color(\.providerMistral)
        case "deepseek": return theme.color(\.providerDeepseek)
        case "bedrock", "aws": return theme.color(\.providerCustom)
        default: return theme.color(\.providerCustom)
        }
    }

    /// Reduces `claude-code`, `anthropic/claude-opus-5` and `Anthropic` to one
    /// comparable key. Matching on the raw string is what let the two previous
    /// copies of this logic disagree.
    private static func normalised(_ name: String) -> String {
        let head = name.lowercased().split(separator: "/").first.map(String.init) ?? name.lowercased()
        return head.trimmingCharacters(in: .whitespaces)
    }
}

/// The provider's identity mark: a filled dot, sized for the line it sits on.
///
/// Deliberately a dot rather than a per-provider glyph or logo — a logo would
/// have to be shipped, licensed, and redrawn per theme, and at 11pt would read
/// as noise. A colour-coded dot is legible at any size and inherits the
/// theme's own palette, so it stays coherent across all 23 themes for free.
struct ProviderDot: View {
    @Environment(\.nexusTheme) private var theme
    let provider: String?
    var size: CGFloat = 6

    var body: some View {
        Circle()
            .fill(ProviderIdentity.color(provider, theme: theme))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
