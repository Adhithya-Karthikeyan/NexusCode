import SwiftUI

/// The shipped theme catalogue: twelve seeds, expanded by `AppTheme.derived(from:)`.
///
/// **What this file used to be.** 756 lines in which each of seven themes spelled
/// out all 74 `ThemeTokens` *and* a second, separately hand-typed `ElevationLadder`
/// — 518 hex values, none of which any human could audit. The results were exactly
/// what you would predict: `level2` and `level3` came out identical in five of the
/// seven themes (so a popover had no rung above the card it floats over), both
/// light themes collapsed levels 1, 2 and 3 into `#FFFFFF`, `chromeBorderSubtle`
/// equalled `surfaceOverlay` in four themes, and two themes shipped a button whose
/// label sat at 3.40:1 on its own fill. Every one of those is a copy-editing
/// failure, not a taste failure.
///
/// **What it is now.** Each theme authors the ~22 colours that carry its identity;
/// the other 52 tokens, the whole elevation ladder, both gradients and the state
/// layers are derived from them (`ThemeDerivation.swift`), with every contrast
/// floor enforced during derivation rather than checked afterwards. A duplicate
/// rung is now unrepresentable, and `ThemeSeed.validate()` — asserted for all
/// twelve in `ThemeCatalogTests` — refuses a palette that misses a floor.
///
/// **Sources.** These are not invented palettes. Each is anchored to a body of
/// work developers have already voted for over years (Tokyo Night, Kanagawa,
/// Catppuccin, Ayu, Everforest, Rosé Pine, Synthwave '84, Flexoki), corrected
/// where the original misses this app's floors — every such correction is noted
/// inline, because "we changed the famous theme" is exactly the kind of decision
/// that deserves a reason next to it.
public enum ThemeCatalog {
    /// Every shipped theme, in picker order: darks first, then lights.
    public static let seeds: [ThemeSeed] = [
        storm, sumi, mocha, mirage, grove, moon, neon, ink,
        porcelain, paper, dawn, clarity,
    ]

    // MARK: - Dark

    /// The very modern one, and the app's default. Tokyo Night Storm.
    ///
    /// The reference implementation of the rule that separates this catalogue
    /// from the one it replaces: **the surface ramp carries hue.** `#1A1B26` is
    /// a blue-violet, not a grey, and every rung above it keeps that
    /// temperature. A near-black neutral with one blue accent bolted on is what
    /// reads as dead; a canvas that is already, quietly, the accent's own family
    /// is what reads as designed.
    static let storm = ThemeSeed(
        id: "storm",
        name: "Storm",
        isDark: true,
        pairId: "porcelain",
        surfaces: SurfaceRamp(sunken: "#121320", base: "#1A1B26", raised: "#22243A", overlay: "#2A2E48", inset: "#161721"),
        // Comment/muted raised from Tokyo Night's own `#565F89`, which measures
        // ~2.6:1 on this base — below even the 3:1 non-text floor, and the most
        // commonly patched value in the theme's own issue tracker.
        text: TextRamp(primary: "#C0CAF5", secondary: "#A9B1D6", muted: "#737AA2"),
        accent: AccentSeed(primary: "#7AA2F7", secondary: "#BB9AF7"),
        semantic: SemanticSeed(success: "#9ECE6A", warning: "#E0AF68", error: "#F7768E", info: "#7DCFFF"),
        syntax: SyntaxSeed(keyword: "#BB9AF7", function: "#7AA2F7", type: "#2AC3DE", string: "#9ECE6A", number: "#FF9E64", comment: "#737AA2"),
        materials: MaterialUsage(sidebar: .solid, overlay: .regular, composer: .solid),
        typography: .neutral
    )

    /// The developer-friendly one. Kanagawa Wave.
    ///
    /// Its defining property is *low accent chroma* — roughly C 0.095 where the
    /// rest of this catalogue sits 0.13–0.19. That restraint is not blandness,
    /// it is the whole eight-hour register: nothing on screen is bright enough
    /// to pull the eye off the code. Warm ink (`#DCD7BA`) on cool ground is the
    /// second half of it, and the reason the palette reads as sumi on paper
    /// rather than as a dimmed dark theme.
    static let sumi = ThemeSeed(
        id: "sumi",
        name: "Sumi",
        isDark: true,
        pairId: "paper",
        surfaces: SurfaceRamp(sunken: "#16161D", base: "#1F1F28", raised: "#2A2A37", overlay: "#363646", inset: "#1A1A22"),
        text: TextRamp(primary: "#DCD7BA", secondary: "#C8C093", muted: "#938AA9"),
        accent: AccentSeed(primary: "#7E9CD8", secondary: "#E6C384"),
        semantic: SemanticSeed(success: "#98BB6C", warning: "#FF9E3B", error: "#E46876", info: "#7FB4CA"),
        syntax: SyntaxSeed(keyword: "#957FB8", function: "#7E9CD8", type: "#7AA89F", string: "#98BB6C", number: "#D27E99", comment: "#727169"),
        typography: .neutral
    )

    /// The cozy one. Catppuccin Mocha.
    ///
    /// Widest usable ladder in the catalogue — the base→raised step is ΔL\* 5.8,
    /// nearly double some of its neighbours, which is what gives a card real
    /// separation from the canvas without a border doing the work.
    static let mocha = ThemeSeed(
        id: "mocha",
        name: "Mocha",
        isDark: true,
        surfaces: SurfaceRamp(sunken: "#181825", base: "#1E1E2E", raised: "#292A3D", overlay: "#35374D", inset: "#11111B"),
        text: TextRamp(primary: "#CDD6F4", secondary: "#A6ADC8", muted: "#7F849C"),
        accent: AccentSeed(primary: "#CBA6F7", secondary: "#94E2D5"),
        semantic: SemanticSeed(success: "#A6E3A1", warning: "#F9E2AF", error: "#F38BA8", info: "#89B4FA"),
        syntax: SyntaxSeed(keyword: "#CBA6F7", function: "#89B4FA", type: "#F9E2AF", string: "#A6E3A1", number: "#FAB387", comment: "#7F849C"),
        materials: MaterialUsage(sidebar: .solid, overlay: .regular, composer: .solid),
        typography: .neutral
    )

    /// The product one. Ayu Mirage.
    ///
    /// The theme that proves the accent rule: amber (H 83°) against a blue-grey
    /// ground (H 267°) is a 184° near-complementary split, so the two accents
    /// can never be confused for one another. That maps onto the one distinction
    /// this app most needs to draw — warm is *your* action, cool is the model's
    /// output — instead of onto decoration.
    static let mirage = ThemeSeed(
        id: "mirage",
        name: "Mirage",
        isDark: true,
        surfaces: SurfaceRamp(sunken: "#161A23", base: "#1F2430", raised: "#282F3E", overlay: "#333C4D", inset: "#171B24"),
        text: TextRamp(primary: "#CCCAC2", secondary: "#9EA6B4", muted: "#8A93A3"),
        accent: AccentSeed(primary: "#FFCC66", secondary: "#5CCFE6"),
        semantic: SemanticSeed(success: "#87D96C", warning: "#FFCC66", error: "#F27983", info: "#5CCFE6"),
        syntax: SyntaxSeed(keyword: "#FFA659", function: "#FFCD66", type: "#73D0FF", string: "#D5FF80", number: "#DFBFFF", comment: "#6E7C8F"),
        typography: .toolForged
    )

    /// Lowest eye strain, and the best diffs in the catalogue. Everforest Dark.
    ///
    /// Its base sits at L\* ≈ 21.7 — by far the lightest dark base here, which
    /// keeps the whole palette out of the crushed bottom of sRGB where adjacent
    /// surfaces stop being separable at all.
    ///
    /// **The diff pair is the reason to ship it.** `#A7C080` and `#E67E80` are
    /// 106° apart at matched lightness, so an added and a removed line differ by
    /// hue rather than by brightness — which is what keeps them apart for a
    /// red-green colour-blind reader too.
    static let grove = ThemeSeed(
        id: "grove",
        name: "Grove",
        isDark: true,
        surfaces: SurfaceRamp(sunken: "#272E33", base: "#2D353B", raised: "#374145", overlay: "#414D51", inset: "#232A2E"),
        text: TextRamp(primary: "#D3C6AA", secondary: "#A6B0A0", muted: "#899B8B"),
        accent: AccentSeed(primary: "#A7C080", secondary: "#7FBBB3"),
        semantic: SemanticSeed(success: "#A7C080", warning: "#DBBC7F", error: "#E67E80", info: "#7FBBB3"),
        syntax: SyntaxSeed(keyword: "#E67E80", function: "#7FBBB3", type: "#DBBC7F", string: "#A7C080", number: "#D699B6", comment: "#859289"),
        typography: .editorial,
        // The one earned override in the catalogue. The generic derivation mixes
        // a diff row's fill 86% toward the base surface, which is right for a
        // status badge and slightly too dark for a hunk you have to read code
        // inside. Everforest ships its own diff fills, tuned to sit ~4 ΔL* above
        // base for exactly that reason, and they are better than the generic
        // answer here.
        overrides: { tokens in
            tokens.diffAddedBg = "#425047"
            tokens.diffRemovedBg = "#514045"
        }
    )

    /// The distinctive one. Rosé Pine Moon.
    ///
    /// Most chromatic ramp in the catalogue, and the only palette here with **no
    /// green at all**: additions are foam `#9CCFD8`, deletions are love
    /// `#EB6F92`. Those are 205° apart *and* separated in lightness, so the diff
    /// survives deuteranopia — which makes the most decorative-looking theme in
    /// the set quietly the most accessible one for its most important surface.
    static let moon = ThemeSeed(
        id: "moon",
        name: "Moon",
        isDark: true,
        pairId: "dawn",
        surfaces: SurfaceRamp(sunken: "#1C1A2B", base: "#232136", raised: "#2E2B45", overlay: "#393552", inset: "#191724"),
        // Muted lifted from Rosé Pine's own `#6E6A86` (3.03:1 — technically
        // passing, visibly not) to `#817C9C`.
        text: TextRamp(primary: "#E0DEF4", secondary: "#B4AFD0", muted: "#817C9C"),
        accent: AccentSeed(primary: "#C4A7E7", secondary: "#EA9A97"),
        semantic: SemanticSeed(success: "#9CCFD8", warning: "#F6C177", error: "#EB6F92", info: "#C4A7E7"),
        syntax: SyntaxSeed(keyword: "#C4A7E7", function: "#9CCFD8", type: "#EA9A97", string: "#F6C177", number: "#EB6F92", comment: "#817C9C"),
        materials: MaterialUsage(sidebar: .solid, overlay: .thick, composer: .solid),
        typography: .editorial
    )

    /// The neon one. Synthwave '84, re-engineered to survive a workday.
    ///
    /// Two mechanisms are what separate this from the demo theme it is drawn
    /// from. First, the ground is **violet-black with real chroma** (`#1E1A2A`,
    /// H 295°) rather than `#000`, so no maximum-contrast edge exists anywhere
    /// on screen — pure black under saturated pink is what makes neon themes
    /// unusable after an hour. Second, chroma *rises* with lightness up the
    /// ramp, so elevation reads as lit rather than merely stacked.
    ///
    /// The house rule that keeps it honest: neon is a glyph, caret and stroke
    /// colour. Nothing larger than a badge is ever filled with it.
    static let neon = ThemeSeed(
        id: "neon",
        name: "Neon Grid",
        isDark: true,
        surfaces: SurfaceRamp(sunken: "#131020", base: "#1E1A2A", raised: "#2A2540", overlay: "#363052", inset: "#141220"),
        // `#EDE6F7`, carrying a trace of the surface's own hue — NOT Synthwave's
        // `#FFFFFF`. That single substitution is the difference between a theme
        // you screenshot and a theme you work in.
        text: TextRamp(primary: "#EDE6F7", secondary: "#B6ABDD", muted: "#8D8FC4"),
        accent: AccentSeed(primary: "#FF7EDB", secondary: "#36F9F6"),
        semantic: SemanticSeed(success: "#72F1B8", warning: "#FEDE5D", error: "#FE4450", info: "#36F9F6"),
        syntax: SyntaxSeed(keyword: "#FEDE5D", function: "#36F9F6", type: "#FF7EDB", string: "#FF8B39", number: "#FE4450", comment: "#8D8FC4"),
        materials: MaterialUsage(sidebar: .solid, overlay: .regular, composer: .solid),
        typography: .toolForged
    )

    /// The paper-and-ink one. Flexoki.
    ///
    /// The deliberate counter-example to Storm: these surfaces are genuinely
    /// neutral (C ≈ 0.003) and the theme still does not read dead, because the
    /// warmth lives in the **text** (`#CECDC3`, H 68°) and the accent is thrown
    /// 172° the other way into blue. Proof that "put hue in the surfaces" is one
    /// working answer rather than the only one — what actually matters is that
    /// ink and ground are not the same temperature. Most even ladder here, which
    /// makes it the best choice for reading a long transcript.
    static let ink = ThemeSeed(
        id: "ink",
        name: "Ink",
        isDark: true,
        pairId: "clarity",
        surfaces: SurfaceRamp(sunken: "#100F0F", base: "#1C1B1A", raised: "#282726", overlay: "#343331", inset: "#0D0C0C"),
        text: TextRamp(primary: "#CECDC3", secondary: "#A19F98", muted: "#787672"),
        // Flexoki's 300 steps, not its 400s — the 400s land at 4.37:1 and 3.97:1
        // on this base, below the floor for an ink that carries meaning.
        accent: AccentSeed(primary: "#66A0C8", secondary: "#D0A215"),
        semantic: SemanticSeed(success: "#879A39", warning: "#D0A215", error: "#E8705F", info: "#66A0C8"),
        syntax: SyntaxSeed(keyword: "#8B7EC8", function: "#66A0C8", type: "#D0A215", string: "#879A39", number: "#DA702C", comment: "#787672"),
        typography: .toolForged
    )

    // MARK: - Light

    /// Cool, IDE-professional. The default light theme.
    ///
    /// Fixes precisely what the theme it replaces broke: that one's ladder ran
    /// `#E7E9EC → #FFFFFF → #FFFFFF → #FFFFFF`, so three of its four rungs were
    /// the same colour and nothing could be raised above anything. Porcelain
    /// keeps real headroom above the canvas by refusing to spend white on it.
    static let porcelain = ThemeSeed(
        id: "porcelain",
        name: "Porcelain",
        isDark: false,
        pairId: "storm",
        surfaces: SurfaceRamp(sunken: "#E4E8ED", base: "#EFF2F6", raised: "#F7F9FB", overlay: "#FCFDFE", inset: "#DCE1E7"),
        text: TextRamp(primary: "#242B33", secondary: "#545D69", muted: "#6B7480"),
        accent: AccentSeed(primary: "#0C69CE", secondary: "#7D50CD"),
        semantic: SemanticSeed(success: "#0A7E3A", warning: "#936017", error: "#C9292F", info: "#0C69CE"),
        syntax: SyntaxSeed(keyword: "#7442BE", function: "#1461BA", type: "#1B6C7A", string: "#1B7339", number: "#A14B13", comment: "#6F7885"),
        typography: .neutral
    )

    /// Warm and editorial.
    ///
    /// The matched-hue school: olive-warm ink (H 94°) on cream (H 92°). Ink and
    /// paper sharing a hue is why it reads as *printed* rather than as black
    /// text dropped onto a beige rectangle — the failure mode of most warm light
    /// themes.
    static let paper = ThemeSeed(
        id: "paper",
        name: "Paper",
        isDark: false,
        pairId: "sumi",
        surfaces: SurfaceRamp(sunken: "#EAE5D8", base: "#F5F2E7", raised: "#FBF9F1", overlay: "#FEFDF7", inset: "#E2DCCC"),
        text: TextRamp(primary: "#2C2A23", secondary: "#5F5C52", muted: "#75726A"),
        accent: AccentSeed(primary: "#2A67BD", secondary: "#B04F1F"),
        semantic: SemanticSeed(success: "#297C3D", warning: "#926011", error: "#BF3B32", info: "#226BC0"),
        syntax: SyntaxSeed(keyword: "#9E2B36", function: "#275EAE", type: "#1A6F6B", string: "#237236", number: "#6C44A4", comment: "#7F7962"),
        typography: .editorial
    )

    /// Soft and personable. Rosé Pine Dawn.
    ///
    /// The complementary-ink school, and the exact opposite of Paper's method:
    /// violet ink (H 292°) on blush paper (H 52°) is a 240° split. That
    /// deliberate disagreement between ink and ground is the entire reason it
    /// reads as designed rather than merely tinted.
    static let dawn = ThemeSeed(
        id: "dawn",
        name: "Dawn",
        isDark: false,
        pairId: "moon",
        surfaces: SurfaceRamp(sunken: "#EFE6E0", base: "#F9F0EA", raised: "#FDF7F3", overlay: "#FFFCFA", inset: "#E7DCD5"),
        text: TextRamp(primary: "#2B2542", secondary: "#5D567D", muted: "#726A94"),
        accent: AccentSeed(primary: "#6B5AA8", secondary: "#107091"),
        semantic: SemanticSeed(success: "#257C58", warning: "#955F16", error: "#AE4457", info: "#107091"),
        syntax: SyntaxSeed(keyword: "#6350A0", function: "#0C6785", type: "#8A6114", string: "#187350", number: "#A43E43", comment: "#7A778F"),
        typography: .editorial
    )

    /// High-contrast and accessible.
    ///
    /// Deliberately not pure white or pure black at either end: `#FFFFFF`
    /// maximises glare without buying any usable contrast over `#FDFDFE`, and
    /// this is the theme whose whole point is that a user can look at it for a
    /// long time. Body text lands at AAA, and nothing here is translucent or
    /// gradient-filled — a predictable contrast is the feature.
    static let clarity = ThemeSeed(
        id: "clarity",
        name: "Clarity",
        isDark: false,
        pairId: "ink",
        surfaces: SurfaceRamp(sunken: "#E4E7EA", base: "#F0F2F4", raised: "#F8F9FA", overlay: "#FDFDFE", inset: "#DCDFE2"),
        text: TextRamp(primary: "#161A1E", secondary: "#474C53", muted: "#565B62"),
        accent: AccentSeed(primary: "#0B509E", secondary: "#6731A8"),
        semantic: SemanticSeed(success: "#126132", warning: "#814D03", error: "#A0161C", info: "#0B509E"),
        syntax: SyntaxSeed(keyword: "#5F279E", function: "#0E498E", type: "#065460", string: "#02582A", number: "#813610", comment: "#576574"),
        typography: .neutral
    )
}

// MARK: - Retired theme ids

public extension ThemeCatalog {
    /// Where a user who picked one of the seven retired themes lands.
    ///
    /// Without this, `WorkspaceModel.init` silently falls back to the default
    /// for any id it cannot resolve — so shipping this catalogue would have
    /// quietly moved every existing user onto Storm and lost their choice with
    /// no way to tell that anything had happened. Each mapping goes to the
    /// theme that occupies the retired one's register, not to whatever is
    /// nearest in hue.
    static let retiredThemeIds: [String: String] = [
        "meridian": "storm",      // the restrained blue default
        "studio": "porcelain",    // cool professional light
        "cinder": "mirage",       // warm, strong single brand colour
        "daylight": "paper",      // warm editorial light
        "basalt": "sumi",         // keyboard-driven, tool-forward dark
        "vantage": "ink",         // the high-contrast reading theme
        "nightfall": "moon",      // violet, gradient-forward, editorial
    ]

    /// Resolves a possibly-retired id to one this catalogue actually ships.
    /// Returns `nil` for an id that was never ours, so a caller can still fall
    /// through to the generated terminal palettes.
    static func migrate(_ id: String) -> String? {
        seeds.contains { $0.id == id } ? id : retiredThemeIds[id]
    }
}
