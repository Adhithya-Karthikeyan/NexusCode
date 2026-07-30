import XCTest
import SwiftUI
@testable import NexusKit

/// The derivation engine is what makes a 14-theme catalogue maintainable, so
/// its guarantees have to hold for *any* seed — not just the fourteen currently
/// shipped. These tests hammer the maths directly and then prove the enforcement
/// contract against a deliberately hostile seed: one whose authored colours all
/// miss the floors on purpose.
final class ThemeDerivationTests: XCTestCase {
    // MARK: - Hex maths

    func testParsesShortAndLongForm() throws {
        let short = try XCTUnwrap(Hex.parse("#0f8"))
        let long = try XCTUnwrap(Hex.parse("#00FF88"))
        XCTAssertEqual(Hex.string(short), Hex.string(long))
    }

    func testParseRejectsMalformedInput() {
        XCTAssertNil(Hex.parse("not a colour"))
        XCTAssertNil(Hex.parse("#12345"))
        XCTAssertNil(Hex.parse(""))
        // Alpha is deliberately unsupported — a translucent token would make
        // every contrast guarantee below silently meaningless.
        XCTAssertNil(Hex.parse("#11223344"))
    }

    func testRoundTripsThroughStringWithoutDrift() {
        for hex in ["#000000", "#FFFFFF", "#6E9BFF", "#0B0D12", "#D97757"] {
            let parsed = Hex.parse(hex)
            XCTAssertEqual(Hex.string(parsed!), hex.uppercased())
        }
    }

    func testMixEndpointsAreExact() {
        XCTAssertEqual(Hex.mix("#000000", "#FFFFFF", 0), "#000000")
        XCTAssertEqual(Hex.mix("#000000", "#FFFFFF", 1), "#FFFFFF")
    }

    func testMixMidpointIsHalfway() {
        XCTAssertEqual(Hex.mix("#000000", "#FFFFFF", 0.5), "#808080")
    }

    func testMixClampsOutOfRangeAmounts() {
        XCTAssertEqual(Hex.mix("#000000", "#FFFFFF", -3), "#000000")
        XCTAssertEqual(Hex.mix("#000000", "#FFFFFF", 12), "#FFFFFF")
    }

    func testMixFallsBackToTheFirstColourWhenEitherSideIsUnparseable() {
        XCTAssertEqual(Hex.mix("#123456", "garbage", 0.5), "#123456")
    }

    func testContrastMatchesTheKnownExtremes() {
        XCTAssertEqual(Hex.contrast("#000000", "#FFFFFF"), 21, accuracy: 0.01)
        XCTAssertEqual(Hex.contrast("#777777", "#777777"), 1, accuracy: 0.001)
    }

    /// The two implementations of this ratio in the codebase — this one and
    /// `Color.contrastRatio` in `Theme.swift`, which the shipped app's own
    /// `readableText` uses — must never disagree, or a token could pass the
    /// derivation floor and still be picked against at render time.
    func testContrastAgreesWithTheColorExtensionUsedAtRenderTime() {
        for (a, b) in [("#EDEFF4", "#0B0D12"), ("#6E9BFF", "#FFFFFF"), ("#2B2420", "#FAF6EF")] {
            XCTAssertEqual(Hex.contrast(a, b), Color.contrastRatio(a, b), accuracy: 0.0001, "\(a) on \(b)")
        }
    }

    func testPrefersDarkInkOnLightBackgroundsAndLightInkOnDarkOnes() {
        XCTAssertTrue(Hex.prefersDarkInk(on: "#FAF6EF"))
        XCTAssertTrue(Hex.prefersDarkInk(on: "#F5F6F8"))
        XCTAssertFalse(Hex.prefersDarkInk(on: "#0B0D12"))
        XCTAssertFalse(Hex.prefersDarkInk(on: "#000000"))
    }

    // MARK: - Contrast enforcement

    func testEnsureContrastLeavesAnAlreadyPassingInkUntouched() {
        let ink = "#EDEFF4"
        XCTAssertEqual(Hex.ensureContrast(ink, on: "#0B0D12", ratio: 4.5), ink)
    }

    func testEnsureContrastLiftsAFailingInkUntilItClearsTheFloor() {
        // A mid-grey on near-black is nowhere near 4.5:1 to start with.
        let start = "#3A3F4E"
        let background = "#0B0D12"
        XCTAssertLessThan(Hex.contrast(start, background), 4.5)

        let fixed = Hex.ensureContrast(start, on: background, ratio: 4.5)
        XCTAssertGreaterThanOrEqual(Hex.contrast(fixed, background), 4.5)
    }

    /// The floor must be met with as little movement as the 2% step allows —
    /// an implementation that jumped straight to white would satisfy the
    /// assertion above while destroying every palette it touched.
    func testEnsureContrastStopsCloseToTheFloorRatherThanOvershootingToWhite() {
        let fixed = Hex.ensureContrast("#3A3F4E", on: "#0B0D12", ratio: 4.5)
        XCTAssertNotEqual(fixed, "#FFFFFF")
        XCTAssertLessThan(Hex.contrast(fixed, "#0B0D12"), 6.0, "moved much further than the 4.5 floor required")
    }

    func testEnsureContrastDarkensInkOnALightBackground() {
        let background = "#FAF6EF"
        let fixed = Hex.ensureContrast("#C9C2B6", on: background, ratio: 4.5)
        XCTAssertGreaterThanOrEqual(Hex.contrast(fixed, background), 4.5)
        XCTAssertLessThan(Hex.luminance(fixed), Hex.luminance("#C9C2B6"), "should have gone darker, not lighter")
    }

    func testEnsureSurfaceContrastMovesTheFillAwayFromAFixedInk() {
        let ink = "#EDEFF4"
        let start = "#8A8FA0"
        XCTAssertLessThan(Hex.contrast(start, ink), 4.5)

        let fixed = Hex.ensureSurfaceContrast(start, under: ink, ratio: 4.5)
        XCTAssertGreaterThanOrEqual(Hex.contrast(fixed, ink), 4.5)
        XCTAssertLessThan(Hex.luminance(fixed), Hex.luminance(start), "a light ink means the fill must go darker")
    }

    // MARK: - Seed expansion

    /// A seed whose authored colours ALL miss their floors. Every guarantee the
    /// derivation makes has to survive it — this is the test that says the
    /// engine enforces rather than merely copies.
    private var hostileSeed: ThemeSeed {
        ThemeSeed(
            id: "hostile",
            name: "Hostile",
            isDark: true,
            surfaces: SurfaceRamp(
                sunken: "#0A0A0C", base: "#101014", raised: "#18181E",
                overlay: "#202028", inset: "#0D0D11"
            ),
            // All three inks are far too dark to read on that base.
            text: TextRamp(primary: "#3A3A44", secondary: "#2E2E36", muted: "#242430"),
            // An accent so dark that both its foreground and its wash are in trouble.
            accent: AccentSeed(primary: "#1B2440", secondary: "#221E3A", emphasis: "#232E52"),
            // Status hues that would each fail on the base surface.
            semantic: SemanticSeed(success: "#12301F", warning: "#332608", error: "#331014", info: "#122038"),
            syntax: SyntaxSeed(
                keyword: "#F0708A", function: "#9DBCFF", type: "#7EC9E0",
                string: "#7ED0A0", number: "#E5B567", comment: "#1E1E26"
            )
        )
    }

    func testDerivationProducesEverySeventyFourTokens() {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        XCTAssertEqual(Mirror(reflecting: tokens).children.count, 74)
    }

    func testEveryDerivedTokenIsAParseableColour() throws {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        for child in Mirror(reflecting: tokens).children {
            let hex = try XCTUnwrap(child.value as? String, "\(child.label ?? "?") is not a String")
            XCTAssertNotNil(Hex.parse(hex), "\(child.label ?? "?") is not a valid colour: \(hex)")
        }
    }

    func testDerivationLiftsBodyAndSecondaryTextToTheirFloors() {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        XCTAssertGreaterThanOrEqual(Hex.contrast(tokens.textPrimary, tokens.surfaceBase), 4.5)
        XCTAssertGreaterThanOrEqual(Hex.contrast(tokens.textSecondary, tokens.surfaceBase), 4.5)
        XCTAssertGreaterThanOrEqual(Hex.contrast(tokens.textMuted, tokens.surfaceBase), 3.0)
    }

    /// The exact pair that shipped at 3.40:1 on Daylight and 4.15:1 on Studio
    /// when it was hand-authored. It is computed now, so it cannot recur.
    func testDerivedAccentForegroundAlwaysClearsTheButtonFloor() {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        XCTAssertGreaterThanOrEqual(Hex.contrast(tokens.accentFg, tokens.accentDefault), 4.5)
    }

    /// `CountPill`'s `.accent` tone and `SidebarNavRow`'s selected label both
    /// composite an ink onto `accentMuted` via `Color.readableText`. The
    /// derivation has to leave that computation a winning option.
    func testDerivedAccentMutedLeavesAReadableInkAvailable() {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        let best = max(
            Hex.contrast(tokens.textPrimary, tokens.accentMuted),
            Hex.contrast(tokens.textInverse, tokens.accentMuted)
        )
        XCTAssertGreaterThanOrEqual(best, 4.5)
    }

    func testEveryDerivedStatusFamilyClearsItsOwnFloor() {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        let families = [
            ("success", tokens.successFg, tokens.successBg),
            ("warning", tokens.warningFg, tokens.warningBg),
            ("error", tokens.errorFg, tokens.errorBg),
            ("info", tokens.infoFg, tokens.infoBg),
        ]
        for (name, fg, bg) in families {
            XCTAssertGreaterThanOrEqual(Hex.contrast(fg, bg), 4.5, "\(name) fg on its own bg")
            XCTAssertGreaterThanOrEqual(Hex.contrast(fg, tokens.surfaceBase), 4.5, "\(name) fg on the base surface")
        }
    }

    /// Diff colours and status colours are derived from the same two hues on
    /// purpose — "added green" and "success green" being two greens that almost
    /// match is exactly the drift the hand-authored catalogue had.
    func testDiffColoursAreTheSameHuesAsTheirStatusFamilies() {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        XCTAssertEqual(tokens.diffAddedFg, tokens.successFg)
        XCTAssertEqual(tokens.diffAddedBg, tokens.successBg)
        XCTAssertEqual(tokens.diffRemovedFg, tokens.errorFg)
        XCTAssertEqual(tokens.diffRemovedBg, tokens.errorBg)
    }

    func testSyntaxConstantFallsBackToTypeWhenTheSeedOmitsIt() {
        let tokens = ThemeTokens.derived(from: hostileSeed)
        XCTAssertEqual(tokens.syntaxConstant, tokens.syntaxType)
    }

    func testSyntaxConstantIsHonouredWhenTheSeedSuppliesIt() {
        let seed = hostileSeed
        let withConstant = ThemeSeed(
            id: seed.id, name: seed.name, isDark: seed.isDark, pairId: seed.pairId,
            surfaces: seed.surfaces, text: seed.text, accent: seed.accent, semantic: seed.semantic,
            syntax: SyntaxSeed(
                keyword: seed.syntax.keyword, function: seed.syntax.function, type: seed.syntax.type,
                string: seed.syntax.string, number: seed.syntax.number, comment: seed.syntax.comment,
                constant: "#C9A6FF"
            )
        )
        XCTAssertEqual(ThemeTokens.derived(from: withConstant).syntaxConstant, "#C9A6FF")
    }

    /// Provider hues are brand facts, so their identity must survive the
    /// per-theme legibility adjustment: Anthropic stays warm-orange and OpenAI
    /// stays green on a near-black canvas AND on a near-white one.
    func testProviderHuesStayLegibleAndKeepTheirHueOnBothAppearances() throws {
        let dark = ThemeTokens.derived(from: hostileSeed)

        let lightSeed = ThemeSeed(
            id: "hostile-light", name: "Hostile Light", isDark: false,
            surfaces: SurfaceRamp(sunken: "#E8E6E1", base: "#FBFAF7", raised: "#FFFFFF", overlay: "#FFFFFF", inset: "#F2F0EB"),
            text: TextRamp(primary: "#1E1D1B", secondary: "#4A4844", muted: "#6B6864"),
            accent: AccentSeed(primary: "#1C6FD3", secondary: "#7247B0", emphasis: "#0A5FC2"),
            semantic: SemanticSeed(success: "#1E8E5A", warning: "#90640B", error: "#C1332A", info: "#1C75D3"),
            syntax: SyntaxSeed(keyword: "#A626A4", function: "#1C75D3", type: "#0F68A0", string: "#1E8E5A", number: "#90640B", comment: "#6B6864")
        )
        let light = ThemeTokens.derived(from: lightSeed)

        for tokens in [dark, light] {
            let surface = tokens.surfaceBase
            XCTAssertGreaterThanOrEqual(Hex.contrast(tokens.providerAnthropic, surface), 3.0)
            XCTAssertGreaterThanOrEqual(Hex.contrast(tokens.providerOpenai, surface), 3.0)
            XCTAssertGreaterThanOrEqual(Hex.contrast(tokens.providerGoogle, surface), 3.0)

            // Hue identity: Anthropic's terracotta stays red-dominant, OpenAI's
            // teal stays green-dominant, Google's blue stays blue-dominant.
            let anthropic = try XCTUnwrap(Hex.parse(tokens.providerAnthropic))
            XCTAssertGreaterThan(anthropic.r, anthropic.b, "Anthropic must stay warm")
            let openai = try XCTUnwrap(Hex.parse(tokens.providerOpenai))
            XCTAssertGreaterThan(openai.g, openai.r, "OpenAI must stay green")
            let google = try XCTUnwrap(Hex.parse(tokens.providerGoogle))
            XCTAssertGreaterThan(google.b, google.r, "Google must stay blue")
        }
    }

    func testDerivationIsDeterministic() {
        XCTAssertEqual(ThemeTokens.derived(from: hostileSeed), ThemeTokens.derived(from: hostileSeed))
    }
}
