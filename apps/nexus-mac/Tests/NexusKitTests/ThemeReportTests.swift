import XCTest
@testable import NexusKit

/// Not an assertion — a printout. Run with
/// `swift test --filter ThemeReportTests` to see what the catalogue actually
/// measures, which is how a palette gets tuned without guessing.
final class ThemeReportTests: XCTestCase {
    func testPrintCatalogueMeasurements() {
        print("\nid          appearance  body   2ndry  muted  accent  ladder ΔL*")
        print(String(repeating: "-", count: 74))
        for theme in AppTheme.all {
            let t = theme.tokens
            let base = t.surfaceBase
            let rungs = (0...3).map { theme.elevation.step($0).surface }
            let steps = (0..<3).map { abs(Hex.lightness(rungs[$0 + 1]) - Hex.lightness(rungs[$0])) }
            let line = String(
                format: "%-11@ %-11@ %5.2f  %5.2f  %5.2f  %5.2f   %.1f/%.1f/%.1f",
                theme.id as NSString,
                (theme.isDark ? "dark" : "light") as NSString,
                Hex.contrast(t.textPrimary, base),
                Hex.contrast(t.textSecondary, base),
                Hex.contrast(t.textMuted, base),
                Hex.contrast(t.accentDefault, base),
                steps[0], steps[1], steps[2]
            )
            print(line)
        }
        print("")
    }
}
