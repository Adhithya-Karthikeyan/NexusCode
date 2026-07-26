import SwiftUI
import NexusKit

/// The window shell: a sidebar of tabs, the active surface, and a status bar
/// that stays visible everywhere so provider, cost and agent activity are never
/// more than a glance away.
struct RootView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    var body: some View {
        @Bindable var workspace = workspace

        NavigationSplitView {
            List(selection: $workspace.tab) {
                Section {
                    ForEach(WorkspaceTab.allCases) { tab in
                        Label(tab.title, systemImage: tab.systemImage)
                            .tag(tab)
                            .badge(badge(for: tab))
                    }
                } header: {
                    Text("Workspace")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.color(\.textMuted))
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
            .listStyle(.sidebar)
        } detail: {
            VStack(spacing: 0) {
                if let problem = workspace.setupProblem {
                    SetupBanner(message: problem)
                }
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                StatusBar()
            }
            .background(theme.color(\.surfaceBase))
        }
        .tint(theme.color(\.accentDefault))
    }

    @ViewBuilder
    private var content: some View {
        switch workspace.tab {
        case .chat:
            if let conversation = workspace.conversation {
                ConversationView(controller: conversation)
            } else {
                EmptyState(
                    icon: "terminal",
                    title: "No nexus executable",
                    message: "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                )
            }
        case .agents:
            AgentsView()
        case .sessions:
            PlaceholderTab(
                icon: "clock.arrow.circlepath",
                title: "Sessions",
                message: "Backed by `nexus session list -o json` and replayed with `nexus replay <id> -o ndjson`."
            )
        case .tasks:
            PlaceholderTab(
                icon: "checklist",
                title: "Tasks",
                message: "Backed by `nexus task list -o json` — the same durable store the CLI writes."
            )
        case .settings:
            SettingsView()
        }
    }

    /// Live agent count on the Agents tab, so activity is visible from any tab.
    private func badge(for tab: WorkspaceTab) -> Int {
        guard tab == .agents else { return 0 }
        let lanes = workspace.conversation?.view.activeLanes.count ?? 0
        let agents = workspace.omc?.snapshot.runningAgents.count ?? 0
        return lanes + agents
    }
}

/// Shown when the CLI could not be found — explains the fix instead of failing
/// silently on every button press.
struct SetupBanner: View {
    @Environment(\.nexusTheme) private var theme
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(theme.color(\.warningFg))
            Text(message)
                .font(.system(size: 11.5))
                .foregroundStyle(theme.color(\.textSecondary))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(theme.color(\.warningBg))
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.color(\.warningBorder)).frame(height: 1)
        }
    }
}

/// A tab whose CLI backing exists but whose screen is not built yet. Named
/// explicitly rather than shipped as a blank pane, so it is obvious what is
/// pending and which command will drive it.
struct PlaceholderTab: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        EmptyState(icon: icon, title: "\(title) — not built yet", message: message)
    }
}

/// The always-visible bottom strip: provider/model, live cost, context pressure,
/// and how many agents are working.
struct StatusBar: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    private var runningCount: Int {
        (workspace.conversation?.view.activeLanes.count ?? 0)
            + (workspace.omc?.snapshot.runningAgents.count ?? 0)
    }

    var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 6) {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(theme.color(\.accentDefault))
                Text("NexusCode")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.color(\.textPrimary))
            }

            if let session = workspace.conversation?.view.session {
                Metric(label: "model", value: session.model, emphasis: true)
            }

            if let totals = workspace.conversation?.view.totals, totals.costUsd > 0 {
                Metric(label: "cost", value: String(format: "$%.4f", totals.costUsd))
            }

            if let hud = workspace.omc?.snapshot.hud {
                if let percent = hud.contextUsedPercentage {
                    Metric(label: "ctx", value: "\(percent)%", emphasis: percent > 80)
                }
                if let cost = hud.totalCostUsd {
                    Metric(label: "session", value: String(format: "$%.2f", cost))
                }
            }

            Spacer(minLength: 8)

            if runningCount > 0 {
                HStack(spacing: 6) {
                    StatusDot(isRunning: true, isFailed: false)
                    Text("\(runningCount) working")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.color(\.accentDefault))
                }
            } else {
                HStack(spacing: 6) {
                    StatusDot(isRunning: false, isFailed: false, animate: false)
                    Text("ready")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.color(\.textMuted))
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(theme.color(\.surfaceSunken))
        .overlay(alignment: .top) {
            Rectangle().fill(theme.color(\.chromeDivider)).frame(height: 1)
        }
    }
}

/// Theme picker + where the app is pointed. Deliberately small: configuration
/// belongs to `nexus config`, and duplicating it here would create a second
/// source of truth.
struct SettingsView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    private let columns = [GridItem(.adaptive(minimum: 160), spacing: 10)]

    var body: some View {
        @Bindable var workspace = workspace

        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Theme")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.color(\.textPrimary))
                Text("The same \(NexusTheme.all.count) palettes the terminal ships — generated from the theme package, so both render identical colours.")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.color(\.textMuted))

                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(NexusTheme.all) { candidate in
                        ThemeSwatch(
                            theme: candidate,
                            isSelected: candidate.id == workspace.themeId
                        )
                        .onTapGesture { workspace.themeId = candidate.id }
                    }
                }

                Divider().overlay(theme.color(\.chromeDivider))

                Text("Project")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.color(\.textPrimary))
                Panel {
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledLine(label: "Directory", value: workspace.projectDirectory.path)
                        LabeledLine(label: "nexus", value: workspace.binaryPath ?? "not found")
                        LabeledLine(
                            label: "OMC",
                            value: workspace.omc?.isAvailable == true
                                ? "watching \(workspace.omc?.workspace?.root.lastPathComponent ?? "")/.omc"
                                : "not used by this project"
                        )
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct LabeledLine: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(theme.color(\.textMuted))
                .frame(width: 70, alignment: .leading)
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.color(\.textSecondary))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A live preview of a theme, drawn with that theme's own tokens.
struct ThemeSwatch: View {
    @Environment(\.nexusTheme) private var current
    let theme: NexusTheme
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                ForEach(
                    [\ThemeTokens.accentDefault, \ThemeTokens.textPrimary,
                     \ThemeTokens.successFg, \ThemeTokens.warningFg, \ThemeTokens.errorFg],
                    id: \.self
                ) { token in
                    RoundedRectangle(cornerRadius: 3)
                        .fill(theme.color(token))
                        .frame(height: 18)
                }
            }
            HStack(spacing: 4) {
                Text(theme.name)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.color(\.textPrimary))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.color(\.accentDefault))
                }
            }
            Text(theme.isDark ? "dark" : "light")
                .font(.system(size: 9))
                .foregroundStyle(theme.color(\.textMuted))
        }
        .padding(10)
        .background(theme.color(\.surfaceRaised))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(
                    isSelected ? current.color(\.accentDefault) : theme.color(\.chromeBorderSubtle),
                    lineWidth: isSelected ? 2 : 1
                )
        }
        .contentShape(Rectangle())
    }
}
