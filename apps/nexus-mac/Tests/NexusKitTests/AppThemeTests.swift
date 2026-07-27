import XCTest
import SwiftUI
@testable import NexusKit

/// `AppTheme` is hand-designed, not generated — so unlike `ThemeTests`, these
/// guard hand-authored data rather than a generator's output: every theme
/// must still define all 74 tokens, every colour must parse, and the
/// contrast floors this codebase has already been burned by (see the
/// "documented finding" about pure white on near-black) must hold for real.
final class AppThemeTests: XCTestCase {
    // MARK: - Completeness

    func testShipsBetweenSixAndEightHandDesignedThemes() {
        XCTAssertTrue((6...8).contains(AppTheme.all.count), "expected 6-8 hand-designed themes, found \(AppTheme.all.count)")
    }

    func testEveryThemeDefinesAllSeventyFourTokens() throws {
        let mirrorOfTokens = Mirror(reflecting: AppTheme.all[0].tokens)
        XCTAssertEqual(mirrorOfTokens.children.count, 74, "token count changed — update this test alongside ThemeTokens")

        for theme in AppTheme.all {
            XCTAssertEqual(Mirror(reflecting: theme.tokens).children.count, 74, "\(theme.id) does not define every token")
        }
    }

    func testEveryTokenInEveryThemeIsAParseableColour() throws {
        for theme in AppTheme.all {
            for child in Mirror(reflecting: theme.tokens).children {
                let hex = try XCTUnwrap(child.value as? String)
                XCTAssertNotNil(Color(hex: hex), "\(theme.id).\(child.label ?? "?") is not a valid colour: \(hex)")
            }
        }
    }

    func testEveryNonTokenColourFieldIsAParseableColour() {
        for theme in AppTheme.all {
            for level in 0...3 {
                let step = theme.elevation.step(level)
                XCTAssertNotNil(Color(hex: step.surface), "\(theme.id) elevation level \(level) surface is not a valid colour: \(step.surface)")
                XCTAssertNotNil(Color(hex: step.border), "\(theme.id) elevation level \(level) border is not a valid colour: \(step.border)")
            }
            for stop in theme.gradients.surfaceWash {
                XCTAssertNotNil(Color(hex: stop), "\(theme.id) surfaceWash stop is not a valid colour: \(stop)")
            }
            for stop in theme.gradients.accentGradient {
                XCTAssertNotNil(Color(hex: stop), "\(theme.id) accentGradient stop is not a valid colour: \(stop)")
            }
            XCTAssertNotNil(Color(hex: theme.accents.primary), "\(theme.id) accent primary is not a valid colour")
            XCTAssertNotNil(Color(hex: theme.accents.secondary), "\(theme.id) accent secondary is not a valid colour")
        }
    }

    func testThemeIdsAreUnique() {
        let ids = AppTheme.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    func testDefaultThemeResolves() {
        XCTAssertNotNil(AppTheme.named(AppTheme.defaultThemeId))
    }

    // MARK: - Register requirements

    func testAtLeastTwoLightThemesExist() {
        let lightThemes = AppTheme.all.filter { !$0.isDark }
        XCTAssertGreaterThanOrEqual(lightThemes.count, 2, "spec requires at least two light themes")
    }

    func testAtLeastOneHighContrastAccessibleThemeExists() {
        // A high-contrast theme is identifiable by an unusually strong body
        // contrast ratio (well above the 4.5:1 floor every theme must clear)
        // plus zero shadow/material usage, which is the actual accessibility
        // property we care about: predictable contrast, nothing translucent.
        let candidates = AppTheme.all.filter { theme in
            let body = Color.contrastRatio(theme.tokens.textPrimary, theme.tokens.surfaceBase)
            let flatMaterials = theme.materials.sidebar == .solid && theme.materials.overlay == .solid && theme.materials.composer == .solid
            let noShadow = (0...3).allSatisfy { theme.elevation.step($0).shadowOpacity == 0 }
            return body >= 7.0 && flatMaterials && noShadow
        }
        XCTAssertFalse(candidates.isEmpty, "expected at least one high-contrast/accessible theme (AAA body contrast, no material, no shadow)")
    }

    // MARK: - Contrast floors

    func testBodyTextClearsFourPointFiveToOneOnBaseSurface() {
        for theme in AppTheme.all {
            let ratio = Color.contrastRatio(theme.tokens.textPrimary, theme.tokens.surfaceBase)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.id): textPrimary on surfaceBase is \(ratio), below the 4.5:1 WCAG AA floor for body text")
        }
    }

    func testSecondaryTextClearsThreeToOneOnBaseSurface() {
        for theme in AppTheme.all {
            let ratio = Color.contrastRatio(theme.tokens.textSecondary, theme.tokens.surfaceBase)
            XCTAssertGreaterThanOrEqual(ratio, 3.0, "\(theme.id): textSecondary on surfaceBase is \(ratio), below the 3:1 floor for secondary text")
        }
    }

    func testNoDarkThemeUsesPureWhiteForPrimaryTextOnANearBlackSurface() {
        // Documented finding in this codebase: pure #FFFFFF on a near-black
        // surface glows. Every dark theme's body text must be an off-white.
        for theme in AppTheme.all where theme.isDark {
            XCTAssertNotEqual(
                theme.tokens.textPrimary.uppercased(), "#FFFFFF",
                "\(theme.id) uses pure white for textPrimary on a dark surface — use an off-white instead"
            )
        }
    }

    // MARK: - OS light/dark pairing

    func testEveryDeclaredPairIdActuallyResolves() {
        for theme in AppTheme.all where theme.pairId != nil {
            XCTAssertNotNil(theme.pairedTheme, "\(theme.id) declares pair \(theme.pairId!) which does not exist in AppTheme.all")
        }
    }

    func testDeclaredPairsResolveToTheOppositeAppearance() throws {
        for theme in AppTheme.all where theme.pairId != nil {
            let paired = try XCTUnwrap(theme.pairedTheme)
            XCTAssertNotEqual(paired.isDark, theme.isDark, "\(theme.id) and its pair \(paired.id) must be opposite appearances")

            let resolvedOpposite = theme.resolved(for: paired.isDark ? .dark : .light)
            XCTAssertEqual(resolvedOpposite.id, paired.id)

            let resolvedSame = theme.resolved(for: theme.isDark ? .dark : .light)
            XCTAssertEqual(resolvedSame.id, theme.id)
        }
    }

    func testAnUnpairedThemeResolvesToItselfInEitherScheme() {
        let unpaired = AppTheme.all.filter { $0.pairId == nil }
        XCTAssertFalse(unpaired.isEmpty, "expected at least one standalone theme")
        for theme in unpaired {
            XCTAssertEqual(theme.resolved(for: .light).id, theme.id)
            XCTAssertEqual(theme.resolved(for: .dark).id, theme.id)
        }
    }

    // MARK: - Bridge from NexusTheme (backward compatibility)

    func testEveryGeneratedThemeStillBridgesToAWorkingAppTheme() {
        // The 16 terminal-generated themes must keep rendering through the
        // richer model even though they were never hand-designed for it.
        for theme in NexusTheme.all {
            let app = theme.appTheme
            XCTAssertEqual(app.id, theme.id)
            XCTAssertEqual(app.tokens, theme.tokens)
            for level in 0...3 {
                XCTAssertNotNil(Color(hex: app.elevation.step(level).surface))
            }
        }
    }

    func testNexusThemeAllStillWorks() {
        // Guards against a regression in this task's own additive changes:
        // the 16 generated palettes stay fully intact and selectable — this
        // task added a second catalogue, it did not remove the first one.
        XCTAssertEqual(NexusTheme.all.count, 16)
        XCTAssertNotNil(NexusTheme.named(NexusTheme.defaultThemeId))
    }

    func testEnvironmentDefaultsToAHandDesignedTheme() {
        // `\.nexusTheme` now resolves to `AppTheme`, and its default is a
        // hand-designed theme (Meridian), not a generated one. A default
        // nobody changes is what most users will actually see, so shipping
        // seven good themes behind an unchanged terminal-derived default
        // would have fixed nothing from the user's seat.
        XCTAssertEqual(ThemeKey.defaultValue.id, AppTheme.defaultThemeId)
        XCTAssertNotNil(AppTheme.all.first { $0.id == ThemeKey.defaultValue.id })
    }

    // MARK: - Composed pairs (what a component actually renders)
    //
    // `testBodyTextClearsFourPointFiveToOneOnBaseSurface` and its secondary
    // sibling above check *reading* text — they would not have caught the two
    // real failures found by widening the check to what `SoftButton` and
    // `CountPill` actually composite as a filled background + a label on top
    // of it: `accentFg`/`accentDefault` measured 3.40 (Daylight) and 4.15
    // (Studio), both now fixed by darkening the accent fill (hue/saturation
    // held, only lightness moved — same instinct as never using pure white on
    // near-black: adjust the one component doing the least visual damage).
    // These tests assert every such pair directly from the theme's own
    // values, so a future theme (or a future edit to an existing one) cannot
    // reintroduce the same class of bug silently.

    func testSoftButtonNeutralToneClearsFourPointFiveToOne() {
        for theme in AppTheme.all {
            let ratio = Color.contrastRatio(theme.tokens.textSecondary, theme.tokens.surfaceOverlay)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.id): SoftButton .neutral (textSecondary on surfaceOverlay) is \(ratio)")
        }
    }

    func testSoftButtonAccentToneClearsFourPointFiveToOne() {
        for theme in AppTheme.all {
            let ratio = Color.contrastRatio(theme.tokens.accentFg, theme.tokens.accentDefault)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.id): SoftButton .accent (accentFg on accentDefault) is \(ratio)")
        }
    }

    func testSoftButtonAndCountPillDangerToneClearsFourPointFiveToOne() {
        for theme in AppTheme.all {
            let ratio = Color.contrastRatio(theme.tokens.errorFg, theme.tokens.errorBg)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.id): .danger (errorFg on errorBg) is \(ratio)")
        }
    }

    func testCountPillWarningToneClearsFourPointFiveToOne() {
        for theme in AppTheme.all {
            let ratio = Color.contrastRatio(theme.tokens.warningFg, theme.tokens.warningBg)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.id): CountPill .warning (warningFg on warningBg) is \(ratio)")
        }
    }

    func testCountPillAccentToneClearsFourPointFiveToOneViaComputedReadableText() {
        // `.accent`'s foreground is computed (`Color.readableText`), not a
        // fixed token — so what this asserts is the *contract* that
        // computation must uphold on every theme, not one hardcoded pairing.
        for theme in AppTheme.all {
            let primaryRatio = Color.contrastRatio(theme.tokens.textPrimary, theme.tokens.accentMuted)
            let inverseRatio = Color.contrastRatio(theme.tokens.textInverse, theme.tokens.accentMuted)
            let best = max(primaryRatio, inverseRatio)
            XCTAssertGreaterThanOrEqual(best, 4.5, "\(theme.id): CountPill .accent (best of textPrimary/textInverse on accentMuted) is \(best)")
        }
    }
}
