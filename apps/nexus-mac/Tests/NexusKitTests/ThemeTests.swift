import XCTest
import SwiftUI
@testable import NexusKit

/// The themes are GENERATED from `packages/theme`, so these tests guard the
/// generator's output rather than hand-written data: every theme must be
/// complete, every token must be a parseable colour, and the app must agree with
/// the terminal about which palettes exist.
final class ThemeTests: XCTestCase {
    func testShipsTheFullBuiltInPalette() {
        XCTAssertEqual(NexusTheme.all.count, 16, "regenerate themes if the palette changed")
        XCTAssertTrue(NexusTheme.all.contains { $0.id == "nexus-noir" })
        XCTAssertTrue(NexusTheme.all.contains { $0.id == "paper-nexus" })
    }

    func testDefaultThemeResolves() {
        XCTAssertNotNil(NexusTheme.named(NexusTheme.defaultThemeId))
        // `ThemeKey.defaultValue` is `AppTheme`, not `NexusTheme` — the app
        // renders through the richer model unconditionally, and its default
        // is a hand-designed theme (see `AppThemeTests` for that contract).
        // This file's own concern is narrower: that the terminal catalogue's
        // `defaultThemeId` still resolves to a real theme in `NexusTheme.all`.
    }

    func testThemeIdsAreUnique() {
        let ids = NexusTheme.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    func testEveryTokenInEveryThemeIsAParseableColour() throws {
        let mirrorOfTokens = Mirror(reflecting: NexusTheme.all[0].tokens)
        XCTAssertEqual(mirrorOfTokens.children.count, 74, "token count changed — regenerate")

        for theme in NexusTheme.all {
            for child in Mirror(reflecting: theme.tokens).children {
                let hex = try XCTUnwrap(child.value as? String)
                XCTAssertNotNil(
                    Color(hex: hex),
                    "\(theme.id).\(child.label ?? "?") is not a valid colour: \(hex)"
                )
            }
        }
    }

    func testBothLightAndDarkThemesExist() {
        XCTAssertTrue(NexusTheme.all.contains(where: \.isDark))
        XCTAssertTrue(NexusTheme.all.contains { !$0.isDark })
    }

    // MARK: - Hex parsing

    func testParsesShorthandFullAndAlphaHex() throws {
        XCTAssertNotNil(Color(hex: "#fff"))
        XCTAssertNotNil(Color(hex: "#0A0E14"))
        XCTAssertNotNil(Color(hex: "#0A0E14FF"))
    }

    func testRejectsMalformedHexRatherThanRenderingBlack() {
        XCTAssertNil(Color(hex: "0A0E14"), "missing # must not silently parse")
        XCTAssertNil(Color(hex: "#xyzxyz"))
        XCTAssertNil(Color(hex: "#12345"))
        XCTAssertNil(Color(hex: ""))
    }

    // MARK: - OS pairing

    func testDarkThemeResolvesToItsLightSiblingInLightMode() throws {
        let noir = try XCTUnwrap(NexusTheme.named("nexus-noir"))
        XCTAssertTrue(noir.isDark)

        // Nexus Noir declares paper-nexus as its light pair.
        let resolved = noir.resolved(for: .light)
        XCTAssertFalse(resolved.isDark, "a dark theme must not be used verbatim in light mode")
        XCTAssertEqual(resolved.id, "paper-nexus")

        // …and stays itself in dark mode.
        XCTAssertEqual(noir.resolved(for: .dark).id, "nexus-noir")
    }

    func testAThemeWithNoPairStaysItself() throws {
        let unpaired = NexusTheme.all.first { $0.pairId == nil }
        guard let unpaired else { throw XCTSkip("every theme declares a pair") }
        XCTAssertEqual(unpaired.resolved(for: .light).id, unpaired.id)
        XCTAssertEqual(unpaired.resolved(for: .dark).id, unpaired.id)
    }

    func testEveryDeclaredPairIdActuallyResolves() {
        for theme in NexusTheme.all where theme.pairId != nil {
            XCTAssertNotNil(
                theme.pairedTheme,
                "\(theme.id) declares pair \(theme.pairId!) which does not exist"
            )
        }
    }
}
