import SwiftUI
import NexusKit

/// NexusCode for macOS.
///
/// The window is a control surface over the `nexus` CLI. Nothing here talks to a
/// provider, holds a key, or decides anything about a run — it composes commands
/// and renders the events they emit.
@main
struct NexusMacApp: App {
    @State private var workspace = WorkspaceModel()

    var body: some Scene {
        WindowGroup {
            ThemedRoot()
                .environment(workspace)
                .frame(minWidth: 900, minHeight: 560)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // `.unified(showsTitle: false)` collapsed the title-bar row and left the
        // sidebar column with no top safe area, drawing its header under the
        // traffic lights. `.unifiedCompact` keeps a real (slim) title bar, so
        // both columns get a correct inset.
        // An explicit default size: `RootView` is greedy in both axes
        // (`maxWidth/maxHeight: .infinity`), which leaves a macOS window with no
        // ideal size to resolve — a window that cannot size itself may never
        // become visible at all.
        .defaultSize(width: 1280, height: 860)
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Conversation") { workspace.conversation?.clear() }
                    .keyboardShortcut("n", modifiers: .command)
            }
            CommandMenu("Run") {
                Button("Stop") { workspace.conversation?.cancel() }
                    .keyboardShortcut(".", modifiers: .command)
                    .disabled(workspace.conversation?.isRunning != true)
                Divider()
                ForEach(WorkspaceTab.allCases) { tab in
                    Button(tab.title) { workspace.tab = tab }
                }
            }
        }
    }
}

/// Resolves the selected theme against the OS's actual light/dark setting
/// before anything below it renders, so a paired theme (Meridian↔Studio,
/// Cinder↔Daylight) follows System Appearance the way a native app does,
/// instead of staying locked to whichever brightness was active when it was
/// picked. An unpaired theme (Basalt, Vantage, Nightfall) has no sibling to
/// switch to, so `resolved(for:)` returns it unchanged in either scheme —
/// that theme simply doesn't follow the OS, which is the correct behaviour
/// for a theme that was never designed with a light/dark counterpart.
///
/// `@Environment(\.colorScheme)` read here is the OS's own truth: nothing
/// above this view calls `.preferredColorScheme`, so SwiftUI hasn't been told
/// to override it yet. The resolved theme's `isDark` is what gets asserted
/// downstream via `.preferredColorScheme` below — so native chrome (title
/// bar, scrollbars, the traffic lights) always matches what this window is
/// actually showing, never the raw OS setting when they disagree (i.e. an
/// unpaired dark theme picked while the Mac is in Light Mode). Reading
/// `colorScheme` and asserting it are deliberately two different steps so
/// this doesn't feed back into itself.
private struct ThemedRoot: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.colorScheme) private var systemScheme

    private var resolvedTheme: AppTheme {
        workspace.activeTheme.resolved(for: systemScheme)
    }

    var body: some View {
        RootView()
            .environment(\.nexusTheme, resolvedTheme)
            .preferredColorScheme(resolvedTheme.isDark ? .dark : .light)
    }
}

/// Top-level app state: which project, which theme, which tab, and the
/// controllers that talk to the CLI and to OMC.
@MainActor
@Observable
final class WorkspaceModel {
    var tab: WorkspaceTab = .chat

    /// An id from EITHER catalogue: one of the 7 hand-designed `AppTheme`s or
    /// one of the 16 generated `NexusTheme`s. `activeTheme` below resolves
    /// whichever one it turns out to be through the same `AppTheme` model, so
    /// nothing downstream needs to know which catalogue the user picked from.
    var themeId: String = AppTheme.defaultThemeId {
        didSet { defaults.set(themeId, forKey: Keys.theme) }
    }

    private(set) var conversation: ConversationController?
    private(set) var omc: OMCController?
    private(set) var binaryPath: String?
    /// The resolved CLI, exposed so a screen can build its own controller
    /// (providers, sessions, tasks) without WorkspaceModel having to own one
    /// of every kind.
    private(set) var binary: NexusBinary?
    /// Set when the CLI could not be located — the UI explains rather than
    /// failing silently on every action.
    private(set) var setupProblem: String?

    var projectDirectory: URL {
        didSet {
            defaults.set(projectDirectory.path, forKey: Keys.project)
            attach()
        }
    }

    private let defaults: UserDefaults
    private enum Keys {
        static let project = "nexus.projectDirectory"
        static let theme = "nexus.themeId"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Launched from Finder, the working directory is `/` — useless as a
        // project root. Prefer the last directory the user actually chose, so
        // the app reopens where they left off, and fall back to the working
        // directory only when it looks like a real project (i.e. launched from
        // a terminal inside one).
        projectDirectory = ProjectLocation.resolve(
            remembered: defaults.string(forKey: Keys.project)
        )
        if let saved = defaults.string(forKey: Keys.theme),
           AppTheme.named(saved) != nil || NexusTheme.named(saved) != nil {
            themeId = saved
        }
        attach()
    }

    /// Resolves `themeId` through whichever catalogue actually defines it,
    /// preferring a hand-designed theme when (implausibly) both did. A
    /// generated palette comes back through `NexusTheme.appTheme` — the same
    /// richer model either way, so `ThemedRoot` never needs to branch on
    /// which catalogue answered.
    var activeTheme: AppTheme {
        AppTheme.named(themeId)
            ?? NexusTheme.named(themeId)?.appTheme
            ?? AppTheme.named(AppTheme.defaultThemeId)
            ?? AppTheme.all[0]
    }

    /// Point the window at another project. Rebuilds the CLI client and restarts
    /// the OMC watcher, because both are scoped to a directory.
    func chooseProjectDirectory(_ url: URL) {
        omc?.stop()
        projectDirectory = url
    }

    private func attach() {
        guard let binary = NexusBinary.discover(repoRoot: projectDirectory) else {
            // The one place `NexusBinary.explainMissing` needs calling for
            // THIS window's own conversation/OMC wiring — every view-level
            // fallback below reads `setupProblem` back out rather than
            // calling it again, so this is the only call site.
            setupProblem = NexusBinary.explainMissing()
            conversation = nil
            omc = nil
            self.binary = nil
            return
        }
        setupProblem = nil
        binaryPath = binary.url.path
        self.binary = binary
        conversation = ConversationController(
            client: NexusClient(binary: binary),
            binary: binary,
            workingDirectory: projectDirectory
        )
        let controller = OMCController(discoveringFrom: projectDirectory)
        controller.start()
        omc = controller
    }
}
