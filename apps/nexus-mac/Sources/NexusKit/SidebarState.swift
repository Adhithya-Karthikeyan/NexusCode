import Foundation
import Observation

/// How the left rail is presented right now.
///
/// The everyday collapse is `expanded ↔ rail`, not `expanded ↔ gone`: an icon
/// rail keeps all eight destinations one click away at a quarter of the width,
/// which is the model Linear, Slack, Xcode and Zed all converge on.
///
/// `hidden` exists as well, but it is a different kind of act and is kept
/// behind a different key. It became safe to offer only once ⌘1–⌘8 reached every
/// destination without the sidebar — without those, an app whose only navigation
/// can vanish is an app a user can get stranded in.
public enum SidebarPresentation: String, Sendable, Hashable {
    /// Full width: icons, labels, group headings, badges, recents.
    case expanded
    /// Icon-only rail. Labels survive as tooltips and accessibility labels.
    case rail
    /// Gone entirely, for reading a long transcript on a small screen.
    ///
    /// Deliberately NOT reachable from the ordinary collapse toggle, and
    /// deliberately never chosen by the width breakpoint. An app whose only
    /// navigation can vanish is an app a user can get stranded in — so this
    /// state exists only because ⌘1–⌘8 reach every destination without it, and
    /// only as an explicit act (⌃⌘S). `toggle()` cycles expanded ↔ rail and
    /// never lands here.
    case hidden
}

/// The sidebar's geometry and collapse state, as a testable value type.
///
/// Kept in `NexusKit` rather than inline in `WorkspaceModel` (which lives in the
/// app target and so is unreachable from `swift test`) because the interesting
/// parts here are all rules — clamping, the auto-collapse breakpoint, what a
/// user's explicit choice must override — and a rule that cannot be tested is a
/// rule that silently rots. The view layer owns only the animation.
@MainActor
@Observable
public final class SidebarState {
    /// The rail's fixed width. A 16pt glyph in a 24pt target plus optical
    /// margins — wide enough to be a real hit target, narrow enough to read as
    /// chrome rather than as a second column. 56 is where the field has landed
    /// (shadcn 56, Arc 48, VS Code 48).
    public static let railWidth: CGFloat = 56

    /// Drag-resize bounds for the expanded rail.
    ///
    /// The floor is the point below which "Integrations" — the longest nav
    /// label — starts truncating; below that the expanded state is strictly
    /// worse than the rail, so the drag stops there rather than degrading into
    /// a column of ellipses.
    public static let minWidth: CGFloat = 200
    /// 340, not 380: at the 1280pt default window, 380 is 30% of the frame —
    /// the same disproportion the fixed-width sidebar was criticised for.
    public static let maxWidth: CGFloat = 340
    public static let defaultWidth: CGFloat = 240

    /// Widths the drag snaps to: the minimum, the designed width, and one
    /// comfortable step above it for long project names.
    ///
    /// Applied live during the drag rather than corrected on release, so the
    /// magnetism is something the user feels and can aim at instead of a jump
    /// that happens after they have let go.
    public static let snapStops: [CGFloat] = [200, 240, 288]
    /// How close a drag must come to a stop before it snaps.
    public static let snapDistance: CGFloat = 8

    /// Below this window width the sidebar auto-collapses to the rail.
    ///
    /// A fixed-width sidebar takes a LARGER share of the window the narrower the
    /// window gets — at the app's 900pt minimum a 252pt rail was eating 28% of
    /// the frame. Every competitor narrows or collapses instead of holding
    /// width, which is what this breakpoint restores.
    public static let autoCollapseBelow: CGFloat = 1_000

    /// What the user last asked for, independent of what the window is
    /// currently wide enough to honour.
    ///
    /// Split from `presentation(forWindowWidth:)` deliberately: if a narrow
    /// window overwrote the stored preference, then widening the window again
    /// would leave the sidebar collapsed with no memory that the user ever
    /// wanted it open — the auto-collapse would have silently become a
    /// permanent decision. This holds the intent; the breakpoint only overrides
    /// how it is *rendered*.
    public private(set) var preference: SidebarPresentation {
        didSet { defaults.set(preference.rawValue, forKey: Keys.presentation) }
    }

    /// The expanded width, as last dragged.
    public private(set) var width: CGFloat {
        didSet { defaults.set(Double(width), forKey: Keys.width) }
    }

    /// What to restore when `.hidden` is lifted. Not persisted: hiding is a
    /// momentary act for one reading session, and a relaunch that came back
    /// with no navigation at all would be indistinguishable from a broken app.
    private var lastVisible: SidebarPresentation = .expanded

    private let defaults: UserDefaults

    private enum Keys {
        static let presentation = "nexus.sidebar.presentation"
        static let width = "nexus.sidebar.width"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let raw = defaults.string(forKey: Keys.presentation),
           let restored = SidebarPresentation(rawValue: raw),
           // Never restore `.hidden`. It is a momentary state for reading one
           // long transcript; coming back from a relaunch with no navigation
           // visible is indistinguishable from the app having failed to draw.
           restored != .hidden {
            preference = restored
        } else {
            preference = .expanded
        }
        // `double(forKey:)` answers 0 for a key that was never set, and a 0pt
        // sidebar is a sidebar that isn't there — so a never-saved width has to
        // be told apart from a saved one rather than clamped up from zero.
        if defaults.object(forKey: Keys.width) != nil {
            width = Self.clamp(CGFloat(defaults.double(forKey: Keys.width)))
        } else {
            width = Self.defaultWidth
        }
        // Verification seam, same contract as `NEXUS_UI_TAB`/`NEXUS_UI_THEME`:
        // the rail has to be capturable at ANY window width, not only below the
        // auto-collapse breakpoint, or the only way to photograph it is to also
        // change the thing being photographed. Applied last so it wins over the
        // restored preference; unset means a normal launch is untouched.
        if let forced = ProcessInfo.processInfo.environment["NEXUS_UI_SIDEBAR"],
           let presentation = SidebarPresentation(rawValue: forced) {
            preference = presentation
        }
    }

    /// How the sidebar should actually render at this window width.
    ///
    /// The breakpoint may force something NARROWER than the preference; it may
    /// never force something wider, and it may never force `.hidden`. A user who
    /// collapsed the sidebar on a wide window meant it, and a user who hid it
    /// entirely meant that even more.
    public func presentation(forWindowWidth windowWidth: CGFloat) -> SidebarPresentation {
        if preference == .hidden { return .hidden }
        guard windowWidth >= Self.autoCollapseBelow else { return .rail }
        return preference
    }

    /// The width the sidebar column should occupy at this window width.
    public func renderedWidth(forWindowWidth windowWidth: CGFloat) -> CGFloat {
        switch presentation(forWindowWidth: windowWidth) {
        case .hidden: return 0
        case .rail: return Self.railWidth
        case .expanded: return width
        }
    }

    /// Flips between expanded and the rail. Bound to the toggle control and
    /// ⌘B; never called by the breakpoint, and never lands on `.hidden`.
    ///
    /// From `.hidden` this restores rather than cycles — the natural reading of
    /// pressing the collapse key while nothing is shown is "bring it back".
    public func toggle() {
        switch preference {
        case .expanded: preference = .rail
        case .rail, .hidden: preference = .expanded
        }
    }

    /// ⌃⌘S: away entirely, and back to whatever was showing before.
    public func toggleHidden() {
        if preference == .hidden {
            preference = lastVisible
        } else {
            lastVisible = preference
            preference = .hidden
        }
    }

    public func set(_ presentation: SidebarPresentation) {
        preference = presentation
    }

    /// Applies a drag, clamped to the allowed range.
    ///
    /// Dragging is only meaningful while expanded — a rail has one correct
    /// width — so a drag arriving in rail state is ignored rather than silently
    /// storing a width the user cannot see the effect of.
    public func resize(to candidate: CGFloat) {
        guard preference == .expanded else { return }
        let snapped = Self.snapStops.first { abs($0 - candidate) <= Self.snapDistance } ?? candidate
        width = Self.clamp(snapped)
    }

    /// Double-click on the drag handle: back to the designed width.
    public func resetWidth() {
        width = Self.defaultWidth
    }

    static func clamp(_ value: CGFloat) -> CGFloat {
        min(max(value, minWidth), maxWidth)
    }
}
