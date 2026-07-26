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
            RootView()
                .environment(workspace)
                .environment(\.nexusTheme, workspace.activeTheme)
                .frame(minWidth: 900, minHeight: 560)
                .preferredColorScheme(workspace.activeTheme.isDark ? .dark : .light)
        }
        // `.unified(showsTitle: false)` collapsed the title-bar row and left the
        // sidebar column with no top safe area, drawing its header under the
        // traffic lights. `.unifiedCompact` keeps a real (slim) title bar, so
        // both columns get a correct inset.
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

/// Top-level app state: which project, which theme, which tab, and the
/// controllers that talk to the CLI and to OMC.
@MainActor
@Observable
final class WorkspaceModel {
    var tab: WorkspaceTab = .chat

    var themeId: String = NexusTheme.defaultThemeId {
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
        if let saved = defaults.string(forKey: Keys.theme), NexusTheme.named(saved) != nil {
            themeId = saved
        }
        attach()
    }

    var activeTheme: NexusTheme {
        NexusTheme.named(themeId) ?? NexusTheme.all[0]
    }

    /// Point the window at another project. Rebuilds the CLI client and restarts
    /// the OMC watcher, because both are scoped to a directory.
    func chooseProjectDirectory(_ url: URL) {
        omc?.stop()
        projectDirectory = url
    }

    private func attach() {
        guard let binary = NexusBinary.discover(repoRoot: projectDirectory) else {
            setupProblem = """
                Could not find the `nexus` executable. Install it, or set NEXUS_BIN \
                to its path, or point this window at a NexusCode checkout that has \
                been built.
                """
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
