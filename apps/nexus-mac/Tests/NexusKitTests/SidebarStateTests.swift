import XCTest
@testable import NexusKit

/// The sidebar's rules, which is the whole reason `SidebarState` is a testable
/// type instead of a few `@State` flags in `RootView`: an auto-collapse that
/// quietly eats the user's preference, or a restored width of zero, are both
/// invisible in a screenshot and obvious here.
@MainActor
final class SidebarStateTests: XCTestCase {
    /// A throwaway suite per test — `UserDefaults.standard` would let one test
    /// leak its persisted width into the next, and into the developer's own app.
    private func isolatedDefaults(_ name: String = #function) -> UserDefaults {
        let suite = UserDefaults(suiteName: "nexus.tests.sidebar.\(name)")!
        suite.removePersistentDomain(forName: "nexus.tests.sidebar.\(name)")
        return suite
    }

    // MARK: - Defaults

    func testDefaultsToExpandedAtTheDesignedWidth() {
        let state = SidebarState(defaults: isolatedDefaults())
        XCTAssertEqual(state.preference, .expanded)
        XCTAssertEqual(state.width, SidebarState.defaultWidth)
    }

    /// `double(forKey:)` answers 0 for a key that was never set. A sidebar
    /// restored to 0pt is a sidebar that isn't there — the exact reason the
    /// initialiser distinguishes "never saved" from "saved".
    func testANeverSavedWidthDoesNotRestoreAsZero() {
        let defaults = isolatedDefaults()
        XCTAssertNil(defaults.object(forKey: "nexus.sidebar.width"))

        let state = SidebarState(defaults: defaults)
        XCTAssertEqual(state.width, SidebarState.defaultWidth)
        XCTAssertGreaterThanOrEqual(state.width, SidebarState.minWidth)
    }

    // MARK: - Toggle + persistence

    func testToggleFlipsBetweenExpandedAndRail() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.toggle()
        XCTAssertEqual(state.preference, .rail)
        state.toggle()
        XCTAssertEqual(state.preference, .expanded)
    }

    /// `toggle()` is the everyday collapse and must never land on `.hidden` —
    /// removing the app's only navigation should take a deliberate, separate act.
    func testToggleNeverReachesHidden() {
        let state = SidebarState(defaults: isolatedDefaults())
        for _ in 0..<8 {
            state.toggle()
            XCTAssertNotEqual(state.preference, .hidden)
        }
    }

    /// Pressing the collapse key while nothing is showing should bring it back,
    /// not cycle deeper into invisibility.
    func testToggleRestoresFromHidden() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.toggleHidden()
        XCTAssertEqual(state.preference, .hidden)
        state.toggle()
        XCTAssertEqual(state.preference, .expanded)
    }

    func testToggleHiddenRestoresWhateverWasShowing() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.set(.rail)
        state.toggleHidden()
        XCTAssertEqual(state.preference, .hidden)
        state.toggleHidden()
        XCTAssertEqual(state.preference, .rail, "must return to the rail, not to expanded")
    }

    func testHiddenRendersAtZeroWidth() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.toggleHidden()
        XCTAssertEqual(state.renderedWidth(forWindowWidth: 1_440), 0)
        XCTAssertEqual(state.presentation(forWindowWidth: 1_440), .hidden)
    }

    /// The breakpoint may force something narrower; it must never force
    /// `.hidden`, and it must not override a deliberate hide either.
    func testWindowWidthNeverForcesOrLiftsHidden() {
        let state = SidebarState(defaults: isolatedDefaults())
        XCTAssertNotEqual(state.presentation(forWindowWidth: 400), .hidden, "narrow must collapse to the rail, not vanish")

        state.toggleHidden()
        XCTAssertEqual(state.presentation(forWindowWidth: 1_920), .hidden, "a wide window must not undo a deliberate hide")
    }

    /// A relaunch that comes up with no navigation at all is indistinguishable
    /// from the app having failed to draw.
    func testHiddenIsNotRestoredOnRelaunch() {
        let defaults = isolatedDefaults()
        let first = SidebarState(defaults: defaults)
        first.toggleHidden()
        XCTAssertEqual(first.preference, .hidden)

        let relaunched = SidebarState(defaults: defaults)
        XCTAssertNotEqual(relaunched.preference, .hidden)
        XCTAssertEqual(relaunched.preference, .expanded)
    }

    func testPreferenceSurvivesRelaunch() {
        let defaults = isolatedDefaults()
        let first = SidebarState(defaults: defaults)
        first.toggle()
        XCTAssertEqual(first.preference, .rail)

        let relaunched = SidebarState(defaults: defaults)
        XCTAssertEqual(relaunched.preference, .rail)
    }

    func testWidthSurvivesRelaunch() {
        let defaults = isolatedDefaults()
        let first = SidebarState(defaults: defaults)
        // Deliberately not near a snap stop, so this measures persistence
        // rather than accidentally measuring the magnetism.
        first.resize(to: 312)

        let relaunched = SidebarState(defaults: defaults)
        XCTAssertEqual(relaunched.width, 312)
    }

    // MARK: - Snap

    func testDragSnapsToANearbyStop() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.resize(to: 245)
        XCTAssertEqual(state.width, 240, "245 is within 8pt of the 240 stop")
        state.resize(to: 294)
        XCTAssertEqual(state.width, 288)
    }

    func testDragDoesNotSnapWhenFarFromAStop() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.resize(to: 265)
        XCTAssertEqual(state.width, 265, "265 is 17pt from the nearest stop and must be honoured exactly")
    }

    func testEverySnapStopIsInsideTheDragRange() {
        for stop in SidebarState.snapStops {
            XCTAssertGreaterThanOrEqual(stop, SidebarState.minWidth)
            XCTAssertLessThanOrEqual(stop, SidebarState.maxWidth)
        }
    }

    // MARK: - Resize

    func testResizeClampsToTheAllowedRange() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.resize(to: 40)
        XCTAssertEqual(state.width, SidebarState.minWidth)
        state.resize(to: 2_000)
        XCTAssertEqual(state.width, SidebarState.maxWidth)
    }

    /// A rail has exactly one correct width, so a drag arriving in rail state
    /// must not silently store a width whose effect the user cannot see.
    func testResizeIsIgnoredWhileCollapsedToTheRail() {
        let state = SidebarState(defaults: isolatedDefaults())
        let original = state.width
        state.set(.rail)
        state.resize(to: 340)
        XCTAssertEqual(state.width, original)
    }

    func testResetWidthReturnsToTheDesignedWidth() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.resize(to: SidebarState.maxWidth)
        state.resetWidth()
        XCTAssertEqual(state.width, SidebarState.defaultWidth)
    }

    // MARK: - Auto-collapse breakpoint

    func testNarrowWindowsRenderAsARailRegardlessOfPreference() {
        let state = SidebarState(defaults: isolatedDefaults())
        XCTAssertEqual(state.preference, .expanded)
        XCTAssertEqual(state.presentation(forWindowWidth: 900), .rail)
        XCTAssertEqual(state.renderedWidth(forWindowWidth: 900), SidebarState.railWidth)
    }

    /// **The regression this split exists to prevent.** If the breakpoint wrote
    /// through to `preference`, then narrowing and re-widening a window would
    /// leave the sidebar collapsed forever, with nothing recording that the user
    /// ever wanted it open.
    func testAutoCollapseDoesNotOverwriteTheUsersPreference() {
        let state = SidebarState(defaults: isolatedDefaults())
        _ = state.presentation(forWindowWidth: 700)
        XCTAssertEqual(state.preference, .expanded, "the breakpoint must not consume the preference")
        XCTAssertEqual(state.presentation(forWindowWidth: 1_440), .expanded, "re-widening must restore it")
    }

    /// The breakpoint can force the rail; it can never force expansion. A user
    /// who collapsed the sidebar on a wide window meant it.
    func testAWideWindowNeverForcesTheSidebarBackOpen() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.set(.rail)
        XCTAssertEqual(state.presentation(forWindowWidth: 1_920), .rail)
        XCTAssertEqual(state.renderedWidth(forWindowWidth: 1_920), SidebarState.railWidth)
    }

    func testRenderedWidthHonoursADraggedWidthOnAWideWindow() {
        let state = SidebarState(defaults: isolatedDefaults())
        state.resize(to: 305)
        XCTAssertEqual(state.renderedWidth(forWindowWidth: 1_440), 305)
    }

    // MARK: - Geometry sanity

    func testTheRailIsNarrowerThanTheNarrowestExpandedWidth() {
        XCTAssertLessThan(SidebarState.railWidth, SidebarState.minWidth)
    }

    func testTheDefaultWidthSitsInsideTheDragRange() {
        XCTAssertGreaterThanOrEqual(SidebarState.defaultWidth, SidebarState.minWidth)
        XCTAssertLessThanOrEqual(SidebarState.defaultWidth, SidebarState.maxWidth)
    }

    /// At the app's own 900pt minimum window width the sidebar must already be
    /// a rail — that is the case the breakpoint was chosen for.
    func testTheBreakpointIsAboveTheAppsMinimumWindowWidth() {
        XCTAssertGreaterThan(SidebarState.autoCollapseBelow, 900)
    }
}
