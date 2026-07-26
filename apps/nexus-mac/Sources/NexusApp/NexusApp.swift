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
        .windowToolbarStyle(.unified(showsTitle: false))
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
    var themeId: String = NexusTheme.defaultThemeId
    var followSystemAppearance = true

    private(set) var conversation: ConversationController?
    private(set) var omc: OMCController?
    private(set) var binaryPath: String?
    /// Set when the CLI could not be located — the UI explains rather than
    /// failing silently on every action.
    private(set) var setupProblem: String?

    var projectDirectory: URL {
        didSet { attach() }
    }

    init() {
        // Default to the current working directory; the Settings tab can repoint
        // it, and each project gets its own OMC state and session history.
        projectDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        attach()
    }

    var activeTheme: NexusTheme {
        NexusTheme.named(themeId) ?? NexusTheme.all[0]
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
            return
        }
        setupProblem = nil
        binaryPath = binary.url.path
        conversation = ConversationController(
            client: NexusClient(binary: binary),
            workingDirectory: projectDirectory
        )
        let controller = OMCController(discoveringFrom: projectDirectory)
        controller.start()
        omc = controller
    }
}
