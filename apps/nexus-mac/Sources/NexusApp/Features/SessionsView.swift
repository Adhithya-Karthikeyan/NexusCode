import SwiftUI
import NexusKit

/// Past conversations — a master/detail browser over `nexus session …`.
///
/// `WorkspaceModel` does not hold a `SessionsController` (it is scoped to the
/// chat tab only), so this view builds its own from `NexusBinary.discover` +
/// `NexusClient`, exactly the way `WorkspaceModel.attach()` builds
/// `ConversationController` — and rebuilds it whenever the project directory
/// changes, via `.task(id:)`.
struct SessionsView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    @State private var controller: SessionsController?
    @State private var selectedSessionId: String?
    @State private var detail: NexusSessionDetail?
    @State private var isLoadingDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerBar

            Rectangle().fill(theme.color(\.chromeDivider)).frame(height: 1)

            // No `.padding()` follows this — every branch handles its own
            // padding internally, so nothing here demands "available space
            // plus padding" and evicts a sibling out of the window.
            Group {
                if let controller {
                    stateBody(controller)
                } else {
                    HeroEmptyState(
                        icon: "terminal",
                        title: "No nexus executable",
                        message: "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.color(\.surfaceBase))
        .task(id: workspace.projectDirectory) { await attach() }
    }

    @ViewBuilder
    private func stateBody(_ controller: SessionsController) -> some View {
        if controller.isLoading && controller.sessions.isEmpty {
            loadingState
        } else if let error = controller.error, controller.sessions.isEmpty {
            errorState(error) { Task { await controller.refresh() } }
        } else if controller.sessions.isEmpty {
            HeroEmptyState(
                icon: "clock.arrow.circlepath",
                title: "No sessions yet",
                message: "Sessions appear here once you run `nexus ask` — every conversation is recorded to the session store."
            )
        } else {
            VStack(alignment: .leading, spacing: 0) {
                // A stale-data caveat, not a fatal error — the list already
                // loaded once, so a failed refresh must not blank it out.
                if let error = controller.error {
                    errorBanner(error)
                }
                splitView(controller)
            }
        }
    }

    // MARK: - Header

    private var headerBar: some View {
        SectionHeader(
            "Sessions",
            subtitle: "Past conversations — nexus session list",
            accessory: AnyView(
                HStack(spacing: Space.sm) {
                    if let controller {
                        CountPill(text: "\(controller.sessions.count)", tone: .neutral)
                    }
                    Button {
                        Task { await controller?.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(SoftButton(size: .compact))
                }
            )
        )
        .padding(.horizontal, Space.xl)
        .padding(.vertical, Space.md)
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: Space.sm) {
            ProgressView()
            Text("Loading sessions…")
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textMuted))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String, retry: @escaping () -> Void) -> some View {
        VStack(spacing: Space.sm) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(theme.color(\.errorFg))
            Text(message)
                .font(Kind.body)
                .foregroundStyle(theme.color(\.textSecondary))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button("Retry", action: retry)
                .buttonStyle(SoftButton(tone: .accent))
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: Space.xs) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10))
            Text(message)
                .font(Kind.caption)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .foregroundStyle(theme.color(\.warningFg))
        .padding(.horizontal, Space.xl)
        .padding(.vertical, Space.xs)
        .background(theme.color(\.warningBg).opacity(0.5))
    }

    // MARK: - Split view

    private func splitView(_ controller: SessionsController) -> some View {
        HStack(spacing: 0) {
            listPane(controller)
                .frame(width: 340)

            Rectangle().fill(theme.hairline).frame(width: 1)

            detailPane(controller)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func listPane(_ controller: SessionsController) -> some View {
        ScrollView {
            // `controller.sessions` is already newest-first (sorted in
            // `refresh()`), so this renders in that order without re-sorting.
            LazyVStack(spacing: Space.sm) {
                ForEach(controller.sessions) { session in
                    SessionRow(
                        session: session,
                        isSelected: session.id == selectedSessionId,
                        action: { selectedSessionId = session.id }
                    )
                }
            }
            .padding(Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func detailPane(_ controller: SessionsController) -> some View {
        ScrollView {
            Group {
                if let selectedSessionId,
                   let session = controller.sessions.first(where: { $0.id == selectedSessionId }) {
                    SessionDetailCard(session: session, detail: detail, isLoading: isLoadingDetail)
                } else {
                    HeroEmptyState(
                        icon: "doc.text.magnifyingglass",
                        title: "Select a session",
                        message: "Choose a session on the left to see its runs and actions."
                    )
                }
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Reloads `session show` whenever the selection changes, independent
        // of the outer list refresh.
        .task(id: selectedSessionId) {
            guard let selectedSessionId else {
                detail = nil
                return
            }
            isLoadingDetail = true
            detail = await controller.show(selectedSessionId)
            isLoadingDetail = false
        }
    }

    // MARK: - Attach

    private func attach() async {
        guard let binary = NexusBinary.discover(repoRoot: workspace.projectDirectory) else {
            controller = nil
            return
        }
        let newController = SessionsController(client: NexusClient(binary: binary), workingDirectory: workspace.projectDirectory)
        controller = newController
        await newController.refresh()
        // Selecting the first session on first load makes the detail pane
        // useful immediately, instead of opening on an empty "select one" hint.
        if selectedSessionId == nil {
            selectedSessionId = newController.sessions.first?.id
        }
    }
}

/// One session in the list: name/id, provider · model, turn count, tokens,
/// cost, and relative recency. Selection reads as an accent border, the same
/// technique `AgentCard` uses for its running/failed state, rather than a
/// filled background that would fight the card's own surface colour.
private struct SessionRow: View {
    @Environment(\.nexusTheme) private var theme
    let session: NexusSession
    let isSelected: Bool
    let action: () -> Void

    private var displayName: String {
        session.name ?? String(session.sessionId.prefix(8))
    }

    private var modelLine: String? {
        switch (session.provider, session.model) {
        case let (provider?, model?): return "\(provider) · \(model)"
        case let (provider?, nil): return provider
        case let (nil, model?): return model
        default: return nil
        }
    }

    var body: some View {
        Button(action: action) {
            Card(padding: Space.md) {
                VStack(alignment: .leading, spacing: Space.sm) {
                    HStack(alignment: .top, spacing: Space.sm) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(displayName)
                                .font(Kind.bodyEmphasis)
                                .foregroundStyle(theme.color(\.textPrimary))
                                .lineLimit(1)
                            if let modelLine {
                                HStack(spacing: 4) {
                                    Circle()
                                        .fill(providerColor(session.provider))
                                        .frame(width: 6, height: 6)
                                    Text(modelLine)
                                        .font(Kind.caption)
                                        .foregroundStyle(theme.color(\.textMuted))
                                        .lineLimit(1)
                                }
                            }
                        }

                        Spacer(minLength: Space.sm)

                        if let updatedAt = session.updatedAt {
                            Text(updatedAt, style: .relative)
                                .font(Kind.caption)
                                .foregroundStyle(theme.color(\.textMuted))
                        }
                    }

                    HStack(spacing: Space.md) {
                        Metric(label: "turns", value: "\(session.turnCount)")
                        Metric(label: "tok", value: formatCount(session.inputTokens + session.outputTokens))
                        if session.costUsd > 0 {
                            Metric(label: "cost", value: String(format: "$%.4f", session.costUsd), emphasis: true)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(
                        isSelected ? theme.color(\.accentDefault).opacity(0.6) : .clear,
                        lineWidth: 1.4
                    )
            }
        }
        .buttonStyle(.plain)
    }

    private func providerColor(_ provider: String?) -> Color {
        switch provider?.lowercased() {
        case "anthropic": return theme.color(\.providerAnthropic)
        case "openai": return theme.color(\.providerOpenai)
        case "google", "gemini": return theme.color(\.providerGoogle)
        case "xai", "grok": return theme.color(\.providerXai)
        case "ollama": return theme.color(\.providerOllama)
        case "mistral": return theme.color(\.providerMistral)
        case "deepseek": return theme.color(\.providerDeepseek)
        default: return theme.color(\.providerCustom)
        }
    }
}

/// The trailing pane for the selected session: identity, actions, metrics,
/// and its recorded runs.
private struct SessionDetailCard: View {
    @Environment(\.nexusTheme) private var theme
    let session: NexusSession
    let detail: NexusSessionDetail?
    let isLoading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(session.name ?? session.sessionId)
                    .font(Kind.title)
                    .foregroundStyle(theme.color(\.textPrimary))
                    .textSelection(.enabled)
                Text(session.sessionId)
                    .font(Kind.monoSmall)
                    .foregroundStyle(theme.color(\.textMuted))
                    .textSelection(.enabled)
            }

            HStack(spacing: Space.sm) {
                // Intent-only: these surface the action, they don't perform it.
                // RootView owns wiring across tabs (see its header comment on
                // why it, not this file, drives ConversationController), so
                // resuming/replaying into the chat tab is the lead's wiring.
                Button("Resume") {}
                    .buttonStyle(SoftButton(tone: .accent))
                Button("Replay") {}
                    .buttonStyle(SoftButton(tone: .neutral))
                Spacer(minLength: 0)
            }

            Card(padding: Space.md, radius: Radius.panel) {
                VStack(alignment: .leading, spacing: Space.md) {
                    HStack(spacing: Space.lg) {
                        Metric(label: "turns", value: "\(session.turnCount)")
                        Metric(label: "runs", value: "\(session.runCount)")
                        Metric(label: "events", value: "\(session.eventCount)")
                        Spacer(minLength: 0)
                    }
                    HStack(spacing: Space.lg) {
                        Metric(label: "in", value: formatCount(session.inputTokens))
                        Metric(label: "out", value: formatCount(session.outputTokens))
                        if session.costUsd > 0 {
                            Metric(label: "cost", value: String(format: "$%.4f", session.costUsd), emphasis: true)
                        }
                        Spacer(minLength: 0)
                    }
                    if let created = session.createdAt {
                        HStack(spacing: 5) {
                            Text("CREATED")
                                .font(Kind.micro)
                                .tracking(0.5)
                                .foregroundStyle(theme.color(\.textMuted).opacity(0.8))
                            Text(created, style: .relative)
                                .font(Kind.caption)
                                .foregroundStyle(theme.color(\.textSecondary))
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader(
                    "Runs",
                    accessory: detail.map { AnyView(CountPill(text: "\($0.runs.count)", tone: .neutral)) }
                )
                if isLoading {
                    ProgressView().controlSize(.small)
                } else if let detail, !detail.runs.isEmpty {
                    VStack(spacing: Space.xs) {
                        ForEach(detail.runs) { run in
                            RunRow(run: run)
                        }
                    }
                } else if detail != nil {
                    Text("No runs recorded for this session.")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                }
            }
        }
    }
}

/// One row of `NexusSessionDetail.runs` — adapter/model plus its status.
private struct RunRow: View {
    @Environment(\.nexusTheme) private var theme
    let run: NexusSessionRun

    private var isFailed: Bool {
        guard let status = run.status?.lowercased() else { return false }
        return status == "failed" || status == "error"
    }

    var body: some View {
        HStack(spacing: Space.sm) {
            StatusDot(isRunning: false, isFailed: isFailed, size: 6, animate: false)
            Text(run.adapterId ?? run.runId)
                .font(Kind.monoSmall)
                .foregroundStyle(theme.color(\.textSecondary))
                .lineLimit(1)
            if let model = run.model {
                Text(model)
                    .font(Kind.caption)
                    .foregroundStyle(theme.color(\.textMuted))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if let status = run.status {
                Text(status)
                    .font(Kind.micro)
                    .foregroundStyle(isFailed ? theme.color(\.errorFg) : theme.color(\.textMuted))
            }
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, Space.xs)
        .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}

/// Renders a token/count total as `12.4k`/`1.2m` past the point plain digits
/// stop being scannable at a glance.
private func formatCount(_ value: Int) -> String {
    switch value {
    case 1_000_000...:
        return String(format: "%.1fm", Double(value) / 1_000_000)
    case 1_000...:
        return String(format: "%.1fk", Double(value) / 1_000)
    default:
        return "\(value)"
    }
}
