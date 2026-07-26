import SwiftUI
import NexusKit

/// The design system.
///
/// The first pass had no scales — every view picked its own padding, font size
/// and radius, which is exactly why it read as flat and unfinished. Sizes here
/// are a deliberate ramp rather than arbitrary numbers, so density is consistent
/// and hierarchy is legible at a glance.

enum Space {
    /// Hairline gaps inside a control.
    static let xs: CGFloat = 4
    /// Between tightly-related elements (icon ↔ label).
    static let sm: CGFloat = 8
    /// Default gap inside a card.
    static let md: CGFloat = 12
    /// Between cards.
    static let lg: CGFloat = 18
    /// Page gutters.
    static let xl: CGFloat = 26
    /// Around hero/empty states.
    static let xxl: CGFloat = 44
}

enum Radius {
    static let control: CGFloat = 7
    static let card: CGFloat = 12
    static let panel: CGFloat = 16
    static let pill: CGFloat = 999
}

/// One typographic ramp. Weight and size move together so hierarchy survives
/// even in a monochrome theme.
enum Kind {
    static let hero = Font.system(size: 25, weight: .semibold, design: .rounded)
    static let title = Font.system(size: 15, weight: .semibold)
    static let section = Font.system(size: 11, weight: .semibold, design: .rounded)
    static let body = Font.system(size: 13, weight: .regular)
    static let bodyEmphasis = Font.system(size: 13, weight: .medium)
    static let caption = Font.system(size: 11, weight: .regular)
    static let micro = Font.system(size: 9.5, weight: .semibold, design: .rounded)
    static let mono = Font.system(size: 11.5, design: .monospaced)
    static let monoSmall = Font.system(size: 10, design: .monospaced)
}

extension NexusTheme {
    /// Shadow tuned per theme mode: a dark UI needs depth from a darker, wider
    /// shadow, while a light UI needs a tighter, softer one or it looks muddy.
    var cardShadow: (color: Color, radius: CGFloat, y: CGFloat) {
        isDark
            ? (Color.black.opacity(0.42), 14, 5)
            : (Color.black.opacity(0.09), 9, 3)
    }

    /// A soft accent wash used behind hero moments.
    var accentGlow: RadialGradient {
        RadialGradient(
            colors: [color(\.accentDefault).opacity(isDark ? 0.20 : 0.13), .clear],
            center: .center,
            startRadius: 2,
            endRadius: 190
        )
    }

    /// Vertical wash that lifts a surface off the page without a hard edge.
    func surfaceWash(_ top: KeyPath<ThemeTokens, String>, _ bottom: KeyPath<ThemeTokens, String>) -> LinearGradient {
        LinearGradient(
            colors: [color(top), color(bottom)],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

/// A raised card. The single elevation primitive — views should not roll their
/// own background+border+shadow combinations.
struct Card<Content: View>: View {
    @Environment(\.nexusTheme) private var theme
    var padding: CGFloat = Space.md
    var radius: CGFloat = Radius.card
    var elevated = true
    @ViewBuilder var content: Content

    var body: some View {
        let shadow = theme.cardShadow
        content
            .padding(padding)
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(theme.color(\.surfaceRaised))
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
            }
            .shadow(
                color: elevated ? shadow.color : .clear,
                radius: elevated ? shadow.radius : 0,
                y: elevated ? shadow.y : 0
            )
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

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased())
                    .font(Kind.section)
                    .tracking(0.7)
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

    var body: some View {
        HStack(spacing: 5) {
            Text(label.uppercased())
                .font(Kind.micro)
                .tracking(0.5)
                .foregroundStyle(theme.color(\.textMuted).opacity(0.8))
            Text(value)
                .font(Kind.monoSmall)
                .foregroundStyle(emphasis ? theme.color(\.accentDefault) : theme.color(\.textSecondary))
                .monospacedDigit()
        }
        .fixedSize()
    }
}

/// A button that reads as a real control: hover feedback, pressed state, and a
/// focus-visible border. The first pass used `.buttonStyle(.plain)` everywhere,
/// which is why nothing felt clickable.
struct SoftButton: ButtonStyle {
    @Environment(\.nexusTheme) private var theme
    var tone: Tone = .neutral
    var size: Size = .regular

    enum Tone { case neutral, accent, danger }
    enum Size { case compact, regular }

    @State private var hovering = false

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
            .background(background.opacity(hovering ? 1 : 0.82), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .foregroundStyle(foreground)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(
                        tone == .neutral ? theme.color(\.chromeBorderSubtle) : .clear,
                        lineWidth: 1
                    )
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
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
                Image(systemName: icon)
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(theme.color(\.accentDefault))
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
