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
            let body = contrastRatio(theme.tokens.textPrimary, theme.tokens.surfaceBase)
            let flatMaterials = theme.materials.sidebar == .solid && theme.materials.overlay == .solid && theme.materials.composer == .solid
            let noShadow = (0...3).allSatisfy { theme.elevation.step($0).shadowOpacity == 0 }
            return body >= 7.0 && flatMaterials && noShadow
        }
        XCTAssertFalse(candidates.isEmpty, "expected at least one high-contrast/accessible theme (AAA body contrast, no material, no shadow)")
    }

    // MARK: - Contrast floors

    func testBodyTextClearsFourPointFiveToOneOnBaseSurface() {
        for theme in AppTheme.all {
            let ratio = contrastRatio(theme.tokens.textPrimary, theme.tokens.surfaceBase)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.id): textPrimary on surfaceBase is \(ratio), below the 4.5:1 WCAG AA floor for body text")
        }
    }

    func testSecondaryTextClearsThreeToOneOnBaseSurface() {
        for theme in AppTheme.all {
            let ratio = contrastRatio(theme.tokens.textSecondary, theme.tokens.surfaceBase)
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
        // the existing 16-theme picker must be completely unaffected.
        XCTAssertEqual(NexusTheme.all.count, 16)
        XCTAssertNotNil(NexusTheme.named(NexusTheme.defaultThemeId))
        XCTAssertEqual(ThemeKey.defaultValue.id, NexusTheme.defaultThemeId)
    }
}

// MARK: - WCAG 2.1 contrast ratio

/// Relative luminance and contrast ratio per WCAG 2.1, operating directly on
/// hex strings so tests read close to the spec's own formula rather than
/// routing through `Color` (whose component accessors are unreliable across
/// colour spaces in headless `swift test` runs).
private func contrastRatio(_ hexA: String, _ hexB: String) -> Double {
    func luminance(_ hex: String) -> Double {
        var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt64(text, radix: 16) else { return 0 }
        let r = Double((value >> 16) & 0xFF) / 255
        let g = Double((value >> 8) & 0xFF) / 255
        let b = Double(value & 0xFF) / 255
        func linearize(_ c: Double) -> Double {
            c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
    }

    let lumA = luminance(hexA)
    let lumB = luminance(hexB)
    let lighter = max(lumA, lumB)
    let darker = min(lumA, lumB)
    return (lighter + 0.05) / (darker + 0.05)
}
