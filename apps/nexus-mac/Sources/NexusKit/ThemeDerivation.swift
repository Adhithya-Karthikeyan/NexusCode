import Foundation

/// Colour maths on hex strings.
///
/// Deliberately string-in / string-out rather than `Color`-based, for the same
/// reason `Color.contrastRatio` is (see `Theme.swift`): `Color`'s component
/// accessors need a window server and a colour space to resolve against, which
/// headless `swift test` does not have. Everything here gives the same answer
/// in a running app and in a unit test — which is the only way a contrast floor
/// can be a guarantee rather than a hope.
public enum Hex {
    /// Non-premultiplied sRGB components in 0...1.
    public struct RGB: Sendable, Hashable {
        public var r: Double
        public var g: Double
        public var b: Double
    }

    /// Parses `#rgb` / `#rrggbb`. Alpha is deliberately unsupported: every
    /// derived token is an opaque surface or an opaque ink, and a translucent
    /// token would make the contrast maths below silently meaningless.
    public static func parse(_ hex: String) -> RGB? {
        var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") { text.removeFirst() }
        if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
        guard text.count == 6, let value = UInt64(text, radix: 16) else { return nil }
        return RGB(
            r: Double((value >> 16) & 0xFF) / 255,
            g: Double((value >> 8) & 0xFF) / 255,
            b: Double(value & 0xFF) / 255
        )
    }

    public static func string(_ rgb: RGB) -> String {
        func channel(_ value: Double) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", channel(rgb.r), channel(rgb.g), channel(rgb.b))
    }

    /// Linear interpolation in sRGB space. Not perceptually uniform — and that
    /// is the right trade here: every use below mixes an ink toward a surface
    /// that is already close to it in hue, where sRGB mixing and OKLab mixing
    /// differ by less than a rounding step, and sRGB keeps the maths auditable
    /// by hand from the hex values a designer actually reads.
    ///
    /// `amount` is how much of `b` ends up in the result.
    public static func mix(_ a: String, _ b: String, _ amount: Double) -> String {
        guard let lhs = parse(a), let rhs = parse(b) else { return a }
        let t = min(max(amount, 0), 1)
        return string(RGB(
            r: lhs.r + (rhs.r - lhs.r) * t,
            g: lhs.g + (rhs.g - lhs.g) * t,
            b: lhs.b + (rhs.b - lhs.b) * t
        ))
    }

    /// WCAG 2.1 relative luminance.
    public static func luminance(_ hex: String) -> Double {
        guard let rgb = parse(hex) else { return 0 }
        func linearize(_ c: Double) -> Double {
            c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b)
    }

    /// WCAG 2.1 contrast ratio, 1...21.
    public static func contrast(_ a: String, _ b: String) -> Double {
        let lumA = luminance(a)
        let lumB = luminance(b)
        return (max(lumA, lumB) + 0.05) / (min(lumA, lumB) + 0.05)
    }

    /// CIE L\* — perceptual lightness, 0 (black) to 100 (white).
    ///
    /// **The right metric for two large adjacent fills, where the WCAG ratio is
    /// the wrong one.** Near black the ratio compresses savagely: `#08090D` and
    /// `#14161D`, two rungs that are plainly different on screen, measure
    /// 1.10:1 — a number that reads as "identical" and led this project to
    /// conclude its surface ladder was invisible when in fact only the top two
    /// rungs were (they were the same hex). In L\* the same pair is 4.8 apart,
    /// which is the honest description. Contrast ratio stays the right tool for
    /// text on a background; this is the tool for surface next to surface.
    public static func lightness(_ hex: String) -> Double {
        let y = luminance(hex)
        let delta = 6.0 / 29.0
        let f = y > pow(delta, 3) ? pow(y, 1.0 / 3.0) : y / (3 * delta * delta) + 4.0 / 29.0
        return 116 * f - 16
    }

    /// Hue angle in degrees, 0..<360. Undefined for a neutral, which answers 0.
    ///
    /// Used to assert that a theme's six syntax roles are actually
    /// distinguishable from one another rather than six shades of one colour.
    public static func hue(_ hex: String) -> Double {
        guard let rgb = parse(hex) else { return 0 }
        let maxC = max(rgb.r, rgb.g, rgb.b)
        let minC = min(rgb.r, rgb.g, rgb.b)
        let chroma = maxC - minC
        guard chroma > 0.0001 else { return 0 }

        let raw: Double
        switch maxC {
        case rgb.r: raw = (rgb.g - rgb.b) / chroma
        case rgb.g: raw = 2 + (rgb.b - rgb.r) / chroma
        default: raw = 4 + (rgb.r - rgb.g) / chroma
        }
        let degrees = raw * 60
        return degrees < 0 ? degrees + 360 : degrees
    }

    /// The shorter way round the colour wheel between two hues, 0...180.
    public static func hueSeparation(_ a: String, _ b: String) -> Double {
        let difference = abs(hue(a) - hue(b)).truncatingRemainder(dividingBy: 360)
        return difference > 180 ? 360 - difference : difference
    }

    /// Flattens a translucent ink over an opaque backdrop.
    ///
    /// Exists for one test (`testSidebarSurvivesAWhiteBackdrop`): a translucent
    /// sidebar's rendered value is a function of the user's wallpaper, and this
    /// app has already shipped a build where a bright desktop lifted the
    /// DARKEST surface in the theme above the canvas it sits beside, inverting
    /// the whole depth story. Being able to compute that composite is what
    /// turns "the material must not govern value" from a comment into an
    /// assertion.
    public static func composite(_ ink: String, over backdrop: String, alpha: Double) -> String {
        mix(backdrop, ink, min(max(alpha, 0), 1))
    }

    /// Whether a background wants dark ink or light ink on it.
    public static func prefersDarkInk(on background: String) -> Bool {
        contrast("#000000", background) >= contrast("#FFFFFF", background)
    }

    /// Nudges `ink` away from `background` until it clears `ratio`, keeping as
    /// much of the authored hue as the floor allows.
    ///
    /// **This is the mechanism that makes the contrast tests proofs instead of
    /// tripwires.** Before this file existed, every one of the 74 tokens in
    /// every theme was authored by hand, and `AppThemeTests` could only report
    /// after the fact that a hand-picked pair had missed the floor — which is
    /// exactly how `accentFg`/`accentDefault` shipped at 3.40:1 on Daylight and
    /// 4.15:1 on Studio. Deriving the ink and then *enforcing* the floor means a
    /// new theme cannot introduce that class of defect at all: the worst a bad
    /// seed can do now is come out less saturated than its author intended.
    ///
    /// Moves toward black or white, whichever direction the background implies,
    /// in 2% steps — small enough that the result stops the moment the floor is
    /// met rather than overshooting to a flat black or white.
    public static func ensureContrast(_ ink: String, on background: String, ratio: Double) -> String {
        guard parse(ink) != nil, parse(background) != nil else { return ink }
        if contrast(ink, background) >= ratio { return ink }

        let target = prefersDarkInk(on: background) ? "#000000" : "#FFFFFF"
        var amount = 0.02
        while amount <= 1 {
            let candidate = mix(ink, target, amount)
            if contrast(candidate, background) >= ratio { return candidate }
            amount += 0.02
        }
        return target
    }

    /// Nudges a *surface* away from an ink until the pair clears `ratio`.
    ///
    /// The mirror of `ensureContrast`, for the cases where the ink is the fixed
    /// quantity and the fill is the one free to move — a tinted badge wash
    /// (`accentMuted`, `warningBg`) exists to sit *behind* text whose colour is
    /// already decided, so it is the wash that should give way.
    public static func ensureSurfaceContrast(_ surface: String, under ink: String, ratio: Double) -> String {
        guard parse(surface) != nil, parse(ink) != nil else { return surface }
        if contrast(surface, ink) >= ratio { return surface }

        // Away from the ink: if the ink is light, the surface goes darker.
        let target = luminance(ink) > luminance(surface) ? "#000000" : "#FFFFFF"
        var amount = 0.02
        while amount <= 1 {
            let candidate = mix(surface, target, amount)
            if contrast(candidate, ink) >= ratio { return candidate }
            amount += 0.02
        }
        return target
    }
}

// MARK: - Seed

/// The five-rung surface ladder, back to front.
///
/// `inset` is off-ladder on purpose: it is the one surface that goes the *other*
/// way (a well, not a rise) — a code block, a recessed field, the user's own
/// turn on a light theme. Giving it a name rather than a rung number stops it
/// being mistaken for "level -1" and re-derived differently by every caller.
public struct SurfaceRamp: Sendable, Hashable {
    public let sunken: String
    public let base: String
    public let raised: String
    public let overlay: String
    public let inset: String

    public init(sunken: String, base: String, raised: String, overlay: String, inset: String) {
        self.sunken = sunken
        self.base = base
        self.raised = raised
        self.overlay = overlay
        self.inset = inset
    }
}

/// Three inks. `textInverse` is not here — it is always the theme's own base
/// surface, because "inverse" only ever means "legible on top of the accent",
/// and every theme already owns exactly the colour that satisfies that.
public struct TextRamp: Sendable, Hashable {
    public let primary: String
    public let secondary: String
    public let muted: String

    public init(primary: String, secondary: String, muted: String) {
        self.primary = primary
        self.secondary = secondary
        self.muted = muted
    }
}

/// The theme's two structural accents.
///
/// `emphasis` is the brighter sibling used for a hover/active moment and as the
/// second stop of the brand gradient; `secondary` is the "other" semantic
/// emphasis (`AccentSystem.secondary`) so two simultaneous emphases on screen
/// do not collide. Everything else an accent needs — the muted wash, the
/// foreground that sits on it — is derived and contrast-enforced.
public struct AccentSeed: Sendable, Hashable {
    public let primary: String
    public let secondary: String
    /// The brighter sibling used for hover/active and as the brand gradient's
    /// second stop. `nil` derives it by pushing `primary` toward the theme's own
    /// light pole — which is what every hand-authored value was anyway, and one
    /// fewer near-duplicate hex to keep in sync per theme.
    public let emphasis: String?

    public init(primary: String, secondary: String, emphasis: String? = nil) {
        self.primary = primary
        self.secondary = secondary
        self.emphasis = emphasis
    }
}

/// The four status hues, as FOREGROUNDS only. Their backgrounds and borders are
/// derived by mixing each hue toward the theme's own base surface, which is
/// what keeps a status colour looking like it belongs to *this* palette instead
/// of like a shared stoplight pasted onto every theme.
public struct SemanticSeed: Sendable, Hashable {
    public let success: String
    public let warning: String
    public let error: String
    public let info: String

    public init(success: String, warning: String, error: String, info: String) {
        self.success = success
        self.warning = warning
        self.error = error
        self.info = info
    }
}

/// The six syntax roles worth authoring. The remaining six `syntax*` tokens are
/// derived from these plus the text ramp — `operator` is secondary text,
/// `variable` is primary text, `tag`/`attribute` reuse string/number, `invalid`
/// is the error hue — because a theme that hand-picks twelve syntax colours
/// picks twelve that drift, and no one has ever wanted `syntaxTag` and
/// `syntaxString` to disagree.
public struct SyntaxSeed: Sendable, Hashable {
    public let keyword: String
    public let function: String
    public let type: String
    public let string: String
    public let number: String
    public let comment: String
    /// Constants/enums. Optional: falls back to `type` when a palette has no
    /// distinct hue for it.
    public let constant: String?

    public init(keyword: String, function: String, type: String, string: String, number: String, comment: String, constant: String? = nil) {
        self.keyword = keyword
        self.function = function
        self.type = type
        self.string = string
        self.number = number
        self.comment = comment
        self.constant = constant
    }
}

/// How a theme expresses depth: whether surfaces cast shadows, and how strong
/// the specular top edge on a raised object is.
///
/// `specular` is authored rather than fixed because the shipped value was
/// measurably invisible. White at 0.11 over `#1B1E27` composites to `#34373F`,
/// which is **1.398:1** against the surface it is supposed to be an edge on —
/// below the threshold at which anything reads as a line at all, on all four
/// dark themes (1.386–1.400 measured). 0.26 composites to 2.34:1, which is a
/// visible edge without becoming the coloured halo that was rejected before.
/// A high-contrast theme wants more of it and a soft theme wants less, so it is
/// a per-theme number, not a constant.
public struct DepthIntent: Sendable, Hashable {
    /// Whether raised surfaces cast a drop shadow.
    ///
    /// `.none` for dark themes, where a shadow over a near-black canvas renders
    /// as a grey smudge (this project reverted exactly that once). `.cast` for
    /// light themes, where an occlusion shadow is simply correct physics and
    /// the only thing that separates white-on-white.
    public enum Shadow: Sendable, Hashable { case none, cast }

    public let shadow: Shadow
    public let specular: Double

    public init(shadow: Shadow = .none, specular: Double = 0.26) {
        self.shadow = shadow
        self.specular = specular
    }

    /// Dark themes: luminance and a specular edge, never a shadow.
    public static let luminous = DepthIntent(shadow: .none, specular: 0.26)
    /// Light themes: a cast shadow, and no specular edge — a white highlight on
    /// a white surface describes nothing.
    public static let paper = DepthIntent(shadow: .cast, specular: 0)
}

/// A complete theme in ~22 authored colours instead of 74.
///
/// **Why this exists.** `AppThemes.swift` used to spell out all 74 `ThemeTokens`
/// per theme. At seven themes that was 518 hand-picked hex values; at the
/// fourteen this catalogue now ships it would have been 1,036. Nobody audits
/// 1,036 hex values, which is why the old file had `diffAddedFg` and
/// `successFg` identical in some themes and quietly divergent in others, and
/// why two themes shipped below the WCAG floor. Authoring the ~22 values that
/// carry a palette's *identity* and deriving the rest means the derived 52
/// cannot drift, and the pairs a component actually composites are enforced
/// (see `Hex.ensureContrast`) rather than checked after the fact.
///
/// Per-theme escape hatch: `overrides` runs last and wins over everything, so a
/// theme that genuinely needs one specific token off the derivation can say so
/// in one line without abandoning the model. It is deliberately a closure over
/// the finished tokens rather than 74 optional fields — an optional per token
/// would just re-create the hand-authoring problem with extra syntax.
public struct ThemeSeed: Sendable {
    public let id: String
    public let name: String
    public let isDark: Bool
    public let pairId: String?
    public let surfaces: SurfaceRamp
    public let text: TextRamp
    public let accent: AccentSeed
    public let semantic: SemanticSeed
    public let syntax: SyntaxSeed
    /// Where this theme spends translucency. Defaults to solid everywhere —
    /// the safe answer, and the only one a theme that says nothing should get.
    public let materials: MaterialUsage
    public let typography: TypographyIntent
    public let depth: DepthIntent
    /// The escape hatch: runs last, over the finished tokens, and wins.
    ///
    /// A closure rather than 74 optional fields, because 74 optionals would
    /// just re-create the hand-authoring problem with extra syntax. Each use is
    /// a small bug report against the derivation — Grove uses it because
    /// Everforest's own diff-row fills are genuinely better than a generic mix,
    /// and that is the bar.
    public let overrides: (@Sendable (inout ThemeTokens) -> Void)?

    public init(
        id: String,
        name: String,
        isDark: Bool,
        pairId: String? = nil,
        surfaces: SurfaceRamp,
        text: TextRamp,
        accent: AccentSeed,
        semantic: SemanticSeed,
        syntax: SyntaxSeed,
        materials: MaterialUsage = MaterialUsage(sidebar: .solid, overlay: .solid, composer: .solid),
        typography: TypographyIntent = .neutral,
        depth: DepthIntent? = nil,
        overrides: (@Sendable (inout ThemeTokens) -> Void)? = nil
    ) {
        self.id = id
        self.name = name
        self.isDark = isDark
        self.pairId = pairId
        self.surfaces = surfaces
        self.text = text
        self.accent = accent
        self.semantic = semantic
        self.syntax = syntax
        self.materials = materials
        self.typography = typography
        // Defaulted from `isDark` rather than required: the correct depth
        // model follows from the appearance, and a theme that does not say
        // otherwise should get the right one for free.
        self.depth = depth ?? (isDark ? .luminous : .paper)
        self.overrides = overrides
    }
}

// MARK: - Validation

public extension ThemeSeed {
    /// One way a seed fails the catalogue's own standards.
    struct Violation: Error, CustomStringConvertible, Equatable {
        public let themeId: String
        public let rule: String
        public let detail: String

        public var description: String { "\(themeId): \(rule) — \(detail)" }
    }

    /// Every floor a shipped theme must clear, checked from the seed's own
    /// values so a bad palette fails in `swift test` rather than on screen.
    ///
    /// Returns ALL violations rather than throwing on the first, because a
    /// palette being tuned wants the whole list in one pass.
    func validate() -> [Violation] {
        var violations: [Violation] = []
        func fail(_ rule: String, _ detail: String) {
            violations.append(Violation(themeId: id, rule: rule, detail: detail))
        }

        let base = surfaces.base
        let rungs = [surfaces.sunken, surfaces.base, surfaces.raised, surfaces.overlay, surfaces.inset]

        // Text. 7:1 for body, not the 4.5 legibility floor — 4.5 is where text
        // stops being hard to read; 7 is the register an app someone stares at
        // all day should actually sit at.
        let body = Hex.contrast(text.primary, base)
        if body < 7.0 { fail("body contrast", "textPrimary on surfaceBase is \(rounded(body)), below 7:1") }
        let secondary = Hex.contrast(text.secondary, base)
        if secondary < 4.5 { fail("secondary contrast", "textSecondary on surfaceBase is \(rounded(secondary)), below 4.5:1") }
        let muted = Hex.contrast(text.muted, base)
        if muted < 3.0 { fail("muted contrast", "textMuted on surfaceBase is \(rounded(muted)), below 3:1") }

        // The duplicate-rung defect, structurally prevented. Five rungs that
        // are not five distinct colours is a ladder with a missing step, and it
        // shipped in five of the seven themes this catalogue replaces.
        if Set(rungs.map { $0.uppercased() }).count != rungs.count {
            fail("ramp uniqueness", "surface ramp repeats a hex: \(rungs.joined(separator: " "))")
        }

        // Perceptual steps between the rungs the eye actually sees adjacent.
        let ladder = [surfaces.sunken, surfaces.base, surfaces.raised, surfaces.overlay]
        for index in 0..<(ladder.count - 1) {
            let step = abs(Hex.lightness(ladder[index + 1]) - Hex.lightness(ladder[index]))
            // Light themes compress toward white on purpose: perceptual
            // lightness has a hard ceiling at 100, so "raised" above a near-white
            // canvas has genuinely less room than "raised" above near-black.
            // Demanding the dark floor here would force a light theme's canvas
            // grey and dingy to buy headroom it does not need.
            let floor = isDark ? 3.0 : (index == 0 ? 3.0 : 1.2)
            if step < floor {
                fail("ladder step", "\(ladder[index])→\(ladder[index + 1]) is ΔL* \(rounded(step)), below \(floor)")
            }
        }

        // White is the ceiling. A light theme whose top rung is #FFFFFF has
        // nowhere left to raise anything to — which is precisely the structural
        // gap that forced `SpeakerSlab` to invert on light themes.
        if !isDark, surfaces.overlay.uppercased() == "#FFFFFF" {
            fail("light headroom", "surfaces.overlay is #FFFFFF, leaving no rung above it")
        }

        // Accents and semantics are inks too — each one lands on the canvas.
        let inks: [(String, String)] = [
            ("accent.primary", accent.primary), ("accent.emphasis", accentEmphasis),
            ("accent.secondary", accent.secondary),
            ("success", semantic.success), ("warning", semantic.warning),
            ("error", semantic.error), ("info", semantic.info),
        ]
        for (label, hex) in inks {
            let ratio = Hex.contrast(hex, base)
            if ratio < 4.5 { fail("ink contrast", "\(label) on surfaceBase is \(rounded(ratio)), below 4.5:1") }
        }

        // Six syntax roles that are six shades of one colour are not six roles.
        //
        // Hue OR lightness, not hue alone. A pure-hue rule sounds tidier and is
        // simply wrong about how colours are told apart: Ayu Mirage's keyword
        // and function are 12.6° apart and perfectly separable because they are
        // also 9.3 ΔL* apart, while Rosé Pine Dawn's function and type were
        // 14.2° apart at 0.8 ΔL* — the same hue AND the same lightness, which is
        // the pair a reader actually cannot resolve. Measured across all twelve
        // palettes, 20° / 8 ΔL* is the boundary that flags exactly the pairs a
        // person would complain about and none of the ones they would not.
        let roles: [(String, String)] = [
            ("keyword", syntax.keyword), ("function", syntax.function), ("type", syntax.type),
            ("string", syntax.string), ("number", syntax.number),
        ]
        for outer in 0..<roles.count {
            for inner in (outer + 1)..<roles.count {
                let separation = Hex.hueSeparation(roles[outer].1, roles[inner].1)
                let lightnessGap = abs(Hex.lightness(roles[outer].1) - Hex.lightness(roles[inner].1))
                if separation < 20, lightnessGap < 8 {
                    fail(
                        "syntax separation",
                        "\(roles[outer].0) and \(roles[inner].0) are \(rounded(separation))° apart at only ΔL* \(rounded(lightnessGap))"
                    )
                }
            }
        }

        return violations
    }

    private func rounded(_ value: Double) -> String { String(format: "%.2f", value) }

    /// The accent's bright sibling — authored, or derived toward the theme's
    /// light pole. Read from both derivation entry points so the tokens and the
    /// gradient can never disagree about what "emphasis" is.
    var accentEmphasis: String {
        accent.emphasis ?? Hex.mix(accent.primary, isDark ? "#FFFFFF" : "#000000", 0.22)
    }
}

// MARK: - Whole-theme derivation

public extension AppTheme {
    /// A complete `AppTheme` from a seed — the only constructor the catalogue uses.
    ///
    /// The elevation ladder is a FUNCTION of the surface ramp rather than a
    /// second, hand-typed copy of it. That is the whole fix for the defect this
    /// catalogue replaces: `level2` and `level3` were separately typed and came
    /// out identical in five of seven themes, so a popover had no rung above a
    /// card, and both light themes collapsed levels 1, 2 and 3 into `#FFFFFF`.
    /// A derived ladder cannot contain a duplicate, because `validate()`
    /// range-checks the ramp it is derived from.
    ///
    /// **The rung remap.** Level 1 is now the CANVAS (`base`), not `raised`:
    /// level 0 is the sidebar and status chrome, 1 the canvas, 2 cards and the
    /// user's own turn, 3 popovers and modals. Before this, `RootView` painted
    /// the canvas with `surface(1)` while the sidebar reached past the ladder
    /// for the `surfaceSunken` *token* — two accessors for one concept, which
    /// is how they drifted.
    static func derived(from seed: ThemeSeed) -> AppTheme {
        var tokens = ThemeTokens.derived(from: seed)
        seed.overrides?(&tokens)

        let ramp = seed.surfaces
        let isDark = seed.isDark

        // A border is a dilution of the ink ON this rung, so it can never come
        // out as the same hex as the surface it bounds — the
        // `chromeBorderSubtle == surfaceOverlay` bug that shipped in four themes.
        func border(_ surface: String, _ amount: Double) -> String {
            Hex.mix(surface, seed.text.primary, amount)
        }
        func shadow(_ level: Int) -> (opacity: Double, radius: Double) {
            guard seed.depth.shadow == .cast else { return (0, 0) }
            return ([0, 0.05, 0.08, 0.12][level], [0, 4, 8, 14][level])
        }

        func step(_ surface: String, _ borderAmount: Double, _ level: Int) -> ElevationStep {
            let cast = shadow(level)
            return ElevationStep(
                surface: surface,
                border: border(surface, borderAmount),
                shadowOpacity: cast.opacity,
                shadowRadius: cast.radius
            )
        }

        return AppTheme(
            id: seed.id,
            name: seed.name,
            isDark: isDark,
            tokens: tokens,
            pairId: seed.pairId,
            elevation: ElevationLadder(
                level0: step(ramp.sunken, isDark ? 0.09 : 0.11, 0),
                level1: step(ramp.base, isDark ? 0.16 : 0.20, 1),
                level2: step(ramp.raised, isDark ? 0.22 : 0.26, 2),
                level3: step(ramp.overlay, isDark ? 0.30 : 0.36, 3)
            ),
            materials: seed.materials,
            gradients: GradientSet(
                surfaceWash: [ramp.base, ramp.sunken],
                accentGradient: [seed.accent.primary, seed.accentEmphasis]
            ),
            stateLayers: StateLayers(
                hover: isDark ? 0.08 : 0.05,
                pressed: isDark ? 0.14 : 0.09,
                selected: isDark ? 0.18 : 0.12,
                disabled: isDark ? 0.38 : 0.40
            ),
            accents: AccentSystem(primary: seed.accent.primary, secondary: seed.accent.secondary),
            typography: seed.typography,
            depth: seed.depth
        )
    }
}

// MARK: - Provider identity

/// The per-provider identity hues, defined once for the whole app rather than
/// re-picked in every theme.
///
/// A provider's colour is a *brand fact* — Anthropic is terracotta, OpenAI is
/// teal-green, Google is blue — and it means the same thing on every theme, so
/// re-authoring eight of them per theme only creates fourteen chances to
/// disagree about what colour Anthropic is. What genuinely must vary per theme
/// is legibility: the same terracotta that reads correctly on near-black is
/// muddy on a warm off-white. `toned(for:)` is that adjustment and nothing more
/// — the hue is never touched, only how far it is pushed toward the theme's
/// own ink or paper until it clears a 3:1 non-text floor against the surface it
/// will be drawn on (a `ProviderDot` is a 6pt graphical object, which is what
/// WCAG 1.4.11 sets 3:1 for).
public enum ProviderHues {
    public static let anthropic = "#D97757"
    public static let openai = "#10A37F"
    public static let google = "#4285F4"
    public static let xai = "#8E96A6"
    public static let ollama = "#A78BFA"
    public static let mistral = "#FF7000"
    public static let deepseek = "#4D6BFE"
    public static let custom = "#E06BB8"

    /// The canonical hue, pushed only as far as legibility on `surface` needs.
    static func toned(_ hue: String, on surface: String, isDark: Bool) -> String {
        // Lighten on dark, darken on light — the direction that preserves hue.
        let anchor = isDark ? "#FFFFFF" : "#000000"
        var amount = 0.0
        var candidate = hue
        while amount <= 1 {
            candidate = Hex.mix(hue, anchor, amount)
            if Hex.contrast(candidate, surface) >= 3.0 { return candidate }
            amount += 0.04
        }
        return candidate
    }
}

// MARK: - Derivation

public extension ThemeTokens {
    /// Expands a `ThemeSeed` into all 74 tokens, enforcing every contrast floor
    /// the app's components actually composite.
    ///
    /// Read this as five passes: inks and chrome from the ramps; the accent
    /// family with its foreground and wash both contrast-enforced; the four
    /// status families derived by mixing each hue toward the base surface; the
    /// syntax and diff roles; then the incidental tokens (selection, scrollbar,
    /// badge) that no theme has ever wanted to choose independently.
    static func derived(from seed: ThemeSeed) -> ThemeTokens {
        let surfaces = seed.surfaces
        let base = surfaces.base
        let isDark = seed.isDark

        // Inks, floored at the WCAG levels the app's own tests assert. A seed
        // that picks a too-quiet grey for secondary text gets it lifted rather
        // than shipped — see `Hex.ensureContrast`.
        let textPrimary = Hex.ensureContrast(seed.text.primary, on: base, ratio: 4.5)
        // Enforced against the base surface AND `surfaceOverlay`, because the
        // canvas is not the binding constraint for this ink. `SoftButton`'s
        // `.neutral` tone — the most common button in the app — paints
        // `textSecondary` onto `surfaceOverlay`, which on a dark theme is the
        // LIGHTER of the two, so a secondary that comfortably clears 4.5:1 on
        // the canvas can still fail on the control. Grove is exactly that case:
        // `#A6B0A0` measures 6.29:1 on its base and 3.88:1 on its overlay.
        let textSecondary = Hex.ensureContrast(
            Hex.ensureContrast(seed.text.secondary, on: base, ratio: 4.5),
            on: surfaces.overlay, ratio: 4.5
        )
        let textMuted = Hex.ensureContrast(seed.text.muted, on: base, ratio: 3.0)
        // "Inverse" only ever means "legible on the accent", and the base
        // surface is by construction the furthest thing from the ink.
        let textInverse = base

        // Chrome borders as a ladder from the surface toward the ink, so a
        // border is always a *dilution of the text colour on this surface*
        // rather than a fourth grey nobody can place.
        let borderSubtle = Hex.mix(base, textPrimary, isDark ? 0.09 : 0.11)
        let border = Hex.mix(base, textPrimary, isDark ? 0.16 : 0.20)
        let borderStrong = Hex.mix(base, textPrimary, isDark ? 0.30 : 0.36)
        let divider = borderSubtle

        // Accent family. `accentFg` is computed from whichever pole reads
        // better on the fill and then floored — never an authored guess, which
        // is precisely how the 3.40:1 Daylight button shipped.
        let accent = seed.accent.primary
        let accentEmphasis = seed.accentEmphasis
        let accentFgSeed = Hex.prefersDarkInk(on: accent) ? base : "#FFFFFF"
        let accentFg = Hex.ensureContrast(accentFgSeed, on: accent, ratio: 4.5)
        // The muted wash a selected row / accent badge fills with. Enforced
        // against `textPrimary` because that is the ink `CountPill` and
        // `SidebarNavRow` actually compute onto it.
        let accentMutedSeed = Hex.mix(accent, base, isDark ? 0.66 : 0.72)
        let accentMuted = Hex.ensureSurfaceContrast(accentMutedSeed, under: textPrimary, ratio: 4.5)

        /// One status family: a floored foreground, a wash mixed toward the
        /// base surface, and a border half way between the two.
        func statusFamily(_ hue: String) -> (fg: String, bg: String, border: String) {
            let fg = Hex.ensureContrast(hue, on: base, ratio: 4.5)
            let bgSeed = Hex.mix(fg, base, isDark ? 0.86 : 0.88)
            let bg = Hex.ensureSurfaceContrast(bgSeed, under: fg, ratio: 4.5)
            return (fg, bg, Hex.mix(fg, bg, 0.55))
        }

        let success = statusFamily(seed.semantic.success)
        let warning = statusFamily(seed.semantic.warning)
        let error = statusFamily(seed.semantic.error)
        let info = statusFamily(seed.semantic.info)

        let syntaxConstant = seed.syntax.constant ?? seed.syntax.type
        let syntaxComment = Hex.ensureContrast(seed.syntax.comment, on: base, ratio: 3.0)

        func provider(_ hue: String) -> String {
            ProviderHues.toned(hue, on: base, isDark: isDark)
        }

        return ThemeTokens(
            surfaceSunken: surfaces.sunken,
            surfaceBase: surfaces.base,
            surfaceRaised: surfaces.raised,
            surfaceOverlay: surfaces.overlay,
            surfaceInset: surfaces.inset,
            textPrimary: textPrimary,
            textSecondary: textSecondary,
            textMuted: textMuted,
            textInverse: textInverse,
            // A link is the accent at reading weight, floored for body text.
            textLink: Hex.ensureContrast(accentEmphasis, on: base, ratio: 4.5),
            chromeBorder: border,
            chromeBorderSubtle: borderSubtle,
            chromeBorderStrong: borderStrong,
            chromeBorderFocus: accent,
            chromeTitle: textPrimary,
            chromeDivider: divider,
            accentDefault: accent,
            accentEmphasis: accentEmphasis,
            accentMuted: accentMuted,
            accentFg: accentFg,
            successFg: success.fg,
            successBg: success.bg,
            successBorder: success.border,
            warningFg: warning.fg,
            warningBg: warning.bg,
            warningBorder: warning.border,
            errorFg: error.fg,
            errorBg: error.bg,
            errorBorder: error.border,
            infoFg: info.fg,
            infoBg: info.bg,
            infoBorder: info.border,
            streamCursor: accentEmphasis,
            streamThinking: textMuted,
            streamText: textPrimary,
            // A diff is a status family in a different frame — deriving it from
            // the same two hues is what stops "added green" and "success green"
            // being two greens that almost match.
            diffAddedFg: success.fg,
            diffAddedBg: success.bg,
            diffRemovedFg: error.fg,
            diffRemovedBg: error.bg,
            diffContext: textMuted,
            diffGutter: borderStrong,
            syntaxKeyword: seed.syntax.keyword,
            syntaxFunction: seed.syntax.function,
            syntaxType: seed.syntax.type,
            syntaxString: seed.syntax.string,
            syntaxNumber: seed.syntax.number,
            syntaxComment: syntaxComment,
            syntaxOperator: textSecondary,
            syntaxVariable: textPrimary,
            syntaxConstant: syntaxConstant,
            syntaxTag: seed.syntax.string,
            syntaxAttribute: seed.syntax.number,
            syntaxInvalid: error.fg,
            providerAnthropic: provider(ProviderHues.anthropic),
            providerOpenai: provider(ProviderHues.openai),
            providerGoogle: provider(ProviderHues.google),
            providerXai: provider(ProviderHues.xai),
            providerOllama: provider(ProviderHues.ollama),
            providerMistral: provider(ProviderHues.mistral),
            providerDeepseek: provider(ProviderHues.deepseek),
            providerCustom: provider(ProviderHues.custom),
            costOk: success.fg,
            costWarn: warning.fg,
            costCrit: error.fg,
            selectionBg: Hex.mix(accent, base, isDark ? 0.78 : 0.80),
            selectionFg: textPrimary,
            focusRing: accent,
            badgeBg: surfaces.raised,
            badgeFg: textPrimary,
            scrollbarTrack: surfaces.raised,
            scrollbarThumb: borderStrong,
            spinner: accent,
            linkVisited: Hex.ensureContrast(seed.accent.secondary, on: base, ratio: 4.5),
            overlayScrim: surfaces.sunken
        )
    }
}
