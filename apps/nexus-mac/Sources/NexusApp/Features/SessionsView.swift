import SwiftUI
import NexusKit

/// Past conversations — a master/detail browser over `nexus session …`.
///
/// `WorkspaceModel` does not hold a `SessionsController` (it is scoped to the
/// chat tab only), so this view builds its own from `workspace.binary` +
/// `NexusClient` — reading the ONE binary `WorkspaceModel.attach()` already
/// resolved, not re-running `NexusBinary.discover` itself — and rebuilds it
/// whenever the project directory changes, via `.task(id:)`.
struct SessionsView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    @State private var controller: SessionsController?
    @State private var selectedSessionId: String?
    @State private var detail: NexusSessionDetail?
    @State private var isLoadingDetail = false
    /// Set while a Replay is streaming `nexus replay … -o ndjson` — guards
    /// against a second tap re-entering the fold mid-stream and disables the
    /// button so it reads as busy rather than dead.
    @State private var isReplaying = false

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
                        message: workspace.setupProblem ?? "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
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
            LoadingState(message: "Loading sessions…")
        } else if let error = controller.error, controller.sessions.isEmpty {
            ErrorState(message: error) { Task { await controller.refresh() } }
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
                // Dismissible: the list underneath is real and usable either
                // way (see `InlineBanner`'s doc for why that's unconditional).
                if let error = controller.error {
                    InlineBanner(message: error) { controller.error = nil }
                        .padding(.horizontal, Space.xl)
                        .padding(.vertical, Space.xs)
                }
                splitView(controller)
            }
        }
    }

    // MARK: - Header

    private var headerBar: some View {
        PageHeader(
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
                    SessionDetailCard(
                        session: session,
                        detail: detail,
                        isLoading: isLoadingDetail,
                        isReplaying: isReplaying,
                        onResume: { resume(session) },
                        onReplay: { Task { await replay(session, using: controller) } }
                    )
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

    // MARK: - Resume / Replay
    //
    // Both reopen the selected session in the chat tab through
    // `ConversationController.reopen(sessionId:)` — the seam that stops any
    // live backend, resets the fold, and points `sessionId` at the target so
    // the next submit carries `--resume`. They diverge from there: Resume
    // leaves the transcript empty (the CLI restores the model's context, not
    // a UI event log — see `reopen`'s doc), Replay immediately re-populates it
    // by folding the session's recorded events through the same
    // `ConversationController.ingest` every live run already uses.

    /// Reopens `session` as the live conversation so the next message the
    /// user sends builds on it via `--resume`.
    private func resume(_ session: NexusSession) {
        guard let conversation = workspace.conversation else { return }
        conversation.reopen(sessionId: session.sessionId)
        workspace.tab = .chat
    }

    /// Reopens `session` and immediately re-renders its recorded transcript
    /// by streaming `nexus replay … -o ndjson` and folding the result — no
    /// separate renderer, the identical `ViewState.reduce` a live run uses.
    private func replay(_ session: NexusSession, using controller: SessionsController) async {
        guard let conversation = workspace.conversation else { return }
        isReplaying = true
        defer { isReplaying = false }
        conversation.reopen(sessionId: session.sessionId)
        let events = await controller.replayEvents(for: session.sessionId)
        conversation.ingest(events)
        workspace.tab = .chat
    }

    // MARK: - Attach

    private func attach() async {
        guard let binary = workspace.binary else {
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
                        if let cost = costLabel(session) {
                            if let help = costHelp(session) {
                                Metric(label: "cost", value: cost, emphasis: true).help(help)
                            } else {
                                Metric(label: "cost", value: cost, emphasis: true)
                            }
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
    let isReplaying: Bool
    let onResume: () -> Void
    let onReplay: () -> Void

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
                // Both reopen this session in the chat tab (see
                // `SessionsView.resume`/`.replay`) — Resume leaves the
                // transcript for `--resume` to carry forward, Replay
                // re-renders it immediately from the recorded log.
                Button("Resume", action: onResume)
                    .buttonStyle(SoftButton(tone: .accent))
                Button(action: onReplay) {
                    HStack(spacing: Space.xs) {
                        if isReplaying {
                            ProgressView().controlSize(.small)
                        }
                        Text("Replay")
                    }
                }
                .buttonStyle(SoftButton(tone: .neutral))
                .disabled(isReplaying)
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
                        if let cost = costLabel(session) {
                            if let help = costHelp(session) {
                                Metric(label: "cost", value: cost, emphasis: true).help(help)
                            } else {
                                Metric(label: "cost", value: cost, emphasis: true)
                            }
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

/// The session-row/detail-card cost readout. `nil` means show nothing —
/// preserved for the genuinely-empty case (no cost data at all, e.g. a
/// session with no runs yet), exactly as before this fix. What changed is
/// that an INCOMPLETE total — some run this session had no known price —
/// now always renders something, instead of silently collapsing into the
/// same "nothing shown" the CLI's `mock` provider's real $0 gets. A known,
/// complete cost still reads as a plain dollar figure, unaffected.
///
/// `session.costUsd` is a PARTIAL sum whenever `costIncomplete` is true (see
/// `NexusSession.costUsd`), so a partial-but-nonzero total is still shown —
/// marked with `*` — rather than being replaced by a bare "—" that would
/// throw away the figure the CLI does know.
///
/// Four decimal places, not the two `RootView`'s status bar and
/// `ConversationView`'s composer readout use for the identical `costUsd` /
/// `costIncomplete` pair: this is a historical record, comparing costs ACROSS
/// many sessions, where a `$0.0123` vs `$0.0089` difference is the whole
/// point of looking — collapsing that to `$0.01` for both would hide it. The
/// status bar and composer are live glance figures instead, where `<$0.01`
/// already answers "is this basically free" without needing the extra digits.
private func costLabel(_ session: NexusSession) -> String? {
    switch session.costUsd {
    case let cost? where cost > 0:
        return session.costIncomplete ? String(format: "$%.4f*", cost) : String(format: "$%.4f", cost)
    default:
        // Either no cost data at all (`nil`) or a confirmed `0` — in both
        // cases there is nothing to show UNLESS incompleteness itself is the
        // news (a mixed session whose priced runs happened to sum to ~0).
        return session.costIncomplete ? "—" : nil
    }
}

/// Non-`nil` exactly when `costLabel` above is showing an incomplete total —
/// call sites attach this as a `.help()` tooltip so the `*`/`—` marker has an
/// explanation on hover instead of being an unlabelled glyph on a dollar
/// figure. Wording matches `RootView`'s `costIncompleteHelp` for the same
/// `costIncomplete` concept — keep the two in sync.
private func costHelp(_ session: NexusSession) -> String? {
    session.costIncomplete
        ? "Partial total — pricing is unknown for at least one run, so this isn't the full cost."
        : nil
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
