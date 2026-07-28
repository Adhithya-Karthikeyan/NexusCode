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
    /// Sheets, popovers, and `CanvasPanel` — the one large framing element per
    /// screen, so it reads as a single deliberate sheet rather than a bigger
    /// card.
    static let panel: CGFloat = 14
    static let pill: CGFloat = 999
}

/// The macOS system type scale.
///
/// macOS has FIXED text styles (no Dynamic Type), and the real metrics are
/// Body 13/16, Headline 13 bold, Title3 15, Title2 17, Title1 22, LargeTitle 26,
/// with 10pt the readable floor. The first pass used invented sizes, which is
/// why nothing sat right next to native controls.
///
/// `hero`/`title` sit at the BOLD end of that real scale on purpose (Large
/// Title's own weight range, and Title2's exact 17pt rather than Title3's
/// 15) rather than the middle of it: a type scale that never actually uses
/// its own range is the "nearly everything renders at Kind.body" problem
/// `DESIGN.md` names directly — every screen gets exactly one `.hero`/
/// `.title` moment, and it needs to read as one at a glance, not merely
/// technically differ from body text. Timidity here was the documented
/// failure mode of every earlier pass.
enum Kind {
    static let hero = Font.system(size: 28, weight: .bold)
    static let title = Font.system(size: 17, weight: .semibold)
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

/// Same two primitives, for `AppTheme` — kept in lockstep with the
/// `NexusTheme` versions above rather than routed through the bridge, because
/// once `\.nexusTheme` resolves to `AppTheme` directly (see
/// `NexusKit/Theme.swift`) every call site in this file reads `theme.hairline`
/// / `theme.accentGlow` on whichever type the environment actually hands it —
/// and during the transition both types need to answer.
extension AppTheme {
    var hairline: Color {
        isDark
            ? Color.white.opacity(0.09)
            : Color.black.opacity(0.11)
    }

    var accentGlow: RadialGradient {
        RadialGradient(
            colors: [color(\.accentDefault).opacity(isDark ? 0.10 : 0.07), .clear],
            center: .center,
            startRadius: 2,
            endRadius: 150
        )
    }

}

/// Either a flat colour fill or a vibrancy material for `shape` — NEVER both
/// layered. A `Material` blurs whatever is directly behind it; filling a
/// shape with a flat colour and then a material on top of that (what `Card`,
/// `Sidebar` and the composer all did on first pass) blurs the opaque
/// colour — which renders as a flat tinted scrim, never as translucency, and
/// is why a theme's `materials` roles did nothing visible: the material was
/// there, it just had nothing but its own backing colour to show through.
/// A free function rather than a `View` modifier so it drops directly into
/// any `.background { }` closure — including one that still needs its own
/// `.ignoresSafeArea()` or `.clipShape()` applied afterward, which a
/// self-contained modifier can't compose with as cleanly.
@ViewBuilder
func themedFill<S: Shape>(_ color: Color, treatment: SurfaceTreatment, in shape: S) -> some View {
    if let material = treatment.material {
        shape.fill(material)
    } else {
        shape.fill(color)
    }
}

/// A raised card. The single elevation primitive — views should not roll their
/// own background+border+shadow combinations.
///
/// Backed by `AppTheme.elevation` rather than picking a surface token by
/// hand: `elevated` selects level 2 (an overlay-like surface — a card that
/// must float above an already-raised one, such as a popover's content) over
/// level 1 (a card resting directly on the base surface). Level 2 also picks
/// up that theme's `materials.overlay` treatment and its per-level shadow.
///
/// Shadow is guarded on `shadowOpacity > 0` rather than trusted to degrade
/// gracefully at `opacity(0)`: the house rule above (`hairline`'s doc
/// comment) is that depth on a near-black canvas comes from the surface
/// ladder and a border, NOT a shadow — a shadow there reads as grey smudge.
/// The 16 terminal-generated themes were never designed with shadow in mind
/// at all, so `NexusTheme.appTheme`'s generic bridge (`AppTheme.swift`) gives
/// every one of them `shadowOpacity: 0` at every level when dark, full stop.
/// Some of the seven HAND-designed themes here choose non-zero shadow on a
/// dark base anyway — Cinder and Nightfall specifically, both explicitly
/// "glass-forward, showcase" themes where a soft shadow under real material
/// reads as depth rather than smudge (verified by rendering both through the
/// headless harness, not assumed). Basalt and Vantage, by contrast, chose
/// `shadowOpacity: 0` at every level on purpose — this file makes neither
/// choice; the theme does.
struct Card<Content: View>: View {
    @Environment(\.nexusTheme) private var theme
    var padding: CGFloat = Space.lg
    var radius: CGFloat = Radius.card
    var elevated = false
    @ViewBuilder var content: Content

    private var step: ElevationStep { theme.elevation.step(elevated ? 2 : 1) }
    private var treatment: SurfaceTreatment { elevated ? theme.materials.overlay : .solid }

    var body: some View {
        content
            .padding(padding)
            .background {
                // `.continuous` curvature: the squircle every native control
                // uses. A plain `cornerRadius` reads subtly wrong beside system
                // chrome.
                themedFill(step.surfaceColor, treatment: treatment, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            }
            .overlay {
                // Full-strength, level-specific `chromeBorder*` rather than a
                // single flat `hairline` — level 2's border is deliberately
                // stronger than level 1's, which is the ONLY depth cue a
                // shadow-free theme (Basalt, Vantage) has to distinguish the
                // two. `opacity(0.85)` restores hairline's "blends with
                // whatever's around it" quality without collapsing that
                // per-level distinction back to one flat line.
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(step.borderColor.opacity(0.85), lineWidth: 1)
            }
            .shadow(color: shadow.color, radius: shadow.radius, y: shadow.y)
    }

    /// Guarded on `shadowOpacity > 0` rather than trusted to draw nothing at
    /// `opacity(0)` — an explicit `.clear`/zero-radius no-op, not an assumed one.
    private var shadow: (color: Color, radius: CGFloat, y: CGFloat) {
        guard step.shadowOpacity > 0 else { return (.clear, 0, 0) }
        return (.black.opacity(step.shadowOpacity), step.shadowRadius, step.shadowRadius * 0.3)
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
        theme.typography == .toolForged
            ? .system(size: 11, weight: .semibold, design: .monospaced)
            : Kind.section
    }

    private var tracking: Double {
        switch theme.typography {
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

/// The one title moment at the top of an entire screen — distinct from
/// `SectionHeader`, which labels a GROUP *within* a screen.
///
/// Integrations, Git, Tasks and Sessions each opened with a `SectionHeader`
/// as their page identity, and Agents and Accounts had no page title at all
/// — both are the exact "nearly everything renders at section-label size"
/// problem `DESIGN.md` calls out: a whole screen's own name, styled
/// identically to "TRY ASKING" or "WORK," is not a title, it's another
/// subsection label. `Kind.title` here is the one deliberate size/weight
/// jump every screen gets, once.
struct PageHeader: View {
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
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(Kind.title)
                    .foregroundStyle(theme.color(\.textPrimary))
                if let subtitle {
                    Text(subtitle)
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
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
        case .accent:
            // `accentFg` was designed for text on the full-strength
            // `accentDefault` fill, not the muted one — pairing it with
            // `accentMuted` (a tinted wash, not a text/background pair) is
            // what measured at 1.5–3.7:1 across every theme, old and new.
            // `accentMuted` itself is unchanged — other components still get
            // exactly the wash they were designed against — only the label
            // colour is now computed to actually read against it.
            let fg = Color.readableText(on: theme.tokens.accentMuted, preferring: theme.tokens.textPrimary, otherwise: theme.tokens.textInverse)
            return (theme.color(\.accentMuted), fg)
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
        if secondary { return theme.accentSecondary }
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
    // Every `Button` is inherently focusable on macOS, so no explicit
    // `.focusable()` is needed to make this read from the environment —
    // reading it is what was missing. Without it, keyboard focus was
    // invisible on every `SoftButton` outside the composer (which tracks its
    // own focus via `@FocusState` instead, since a `TextField` isn't a
    // `ButtonStyle`).
    @Environment(\.isFocused) private var isFocused

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
                background.opacity(hovering ? 1 : 1 - theme.stateLayers.hover),
                in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            )
            .foregroundStyle(foreground)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(
                        isFocused
                            ? theme.color(\.chromeBorderFocus)
                            : (tone == .neutral ? theme.color(\.chromeBorderSubtle) : .clear),
                        lineWidth: isFocused ? 2 : 1
                    )
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 1 - theme.stateLayers.pressed : 1)
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
                    .foregroundStyle(theme.accentGradient)
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

/// The "nothing to show yet, actively loading" moment.
///
/// Before this, four feature views (`SessionsView`, `GitView`,
/// `IntegrationsView`, and `TasksView`) each hand-rolled the identical
/// `ProgressView` + caption pair, differing only in the message string, and
/// `AuthView` rolled a FIFTH, compact variant for the one spot that shares
/// its frame with a pinned error banner rather than owning the whole screen.
/// Same visual language either way — this is that same "waiting on a
/// `nexus` process" moment, not a different one, so `.inline` changes
/// layout density only, never font or colour.
struct LoadingState: View {
    @Environment(\.nexusTheme) private var theme
    let message: String
    var style: Style = .fullPage

    enum Style {
        /// Centred, fills the container — the screen's ENTIRE content
        /// before anything has loaded. Mirrors `HeroEmptyState`'s own
        /// full-page convention so a screen never has to pick between two
        /// different "nothing here" idioms depending on why there's nothing.
        case fullPage
        /// A compact single row for a spot already sharing space with other
        /// chrome (e.g. pinned below an `InlineBanner`) — no `Spacer`s
        /// claiming the whole frame.
        case inline
    }

    private var caption: some View {
        Text(message)
            .font(Kind.caption)
            .foregroundStyle(theme.color(\.textMuted))
    }

    var body: some View {
        switch style {
        case .fullPage:
            VStack(spacing: Space.sm) {
                ProgressView()
                caption
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .inline:
            HStack(spacing: Space.sm) {
                ProgressView().controlSize(.small)
                caption
            }
        }
    }
}

/// A caveat shown ABOVE still-usable content — never instead of it. The one
/// shared shape for "something didn't work, but here's what's still true": a
/// background refresh that failed, an add/save/sign-out that didn't take.
///
/// Before this, four feature views each rolled their own version — three
/// `warning`-toned, one (`AuthView`) `error`-toned for what was functionally
/// the identical situation, and only one of the four had a dismiss control
/// at all. `IntegrationsView` even said outright it was duplicating
/// `TasksView`'s copy "rather than adding a shared type this task isn't
/// scoped to touch" — this is that type.
///
/// `onDismiss` is REQUIRED, not optional: every real call site this replaces
/// is the same "informational, retryable" shape — real content is already on
/// screen underneath, so nothing is ever blocked on this banner, and leaving
/// dismiss optional is exactly how three of the four call sites quietly
/// ended up without one. A state that genuinely blocks the user (nothing
/// loaded at all) is a structurally different shape — see `ErrorState`
/// below, which has no dismiss because there is nothing left to reveal by
/// dismissing it.
struct InlineBanner: View {
    @Environment(\.nexusTheme) private var theme
    let message: String
    var tone: Tone = .warning
    let onDismiss: () -> Void

    enum Tone { case warning, error }

    private var colors: (fg: Color, bg: Color) {
        switch tone {
        case .warning: return (theme.color(\.warningFg), theme.color(\.warningBg))
        case .error: return (theme.color(\.errorFg), theme.color(\.errorBg))
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10))
                .accessibilityHidden(true)
            Text(message)
                .font(Kind.caption)
                .lineLimit(2)
            Spacer(minLength: Space.sm)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .foregroundStyle(colors.fg)
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(colors.bg.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}

/// The "nothing loaded at all, and here's why" moment — replaces a screen's
/// ENTIRE content when the very first load failed. Unlike `InlineBanner`
/// there is no other content underneath to look at, so unlike that type this
/// is STICKY by construction, not a policy choice: dismissing a blank page
/// would just leave a blanker one. Resolved only by `retry` succeeding.
///
/// Before this, `TasksView` and `SessionsView` each hand-rolled the identical
/// icon + message + Retry button, one of the two missing the hero padding
/// `HeroEmptyState` (the state this sits beside, for the same "nothing to
/// show" moment for a different reason) already uses.
struct ErrorState: View {
    @Environment(\.nexusTheme) private var theme
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: Space.sm) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(theme.color(\.errorFg))
                // The message text right below already says what's wrong —
                // this glyph is decoration, not a second, unlabeled thing to
                // announce.
                .accessibilityHidden(true)
            Text(message)
                .font(Kind.body)
                .foregroundStyle(theme.color(\.textSecondary))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button("Retry", action: retry)
                .buttonStyle(SoftButton(tone: .accent))
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The standard page shell: a header that never scrolls away, and a body
/// that fills every bit of the remaining height.
///
/// Every list-style screen in this app used to stack its header and content
/// inside ONE `ScrollView`. A `ScrollView` always top-aligns its content, so
/// a short empty state or a two-item list renders correctly at the top and
/// then leaves a dead void for the rest of the window — that one missing
/// rule about vertical composition is why every screen with little content
/// read as unfinished. `PageScaffold` fixes it at the root instead of
/// per-view: `content` decides for itself whether it needs to scroll (return
/// a `ScrollView` when there is real data) or should fill and centre (return
/// a `HeroEmptyState`, or a loading/error state, unwrapped) — either way the
/// outer `.frame(maxHeight: .infinity)` here is what makes that choice
/// actually take up the window instead of floating in its top third.
struct PageScaffold<Header: View, Content: View>: View {
    @ViewBuilder var header: Header
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

extension PageScaffold where Header == EmptyView {
    init(@ViewBuilder content: () -> Content) {
        self.init(header: { EmptyView() }, content: content)
    }
}

/// The instrument frame every screen renders inside — level-1 surface, a
/// hairline border on all four sides, inset from the window's own chrome.
///
/// See `DESIGN.md`'s "surface ladder": before this, every screen (chat,
/// agents, sessions, settings…) rendered its content directly on the
/// window's level-0 floor colour, with no edge of its own — which is exactly
/// why wide windows read as text floating in a black void rather than a
/// panel inside an instrument. `RootView` wraps its whole content region in
/// this ONE place, so every screen gets the frame for free without each
/// screen's own view needing to know about it.
///
/// `content` is expected to already fill available space (every screen here
/// does, via its own `.frame(maxWidth: .infinity, maxHeight: .infinity)` /
/// `PageScaffold`) — this view supplies the bounded, finite proposal for it
/// to fill, in place of the window's own unbounded column. `PageScaffold`'s
/// header/content split still lives INSIDE this panel; the panel is the
/// frame, not a second layout region competing with it.
///
/// Modifier order matters and mirrors `HeroEmptyState`'s documented rule:
/// background/border/clip wrap `content` FIRST (sized to whatever `content`
/// fills), `.padding` adds the margin next, and `.frame(maxWidth: .infinity,
/// maxHeight: .infinity)` is OUTERMOST so it claims the full column from
/// `RootView` and hands `content` a reduced-but-still-finite proposal — the
/// same "padding before the flexible frame" shape as `ErrorState`, never
/// padding piled on top of an already-infinite frame.
struct CanvasPanel<Content: View>: View {
    @Environment(\.nexusTheme) private var theme
    @ViewBuilder var content: Content

    private var step: ElevationStep { theme.elevation.step(1) }

    var body: some View {
        content
            .background {
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .fill(step.surfaceColor)
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                    .strokeBorder(step.borderColor, lineWidth: 1)
            }
            .shadow(color: shadow.color, radius: shadow.radius, y: shadow.y)
            .padding(Space.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Same guarded convention as `Card`'s shadow: zero at `shadowOpacity ==
    /// 0` rather than trusted to degrade gracefully — depth here comes from
    /// the surface ladder and the hairline border, not a shadow, for every
    /// theme except the two (Cinder, Nightfall) that opted into one on purpose.
    private var shadow: (color: Color, radius: CGFloat, y: CGFloat) {
        guard step.shadowOpacity > 0 else { return (.clear, 0, 0) }
        return (.black.opacity(step.shadowOpacity), step.shadowRadius, step.shadowRadius * 0.3)
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
