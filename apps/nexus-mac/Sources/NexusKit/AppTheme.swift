import SwiftUI

/// The richer theme model the macOS app renders with.
///
/// `NexusTheme` (`Generated/Themes.swift`) is a TERMINAL palette: 74 flat hex
/// tokens designed for ANSI text on a single background. That is exactly why
/// the app's themes read as boring — a terminal has no concept of material,
/// elevation, gradient, translucency, or interaction state, so an app built
/// only on those tokens looks like a terminal wearing a window.
///
/// `AppTheme` keeps every one of the 74 tokens — nothing that already calls
/// `theme.color(\.token)` breaks — and adds the things a terminal palette
/// cannot express: elevation, material, gradient, state layers, a second
/// semantic accent, and typographic intent. See `AppThemes.swift` for the
/// hand-designed themes built on this model, and `NexusTheme.appTheme` below
/// for a generic (non-hand-tuned) version of the same model so the 16
/// generated terminal palettes keep rendering — just without the deliberate
/// design pass the hand-authored themes get.
public struct AppTheme: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let isDark: Bool
    public let tokens: ThemeTokens
    /// Sibling theme for OS light/dark auto-pairing, when the theme declares one.
    public let pairId: String?

    public let elevation: ElevationLadder
    public let materials: MaterialUsage
    public let gradients: GradientSet
    public let stateLayers: StateLayers
    public let accents: AccentSystem
    public let typography: TypographyIntent
    /// Whether surfaces cast shadows, and how strong the specular top edge is.
    /// Authored per theme because the previously hardcoded specular opacity
    /// (0.11) measured 1.398:1 against its own surface — invisible. See
    /// `DepthIntent`.
    public let depth: DepthIntent

    public init(
        id: String,
        name: String,
        isDark: Bool,
        tokens: ThemeTokens,
        pairId: String? = nil,
        elevation: ElevationLadder,
        materials: MaterialUsage,
        gradients: GradientSet,
        stateLayers: StateLayers,
        accents: AccentSystem,
        typography: TypographyIntent,
        depth: DepthIntent? = nil
    ) {
        self.id = id
        self.name = name
        self.isDark = isDark
        self.tokens = tokens
        self.pairId = pairId
        self.elevation = elevation
        self.materials = materials
        self.gradients = gradients
        self.stateLayers = stateLayers
        self.accents = accents
        self.typography = typography
        self.depth = depth ?? (isDark ? .luminous : .paper)
    }
}

// MARK: - Elevation

/// One rung of the surface ladder: a background, the hairline that separates
/// it from what's behind it, and (optionally) a shadow.
///
/// Elevation used to be improvised per view — `Card` picked `surfaceRaised` or
/// `surfaceOverlay` by hand, and every other view rolled its own guess. Making
/// it a first-class 0–3 ladder means a surface asks "how elevated am I"
/// instead of naming a token and hoping it reads as the right depth next to
/// its neighbours.
public struct ElevationStep: Sendable, Hashable {
    public let surface: String
    public let border: String
    /// 0 for themes that reject drop shadows in favour of the colour ladder
    /// alone — a shadow over a near-black canvas reads as grey smudge, which
    /// is the documented reason `DesignSystem.swift`'s `hairline` exists.
    public let shadowOpacity: Double
    public let shadowRadius: Double

    public init(surface: String, border: String, shadowOpacity: Double, shadowRadius: Double) {
        self.surface = surface
        self.border = border
        self.shadowOpacity = shadowOpacity
        self.shadowRadius = shadowRadius
    }

    /// Falls back to a visible magenta rather than a plausible-looking grey —
    /// same convention as `NexusTheme.color(_:)` — so a bad token is caught in
    /// review, not shipped.
    public var surfaceColor: Color { Color(hex: surface) ?? .init(.sRGB, red: 1, green: 0, blue: 1, opacity: 1) }
    public var borderColor: Color { Color(hex: border) ?? .init(.sRGB, red: 1, green: 0, blue: 1, opacity: 1) }
}

/// Levels 0–3: sunken/base, raised, overlay, and the topmost layer (modals,
/// popovers, command palettes) that must always read above everything else.
public struct ElevationLadder: Sendable, Hashable {
    public let level0: ElevationStep
    public let level1: ElevationStep
    public let level2: ElevationStep
    public let level3: ElevationStep

    public init(level0: ElevationStep, level1: ElevationStep, level2: ElevationStep, level3: ElevationStep) {
        self.level0 = level0
        self.level1 = level1
        self.level2 = level2
        self.level3 = level3
    }

    /// Clamps out-of-range levels rather than trapping — a view passing `4`
    /// because it copy-pasted from a deeper stack should still render.
    public func step(_ level: Int) -> ElevationStep {
        switch level {
        case ..<1: return level0
        case 1: return level1
        case 2: return level2
        default: return level3
        }
    }
}

// MARK: - Material

/// Where a surface should be a flat colour fill versus real translucency.
/// Flat `#0A0E14` everywhere — sidebar, popovers, the composer — is exactly
/// what makes an app read as a repainted terminal; a sidebar that shows a
/// hint of what's behind it is what makes it read as a native Mac app.
public enum SurfaceTreatment: Sendable, Hashable {
    case solid
    case thin
    case regular
    case thick

    /// `nil` means "use the flat token colour" — callers fall back to a
    /// token fill when this is nil, which is also the only option an
    /// accessible theme should choose (blur makes contrast unpredictable
    /// against whatever happens to be behind it).
    public var material: Material? {
        switch self {
        case .solid: return nil
        case .thin: return .ultraThinMaterial
        case .regular: return .regularMaterial
        case .thick: return .thickMaterial
        }
    }
}

/// The three surfaces most worth spending translucency on. Not every surface
/// should get vibrancy — over-using it looks as flat and cheap as never using
/// it — so this names the specific roles rather than a single on/off switch.
public struct MaterialUsage: Sendable, Hashable {
    public let sidebar: SurfaceTreatment
    public let overlay: SurfaceTreatment
    public let composer: SurfaceTreatment

    public init(sidebar: SurfaceTreatment, overlay: SurfaceTreatment, composer: SurfaceTreatment) {
        self.sidebar = sidebar
        self.overlay = overlay
        self.composer = composer
    }
}

// MARK: - Gradient

/// The brand gradient: the one or two moments that should look unmistakably
/// like THIS theme — the wordmark plate and the primary CTA.
///
/// There used to be a second entry here, `surfaceWash`, a multi-stop tint for a
/// "hero surface". It was defined by every theme and referenced by zero views,
/// and wiring it up was the wrong fix: the only surface large enough to want it
/// is the canvas, and a vertical wash behind a SCROLLING transcript puts text at
/// the bottom of the window on a different value from text at the top, with the
/// composer docked in the darkest part. Depth here is carried by the ladder.
public struct GradientSet: Sendable, Hashable {
    public let accentGradient: [String]

    public init(accentGradient: [String]) {
        self.accentGradient = accentGradient
    }
}

// MARK: - State layers

/// Hover/pressed/selected/disabled as opacity amounts, defined once per theme
/// instead of guessed per control. `SoftButton` used to hand-pick `0.82` /
/// `0.97` / `0.85` with no reasoning behind the numbers; those now come from
/// here, tuned per theme — a light surface needs a much lighter overlay than
/// a near-black one, or a hover state turns the surface muddy.
public struct StateLayers: Sendable, Hashable {
    public let hover: Double
    public let pressed: Double
    public let selected: Double
    public let disabled: Double

    public init(hover: Double, pressed: Double, selected: Double, disabled: Double) {
        self.hover = hover
        self.pressed = pressed
        self.selected = selected
        self.disabled = disabled
    }
}

// MARK: - Accent system

/// A terminal has exactly one accent because it has exactly one cursor. An
/// app benefits from a second: a colour for the "other" semantic emphasis (an
/// alternate tag family, a secondary badge) that isn't the primary action
/// colour, so two simultaneous emphases on screen don't collide. Per-provider
/// identity colours already exist as tokens (`providerAnthropic` etc.) — this
/// only adds what was missing.
public struct AccentSystem: Sendable, Hashable {
    public let primary: String
    public let secondary: String

    public init(primary: String, secondary: String) {
        self.primary = primary
        self.secondary = secondary
    }
}

// MARK: - Typography intent

/// Most themes share one balanced type ramp — that's `Type` in
/// `DesignSystem.swift`, and it stays the default for anything that doesn't
/// opt in. A theme can lean the ramp toward a point of view: a command-tool
/// theme reads slightly tighter and more mono-forward, a friendly theme reads
/// slightly softer and more open.
public enum TypographyIntent: Sendable, Hashable {
    /// The shared default: `Type`'s ramp, unmodified.
    case neutral
    /// Tighter tracking on labels, numerals lean monospaced — for themes
    /// built around a command-palette / tool register.
    case toolForged
    /// Looser tracking on section labels — for themes built around a
    /// friendly, generous register.
    case editorial
}

// MARK: - Convenience

public extension AppTheme {
    /// A token as a SwiftUI colour. Same magenta-fallback convention as
    /// `NexusTheme.color(_:)`.
    func color(_ token: KeyPath<ThemeTokens, String>) -> Color {
        Color(hex: tokens[keyPath: token]) ?? .init(.sRGB, red: 1, green: 0, blue: 1, opacity: 1)
    }

    /// A raw hex value as a SwiftUI colour — for the fields on `ElevationStep`
    /// / `GradientSet` / `AccentSystem` that aren't part of `ThemeTokens`.
    func color(hex: String) -> Color {
        Color(hex: hex) ?? .init(.sRGB, red: 1, green: 0, blue: 1, opacity: 1)
    }

    var accentSecondary: Color { color(hex: accents.secondary) }

    /// The theme paired with this one for OS light/dark following, if declared.
    var pairedTheme: AppTheme? { pairId.flatMap { AppTheme.named($0) } }

    /// Resolve the theme to use for a colour scheme, honouring `pairId` —
    /// same contract as `NexusTheme.resolved(for:)`.
    func resolved(for scheme: ColorScheme) -> AppTheme {
        let wantsDark = scheme == .dark
        if isDark == wantsDark { return self }
        return pairedTheme ?? self
    }

    /// What actually gets rendered — `resolved(for:)` when the user wants OS
    /// appearance-following, or this EXACT theme, unchanged, when they don't.
    ///
    /// Before this existed, `ThemedRoot` (`NexusApp.swift`) called
    /// `resolved(for:)` unconditionally, with no way to opt out — which made
    /// two of the seven hand-designed themes (Daylight, Studio; both `isDark
    /// == false`) permanently unreachable on a Mac in Dark Mode: picking
    /// either one in Settings moved the checkmark but `resolved(for:)` swapped
    /// the ACTUAL theme straight back to its dark pair every time, silently.
    /// A control that visibly does nothing when clicked is worse than no
    /// control at all — this is that fix. `matchSystemAppearance` is a real,
    /// user-visible, opt-in toggle (Settings), defaulting on so existing
    /// pairing behaviour is unchanged for anyone who wants it; the moment a
    /// user's explicit pick disagrees with the OS scheme, the app turns the
    /// toggle off FOR them (see `WorkspaceModel`), because an explicit pick
    /// is the one thing that must always win.
    func displayed(for scheme: ColorScheme, matchSystemAppearance: Bool) -> AppTheme {
        matchSystemAppearance ? resolved(for: scheme) : self
    }

    func surface(_ level: Int) -> Color { elevation.step(level).surfaceColor }
    func border(_ level: Int) -> Color { elevation.step(level).borderColor }

    var accentGradient: LinearGradient {
        LinearGradient(
            colors: gradients.accentGradient.map { color(hex: $0) },
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}

public extension AppTheme {
    /// Every shipped theme, expanded from the seeds in `AppThemes.swift`.
    ///
    /// Derived rather than listed: a theme is now ~22 authored colours, and the
    /// other 52 tokens plus the whole elevation ladder are a function of them.
    /// See `ThemeCatalog` for why the previous 756-line hand-authored file had
    /// to go.
    static let all: [AppTheme] = ThemeCatalog.seeds.map(AppTheme.derived(from:))

    static let defaultThemeId = "storm"

    static func named(_ id: String) -> AppTheme? {
        all.first { $0.id == id }
    }

    /// `named(_:)`, but also resolving the seven retired theme ids.
    ///
    /// The catalogue replaced every hand-designed theme, so a user who had
    /// picked one has a `themeId` in `UserDefaults` that no longer resolves —
    /// and the unresolved path silently falls back to the default, which would
    /// have moved everyone onto Storm and lost their choice without a word.
    /// This is the one call site that must not do that; see
    /// `ThemeCatalog.retiredThemeIds` for the register-preserving map.
    static func resolving(_ id: String) -> AppTheme? {
        ThemeCatalog.migrate(id).flatMap(named)
    }
}

// MARK: - Bridge from the generated terminal palette

public extension NexusTheme {
    /// A generic, non-hand-tuned `AppTheme` derived purely from this theme's
    /// existing 74 tokens.
    ///
    /// This exists so every one of the 16 generated palettes keeps working
    /// through the richer model — no visual regression for a theme this file
    /// doesn't hand-author — even though none of them were designed with
    /// elevation, material, or gradient in mind. Prefer `AppTheme.all` for
    /// anything that wants the deliberate design pass.
    ///
    /// Shadow is zero at every level when `isDark`: these 16 tokens sets were
    /// never designed with a shadow in mind, so guessing a blanket opacity
    /// for all of them is exactly how a near-black canvas ends up with a grey
    /// smudge halo (the documented reason `DesignSystem.swift`'s `hairline`
    /// exists at all). A light theme's shadow is the standard, uncontroversial
    /// technique — kept.
    var appTheme: AppTheme {
        AppTheme(
            id: id,
            name: name,
            isDark: isDark,
            tokens: tokens,
            pairId: pairId,
            elevation: ElevationLadder(
                level0: ElevationStep(surface: tokens.surfaceSunken, border: tokens.chromeBorderSubtle, shadowOpacity: 0, shadowRadius: 0),
                level1: ElevationStep(surface: tokens.surfaceRaised, border: tokens.chromeBorder, shadowOpacity: isDark ? 0 : 0.06, shadowRadius: isDark ? 0 : 6),
                level2: ElevationStep(surface: tokens.surfaceOverlay, border: tokens.chromeBorderStrong, shadowOpacity: isDark ? 0 : 0.10, shadowRadius: isDark ? 0 : 12),
                // NOT `surfaceOverlay` again. These 16 palettes define four
                // surface tokens, so a naive level3 reused level2's fill and
                // left a popover with no rung above the card it floats over —
                // the same duplicate-rung defect the hand-authored themes had.
                // One more step up the same ink the other rungs are diluted
                // toward keeps the ladder four-deep without inventing a token
                // the terminal palette never declared.
                level3: ElevationStep(surface: Hex.mix(tokens.surfaceOverlay, tokens.textPrimary, 0.06), border: tokens.chromeBorderFocus, shadowOpacity: isDark ? 0 : 0.14, shadowRadius: isDark ? 0 : 20)
            ),
            materials: MaterialUsage(sidebar: .solid, overlay: .solid, composer: .solid),
            gradients: GradientSet(accentGradient: [tokens.accentDefault, tokens.accentEmphasis]),
            stateLayers: StateLayers(
                hover: isDark ? 0.08 : 0.05,
                pressed: isDark ? 0.14 : 0.09,
                selected: isDark ? 0.18 : 0.12,
                disabled: isDark ? 0.38 : 0.40
            ),
            accents: AccentSystem(primary: tokens.accentDefault, secondary: tokens.infoFg),
            typography: .neutral
        )
    }
}
