import XCTest
@testable import NexusKit

/// The shipped catalogue's own guarantees.
///
/// `ThemeDerivationTests` proves the engine is correct for any seed; this proves
/// the twelve seeds actually shipped are ones worth shipping. Every assertion
/// here corresponds to a specific defect in the seven hand-authored themes this
/// catalogue replaced — duplicate ladder rungs, light themes with no headroom
/// above the canvas, borders identical to the surfaces they bound, a sidebar
/// whose rendered value depended on the user's wallpaper.
final class ThemeCatalogTests: XCTestCase {
    private var seeds: [ThemeSeed] { ThemeCatalog.seeds }

    // MARK: - Shape of the catalogue

    func testShipsTwelveSeeds() {
        XCTAssertEqual(seeds.count, 12)
        XCTAssertEqual(AppTheme.all.count, seeds.count, "every seed must expand to a theme")
    }

    func testSeedIdsAreUnique() {
        let ids = seeds.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    /// The brief this catalogue was built to: a strong set of dark themes plus
    /// several light ones. Asserted rather than assumed, because "we shipped
    /// enough darks" is exactly the kind of claim that quietly stops being true.
    func testCoversTheRequestedRegisters() {
        let dark = seeds.filter(\.isDark)
        let light = seeds.filter { !$0.isDark }
        XCTAssertGreaterThanOrEqual(dark.count, 5, "brief asks for at least five good dark themes")
        XCTAssertGreaterThanOrEqual(light.count, 3, "brief asks for several light themes")

        for required in ["neon", "sumi", "storm"] {
            XCTAssertTrue(seeds.contains { $0.id == required }, "missing the \(required) register")
        }
    }

    func testDefaultThemeIsInTheCatalogue() {
        XCTAssertNotNil(AppTheme.named(AppTheme.defaultThemeId))
        XCTAssertEqual(AppTheme.defaultThemeId, "storm")
    }

    // MARK: - Every seed clears its own floors

    /// The single most important test in the file: `validate()` encodes every
    /// contrast and ladder rule, and this runs it against all twelve.
    func testEverySeedValidates() {
        for seed in seeds {
            let violations = seed.validate()
            XCTAssertTrue(
                violations.isEmpty,
                "\(seed.id) violates:\n" + violations.map(\.description).joined(separator: "\n")
            )
        }
    }

    // MARK: - The ladder defects that shipped last time

    /// `level2 == level3` shipped in five of seven previous themes, which left a
    /// popover with no rung above the card it floats over.
    func testNoThemeHasDuplicateLadderRungs() {
        for theme in AppTheme.all {
            let surfaces = (0...3).map { theme.elevation.step($0).surface.uppercased() }
            XCTAssertEqual(
                Set(surfaces).count, surfaces.count,
                "\(theme.id) repeats an elevation surface: \(surfaces.joined(separator: " "))"
            )
        }
    }

    /// A border that equals the surface it bounds draws nothing.
    /// `chromeBorderSubtle == surfaceOverlay` shipped in four previous themes.
    func testBorderIsNeverTheSurfaceItBounds() {
        for theme in AppTheme.all {
            for level in 0...3 {
                let step = theme.elevation.step(level)
                XCTAssertNotEqual(
                    step.border.uppercased(), step.surface.uppercased(),
                    "\(theme.id) level \(level): border is the same colour as its surface"
                )
            }
        }
    }

    /// Perceptual steps, in L\* — the honest metric for two large adjacent
    /// fills. See `Hex.lightness` for why the WCAG ratio is the wrong tool here.
    func testDarkLaddersClearThePerceptualFloor() {
        for seed in seeds where seed.isDark {
            let ladder = [seed.surfaces.sunken, seed.surfaces.base, seed.surfaces.raised, seed.surfaces.overlay]
            for index in 0..<(ladder.count - 1) {
                let step = abs(Hex.lightness(ladder[index + 1]) - Hex.lightness(ladder[index]))
                XCTAssertGreaterThanOrEqual(
                    step, 3.0,
                    "\(seed.id): \(ladder[index])→\(ladder[index + 1]) is only ΔL* \(String(format: "%.2f", step))"
                )
            }
        }
    }

    /// The light-theme structural gap: the previous light themes ran
    /// `#E7E9EC → #FFFFFF → #FFFFFF → #FFFFFF`, so "raised" had nowhere to go
    /// and the user's own turn had to be recessed instead. White is a ceiling,
    /// so a light theme must not spend it on the canvas or on a middle rung.
    func testLightThemesKeepHeadroomAboveTheCanvas() {
        for seed in seeds where !seed.isDark {
            XCTAssertNotEqual(
                seed.surfaces.overlay.uppercased(), "#FFFFFF",
                "\(seed.id): top rung is pure white, leaving nothing above it"
            )
            let below = Hex.lightness(seed.surfaces.base) - Hex.lightness(seed.surfaces.sunken)
            XCTAssertGreaterThanOrEqual(below, 3.0, "\(seed.id): sunken is not far enough below the canvas")

            let above = [
                Hex.lightness(seed.surfaces.raised) - Hex.lightness(seed.surfaces.base),
                Hex.lightness(seed.surfaces.overlay) - Hex.lightness(seed.surfaces.raised),
            ]
            for step in above {
                XCTAssertGreaterThanOrEqual(step, 1.2, "\(seed.id): a rung above the canvas is flat")
            }
        }
    }

    // MARK: - Contrast, at the register this app reads at

    func testBodyTextClearsSevenToOne() {
        for theme in AppTheme.all {
            let ratio = Hex.contrast(theme.tokens.textPrimary, theme.tokens.surfaceBase)
            XCTAssertGreaterThanOrEqual(ratio, 7.0, "\(theme.id): body text is \(String(format: "%.2f", ratio)):1")
        }
    }

    /// `SoftButton.neutral` composites `textSecondary` onto `surfaceOverlay`,
    /// which on a dark theme is LIGHTER than the canvas — so clearing the floor
    /// on the canvas does not imply clearing it on the control. Grove failed
    /// exactly here at 3.88:1 before the derivation started enforcing both.
    func testSecondaryTextClearsTheFloorOnTheControlSurfaceToo() {
        for theme in AppTheme.all {
            let ratio = Hex.contrast(theme.tokens.textSecondary, theme.tokens.surfaceOverlay)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.id): secondary on overlay is \(String(format: "%.2f", ratio)):1")
        }
    }

    /// Six syntax roles that are six shades of one colour are not six roles.
    ///
    /// Hue OR lightness — see `ThemeSeed.validate`'s note for why a pure-hue
    /// rule is wrong about how colour is actually told apart, and for the
    /// measurements behind the 20° / 8 ΔL* boundary.
    func testSyntaxRolesAreActuallyDistinguishable() {
        for seed in seeds {
            let roles: [(String, String)] = [
                ("keyword", seed.syntax.keyword), ("function", seed.syntax.function),
                ("type", seed.syntax.type), ("string", seed.syntax.string), ("number", seed.syntax.number),
            ]
            for outer in 0..<roles.count {
                for inner in (outer + 1)..<roles.count {
                    let separation = Hex.hueSeparation(roles[outer].1, roles[inner].1)
                    let lightnessGap = abs(Hex.lightness(roles[outer].1) - Hex.lightness(roles[inner].1))
                    XCTAssertTrue(
                        separation >= 20 || lightnessGap >= 8,
                        """
                        \(seed.id): \(roles[outer].0)/\(roles[inner].0) are only \
                        \(String(format: "%.1f", separation))° apart at ΔL* \(String(format: "%.1f", lightnessGap))
                        """
                    )
                }
            }
        }
    }

    // MARK: - The material must not govern value

    /// **The worst defect this codebase has shipped, as an assertion.**
    ///
    /// A translucent sidebar renders as a function of the user's wallpaper. The
    /// shipped build measured the sidebar — the theme's DARKEST token — at twice
    /// the luminance of the canvas beside it, inverting the entire depth story,
    /// because the material was drawn over the token instead of under it.
    ///
    /// White is the worst case a desktop can present. Composite each theme's
    /// sidebar fill over it at the opacity `themedFill` actually uses, and
    /// assert the ordering still holds.
    ///
    /// Every shipped theme currently declares a `.solid` sidebar, so for now
    /// this reduces to asserting the ladder itself — which is the point. The
    /// measurement that put them all at `.solid`: the largest material alpha
    /// that keeps the sidebar behind the canvas is **0.025** (Mocha; Storm and
    /// Moon 0.030, Neon 0.040), and a material at 2.5% is not doing anything a
    /// user could name. Translucency lost to the ladder on the evidence rather
    /// than on taste. The test keeps the general form so that a future theme
    /// opting back into a sidebar material fails here instead of on screen.
    func testSidebarStaysBehindTheCanvasOverAWhiteDesktop() {
        // Must match `themedFill` in DesignSystem.swift.
        for theme in AppTheme.all {
            let materialOpacity = theme.materials.sidebar == .solid ? 0 : (theme.isDark ? 0.06 : 0.04)
            let rendered = Hex.composite("#FFFFFF", over: theme.tokens.surfaceSunken, alpha: materialOpacity)
            let canvas = theme.elevation.step(1).surface

            XCTAssertLessThan(
                Hex.lightness(rendered), Hex.lightness(canvas),
                """
                \(theme.id): over a white desktop the sidebar renders at L* \
                \(String(format: "%.1f", Hex.lightness(rendered))), which is not behind \
                the canvas at L* \(String(format: "%.1f", Hex.lightness(canvas)))
                """
            )
        }
    }

    // MARK: - Pairing and migration

    func testEveryDeclaredPairIsReciprocalAndOppositeAppearance() throws {
        for seed in seeds {
            guard let pairId = seed.pairId else { continue }
            let partner = try XCTUnwrap(seeds.first { $0.id == pairId }, "\(seed.id) pairs with missing \(pairId)")
            XCTAssertNotEqual(partner.isDark, seed.isDark, "\(seed.id) and \(pairId) must be opposite appearances")
            XCTAssertEqual(partner.pairId, seed.id, "\(pairId) must pair back to \(seed.id)")
        }
    }

    /// Without the migration map, every existing user's saved `themeId` stops
    /// resolving and `WorkspaceModel` silently drops them on the default — their
    /// choice gone, with nothing on screen saying so.
    func testEveryRetiredThemeIdStillResolves() {
        let retired = ["meridian", "studio", "cinder", "daylight", "basalt", "vantage", "nightfall"]
        for id in retired {
            let resolved = AppTheme.resolving(id)
            XCTAssertNotNil(resolved, "retired id \(id) resolves to nothing")
            XCTAssertNotEqual(resolved?.id, id, "\(id) should map to a NEW theme, not itself")
        }
    }

    /// A retired dark theme must not land its user on a light one, and vice
    /// versa — the migration preserves register, not merely validity.
    func testMigrationPreservesAppearance() throws {
        let appearances: [String: Bool] = [
            "meridian": true, "cinder": true, "basalt": true, "vantage": true, "nightfall": true,
            "studio": false, "daylight": false,
        ]
        for (id, wasDark) in appearances {
            let resolved = try XCTUnwrap(AppTheme.resolving(id))
            XCTAssertEqual(resolved.isDark, wasDark, "\(id) migrated across appearances to \(resolved.id)")
        }
    }

    func testAnIdFromNeitherCatalogueDoesNotMigrate() {
        // Must stay `nil` so the caller can fall through to the 16 generated
        // terminal palettes rather than having them swallowed by the map.
        XCTAssertNil(ThemeCatalog.migrate("nexus-noir"))
        XCTAssertNil(ThemeCatalog.migrate("not-a-theme"))
    }

    func testACurrentIdMigratesToItself() {
        for seed in seeds {
            XCTAssertEqual(ThemeCatalog.migrate(seed.id), seed.id)
        }
    }

    // MARK: - Depth intent

    func testDarkThemesCarryAVisibleSpecularEdgeAndNoShadow() {
        for theme in AppTheme.all where theme.isDark {
            XCTAssertEqual(theme.depth.shadow, .none, "\(theme.id): a shadow over near-black is a grey smudge")
            // 0.11 — the value this replaced — composites to 1.398:1, i.e. to
            // nothing. Anything at or above 0.2 is an edge you can actually see.
            XCTAssertGreaterThanOrEqual(theme.depth.specular, 0.2, "\(theme.id): specular edge would be invisible")
        }
    }

    func testLightThemesCastShadowsInsteadOfCatchingHighlights() {
        for theme in AppTheme.all where !theme.isDark {
            XCTAssertEqual(theme.depth.shadow, .cast)
            XCTAssertEqual(theme.depth.specular, 0, "a white highlight on a white surface describes nothing")
        }
    }
}
