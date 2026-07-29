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

    /// The window's opening size, overridable by `NEXUS_UI_WIDTH`/`_HEIGHT`
    /// for the screenshot sweep — the design brief requires every screen
    /// captured at both 1440x900 and the app's own 900pt minimum, and a
    /// fresh bundle id (mandatory per verification round, see `PLAN.md`) has
    /// no restored window frame to resize. Unset falls back to the same
    /// 1280x860 this always used.
    static let defaultWidth = Double(ProcessInfo.processInfo.environment["NEXUS_UI_WIDTH"] ?? "") ?? 1280
    static let defaultHeight = Double(ProcessInfo.processInfo.environment["NEXUS_UI_HEIGHT"] ?? "") ?? 860

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
        .defaultSize(width: Self.defaultWidth, height: Self.defaultHeight)
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
/// `workspace.matchSystemAppearance` gates that following via `AppTheme
/// .displayed(for:matchSystemAppearance:)` rather than calling `resolved(for:)`
/// unconditionally — the fix for a real bug: with no such gate, Daylight and
/// Studio (the only two `isDark == false` hand-designed themes) were simply
/// unreachable on a Mac in Dark Mode. Picking either one moved the Settings
/// checkmark but `resolved(for:)` swapped the ACTUAL theme straight back to
/// its dark pair every time, silently — see `SettingsView`'s swatch action
/// for how an explicit pick now turns following off instead of losing.
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
        workspace.activeTheme.displayed(for: systemScheme, matchSystemAppearance: workspace.matchSystemAppearance)
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

    /// Whether a paired theme should follow the OS's own light/dark setting
    /// (`AppTheme.resolved(for:)`) rather than rendering exactly as picked.
    /// Defaults on, so nothing changes for anyone who never touches this —
    /// but an explicit pick that disagrees with the current OS scheme turns
    /// this off automatically (see `SettingsView`'s swatch action), because
    /// the pick is the one thing that must always win. See `AppTheme
    /// .displayed(for:matchSystemAppearance:)` for the full history.
    var matchSystemAppearance: Bool = true {
        didSet { defaults.set(matchSystemAppearance, forKey: Keys.matchSystem) }
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
        static let matchSystem = "nexus.matchSystemAppearance"
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
        // `bool(forKey:)` answers `false` for a key that was never set, which
        // would silently flip the "defaults on" contract above for every
        // user who has never touched this — `object(forKey:) != nil` is the
        // only way to tell "saved false" apart from "never saved."
        if defaults.object(forKey: Keys.matchSystem) != nil {
            matchSystemAppearance = defaults.bool(forKey: Keys.matchSystem)
        }
        // Screenshot/verification seam — see `WorkspaceTab.fromEnvironment`'s
        // doc for why this is an env var rather than synthetic input. Applied
        // LAST so it wins over restored defaults, and only when the variables
        // are actually set: a normal launch never enters either branch.
        if let tab = WorkspaceTab.fromEnvironment() { self.tab = tab }
        if let forced = ProcessInfo.processInfo.environment["NEXUS_UI_THEME"],
           AppTheme.named(forced) != nil || NexusTheme.named(forced) != nil {
            themeId = forced
            // A forced theme is an explicit pick, exactly like clicking a
            // swatch — so it must not be silently swapped back to its
            // light/dark pair by appearance-following (see
            // `SettingsView.selectTheme`, which makes the same call).
            matchSystemAppearance = false
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

        // Screenshot seam — see `ConversationController.replayForPreview`.
        if ProcessInfo.processInfo.environment["NEXUS_UI_DEMO"] == "1" {
            conversation?.replayForPreview(ndjson: Self.demoTranscript)
        }
    }

    /// A short scripted conversation covering the shapes the transcript has to
    /// render well: a plain answer, a mid-conversation provider switch, a tool
    /// call with a result, a diff, and a failed turn. Not shipped behaviour —
    /// only reachable with `NEXUS_UI_DEMO=1`.
    static let demoTranscript = """
    {"t":"session","id":"run_demo_1","provider":"anthropic","model":"claude-opus-5","ts":1785088736427}
    {"t":"prompt","lane":"main","id":"p0","text":"Why is the sidebar rendering lighter than the canvas it sits next to?"}
    {"t":"text","lane":"main","delta":"Because the material is overruling the token. `surfaceSunken` is the darkest colour in the theme, but `.ultraThinMaterial` doesn't render the token — it renders **what's behind the window**, lightened.\\n\\nMeasured on the shipped build at 1440x900:\\n\\n- sidebar — relative luminance `0.0244`\\n- canvas panel — `0.0123`\\n- window floor — `0.0048`\\n\\nSo the surface that should be furthest back is twice as bright as the one in front of it. No token is wrong; the material is deciding value when it should only be adding texture."}
    {"t":"usage","lane":"main","inputTokens":1840,"outputTokens":212,"cacheRead":0,"cacheWrite":0,"costUsd":0.0184}
    {"t":"done","lane":"main","finishReason":"stop"}
    {"t":"switch","lane":"main","from":{"providerId":"anthropic","modelId":"claude-opus-5"},"to":{"providerId":"openai","modelId":"gpt-5-codex"},"accepted":true,"blockers":[],"warnings":[],"preserved":["conversation transcript","assembled project context"],"adaptations":[],"reason":"explicit switch requested by client"}
    {"t":"session","id":"run_demo_2","provider":"openai","model":"gpt-5-codex","ts":1785088836427}
    {"t":"prompt","lane":"main","id":"p1","text":"Fix it, then show me the diff."}
    {"t":"text","lane":"main","delta":"Tinting the material back to the token's own value keeps the translucency without letting it govern luminance."}
    {"t":"tool_call","lane":"main","id":"call-1","name":"read_file","args":{"path":"Sources/NexusApp/Components/DesignSystem.swift","limit":120}}
    {"t":"tool_result","lane":"main","id":"call-1","ok":true,"result":[{"type":"text","text":"@ViewBuilder\\nfunc themedFill<S: Shape>(_ color: Color, treatment: SurfaceTreatment, in shape: S) -> some View {"}]}
    {"t":"diff","lane":"main","path":"Sources/NexusApp/Components/DesignSystem.swift","patch":"@@ -132,7 +132,10 @@\\n     if let material = treatment.material {\\n-        shape.fill(material)\\n+        ZStack {\\n+            shape.fill(material)\\n+            shape.fill(color.opacity(isDark ? 0.82 : 0.55))\\n+        }\\n     } else {\\n         shape.fill(color)\\n     }"}
    {"t":"usage","lane":"main","inputTokens":2410,"outputTokens":388,"cacheRead":1792,"cacheWrite":0,"costUsd":0.0091}
    {"t":"done","lane":"main","finishReason":"stop"}
    {"t":"prompt","lane":"main","id":"p2","text":"Run the theme contrast suite."}
    {"t":"error","lane":"main","code":"quota_exhausted","message":"This provider is out of quota for the current billing period.","retryable":true}
    """
}
