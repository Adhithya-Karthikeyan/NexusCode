import AppKit
import SwiftUI

/// Writes a PNG of this window's own view hierarchy, then quits.
///
/// **Why this exists rather than `screencapture -l<windowid>`.** The external
/// route needs a live WindowServer capture, which means it needs Screen
/// Recording permission granted to whatever shell is driving it — and when that
/// permission is absent or revoked, `screencapture` fails with "could not
/// create image from window" for a window that `CGWindowListCopyWindowInfo`
/// reports as onscreen at full alpha. That failure mode is indistinguishable
/// from a broken app, which is exactly the kind of misleading evidence this
/// project has already thrown away three captures over.
///
/// `cacheDisplay(in:to:)` renders the view tree straight into a bitmap through
/// the app's own drawing path. It needs no permission, cannot pick up another
/// window that happens to be in front, and captures the same layout the user
/// sees at the same backing scale.
///
/// **Its one real limitation, stated plainly:** an `NSVisualEffectView` behind a
/// SwiftUI `Material` samples what is *behind the window*, which a cached
/// render has no access to — so themes that opt into translucency come out at
/// their flat token colour instead of the blurred one. That is a faithful
/// picture of the token ladder and of every layout decision, and a slightly
/// darker one of the three surfaces `MaterialUsage` names. Anything being
/// judged specifically on vibrancy still needs a real screen capture.
///
/// Inert unless `NEXUS_UI_SHOT` is set, exactly like the other verification
/// seams (`NEXUS_UI_TAB`, `NEXUS_UI_THEME`, `NEXUS_UI_DEMO`) — a normal launch
/// never enters any of this.
enum ScreenshotSeam {
    /// Main-actor isolated rather than a bare `static var`: every access is
    /// from `armIfRequested`, which SwiftUI only ever calls on the main actor,
    /// and isolating it is what makes that a checked fact instead of a comment.
    @MainActor private static var armed = false

    /// Schedules the capture if the environment asked for one. Safe to call
    /// more than once — SwiftUI will re-run `onAppear` on a view that comes
    /// back, and a second timer would race the first one's `terminate`.
    @MainActor
    static func armIfRequested() {
        guard !armed, let path = ProcessInfo.processInfo.environment["NEXUS_UI_SHOT"] else { return }
        armed = true

        // Long enough for the async controllers a screen depends on to settle.
        // Overridable because the right answer is per-screen, not global:
        // `IntegrationsController.refresh` alone allows 20s across three
        // concurrent CLI calls, and capturing before it lands photographs a
        // spinner and calls it a layout.
        let delay = Double(ProcessInfo.processInfo.environment["NEXUS_UI_SHOT_DELAY"] ?? "") ?? 6

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            let wrote = capture(to: path)
            // Report on stderr rather than failing silently: a harness that
            // gets an exit code of 0 and no file has no way to tell "the app
            // never drew" from "the path was unwritable".
            if !wrote {
                FileHandle.standardError.write("NEXUS_UI_SHOT: no capturable window\n".data(using: .utf8)!)
            }
            NSApp.terminate(nil)
        }
    }

    @MainActor
    private static func capture(to path: String) -> Bool {
        // The real document window, never a panel or the invisible helper
        // windows AppKit keeps around: those are `isVisible` too, and grabbing
        // one yields a 1x1 PNG that looks like a rendering bug.
        let candidates = NSApp.windows.filter { $0.isVisible && $0.contentView != nil && $0.frame.width > 200 }
        guard let window = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }),
              let view = window.contentView
        else { return false }

        let bounds = view.bounds
        guard bounds.width > 0, bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: bounds)
        else { return false }

        // Reported, not assumed. A cached render has no traffic lights in it,
        // so "is the sidebar header clear of them" is not answerable by looking
        // at the PNG — and this app has already drawn its own header under the
        // traffic lights once. The top inset is the number that decides it.
        let insets = view.safeAreaInsets
        FileHandle.standardError.write(
            "NEXUS_UI_SHOT: content=\(Int(bounds.width))x\(Int(bounds.height)) safeAreaTop=\(insets.top)\n"
                .data(using: .utf8)!
        )

        rep.size = bounds.size
        view.cacheDisplay(in: bounds, to: rep)

        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            return true
        } catch {
            FileHandle.standardError.write("NEXUS_UI_SHOT: \(error.localizedDescription)\n".data(using: .utf8)!)
            return false
        }
    }
}
