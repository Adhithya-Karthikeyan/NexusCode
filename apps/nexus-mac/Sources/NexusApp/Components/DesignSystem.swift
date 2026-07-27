import SwiftUI
import NexusKit

/// The design system.
///
/// The first pass had no scales — every view picked its own padding, font size
/// and radius, which is exactly why it read as flat and unfinished. Sizes here
/// are a deliberate ramp rather than arbitrary numbers, so density is consistent
/// and hierarchy is legible at a glance.

/// Spacing, on the AppKit HIG baseline: 6pt within a group, 8pt between
/// groups, 20pt window margins. The first pass invented its own ramp (4/8/12/
/// 18/26/44), which is why density never matched native chrome.
enum Space {
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
    /// Around hero states.
    static let xxl: CGFloat = 32
}

enum Radius {
    /// Buttons, fields.
    static let control: CGFloat = 6
    /// Cards, panels.
    static let card: CGFloat = 10
    /// Sheets, popovers.
    static let panel: CGFloat = 14
    static let pill: CGFloat = 999
}

/// The macOS system type scale.
///
/// macOS has FIXED text styles (no Dynamic Type), and the real metrics are
/// Body 13/16, Headline 13 bold, Title3 15, Title2 17, Title1 22, LargeTitle 26,
/// with 10pt the readable floor. The first pass used invented sizes, which is
/// why nothing sat right next to native controls.
enum Kind {
    static let hero = Font.system(size: 22, weight: .semibold)
    static let title = Font.system(size: 15, weight: .semibold)
    static let headline = Font.system(size: 13, weight: .semibold)
    static let section = Font.system(size: 11, weight: .semibold)
    static let body = Font.system(size: 13, weight: .regular)
    static let bodyEmphasis = Font.system(size: 13, weight: .medium)
    static let caption = Font.system(size: 11, weight: .regular)
    /// 10pt is the documented minimum readable size on macOS — never go below.
    static let micro = Font.system(size: 10, weight: .semibold)
    static let mono = Font.system(size: 12, design: .monospaced)
    static let monoSmall = Font.system(size: 10.5, design: .monospaced)
}

extension NexusTheme {
    /// The hairline that separates one surface from another.
    ///
    /// Depth in a dark tool UI comes from a LADDER OF SURFACE COLOURS plus a 1px
    /// border — not from drop shadows. Shadows over a near-black canvas read as
    /// grey smudge and are the main reason the first pass looked flat rather
    /// than layered. A light theme still needs a slightly stronger edge to
    /// separate two near-white surfaces.
    var hairline: Color {
        isDark
            ? Color.white.opacity(0.09)
            : Color.black.opacity(0.11)
    }

    /// A restrained wash for the one hero moment per screen. Accent is
    /// load-bearing (selection, focus, primary action) — it is not decoration,
    /// so this stays subtle and is used sparingly.
    var accentGlow: RadialGradient {
        RadialGradient(
            colors: [color(\.accentDefault).opacity(isDark ? 0.10 : 0.07), .clear],
            center: .center,
            startRadius: 2,
            endRadius: 150
        )
    }
}

/// A raised card. The single elevation primitive — views should not roll their
/// own background+border+shadow combinations.
///
/// Backed by `AppTheme.elevation` rather than picking a surface token by
/// hand: `elevated` selects level 2 (an overlay-like surface — a card that
/// must float above an already-raised one, such as a popover's content) over
/// level 1 (a card resting directly on the base surface). Level 2 also picks
/// up that theme's `materials.overlay` treatment and its per-level shadow, so
/// a theme like Basalt or Vantage that rejects shadows in favour of the
/// colour ladder alone renders one, and a theme like Nightfall that wants
/// real glass on its overlays renders that instead — neither is special-cased
/// here.
struct Card<Content: View>: View {
    @Environment(\.nexusTheme) private var theme
    var padding: CGFloat = Space.lg
    var radius: CGFloat = Radius.card
    var elevated = false
    @ViewBuilder var content: Content

    private var app: AppTheme { theme.appTheme }
    private var step: ElevationStep { app.elevation.step(elevated ? 2 : 1) }
    private var treatment: SurfaceTreatment { elevated ? app.materials.overlay : .solid }

    var body: some View {
        content
            .padding(padding)
            .background {
                // `.continuous` curvature: the squircle every native control
                // uses. A plain `cornerRadius` reads subtly wrong beside system
                // chrome.
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(step.surfaceColor)
                    .overlay {
                        if let material = treatment.material {
                            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(material)
                        }
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(step.borderColor, lineWidth: 1)
            }
            .shadow(color: .black.opacity(step.shadowOpacity), radius: step.shadowRadius, y: step.shadowRadius * 0.3)
    }
}

/// A section heading with an optional trailing count.
struct SectionHeader: View {
    @Environment(\.nexusTheme) private var theme
    let title: String
    var subtitle: String?
    var accessory: AnyView?

    init(_ title: String, subtitle: String? = nil, accessory: AnyView? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory
    }

    /// Typography intent is the one theme dimension that isn't a colour:
    /// a tool-forged theme (Basalt, Vantage) reads tighter and leans
    /// monospaced for scanability; an editorial theme (Daylight, Nightfall)
    /// opens up a little. Neutral keeps the number this file always used.
    private var font: Font {
        theme.appTheme.typography == .toolForged
            ? .system(size: 11, weight: .semibold, design: .monospaced)
            : Kind.section
    }

    private var tracking: Double {
        switch theme.appTheme.typography {
        case .toolForged: return 0.4
        case .neutral: return 0.7
        case .editorial: return 1.0
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased())
                    .font(font)
                    .tracking(tracking)
                    .foregroundStyle(theme.color(\.textMuted))
                if let subtitle {
                    Text(subtitle)
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted).opacity(0.75))
                }
            }
            Spacer(minLength: 0)
            accessory
        }
    }
}

/// A count badge.
struct CountPill: View {
    @Environment(\.nexusTheme) private var theme
    let text: String
    var tone: Tone = .accent

    enum Tone { case accent, neutral, warning, danger }

    private var colors: (bg: Color, fg: Color) {
        switch tone {
        case .accent: return (theme.color(\.accentMuted), theme.color(\.accentFg))
        case .neutral: return (theme.color(\.surfaceOverlay), theme.color(\.textSecondary))
        case .warning: return (theme.color(\.warningBg), theme.color(\.warningFg))
        case .danger: return (theme.color(\.errorBg), theme.color(\.errorFg))
        }
    }

    var body: some View {
        Text(text)
            .font(Kind.micro)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(colors.bg, in: Capsule())
            .foregroundStyle(colors.fg)
    }
}

/// The animated activity dot. Pulses only while genuinely running, so motion
/// always means something.
struct StatusDot: View {
    @Environment(\.nexusTheme) private var theme
    let isRunning: Bool
    let isFailed: Bool
    var size: CGFloat = 8
    var animate = true

    @State private var pulse = false

    private var color: Color {
        if isFailed { return theme.color(\.errorFg) }
        return isRunning ? theme.color(\.accentDefault) : theme.color(\.textMuted)
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: isRunning ? color.opacity(0.7) : .clear, radius: 5)
            .overlay {
                if isRunning && animate {
                    Circle()
                        .stroke(color.opacity(0.5), lineWidth: 1.5)
                        .scaleEffect(pulse ? 2.6 : 1)
                        .opacity(pulse ? 0 : 0.9)
                }
            }
            .onAppear {
                guard isRunning && animate else { return }
                withAnimation(.easeOut(duration: 1.25).repeatForever(autoreverses: false)) {
                    pulse = true
                }
            }
            .accessibilityLabel(isFailed ? "failed" : (isRunning ? "running" : "idle"))
    }
}

/// A labelled readout for the status bar.
struct Metric: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String
    var emphasis = false
    /// Uses the theme's second accent (`AccentSystem.secondary`) instead of
    /// its primary one — for a readout that must stand out from an
    /// `emphasis: true` metric already on screen (e.g. a live counter next to
    /// a cost total) without the two competing for the same colour.
    var secondary = false

    private var valueColor: Color {
        if secondary { return theme.appTheme.accentSecondary }
        return emphasis ? theme.color(\.accentDefault) : theme.color(\.textSecondary)
    }

    var body: some View {
        HStack(spacing: 5) {
            Text(label.uppercased())
                .font(Kind.micro)
                .tracking(0.5)
                .foregroundStyle(theme.color(\.textMuted).opacity(0.8))
            Text(value)
                .font(Kind.monoSmall)
                .foregroundStyle(valueColor)
                .monospacedDigit()
        }
        .fixedSize()
    }
}

/// A button that reads as a real control: hover feedback, pressed state, and a
/// focus-visible border. The first pass used `.buttonStyle(.plain)` everywhere,
/// which is why nothing felt clickable.
///
/// The hover/pressed opacities used to be two numbers picked by eye (`0.82`,
/// `0.85`) with nothing behind them. They now come from `AppTheme.stateLayers`
/// — a light theme wants a much lighter overlay than a near-black one, or a
/// hover state turns the surface muddy, and that tuning lives with the theme
/// instead of guessed here.
struct SoftButton: ButtonStyle {
    @Environment(\.nexusTheme) private var theme
    var tone: Tone = .neutral
    var size: Size = .regular

    enum Tone { case neutral, accent, danger }
    enum Size { case compact, regular }

    @State private var hovering = false

    private var app: AppTheme { theme.appTheme }

    private var background: Color {
        switch tone {
        case .neutral: return theme.color(\.surfaceOverlay)
        case .accent: return theme.color(\.accentDefault)
        case .danger: return theme.color(\.errorBg)
        }
    }

    private var foreground: Color {
        switch tone {
        case .neutral: return theme.color(\.textSecondary)
        case .accent: return theme.color(\.accentFg)
        case .danger: return theme.color(\.errorFg)
        }
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(size == .compact ? Kind.caption : Kind.bodyEmphasis)
            .padding(.horizontal, size == .compact ? Space.sm : Space.md)
            .padding(.vertical, size == .compact ? 5 : 7)
            .background(
                background.opacity(hovering ? 1 : 1 - app.stateLayers.hover),
                in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            )
            .foregroundStyle(foreground)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(
                        tone == .neutral ? theme.color(\.chromeBorderSubtle) : .clear,
                        lineWidth: 1
                    )
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 1 - app.stateLayers.pressed : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.12), value: hovering)
            .onHover { hovering = $0 }
    }
}

/// Monospaced code/diff block. Scrolls horizontally rather than wrapping, so
/// indentation and diff alignment survive.
struct CodeBlock: View {
    @Environment(\.nexusTheme) private var theme
    let text: String
    var isDiff = false
    var maxHeight: CGFloat? = 260

    private var lines: [(offset: Int, element: String)] {
        Array(text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).enumerated())
    }

    var body: some View {
        ScrollView([.horizontal, .vertical], showsIndicators: true) {
            VStack(alignment: .leading, spacing: 1.5) {
                ForEach(lines, id: \.offset) { line in
                    Text(line.element.isEmpty ? " " : line.element)
                        .font(Kind.monoSmall)
                        .foregroundStyle(color(for: line.element))
                        .textSelection(.enabled)
                }
            }
            .padding(Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: maxHeight)
        .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle).opacity(0.6), lineWidth: 1)
        }
    }

    private func color(for line: String) -> Color {
        guard isDiff else { return theme.color(\.textSecondary) }
        if line.hasPrefix("+") { return theme.color(\.diffAddedFg) }
        if line.hasPrefix("-") { return theme.color(\.diffRemovedFg) }
        if line.hasPrefix("@@") { return theme.color(\.diffGutter) }
        return theme.color(\.diffContext)
    }
}

/// Empty states get a real hero treatment rather than a lonely glyph in a void.
struct HeroEmptyState<Actions: View>: View {
    @Environment(\.nexusTheme) private var theme
    let icon: String
    let title: String
    let message: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: Space.md) {
            ZStack {
                Circle()
                    .fill(theme.accentGlow)
                    .frame(width: 190, height: 190)
                // The one moment per screen that earns the theme's brand
                // gradient rather than its flat accent colour — a hero glyph
                // is exactly the "primary CTA / hero glow" case
                // `GradientSet.accentGradient` exists for.
                Image(systemName: icon)
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(theme.appTheme.accentGradient)
            }
            .frame(height: 150)

            Text(title)
                .font(Kind.hero)
                .foregroundStyle(theme.color(\.textPrimary))

            Text(message)
                .font(Kind.body)
                .foregroundStyle(theme.color(\.textMuted))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 430)
                .fixedSize(horizontal: false, vertical: true)

            actions.padding(.top, Space.sm)
        }
        // Padding BEFORE the flexible frame, never after. `.frame(maxHeight:
        // .infinity).padding(44)` asks for all available space *plus* 88pt,
        // which overflows the enclosing VStack and silently clips its siblings
        // out of the window — that is what made the sidebar, control strip,
        // composer and status bar disappear.
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension HeroEmptyState where Actions == EmptyView {
    init(icon: String, title: String, message: String) {
        self.init(icon: icon, title: title, message: message) { EmptyView() }
    }
}

/// A keyboard-shortcut hint.
struct KeyHint: View {
    @Environment(\.nexusTheme) private var theme
    let keys: String
    let label: String

    var body: some View {
        HStack(spacing: Space.xs) {
            Text(keys)
                .font(Kind.micro)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(theme.color(\.surfaceOverlay), in: RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(theme.color(\.textSecondary))
            Text(label)
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textMuted))
        }
    }
}
