import SwiftUI
import NexusKit

/// What is working right now — the app's most distinctive screen.
///
/// THREE genuinely different kinds of concurrency share this screen, and the
/// split is kept explicit rather than blurred:
///
///  - **Provider lanes** — several models answering the SAME prompt in a
///    compare/race run, read from the live `nexus` event stream.
///  - **NexusCode agent runs** — `nexus agent --role …`, ONE agent iterating
///    on its own output through a verified Observe → Plan → Act → Reflect →
///    Evaluate loop. Provider-agnostic: the identical loop runs on anthropic,
///    mock, or any registered adapter.
///  - **OMC subagents** — specialised agents doing SEPARATE work, read from
///    oh-my-claudecode's on-disk session state.
///
/// Merging them into one undifferentiated "agents" list would misrepresent what
/// is happening, so origin stays visible everywhere: separate sections, a
/// per-card badge, and separate counts in the header strip.
struct AgentsView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    @State private var now = Date()

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    /// Excludes any lane currently driving a role run — that lane surfaces
    /// once, below, in `roleRuns` instead. Without this filter the same lane
    /// would render twice under two different origins.
    private var lanes: [AgentRow] {
        guard let view = workspace.conversation?.view else { return [] }
        return AgentRowBuilder.lanesExcludingRoleRuns(from: view).runningFirst()
    }

    private var roleRuns: [AgentRow] {
        guard let view = workspace.conversation?.view else { return [] }
        return AgentRowBuilder.roleRuns(from: view).runningFirst()
    }

    private var omcAgents: [AgentRow] {
        guard let snapshot = workspace.omc?.snapshot else { return [] }
        return AgentRowBuilder.omcAgents(from: snapshot).runningFirst()
    }

    private var hud: OMCSessionHUD? { workspace.omc?.snapshot.hud }
    private var mission: OMCMission? { workspace.omc?.snapshot.missions?.activeMissions.first }
    private var unreadable: [String] { workspace.omc?.snapshot.unreadable ?? [] }

    /// The header strip needs something to report even before any agent has
    /// run this session — HUD facts (model, cost) exist from the moment OMC
    /// is attached — so it is gated on more than just the three row lists.
    private var hasReadout: Bool { !lanes.isEmpty || !roleRuns.isEmpty || !omcAgents.isEmpty || hud != nil }

    private var noActivity: Bool { lanes.isEmpty && roleRuns.isEmpty && omcAgents.isEmpty }

    /// Stricter than `noActivity`: a mission or an unreadable-paths notice is
    /// real content even when no row is actively running (e.g. between two
    /// agent launches in the same mission), so neither should be replaced by
    /// the "Nothing running" hero — only true silence earns that.
    private var isFullyEmpty: Bool { noActivity && mission == nil && unreadable.isEmpty }

    var body: some View {
        // `HeaderStrip` is pinned via `PageScaffold`'s header slot rather than
        // living inside the scrolling content like every other section here:
        // it is a dashboard readout ("N running", session cost), the one
        // thing on this screen worth keeping visible while scrolling a long
        // list of cards below it — and, when there's nothing running, it's
        // what stops the empty state from being the ENTIRE screen with no
        // context above it.
        PageScaffold {
            if hasReadout {
                HeaderStrip(lanes: lanes, roleRuns: roleRuns, omcAgents: omcAgents, hud: hud)
                    .padding(.horizontal, Space.xl)
                    .padding(.top, Space.xl)
                    .padding(.bottom, Space.lg)
            }
        } content: {
            if isFullyEmpty {
                HeroEmptyState(
                    icon: "person.3.sequence",
                    title: "Nothing running",
                    message: "Provider lanes appear here during a Compare or Race run. NexusCode's own agent runs (`nexus agent --role`) and OMC subagents appear here too, whenever they run in this project."
                )
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.lg) {
                        if !roleRuns.isEmpty {
                            AgentSection(
                                title: "NexusCode Agent Runs",
                                subtitle: "nexus agent --role … — one agent iterating through Observe → Plan → Act → Reflect → Evaluate",
                                rows: roleRuns,
                                now: now
                            )
                        }
                        if !lanes.isEmpty {
                            AgentSection(
                                title: "Provider Lanes",
                                subtitle: "Models answering the same prompt — live nexus event stream",
                                rows: lanes,
                                now: now
                            )
                        }
                        if !omcAgents.isEmpty {
                            AgentSection(
                                title: "OMC Subagents",
                                subtitle: "From .omc/state — specialised agents doing separate work",
                                rows: omcAgents,
                                now: now
                            )
                        }

                        if let mission {
                            MissionPanel(mission: mission)
                        }

                        if !unreadable.isEmpty {
                            UnreadableNotice(paths: unreadable)
                        }
                    }
                    .padding(.horizontal, Space.xl)
                    .padding(.top, hasReadout ? 0 : Space.xl)
                    .padding(.bottom, Space.xl)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(theme.color(\.surfaceBase))
        .onReceive(tick) { now = $0 }
    }
}

/// Promotes running rows to the top without disturbing anything else about
/// ordering. A manual stable sort (index as tiebreak) rather than relying on
/// `sorted`'s stability guarantee, so the intent — "running first, otherwise
/// leave the builder's own order alone" — is legible at the call site.
private extension Array where Element == AgentRow {
    func runningFirst() -> [AgentRow] {
        enumerated()
            .sorted { a, b in
                if a.element.isRunning != b.element.isRunning { return a.element.isRunning }
                return a.offset < b.offset
            }
            .map { $0.element }
    }
}

/// The control-room readout: total activity, split by origin, plus live
/// session facts once OMC's HUD file is available. This is the one place all
/// three kinds of concurrency are counted side by side — never merged, just
/// tallied next to each other.
private struct HeaderStrip: View {
    @Environment(\.nexusTheme) private var theme
    let lanes: [AgentRow]
    let roleRuns: [AgentRow]
    let omcAgents: [AgentRow]
    let hud: OMCSessionHUD?

    private var laneRunning: Int { lanes.filter(\.isRunning).count }
    private var roleRunRunning: Int { roleRuns.filter(\.isRunning).count }
    private var omcRunning: Int { omcAgents.filter(\.isRunning).count }
    private var totalRunning: Int { laneRunning + roleRunRunning + omcRunning }

    /// Amber past 80%, red past 95% — the same thresholds for every percentage
    /// readout in the strip, so "does this number mean trouble" reads at a
    /// glance instead of needing a different scale per metric.
    private func tone(forPercent value: Int?) -> CountPill.Tone {
        guard let value else { return .neutral }
        if value >= 95 { return .danger }
        if value >= 80 { return .warning }
        return .neutral
    }

    var body: some View {
        Card(padding: Space.md, radius: Radius.panel) {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(spacing: Space.sm) {
                    StatusDot(isRunning: totalRunning > 0, isFailed: false, size: 9)
                    Text(totalRunning > 0 ? "\(totalRunning) running" : "Idle")
                        .font(Kind.title)
                        .foregroundStyle(theme.color(\.textPrimary))
                        .monospacedDigit()

                    Spacer(minLength: Space.md)

                    CountPill(
                        text: "\(laneRunning) lane\(laneRunning == 1 ? "" : "s")",
                        tone: laneRunning > 0 ? .accent : .neutral
                    )
                    CountPill(
                        text: "\(roleRunRunning) agent\(roleRunRunning == 1 ? "" : "s")",
                        tone: roleRunRunning > 0 ? .accent : .neutral
                    )
                    CountPill(
                        text: "\(omcRunning) omc",
                        tone: omcRunning > 0 ? .accent : .neutral
                    )
                }

                if let hud {
                    Divider().overlay(theme.color(\.chromeDivider))
                    HStack(spacing: Space.lg) {
                        if let cost = hud.totalCostUsd {
                            ReadoutMetric(label: "session", value: String(format: "$%.2f", cost))
                        }
                        if let context = hud.contextUsedPercentage {
                            ReadoutMetric(label: "context", value: "\(context)%", tone: tone(forPercent: context))
                        }
                        if let fiveHour = hud.fiveHourLimitPercentage {
                            ReadoutMetric(label: "5h limit", value: "\(fiveHour)%", tone: tone(forPercent: fiveHour))
                        }
                        if let sevenDay = hud.sevenDayLimitPercentage {
                            ReadoutMetric(label: "7d limit", value: "\(sevenDay)%", tone: tone(forPercent: sevenDay))
                        }
                        Spacer(minLength: 0)
                        if let model = hud.modelDisplayName {
                            Text(model)
                                .font(Kind.caption)
                                .foregroundStyle(theme.color(\.textMuted))
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
    }
}

/// Like the shared `Metric`, but the value can flip to a warning/danger tone.
/// `Metric` only offers a binary accent/plain emphasis, which cannot express
/// "this percentage has crossed a threshold" — the whole point of a HUD
/// readout — so this stays a small local sibling rather than stretching that
/// primitive to cover a case it wasn't designed for.
private struct ReadoutMetric: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String
    var tone: CountPill.Tone = .neutral

    private var valueColor: Color {
        switch tone {
        case .accent: return theme.color(\.accentDefault)
        case .neutral: return theme.color(\.textSecondary)
        case .warning: return theme.color(\.warningFg)
        case .danger: return theme.color(\.errorFg)
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Text(label.uppercased())
                .font(Kind.micro)
                .tracking(0.5)
                .foregroundStyle(theme.color(\.textMuted).opacity(0.8))
            Text(value)
                .font(Kind.monoSmall)
                .foregroundStyle(valueColor)
                .monospacedDigit()
        }
        .fixedSize()
    }
}

/// One origin's rows: a header naming what this group of concurrency actually
/// is, then an adaptive grid so cards get comfortable width on a wide window
/// and collapse to one column on a narrow one — no `GeometryReader` needed,
/// `.adaptive` does the same job declaratively.
private struct AgentSection: View {
    @Environment(\.nexusTheme) private var theme
    let title: String
    let subtitle: String
    let rows: [AgentRow]
    let now: Date

    private let columns = [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: Space.md)]

    private var runningCount: Int { rows.filter(\.isRunning).count }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(
                title,
                subtitle: subtitle,
                accessory: runningCount > 0
                    ? AnyView(CountPill(text: "\(runningCount) running", tone: .accent))
                    : nil
            )
            LazyVGrid(columns: columns, alignment: .leading, spacing: Space.md) {
                ForEach(rows) { row in
                    AgentCard(row: row, now: now)
                }
            }
        }
    }
}

/// One lane or subagent. Running cards get an accent border and a soft glow —
/// "alive" needs to be visible without reading any text — and failed cards get
/// their own distinct (non-accent) border so a stalled run cannot be mistaken
/// for a healthy one at a glance.
private struct AgentCard: View {
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

    private var stateBorderColor: Color {
        if row.isFailed { return theme.color(\.errorBorder) }
        if row.isRunning { return theme.color(\.accentDefault).opacity(0.55) }
        return .clear
    }

    var body: some View {
        Card(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(alignment: .top, spacing: Space.sm) {
                    StatusDot(isRunning: row.isRunning, isFailed: row.isFailed)
                        .padding(.top, 3)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: Space.xs) {
                            Text(row.title)
                                .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(theme.color(\.textPrimary))
                                .lineLimit(1)
                            OriginBadge(origin: row.origin)
                            if let verdict = row.verdict {
                                VerdictBadge(verdict: verdict)
                            }
                        }
                        Text(row.subtitle)
                            .font(Kind.caption)
                            .foregroundStyle(row.isFailed ? theme.color(\.errorFg) : theme.color(\.textMuted))
                            .lineLimit(1)
                    }

                    Spacer(minLength: Space.sm)

                    if let elapsed {
                        Text(elapsed)
                            .font(Kind.mono)
                            .foregroundStyle(row.isRunning ? theme.color(\.accentDefault) : theme.color(\.textMuted))
                            .monospacedDigit()
                    }
                }

                if let detail = row.detail {
                    Text(detail)
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textSecondary))
                        .lineLimit(2)
                        // Align under the title, past the status dot's column.
                        .padding(.leading, 8 + Space.sm)
                }
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(stateBorderColor, lineWidth: row.isRunning || row.isFailed ? 1.4 : 0)
        }
        .shadow(
            color: row.isRunning ? theme.color(\.accentDefault).opacity(0.24) : .clear,
            radius: row.isRunning ? 12 : 0
        )
    }
}

/// The one badge that answers "which kind of concurrency is this" on every
/// single card — deliberately a different chip colour per origin (info blue
/// for a lane, the theme's secondary accent for a NexusCode role run, neutral
/// chrome for OMC) rather than a shared style, since the whole point is that
/// the three must never blur together.
private struct OriginBadge: View {
    @Environment(\.nexusTheme) private var theme
    let origin: AgentRow.Origin

    private var text: String {
        switch origin {
        case .lane: return "LANE"
        case .roleRun: return "AGENT"
        case .omc: return "OMC"
        }
    }

    private var colors: (bg: Color, fg: Color) {
        switch origin {
        case .lane: return (theme.color(\.infoBg), theme.color(\.infoFg))
        // `accentSecondary` exists precisely for "an alternate tag family, a
        // secondary badge" (see `AccentSystem`'s doc comment) — the theme's
        // primary accent already means "running" everywhere else on this
        // screen (`StatusDot`, the header's count pills), so borrowing it here
        // would blur "this is a role run" into "this is active".
        case .roleRun: return (theme.color(\.surfaceOverlay), theme.accentSecondary)
        case .omc: return (theme.color(\.surfaceOverlay), theme.color(\.textMuted))
        }
    }

    var body: some View {
        Text(text)
            .font(Kind.micro)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(colors.bg, in: Capsule())
            .foregroundStyle(colors.fg)
    }
}

/// The agent loop's three-valued outcome, shown next to the origin badge once
/// a role run has stopped (absent while running — `StatusDot`'s pulse already
/// owns that signal).
///
/// `.indeterminate` gets its own colour and its own word — "unverified" —
/// deliberately distinct from both `.met` ("verified", success green) and
/// `.unmet` ("not met", error red): collapsing it into either would silently
/// break the loop's core honesty guarantee (see `AgentVerdict`). The warning
/// treatment mirrors `UnreadableNotice` below — a caveat about what could be
/// confirmed, not an incident — so it reads as its own thing rather than a
/// soft failure.
private struct VerdictBadge: View {
    @Environment(\.nexusTheme) private var theme
    let verdict: AgentVerdict

    private var text: String {
        switch verdict {
        case .met: return "verified"
        case .unmet: return "not met"
        case .indeterminate: return "unverified"
        }
    }

    private var colors: (bg: Color, fg: Color) {
        switch verdict {
        case .met: return (theme.color(\.successBg), theme.color(\.successFg))
        case .unmet: return (theme.color(\.errorBg), theme.color(\.errorFg))
        case .indeterminate: return (theme.color(\.warningBg), theme.color(\.warningFg))
        }
    }

    var body: some View {
        Text(text)
            .font(Kind.micro)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(colors.bg, in: Capsule())
            .foregroundStyle(colors.fg)
    }
}

/// Mission progress + timeline, when OMC is coordinating a multi-agent mission.
private struct MissionPanel: View {
    @Environment(\.nexusTheme) private var theme
    let mission: OMCMission

    private var progress: Double {
        let total = mission.taskCounts.total
        guard total > 0 else { return 0 }
        return Double(mission.taskCounts.completed) / Double(total)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(
                "Mission",
                subtitle: mission.workerCount > 0 ? "\(mission.workerCount) workers coordinating" : nil
            )

            Card(padding: Space.md, radius: Radius.panel) {
                VStack(alignment: .leading, spacing: Space.md) {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                            Text(mission.objective.isEmpty ? mission.name : mission.objective)
                                .font(Kind.bodyEmphasis)
                                .foregroundStyle(theme.color(\.textPrimary))
                                .lineLimit(2)
                            Spacer(minLength: Space.sm)
                            Text("\(mission.taskCounts.completed)/\(mission.taskCounts.total)")
                                .font(Kind.mono)
                                .foregroundStyle(theme.color(\.textMuted))
                                .monospacedDigit()
                        }
                        ProgressView(value: progress)
                            .tint(theme.color(\.accentDefault))
                    }

                    HStack(spacing: Space.md) {
                        Metric(label: "active", value: "\(mission.taskCounts.inProgress)")
                        Metric(label: "pending", value: "\(mission.taskCounts.pending)")
                        if mission.taskCounts.blocked > 0 {
                            CountPill(text: "\(mission.taskCounts.blocked) blocked", tone: .warning)
                        }
                        if mission.taskCounts.failed > 0 {
                            CountPill(text: "\(mission.taskCounts.failed) failed", tone: .danger)
                        }
                        Spacer(minLength: 0)
                    }

                    if !mission.timeline.isEmpty {
                        Divider().overlay(theme.color(\.chromeDivider))
                        // Newest first — an agent can complete and start again,
                        // so the latest event is the truth, not the last one
                        // physically appended to the file.
                        TimelineRail(events: Array(mission.reverseChronologicalTimeline.prefix(8)))
                    }
                }
            }
        }
    }
}

/// A vertical rail: a dot per event joined by a connector line, newest event
/// on top and picked out in accent so "what just happened" never requires
/// reading timestamps first.
private struct TimelineRail: View {
    @Environment(\.nexusTheme) private var theme
    let events: [OMCTimelineEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                HStack(alignment: .top, spacing: Space.sm) {
                    VStack(spacing: 0) {
                        Circle()
                            .fill(index == 0 ? theme.color(\.accentDefault) : theme.color(\.textMuted).opacity(0.5))
                            .frame(width: 6, height: 6)
                            .padding(.top, 4)
                        if index < events.count - 1 {
                            // Fills the rest of this row's height, so consecutive
                            // rows read as one continuous rail rather than a
                            // stack of disconnected dashes.
                            Rectangle()
                                .fill(theme.color(\.chromeDivider))
                                .frame(width: 1)
                                .frame(maxHeight: .infinity)
                        }
                    }
                    .frame(width: 6)

                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: Space.xs) {
                            Text(event.agent)
                                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .foregroundStyle(theme.color(\.textSecondary))
                            if let at = event.at {
                                Text(at, style: .time)
                                    .font(Kind.micro)
                                    .foregroundStyle(theme.color(\.textMuted).opacity(0.7))
                            }
                        }
                        Text(event.detail)
                            .font(Kind.caption)
                            .foregroundStyle(theme.color(\.textMuted))
                            .lineLimit(2)
                    }
                    .padding(.bottom, Space.sm)
                }
            }
        }
    }
}

/// Understated by design: this is a caveat about data freshness, not an
/// incident, so it must never compete visually with a real failure state.
private struct UnreadableNotice: View {
    @Environment(\.nexusTheme) private var theme
    let paths: [String]

    var body: some View {
        HStack(spacing: Space.xs) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 9))
            Text("Could not read \(paths.joined(separator: ", ")) — some values may be stale.")
                .font(Kind.micro)
        }
        .foregroundStyle(theme.color(\.warningFg).opacity(0.85))
    }
}
