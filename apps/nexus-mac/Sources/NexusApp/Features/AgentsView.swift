import SwiftUI
import NexusKit

/// What is working right now.
///
/// Two genuinely different kinds of concurrency share this screen, and the split
/// is kept explicit rather than blurred:
///
///  - **Provider lanes** — several models answering the SAME prompt in a
///    compare/race run, read from the live `nexus` event stream.
///  - **OMC subagents** — specialised agents doing SEPARATE work, read from
///    oh-my-claudecode's on-disk session state.
///
/// Merging them into one undifferentiated "agents" list would misrepresent what
/// is happening, so origin is always visible.
struct AgentsView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    @State private var now = Date()

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var lanes: [AgentRow] {
        guard let view = workspace.conversation?.view else { return [] }
        return AgentRowBuilder.lanes(from: view)
    }

    private var omcAgents: [AgentRow] {
        guard let snapshot = workspace.omc?.snapshot else { return [] }
        return AgentRowBuilder.omcAgents(from: snapshot)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if lanes.isEmpty && omcAgents.isEmpty {
                    EmptyState(
                        icon: "person.3.sequence",
                        title: "Nothing running",
                        message: "Provider lanes appear here during a Compare or Race run. OMC subagents appear whenever oh-my-claudecode spawns them in this project."
                    )
                    .frame(minHeight: 260)
                }

                if !lanes.isEmpty {
                    Section(
                        title: "Provider lanes",
                        subtitle: "Models answering the same prompt — from the live nexus event stream",
                        count: lanes.filter(\.isRunning).count
                    ) {
                        ForEach(lanes) { row in
                            AgentCard(row: row, now: now)
                        }
                    }
                }

                if !omcAgents.isEmpty {
                    Section(
                        title: "OMC subagents",
                        subtitle: "From .omc/state — specialised agents doing separate work",
                        count: omcAgents.filter(\.isRunning).count
                    ) {
                        ForEach(omcAgents) { row in
                            AgentCard(row: row, now: now)
                        }
                    }
                }

                if let mission = workspace.omc?.snapshot.missions?.activeMissions.first {
                    MissionPanel(mission: mission)
                }

                if let unreadable = workspace.omc?.snapshot.unreadable, !unreadable.isEmpty {
                    // Say so rather than showing stale numbers as if they were live.
                    Text("Could not read: \(unreadable.joined(separator: ", ")) — showing last known state.")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.color(\.warningFg))
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onReceive(tick) { now = $0 }
    }
}

private struct Section<Content: View>: View {
    @Environment(\.nexusTheme) private var theme
    let title: String
    let subtitle: String
    let count: Int
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.color(\.textPrimary))
                if count > 0 {
                    Text("\(count) running")
                        .font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(theme.color(\.accentMuted))
                        .foregroundStyle(theme.color(\.accentFg))
                        .clipShape(Capsule())
                }
            }
            Text(subtitle)
                .font(.system(size: 10.5))
                .foregroundStyle(theme.color(\.textMuted))
            VStack(spacing: 8) { content }
        }
    }
}

/// One agent or lane.
struct AgentCard: View {
    @Environment(\.nexusTheme) private var theme
    let row: AgentRow
    let now: Date

    private var elapsed: String? {
        guard let startedAt = row.startedAt else { return nil }
        let seconds = Int(max(0, now.timeIntervalSince(startedAt)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }

    var body: some View {
        Panel(padding: 12) {
            HStack(alignment: .top, spacing: 10) {
                StatusDot(isRunning: row.isRunning, isFailed: row.isFailed)
                    .padding(.top, 4)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(row.title)
                            .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(theme.color(\.textPrimary))
                        OriginBadge(origin: row.origin)
                    }
                    Text(row.subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(
                            row.isFailed ? theme.color(\.errorFg) : theme.color(\.textMuted)
                        )
                    if let detail = row.detail {
                        Text(detail)
                            .font(.system(size: 10.5))
                            .foregroundStyle(theme.color(\.textSecondary))
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 8)

                if let elapsed {
                    Text(elapsed)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(
                            row.isRunning ? theme.color(\.accentDefault) : theme.color(\.textMuted)
                        )
                        .monospacedDigit()
                }
            }
        }
    }
}

struct OriginBadge: View {
    @Environment(\.nexusTheme) private var theme
    let origin: AgentRow.Origin

    var body: some View {
        Text(origin == .lane ? "lane" : "omc")
            .font(.system(size: 8, weight: .bold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(
                origin == .lane ? theme.color(\.infoBg) : theme.color(\.surfaceOverlay)
            )
            .foregroundStyle(
                origin == .lane ? theme.color(\.infoFg) : theme.color(\.textMuted)
            )
            .clipShape(Capsule())
    }
}

/// Mission progress + timeline, when OMC is coordinating a multi-agent mission.
struct MissionPanel: View {
    @Environment(\.nexusTheme) private var theme
    let mission: OMCMission

    private var progress: Double {
        let total = mission.taskCounts.total
        guard total > 0 else { return 0 }
        return Double(mission.taskCounts.completed) / Double(total)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Mission")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(theme.color(\.textPrimary))

            Panel {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(mission.objective.isEmpty ? mission.name : mission.objective)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(theme.color(\.textPrimary))
                        Spacer(minLength: 8)
                        Text("\(mission.taskCounts.completed)/\(mission.taskCounts.total)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(theme.color(\.textMuted))
                    }

                    ProgressView(value: progress)
                        .tint(theme.color(\.accentDefault))

                    HStack(spacing: 12) {
                        Metric(label: "workers", value: "\(mission.workerCount)")
                        Metric(label: "active", value: "\(mission.taskCounts.inProgress)")
                        if mission.taskCounts.blocked > 0 {
                            Metric(label: "blocked", value: "\(mission.taskCounts.blocked)", emphasis: true)
                        }
                        if mission.taskCounts.failed > 0 {
                            Metric(label: "failed", value: "\(mission.taskCounts.failed)", emphasis: true)
                        }
                    }

                    if !mission.timeline.isEmpty {
                        Divider().overlay(theme.color(\.chromeDivider))
                        // Newest first — an agent can complete and start again, so
                        // the latest event is the truth, not the last one written.
                        ForEach(mission.reverseChronologicalTimeline.prefix(6)) { event in
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(theme.color(\.accentMuted))
                                    .frame(width: 4, height: 4)
                                Text(event.agent)
                                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                                    .foregroundStyle(theme.color(\.textSecondary))
                                Text(event.detail)
                                    .font(.system(size: 10))
                                    .foregroundStyle(theme.color(\.textMuted))
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
            }
        }
    }
}
