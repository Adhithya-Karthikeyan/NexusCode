import SwiftUI
import NexusKit

/// MCP servers, the tool registry, and lifecycle hooks — backed by `nexus mcp
/// …`, `nexus tools list`, and `nexus config get hooks`.
///
/// Like `SessionsView`/`TasksView`, `WorkspaceModel` holds no
/// `IntegrationsController` of its own, so this view builds one from
/// `NexusBinary.discover` + `NexusClient` and rebuilds it whenever the project
/// directory changes. Hooks aren't part of `IntegrationsController` (that type
/// only wraps `mcp`/`tools`), so this view loads them itself over the same
/// client with a plain `NexusCommand.json(["config", "get", "hooks"])` call —
/// verified for real against `nexus config get hooks -o json`, which returns
/// `{"enabled": bool, "hooks": [...]}` matching `HooksConfig` in
/// `packages/config/src/schema.ts` exactly.
struct IntegrationsView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    @State private var client: NexusClient?
    @State private var controller: IntegrationsController?
    @State private var hooksState: HooksLoadState = .loading

    var body: some View {
        // Header pinned, body fills-or-scrolls — see `PageScaffold`'s doc
        // comment. MCP servers / tools / hooks is real, often-long content
        // once populated, so that branch keeps its own `ScrollView`; loading
        // and "no executable" are single hero moments that now fill and
        // centre the space below the header instead of pinning to its top.
        PageScaffold {
            headerRow
                .padding(.horizontal, Space.xl)
                .padding(.top, Space.xl)
                .padding(.bottom, Space.lg)
        } content: {
            if let controller {
                if controller.isLoading && controller.mcpServers.isEmpty && controller.tools.isEmpty {
                    loadingState
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Space.lg) {
                            if let error = controller.error {
                                ErrorBanner(message: error)
                            }
                            mcpSection(controller)
                            toolsSection(controller)
                            hooksSection
                        }
                        .padding(.horizontal, Space.xl)
                        .padding(.bottom, Space.xl)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } else {
                HeroEmptyState(
                    icon: "terminal",
                    title: "No nexus executable",
                    message: "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                )
            }
        }
        .background(theme.color(\.surfaceBase))
        .task(id: workspace.projectDirectory) { await attach() }
    }

    // MARK: - Header

    private var headerRow: some View {
        SectionHeader(
            "Integrations",
            subtitle: "MCP servers, tools, and hooks",
            accessory: AnyView(
                Button {
                    Task { await refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(SoftButton(size: .compact))
            )
        )
    }

    private var loadingState: some View {
        VStack(spacing: Space.sm) {
            ProgressView()
            Text("Loading integrations…")
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textMuted))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - MCP

    private func mcpSection(_ controller: IntegrationsController) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(
                "MCP Servers",
                subtitle: "nexus mcp list · nexus mcp tools",
                accessory: AnyView(CountPill(text: "\(controller.mcpServers.count)", tone: .neutral))
            )
            if controller.mcpServers.isEmpty {
                Text("No MCP servers declared.")
                    .font(Kind.caption)
                    .foregroundStyle(theme.color(\.textMuted))
            } else {
                VStack(spacing: Space.sm) {
                    ForEach(controller.mcpServers) { server in
                        McpServerRow(server: server)
                    }
                }
            }
        }
    }

    // MARK: - Tools

    private func toolsSection(_ controller: IntegrationsController) -> some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            SectionHeader(
                "Tools",
                subtitle: "nexus tools list",
                accessory: AnyView(CountPill(text: "\(controller.tools.count)", tone: .neutral))
            )
            if controller.tools.isEmpty {
                Text("No tools registered.")
                    .font(Kind.caption)
                    .foregroundStyle(theme.color(\.textMuted))
            } else {
                ForEach(displayGroups(controller)) { group in
                    ToolGroupSection(group: group)
                }
            }
        }
    }

    /// Buckets `controller.tools` by `group`, keyed to `controller.groups` for
    /// order and metadata (description/enabled/integration hints). A tool
    /// whose group name has no matching `ToolGroupInfo` (or none at all) falls
    /// into a trailing "Other" bucket rather than vanishing.
    private func displayGroups(_ controller: IntegrationsController) -> [DisplayGroup] {
        var byGroup: [String?: [NexusTool]] = [:]
        for tool in controller.tools {
            byGroup[tool.group, default: []].append(tool)
        }

        var result: [DisplayGroup] = []
        for info in controller.groups {
            let tools = byGroup.removeValue(forKey: info.group) ?? []
            guard !tools.isEmpty else { continue }
            result.append(
                DisplayGroup(
                    id: info.group,
                    title: info.group,
                    description: info.description,
                    enabled: info.enabled,
                    integrations: info.integrations,
                    tools: tools
                )
            )
        }
        let leftovers = byGroup.sorted { ($0.key ?? "") < ($1.key ?? "") }
        for (key, tools) in leftovers where !tools.isEmpty {
            result.append(
                DisplayGroup(
                    id: key ?? "__ungrouped__",
                    title: key ?? "Other",
                    description: nil,
                    enabled: true,
                    integrations: [],
                    tools: tools
                )
            )
        }
        return result
    }

    // MARK: - Hooks

    private var hooksSection: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader("Hooks", subtitle: "nexus config get hooks")
            hooksBody
        }
    }

    @ViewBuilder
    private var hooksBody: some View {
        switch hooksState {
        case .loading:
            ProgressView().controlSize(.small)

        case .notExposed:
            // The honest fallback for an older/future CLI whose `config get
            // hooks` doesn't return a `hooks` array at all — never invented.
            Text("Lifecycle hooks aren't exposed by this CLI build's `nexus config get hooks` yet.")
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textMuted))

        case .failed(let message):
            Text(message)
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.errorFg))

        case .loaded(let enabled, let hooks):
            VStack(alignment: .leading, spacing: Space.sm) {
                if !enabled {
                    Text("Hooks are disabled (hooks.enabled = false).")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.warningFg))
                }
                if hooks.isEmpty {
                    Text("No hooks declared.")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                } else {
                    VStack(spacing: Space.xs) {
                        ForEach(hooks) { hook in
                            HookRow(hook: hook)
                        }
                    }
                    .opacity(enabled ? 1 : 0.55)
                }
            }
        }
    }

    // MARK: - Attach

    private func attach() async {
        guard let binary = NexusBinary.discover(repoRoot: workspace.projectDirectory) else {
            client = nil
            controller = nil
            return
        }
        let newClient = NexusClient(binary: binary)
        client = newClient
        let newController = IntegrationsController(client: newClient, workingDirectory: workspace.projectDirectory)
        controller = newController
        hooksState = .loading
        async let integrations: Void = newController.refresh()
        async let hooks: Void = loadHooks(client: newClient)
        _ = await (integrations, hooks)
    }

    private func refresh() async {
        guard let controller, let client else { return }
        hooksState = .loading
        async let integrations: Void = controller.refresh()
        async let hooks: Void = loadHooks(client: client)
        _ = await (integrations, hooks)
    }

    private func loadHooks(client: NexusClient) async {
        let result = await client.runJSON(NexusCommand.json(["config", "get", "hooks"], cwd: workspace.projectDirectory))
        switch result {
        case .success(let value):
            // A well-formed response always has a `hooks` key (even an empty
            // array); its absence means this CLI build doesn't expose the
            // command the way this view expects.
            guard value["hooks"] != nil else {
                hooksState = .notExposed
                return
            }
            let enabled = value["enabled"]?.boolValue ?? true
            let hooks = value["hooks"]?.arrayValue?.compactMap(HookEntry.init(json:)) ?? []
            hooksState = .loaded(enabled: enabled, hooks: hooks)
        case .failure(let error):
            hooksState = .failed(error.message)
        }
    }
}

// MARK: - Hooks model

/// One entry of `config get hooks`'s `hooks` array — mirrors
/// `CommandHookConfig` in `packages/config/src/schema.ts`
/// (event/command/args/matcher/timeoutMs/env/failOpen).
private struct HookEntry: Identifiable {
    let event: String
    let command: String
    let args: [String]
    let matcher: String?
    let timeoutMs: Int
    let failOpen: Bool

    var id: String { "\(event)-\(command)-\(args.joined(separator: " "))-\(matcher ?? "")" }

    init?(json: JSONValue) {
        guard let event = json["event"]?.stringValue,
              let command = json["command"]?.stringValue
        else { return nil }
        self.event = event
        self.command = command
        self.args = json["args"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.matcher = json["matcher"]?.stringValue
        self.timeoutMs = json["timeoutMs"]?.intValue ?? 5000
        self.failOpen = json["failOpen"]?.boolValue ?? false
    }
}

private enum HooksLoadState {
    case loading
    case loaded(enabled: Bool, hooks: [HookEntry])
    /// `config get hooks` succeeded but didn't return a `hooks` array — an
    /// honest "not exposed" state rather than a fabricated list.
    case notExposed
    case failed(String)
}

private struct HookRow: View {
    @Environment(\.nexusTheme) private var theme
    let hook: HookEntry

    var body: some View {
        Card(padding: Space.sm) {
            HStack(spacing: Space.sm) {
                CountPill(text: hook.event, tone: .accent)
                Text(([hook.command] + hook.args).joined(separator: " "))
                    .font(Kind.monoSmall)
                    .foregroundStyle(theme.color(\.textSecondary))
                    .lineLimit(1)
                if let matcher = hook.matcher {
                    Text(matcher)
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                        .lineLimit(1)
                }
                Spacer(minLength: Space.sm)
                if hook.failOpen {
                    CountPill(text: "fail-open", tone: .warning)
                }
                Text("\(hook.timeoutMs)ms")
                    .font(Kind.micro)
                    .foregroundStyle(theme.color(\.textMuted))
            }
        }
    }
}

// MARK: - MCP row

/// One MCP server: name/transport, connection state, and tool count. A
/// declared-but-disabled server (`enabled == false`) is dimmed with a neutral
/// "disabled" badge and never shows an error — `McpServer`'s own doc
/// guarantees `error` is only ever set on a server `mcp tools` actually
/// attempted to connect to, which by construction means `enabled == true`.
/// An enabled server that failed to connect gets a failed `StatusDot` plus
/// its error verbatim, so the two "nothing is wrong here" vs. "this is
/// broken" states never look the same.
private struct McpServerRow: View {
    @Environment(\.nexusTheme) private var theme
    let server: McpServer

    private var isFailedConnection: Bool { server.enabled && !server.connected }

    var body: some View {
        Card(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(spacing: Space.sm) {
                    StatusDot(isRunning: server.connected, isFailed: isFailedConnection, size: 8, animate: false)
                    Text(server.name)
                        .font(Kind.bodyEmphasis)
                        .foregroundStyle(theme.color(\.textPrimary))
                    if let transport = server.transport {
                        Text(transport)
                            .font(Kind.caption)
                            .foregroundStyle(theme.color(\.textMuted))
                    }
                    Spacer(minLength: Space.sm)
                    if !server.enabled {
                        CountPill(text: "disabled", tone: .neutral)
                    } else if server.connected {
                        CountPill(text: "\(server.toolCount) tools", tone: .accent)
                    } else {
                        CountPill(text: "failed", tone: .danger)
                    }
                }
                if let error = server.error {
                    Text(error)
                        .font(Kind.monoSmall)
                        .foregroundStyle(theme.color(\.errorFg))
                        .textSelection(.enabled)
                        .lineLimit(3)
                }
            }
        }
        .opacity(server.enabled ? 1 : 0.55)
    }
}

// MARK: - Tools

/// A `ToolGroupInfo` merged with the tools that belong to it, or a synthetic
/// "Other" bucket for tools whose group has no matching info — view-layer
/// only, so `IntegrationsController` stays a plain data loader.
private struct DisplayGroup: Identifiable {
    let id: String
    let title: String
    let description: String?
    let enabled: Bool
    let integrations: [ToolIntegration]
    let tools: [NexusTool]
}

private struct ToolGroupSection: View {
    @Environment(\.nexusTheme) private var theme
    let group: DisplayGroup

    private var missingIntegrations: [ToolIntegration] {
        group.integrations.filter { !$0.available }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(
                group.title,
                subtitle: group.description,
                accessory: AnyView(CountPill(text: "\(group.tools.count)", tone: group.enabled ? .neutral : .warning))
            )
            if !missingIntegrations.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(missingIntegrations) { integration in
                        IntegrationHintRow(integration: integration)
                    }
                }
            }
            VStack(spacing: Space.xs) {
                ForEach(group.tools) { tool in
                    NexusToolRow(tool: tool)
                }
            }
        }
    }
}

/// Explains WHY a group's tools are greyed out — a missing optional package
/// or a binary not on PATH, per `ToolIntegration`'s hint.
private struct IntegrationHintRow: View {
    @Environment(\.nexusTheme) private var theme
    let integration: ToolIntegration

    var body: some View {
        HStack(spacing: Space.xs) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 9))
            Text(integration.kind.map { "\(integration.name) (\($0)) not available" } ?? "\(integration.name) not available")
                .font(Kind.caption)
            if let hint = integration.hint {
                Text("— \(hint)")
                    .font(Kind.caption)
            }
        }
        .foregroundStyle(theme.color(\.warningFg))
    }
}

private struct NexusToolRow: View {
    @Environment(\.nexusTheme) private var theme
    let tool: NexusTool

    /// Greyed out for either reason `IntegrationsController`'s doc calls out:
    /// the group isn't enabled, or the optional package/binary it needs isn't
    /// installed — two independent axes, either one dims the row.
    private var isDimmed: Bool { !tool.enabled || tool.integrationAvailable == false }

    var body: some View {
        HStack(spacing: Space.sm) {
            Text(tool.name)
                .font(Kind.body)
                .foregroundStyle(isDimmed ? theme.color(\.textMuted) : theme.color(\.textPrimary))
                .lineLimit(1)
            Spacer(minLength: Space.sm)
            CountPill(text: tool.permission.rawValue, tone: permissionTone)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, Space.xs)
        .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .opacity(isDimmed ? 0.55 : 1)
    }

    /// The permission tier is safety information, not decoration — read is
    /// neutral, network is accent, write is warning, exec (arbitrary command
    /// execution) is danger, so the riskiest tools are never visually quiet.
    private var permissionTone: CountPill.Tone {
        switch tool.permission {
        case .read: return .neutral
        case .network: return .accent
        case .write: return .warning
        case .exec: return .danger
        case .unknown: return .neutral
        }
    }
}

// MARK: - Shared

/// A dismissible-looking (but non-fatal) notice for a refresh that partially
/// failed — mirrors `TasksView`'s `ErrorBanner`, duplicated per-file the same
/// way `SessionsView`'s `errorBanner` is, rather than adding a shared type
/// this task isn't scoped to touch.
private struct ErrorBanner: View {
    @Environment(\.nexusTheme) private var theme
    let message: String

    var body: some View {
        HStack(spacing: Space.xs) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10))
            Text(message)
                .font(Kind.caption)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .foregroundStyle(theme.color(\.warningFg))
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(theme.color(\.warningBg).opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}
