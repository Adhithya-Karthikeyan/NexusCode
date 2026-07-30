import SwiftUI
import NexusKit

/// The shared components, built on the language in `Foundation.swift`.
///
/// Scales (`Space`, `Radius`), the type ramp (`Type`) and the depth model
/// (`Depth`, `SurfaceStyle`) live in that file; this one holds the widgets
/// every screen composes from.

extension Type {
    /// 13pt medium — a row label or an emphasised line of body text. Distinct
    /// from `label` (12pt) which is for a CONTROL's own name.
    static let bodyStrong = TextStyle(font: .system(size: 13, weight: .medium))
}

extension NexusTheme {
    /// The hairline that separates one surface from another.
    var hairline: Color {
        isDark ? Color.white.opacity(0.09) : Color.black.opacity(0.11)
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

extension AppTheme {
    var hairline: Color {
        isDark ? Color.white.opacity(0.09) : Color.black.opacity(0.11)
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

/// A vibrancy material rendered so it cannot invert the surface ladder.
///
/// **This is the fix for the single worst measured defect in the old build.**
/// A material was previously drawn on its own, and `.ultraThinMaterial` over a
/// near-black token on a bright desktop does not render near-black — it
/// renders whatever is behind the window, lightened. Sampling the shipped app
/// at 1440x900 (Meridian): the sidebar, whose token `surfaceSunken` (#08090D)
/// makes it the DARKEST surface in the theme, measured at relative luminance
/// 0.0244 — twice the canvas panel it is supposed to sit beneath (0.0123) and
/// five times the window floor (0.0048). The intended depth order was exactly
/// backwards on screen, which is why the eye went to the chrome and the
/// content read as a hole. No token was wrong; the material was overruling
/// all of them.
///
/// The fix keeps translucency without letting it govern value: the token is the
/// opaque base, and the material sits on top at a few percent purely for its
/// texture and movement. What survives is the faint desktop pickup that makes a
/// Mac app feel native; what does not survive is the material deciding how light
/// the surface is. That belongs to the theme.
///
/// A light theme needs less of it — a light material over a light token is
/// already close to the intended value — so its pass is lighter still.
///
/// Measured afterwards: with the token underneath, the largest material opacity
/// that still keeps every theme's sidebar BEHIND its canvas is about 0.025.
/// That is small enough that the shipped catalogue simply declares `.solid`
/// sidebars (`ThemeCatalog`) and spends translucency only on overlays, which
/// float above everything and so have no ordering to invert. This function
/// stays because that is a theme's decision to make, not this file's.
@ViewBuilder
func themedFill<S: Shape>(_ color: Color, treatment: SurfaceTreatment, in shape: S, isDark: Bool = true) -> some View {
    if let material = treatment.material {
        // Opaque token FIRST, material on top at a token opacity — not the
        // other way round.
        //
        // The previous order (material, then the token at 0.82) left 18% of the
        // rendered value in the desktop's hands, and 18% of a bright wallpaper
        // is enough to bring the documented inversion straight back: composited
        // over white, Storm's sidebar (`#121320`, the DARKEST surface it owns)
        // resolves to roughly `#3D3E4A` — L* 25 against the canvas's L* 11, so
        // the surface furthest back renders as the brightest thing on screen.
        // The fix is not a smaller number of the same kind; it is putting the
        // token underneath, where the desktop can modulate it by a few percent
        // and can never reorder it.
        ZStack {
            shape.fill(color)
            shape.fill(material).opacity(isDark ? 0.06 : 0.04)
        }
    } else {
        shape.fill(color)
    }
}

/// A raised card — one background+border+shadow decision, never rolled by hand.
///
/// Now backed by `SurfaceStyle`, so it picks up the specular top edge every
/// other raised surface has. `elevated` selects level 2 (a card that must
/// float above an already-raised one, e.g. a popover's content) over level 1
/// (a card resting on the base surface).
struct Card<Content: View>: View {
    var padding: CGFloat = Space.lg
    var radius: CGFloat = Radius.card
    var elevated = false
    /// Whether the card stretches to its container's full width.
    ///
    /// Opt-in, not automatic. The unconditional `.frame(maxWidth: .infinity)`
    /// this replaces is why a metrics card with ~200pt of content drew an 800pt
    /// rectangle at a wide window — a card is a container for its contents, and
    /// a card four times wider than what is in it reads as an empty box that
    /// happens to have some text in one corner. A form row or a full-bleed
    /// panel genuinely wants the width and says so.
    var fill = false
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
            .surface(elevated ? 2 : 1, radius: radius, specular: elevated ? 1 : 0.7)
    }
}

/// A section heading with an optional trailing accessory.
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

    /// Typography intent is the one theme dimension that is not a colour: a
    /// tool-forged theme (Mirage, Neon Grid, Ink) leans monospaced for
    /// scanability, an editorial theme (Grove, Moon, Paper, Dawn) opens the
    /// tracking up.
    private var font: Font {
        theme.typography == .toolForged
            ? .system(size: 10.5, weight: .semibold, design: .monospaced)
            : Type.eyebrow.font
    }

    private var tracking: Double {
        switch theme.typography {
        case .toolForged: return 0.5
        case .neutral: return 0.8
        case .editorial: return 1.1
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
                        .textStyle(Type.caption)
                        .foregroundStyle(theme.color(\.textMuted).opacity(0.75))
                }
            }
            Spacer(minLength: 0)
            accessory
        }
        // Capped, because a header spans whatever it is given and a window can
        // be 1900pt wide. Uncapped, the trailing accessory — a "Refresh" button
        // that belongs to the label — ended up stranded most of a screen away
        // from it, which reads as two unrelated controls rather than one group.
        .frame(maxWidth: 640, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The one title moment at the top of a screen — distinct from
/// `SectionHeader`, which labels a GROUP within a screen.
///
/// Owns its own margins and its own bottom hairline, which every call site
/// used to supply by hand — six screens, six slightly different sets of
/// numbers, and no separator on any of them. The effect on screen was that a
/// page title sat as loose text floating above unrelated content, with nothing
/// saying where chrome ended and the page began; on a sparse screen it read as
/// stranded in the top-left corner of a void.
///
/// The hairline matches the one under the chat control strip, so every screen
/// in the app now has the same top edge.
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
        HStack(alignment: .firstTextBaseline, spacing: Space.lg) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .textStyle(Type.title)
                    .foregroundStyle(theme.color(\.textPrimary))
                if let subtitle {
                    Text(subtitle)
                        .textStyle(Type.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            accessory
        }
        .padding(.horizontal, Space.xl)
        .padding(.top, Space.xl)
        .padding(.bottom, Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.hairline).frame(height: 1)
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
            // Computed, never `accentFg` — that token was designed for text on
            // the full-strength accent fill, not on the muted wash, and
            // pairing the two measured 1.5–3.7:1 across every theme.
            let fg = Color.readableText(on: theme.tokens.accentMuted, preferring: theme.tokens.textPrimary, otherwise: theme.tokens.textInverse)
            return (theme.color(\.accentMuted), fg)
        case .neutral: return (theme.color(\.surfaceOverlay), theme.color(\.textSecondary))
        case .warning: return (theme.color(\.warningBg), theme.color(\.warningFg))
        case .danger: return (theme.color(\.errorBg), theme.color(\.errorFg))
        }
    }

    var body: some View {
        Text(text)
            .textStyle(Type.monoMicro)
            .monospacedDigit()
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(colors.bg, in: Capsule())
            .foregroundStyle(colors.fg)
    }
}

/// The activity dot. Pulses only while genuinely running, so motion always
/// means something.
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
    /// Uses the theme's second accent — for a readout that must stand out
    /// from an `emphasis: true` metric already on screen without the two
    /// competing for one colour.
    var secondary = false

    private var valueColor: Color {
        if secondary { return theme.accentSecondary }
        return emphasis ? theme.color(\.accentDefault) : theme.color(\.textSecondary)
    }

    var body: some View {
        HStack(spacing: 5) {
            Text(label.uppercased())
                .textStyle(Type.eyebrow)
                .foregroundStyle(theme.color(\.textMuted).opacity(0.8))
            Text(value)
                .textStyle(Type.monoMicro)
                .foregroundStyle(valueColor)
                .monospacedDigit()
        }
        .fixedSize()
    }
}

/// A button that reads as a real control: hover feedback, pressed state, and a
/// focus-visible border.
struct SoftButton: ButtonStyle {
    @Environment(\.nexusTheme) private var theme
    var tone: Tone = .neutral
    var size: Size = .regular

    enum Tone { case neutral, accent, danger }
    enum Size { case compact, regular }

    @State private var hovering = false
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

    /// The accent tone is the one primary action on screen and is the only
    /// tone that gets a specular edge — a filled accent button is the most
    /// "physical" control in the app and reads as a real, pressable object
    /// with it. Neutral keeps a plain hairline so a tray of secondary buttons
    /// stays quiet.
    @ViewBuilder
    private var border: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
        if isFocused {
            shape.strokeBorder(theme.color(\.chromeBorderFocus), lineWidth: 2)
        } else if tone == .accent && theme.isDark {
            shape.strokeBorder(
                LinearGradient(
                    colors: [.white.opacity(0.28), .white.opacity(0.04)],
                    startPoint: .top, endPoint: .bottom
                ),
                lineWidth: 1
            )
        } else if tone == .neutral {
            shape.strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .textStyle(size == .compact ? Type.caption : Type.bodyStrong)
            .padding(.horizontal, size == .compact ? Space.md : Space.lg)
            .padding(.vertical, size == .compact ? 5 : 7)
            .background(
                background.opacity(hovering ? 1 : 1 - theme.stateLayers.hover),
                in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            )
            .foregroundStyle(foreground)
            .overlay { border }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 1 - theme.stateLayers.pressed : 1)
            .animation(Motion.state, value: configuration.isPressed)
            .animation(Motion.state, value: hovering)
            .onHover { hovering = $0 }
    }
}

/// Monospaced code/diff block. Scrolls horizontally rather than wrapping, so
/// indentation and diff alignment survive.
struct CodeBlock: View {
    @Environment(\.nexusTheme) private var theme
    let text: String
    var isDiff = false
    var maxHeight: CGFloat? = 300

    private var lines: [(offset: Int, element: String)] {
        Array(text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).enumerated())
    }

    var body: some View {
        ScrollView([.horizontal, .vertical], showsIndicators: true) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(lines, id: \.offset) { line in
                    Text(line.element.isEmpty ? " " : line.element)
                        .textStyle(Type.mono)
                        .foregroundStyle(color(for: line.element))
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: maxHeight)
        .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle).opacity(0.7), lineWidth: 1)
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

/// The shared "nothing here yet" composition.
///
/// The old version was a 34pt glyph inside a 190pt radial glow above a 28pt
/// headline and three lines of centred grey text — the single most
/// template-looking element in the app, and identical on six screens. What
/// replaced the glow is a **mark plate**: the glyph on a real level-2 surface
/// with a specular edge, at a size that reads as an object rather than a
/// watermark. It is the same shape language as everything else on screen
/// instead of a decorative special case, and it gives the composition a
/// definite top edge to hang from, which is what the floating glow never did.
struct HeroEmptyState<Actions: View>: View {
    @Environment(\.nexusTheme) private var theme
    let icon: String
    let title: String
    let message: String
    /// A short all-caps line above the title naming what this screen is.
    /// Optional because not every empty state has a second thing worth saying.
    var eyebrow: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            MarkPlate(icon: icon)
                .padding(.bottom, Space.xl)

            if let eyebrow {
                Text(eyebrow.uppercased())
                    .textStyle(Type.eyebrow)
                    .foregroundStyle(theme.color(\.textMuted))
                    .padding(.bottom, Space.md)
            }

            Text(title)
                // `title2` (24pt), not `display` (32pt). An empty state is the
                // screen with the LEAST on it, and giving it the app's largest
                // type meant a screen with nothing to say shouted louder than
                // one full of work. `display` is now reserved for a genuine
                // first-run moment.
                .textStyle(Type.title2)
                .foregroundStyle(theme.color(\.textPrimary))
                .padding(.bottom, Space.lg)

            Text(message)
                .textStyle(Type.body)
                .foregroundStyle(theme.color(\.textMuted))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
                .fixedSize(horizontal: false, vertical: true)

            actions.padding(.top, Space.xl)
        }
        // Padding BEFORE the flexible frame, never after: `.frame(maxHeight:
        // .infinity).padding(n)` asks for all available space PLUS 2n, which
        // overflows the enclosing stack and silently clips its siblings out of
        // the window — that is what once made the sidebar, control strip and
        // composer disappear.
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension HeroEmptyState where Actions == EmptyView {
    init(icon: String, title: String, message: String, eyebrow: String? = nil) {
        self.init(icon: icon, title: title, message: message, eyebrow: eyebrow) { EmptyView() }
    }
}

/// A glyph on a real raised plate — the replacement for the radial-glow circle.
struct MarkPlate: View {
    @Environment(\.nexusTheme) private var theme
    let icon: String
    var size: CGFloat = 60

    var body: some View {
        Image(systemName: icon)
            .font(.system(size: size * 0.42, weight: .regular))
            .foregroundStyle(theme.color(\.textSecondary))
            .frame(width: size, height: size)
            .surface(2, radius: size * 0.30, specular: 1.15)
            .accessibilityHidden(true)
    }
}

/// The "nothing to show yet, actively loading" moment.
struct LoadingState: View {
    @Environment(\.nexusTheme) private var theme
    let message: String
    var style: Style = .fullPage

    enum Style {
        /// Centred, fills the container — a screen's entire content before
        /// anything has loaded.
        case fullPage
        /// A compact single row for a spot already sharing space with other
        /// chrome (e.g. pinned below an `InlineBanner`).
        case inline
    }

    private var caption: some View {
        Text(message)
            .textStyle(Type.caption)
            .foregroundStyle(theme.color(\.textMuted))
    }

    var body: some View {
        switch style {
        case .fullPage:
            VStack(spacing: Space.lg) {
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
/// shared shape for "something didn't work, but here's what's still true".
///
/// `onDismiss` is required, not optional: every call site this replaces has
/// real content on screen underneath, so nothing is ever blocked on this
/// banner. A state that genuinely blocks the user is `ErrorState` below, which
/// has no dismiss because there is nothing left to reveal by dismissing it.
struct InlineBanner: View {
    @Environment(\.nexusTheme) private var theme
    let message: String
    var tone: Tone = .warning
    let onDismiss: () -> Void

    enum Tone { case warning, error }

    private var colors: (fg: Color, bg: Color, border: Color) {
        switch tone {
        case .warning: return (theme.color(\.warningFg), theme.color(\.warningBg), theme.color(\.warningBorder))
        case .error: return (theme.color(\.errorFg), theme.color(\.errorBg), theme.color(\.errorBorder))
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10))
                .accessibilityHidden(true)
            Text(message)
                .textStyle(Type.caption)
                .lineLimit(2)
            Spacer(minLength: Space.sm)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .foregroundStyle(colors.fg)
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
        .background(colors.bg.opacity(0.7), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(colors.border.opacity(0.5), lineWidth: 1)
        }
    }
}

/// The "nothing loaded at all, and here's why" moment — replaces a screen's
/// ENTIRE content when the first load failed. Sticky by construction: there is
/// no other content underneath, so dismissing a blank page would leave a
/// blanker one. Resolved only by `retry` succeeding.
struct ErrorState: View {
    @Environment(\.nexusTheme) private var theme
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: Space.lg) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 22))
                .foregroundStyle(theme.color(\.errorFg))
                // The message right below already says what's wrong — this
                // glyph is decoration, not a second thing to announce.
                .accessibilityHidden(true)
            Text(message)
                .textStyle(Type.body)
                .foregroundStyle(theme.color(\.textSecondary))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
                .fixedSize(horizontal: false, vertical: true)
            Button("Retry", action: retry)
                .buttonStyle(SoftButton(tone: .accent))
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The standard page shell: a header that never scrolls away, and a body that
/// fills every bit of the remaining height.
///
/// Every list screen used to stack header and content inside ONE `ScrollView`.
/// A `ScrollView` top-aligns its content, so a short empty state renders at the
/// top and leaves a dead void for the rest of the window — that one missing
/// rule about vertical composition is why every sparse screen read as
/// unfinished. `content` decides for itself whether to scroll (return a
/// `ScrollView` when there is real data) or fill and centre (return an empty /
/// loading / error state unwrapped); the outer flexible frame here is what
/// makes that choice occupy the window instead of floating in its top third.
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

/// A keyboard-shortcut hint.
struct KeyHint: View {
    @Environment(\.nexusTheme) private var theme
    let keys: String
    let label: String

    var body: some View {
        HStack(spacing: Space.xs) {
            Text(keys)
                .textStyle(Type.monoMicro)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(theme.color(\.surfaceOverlay), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                }
                .foregroundStyle(theme.color(\.textSecondary))
            Text(label)
                .textStyle(Type.caption)
                .foregroundStyle(theme.color(\.textMuted))
        }
    }
}
