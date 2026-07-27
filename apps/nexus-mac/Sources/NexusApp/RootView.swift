import SwiftUI
import AppKit
import NexusKit

/// The window shell: a custom sidebar, the active surface, and a status bar
/// that stays visible everywhere so provider, cost and agent activity are never
/// more than a glance away.
struct RootView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    var body: some View {
        // `StatusBar` is a sibling BELOW the sidebar/content split, not
        // nested inside the content column's own `VStack`. It used to be the
        // latter, which put it flush against the content column's bottom
        // edge only — the sidebar had its own, separate live-status readout
        // (`SidebarFooter`, now gone) sitting at the SAME height one column
        // over, so the window read as having two competing bottom strips.
        // One bar spanning the full width, carrying the real state from
        // both halves (see `StatusBar`'s own doc comment), replaces both.
        VStack(spacing: 0) {
            // A plain HStack, not `NavigationSplitView`.
            //
            // The split view manages its own per-column safe areas and toolbar
            // interaction, and on this OS it gave the detail column a title-bar
            // inset while giving the sidebar column none — drawing the sidebar's
            // header under the traffic lights. Four documented fixes
            // (`safeAreaInset`, `List` + `.listStyle(.sidebar)`, background-only
            // `ignoresSafeArea`, `unifiedCompact`) each failed to move it. Owning
            // the split directly removes the whole interaction: both columns are now
            // ordinary views inside one content area with one safe area.
            HStack(spacing: 0) {
                Sidebar()
                    .frame(width: 248)

                Rectangle()
                    .fill(theme.hairline)
                    .frame(width: 1)

                VStack(spacing: 0) {
                    if let problem = workspace.setupProblem {
                        SetupBanner(message: problem)
                    }
                    content
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .background(theme.color(\.surfaceBase))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            StatusBar()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .tint(theme.color(\.accentDefault))
    }

    @ViewBuilder
    private var content: some View {
        switch workspace.tab {
        case .chat:
            if let conversation = workspace.conversation {
                ChatTab(controller: conversation)
            } else {
                // `workspace.conversation == nil` and `workspace.setupProblem
                // != nil` are set together in `WorkspaceModel.attach()` — the
                // fallback text below only fires if that invariant is ever
                // violated, never the expected path.
                HeroEmptyState(
                    icon: "terminal",
                    title: "No nexus executable",
                    message: workspace.setupProblem ?? "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                )
            }
        case .agents:
            AgentsView()
        case .sessions:
            SessionsView()
        case .tasks:
            TasksView()
        case .accounts:
            AuthView()
        case .integrations:
            IntegrationsView()
        case .git:
            GitView()
        case .settings:
            SettingsView()
        }
    }
}

/// Everything currently doing work, across both kinds of concurrency this app
/// has: provider lanes (compare/race) and OMC subagents. Computed in one place
/// so the sidebar badge, sidebar footer and status bar never disagree.
@MainActor
private func runningCount(_ workspace: WorkspaceModel) -> Int {
    (workspace.conversation?.view.activeLanes.count ?? 0)
        + (workspace.omc?.snapshot.runningAgents.count ?? 0)
}

/// Opens a native folder picker and hands back the chosen directory. Shared by
/// the sidebar's project switcher and the Settings project card so there is
/// exactly one "change project" code path.
@MainActor
private func presentDirectoryPicker(current: URL, onPick: (URL) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = false
    panel.allowsMultipleSelection = false
    panel.directoryURL = current
    panel.prompt = "Open"
    panel.message = "Choose the project NexusCode should drive `nexus` from."
    guard panel.runModal() == .OK, let url = panel.url else { return }
    onPick(url)
}

/// The status bar's cost readout for the whole session. `nil` means show
/// nothing — the genuinely-empty case (no runs yet, or every run so far was
/// free), unchanged from before this existed. Uses the SAME two-decimal /
/// `<$0.01` shape and `*` "partial total" convention as `ConversationView`'s
/// composer readout (`UsageReadout.formatted`) for the identical underlying
/// `ViewState.totals` value — the two are simultaneously visible chrome
/// showing the same number, so they must never disagree digit-for-digit.
/// `SessionsView`'s cost column deliberately keeps four decimals instead: it's
/// a historical record where sub-cent differences across many sessions are
/// the point, not a live glance figure where `<$0.01` already answers "is
/// this basically free" without extra digits.
private func statusBarCost(_ totals: UsageTotals) -> String? {
    guard totals.costUsd > 0 else { return totals.costIncomplete ? "—" : nil }
    let amount = totals.costUsd < 0.01 ? "<$0.01" : String(format: "$%.2f", totals.costUsd)
    return totals.costIncomplete ? "\(amount)*" : amount
}

/// Explains the `*`/`—` marker `statusBarCost` can attach to the status bar's
/// cost readout. Wording matches `SessionsView`'s `costHelp` for the
/// identical `costIncomplete` concept — keep the two in sync.
private let costIncompleteHelp = "Partial total — pricing is unknown for at least one run, so this isn't the full cost."

// MARK: - Sidebar

/// The whole left column: brand mark, project switcher, navigation, and a
/// live-status footer. Built from scratch rather than a stock `List` — a
/// generic list is exactly what made the shell read like a debug window.
private struct Sidebar: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    var body: some View {
        // A `List` rather than a bare `VStack`. Only a List's scroll view
        // participates in the sidebar column's title-bar safe area on macOS — a
        // plain VStack gets no top inset at all, which drew the brand header and
        // project switcher underneath the traffic lights. Keeping List for the
        // inset (and for free keyboard navigation) while hiding its background
        // and row chrome preserves the fully custom look.
        List {
            Group {
                BrandHeader()
                    .padding(.bottom, Space.md)

                ProjectSwitcherRow()
                    .padding(.bottom, Space.lg)

                // Grouped, not one flat list of eight. Ungrouped peers read as
                // equal, which is wrong: Settings is configured once, Chat is
                // used every session.
                ForEach(WorkspaceTab.Group.allCases) { group in
                    SectionHeader(group.title)
                        .padding(.top, group == .work ? 0 : Space.lg)
                        .padding(.bottom, Space.xs)

                    VStack(spacing: 2) {
                        ForEach(WorkspaceTab.tabs(in: group)) { tab in
                            SidebarNavRow(
                                tab: tab,
                                isSelected: workspace.tab == tab,
                                badge: badge(for: tab),
                                action: { workspace.tab = tab }
                            )
                        }
                    }
                }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: Space.md, bottom: 0, trailing: Space.md))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // No footer readout down here any more — this sidebar used to end in
        // its own live-status block ("OMC watching" / "N agents running"),
        // floating with no room to breathe right above the window's bottom
        // edge. `StatusBar` is the single, full-width bottom bar now (see its
        // doc comment): the "OMC watching" fact moved there, and the agent
        // count was always redundant with that bar's own "N working" pill.
        // ONLY the background bleeds under the title bar. Applying
        // `.ignoresSafeArea()` to the whole sidebar is the standard way to get a
        // native-looking material behind the traffic lights — and also the
        // standard way to drag your own content up into that dead zone, because
        // it applies to the entire subtree.
        //
        // `materials.sidebar` is the one of `AppTheme`'s three named material
        // roles this view is actually in a position to honour (the other two,
        // `.overlay` and `.composer`, belong to `Card` and the conversation
        // input bar respectively) — a flat fill everywhere, sidebar included,
        // was exactly what made this app read as a repainted terminal.
        .background(alignment: .top) {
            themedFill(theme.color(\.surfaceSunken), treatment: theme.materials.sidebar, in: Rectangle())
                .ignoresSafeArea()
        }
    }

    /// Live agent count on the Agents tab, so activity is visible from any tab.
    private func badge(for tab: WorkspaceTab) -> Int {
        guard tab == .agents else { return 0 }
        return runningCount(workspace)
    }
}

/// The wordmark: a hexagon mark in the accent colour plus the app name. Kept
/// as its own view so the same mark can be reused at a smaller size in the
/// status bar without duplicating the layout.
private struct BrandHeader: View {
    @Environment(\.nexusTheme) private var theme

    var body: some View {
        HStack(spacing: Space.sm) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(theme.color(\.accentMuted))
                    .frame(width: 30, height: 30)
                Image(systemName: "hexagon.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(theme.color(\.accentDefault))
            }
            Text("NexusCode")
                .font(Kind.title)
                .foregroundStyle(theme.color(\.textPrimary))
            Spacer(minLength: 0)
        }
    }
}

/// The current project, shown as a clickable row that opens a directory
/// picker — this is the entire mechanism for repointing the app at a
/// different checkout, so it has to read as a real control, not a label.
private struct ProjectSwitcherRow: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    @State private var hovering = false

    var body: some View {
        Button {
            presentDirectoryPicker(current: workspace.projectDirectory) {
                workspace.projectDirectory = $0
            }
        } label: {
            HStack(spacing: Space.sm) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.color(\.textMuted))
                    .accessibilityHidden(true)
                Text(workspace.projectDirectory.lastPathComponent)
                    .font(Kind.bodyEmphasis)
                    .foregroundStyle(theme.color(\.textPrimary))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.color(\.textMuted))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 7)
            .background(
                theme.color(\.surfaceOverlay).opacity(hovering ? 1 : 0.55),
                in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(workspace.projectDirectory.path)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .accessibilityLabel("Project: \(workspace.projectDirectory.lastPathComponent)")
        .accessibilityHint("Choose a different project directory")
    }
}

/// One navigation destination.
///
/// Selected state used to be a FULL-STRENGTH `accentDefault` fill — the
/// single loudest object on every screen in the app, for a nav item that
/// only needs to be legible, not shouted. It's now the same restrained
/// technique `CountPill`'s `.accent` tone already uses and already has a
/// contrast test for: a tinted `accentMuted` wash rather than the solid
/// colour, with `Color.readableText` computing the label colour against it
/// (never assumed — see that function's doc comment on exactly how guessing
/// wrong here bit `CountPill` before). A slim accent rail on the leading edge
/// carries the rest of the "this one is selected" signal, at a weight that
/// reads as an indicator rather than a block.
private struct SidebarNavRow: View {
    @Environment(\.nexusTheme) private var theme
    let tab: WorkspaceTab
    let isSelected: Bool
    let badge: Int
    let action: () -> Void

    @State private var hovering = false

    /// Computed rather than reused from `accentFg` — that token was designed
    /// for text on the full-strength `accentDefault` fill, not the muted
    /// wash this row now uses. See `Theme.swift`'s `readableText` doc comment
    /// for the exact bug guessing that token produced elsewhere.
    private var selectedForeground: Color {
        Color.readableText(on: theme.tokens.accentMuted, preferring: theme.tokens.textPrimary, otherwise: theme.tokens.textInverse)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Image(systemName: tab.systemImage)
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 16)
                    // The label below already names this control; a decorative
                    // glyph with its own default AX name (the SF Symbol's) is
                    // exactly what turned this row into a bare, unnamed
                    // `AXButton` in VoiceOver — hiding it lets the row's own
                    // `accessibilityLabel` win instead of competing with it.
                    .accessibilityHidden(true)
                Text(tab.title)
                    .font(Kind.bodyEmphasis)
                Spacer(minLength: 0)
                if badge > 0 {
                    CountPill(text: "\(badge)", tone: isSelected ? .neutral : .accent)
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(isSelected ? selectedForeground : theme.color(\.textSecondary))
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 7)
            .background {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(
                        isSelected
                            ? theme.color(\.accentMuted)
                            : (hovering ? theme.color(\.surfaceOverlay) : .clear)
                    )
            }
            .overlay(alignment: .leading) {
                if isSelected {
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(theme.color(\.accentDefault))
                        .frame(width: 3)
                        .padding(.vertical, 5)
                        .padding(.leading, 2)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        // Set explicitly rather than relying on the label + icon + badge
        // combining on their own: this is the exact control the accessibility
        // tree audit found reading as an unnamed button (see the file's
        // header task notes), so the name is asserted here instead of hoped for.
        .accessibilityLabel(badge > 0 ? "\(tab.title), \(badge) running" : tab.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Setup banner

/// Shown when the CLI could not be found — explains the fix instead of failing
/// silently on every button press.
struct SetupBanner: View {
    @Environment(\.nexusTheme) private var theme
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(theme.color(\.warningFg))
            Text(message)
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textSecondary))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Space.md)
        .background(theme.color(\.warningBg))
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.color(\.warningBorder)).frame(height: 1)
        }
    }
}

// MARK: - Status bar

/// The always-visible bottom strip: provider/model, live cost, context
/// pressure, whether OMC is watching this project, and how many agents are
/// working. One row, never wraps.
///
/// This is now the ONLY bottom bar in the window — it used to share the
/// bottom edge with a second, separate readout pinned to the sidebar
/// (`SidebarFooter`, now gone), which put two differently-styled strips at
/// the same height and made the window read as unfinished. Everything that
/// second strip carried moved here: "OMC watching" joined the row below, and
/// its per-agent count was already redundant with the "N working" pill this
/// bar always had at the trailing edge.
struct StatusBar: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    private var running: Int { runningCount(workspace) }

    private var omcLabel: String? {
        guard let omc = workspace.omc, omc.isAvailable else { return nil }
        return omc.isWatching ? "OMC watching" : "OMC idle"
    }

    var body: some View {
        HStack(spacing: Space.md) {
            HStack(spacing: 6) {
                Image(systemName: "hexagon.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(theme.color(\.accentDefault))
                    .accessibilityHidden(true)
                Text("NexusCode")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.color(\.textPrimary))
            }

            if let omcLabel {
                StatusDivider()
                HStack(spacing: 6) {
                    StatusDot(isRunning: workspace.omc?.isWatching == true, isFailed: false, size: 6, animate: false)
                    Text(omcLabel)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.color(\.textMuted))
                }
            }

            if let session = workspace.conversation?.view.session {
                StatusDivider()
                Metric(label: "model", value: session.model, emphasis: true)
            }

            if let totals = workspace.conversation?.view.totals, let cost = statusBarCost(totals) {
                if totals.costIncomplete {
                    Metric(label: "cost", value: cost)
                        .help(costIncompleteHelp)
                } else {
                    Metric(label: "cost", value: cost)
                }
            }

            if let hud = workspace.omc?.snapshot.hud {
                StatusDivider()
                if let percent = hud.contextUsedPercentage {
                    StatusMetric(label: "ctx", value: "\(percent)%", tone: percent > 80 ? .warning : .neutral)
                }
                if let cost = hud.totalCostUsd {
                    Metric(label: "session", value: String(format: "$%.2f", cost))
                }
            }

            Spacer(minLength: Space.sm)

            if running > 0 {
                HStack(spacing: 6) {
                    StatusDot(isRunning: true, isFailed: false)
                    Text("\(running) working")
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
        .lineLimit(1)
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .background(theme.color(\.surfaceSunken))
        .overlay(alignment: .top) {
            Rectangle().fill(theme.color(\.chromeDivider)).frame(height: 1)
        }
    }
}

/// A hairline separator between status-bar groups — purely structural, so it
/// carries no semantic colour of its own.
private struct StatusDivider: View {
    @Environment(\.nexusTheme) private var theme
    var body: some View {
        Rectangle().fill(theme.color(\.chromeDivider)).frame(width: 1, height: 12)
    }
}

/// Like the shared `Metric`, but with a third, more urgent tone — context
/// pressure needs to visibly escalate past 80% and `Metric` only distinguishes
/// muted vs accent.
private struct StatusMetric: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String
    var tone: Tone = .neutral

    enum Tone { case neutral, warning }

    private var valueColor: Color {
        tone == .warning ? theme.color(\.warningFg) : theme.color(\.textSecondary)
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

// MARK: - Settings

/// Theme picker + where the app is pointed. Deliberately small: configuration
/// belongs to `nexus config`, and duplicating it here would create a second
/// source of truth.
struct SettingsView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    private let columns = [GridItem(.adaptive(minimum: 168, maximum: 220), spacing: Space.md)]

    var body: some View {
        // Header pinned, body fills-or-scrolls — see `PageScaffold`'s doc
        // comment. This screen was a bare `ScrollView` with the "Theme"
        // heading trapped *inside* it alongside both grids and the project
        // card, which only avoided the dead-space symptom because 23
        // swatches happened to fill the window. Pinning the heading here and
        // letting the (genuinely tall) rest of the content own its own
        // `ScrollView` brings it into line with every other screen.
        PageScaffold {
            VStack(alignment: .leading, spacing: 4) {
                Text("Theme")
                    .font(Kind.title)
                    .foregroundStyle(theme.color(\.textPrimary))
                Text("\(AppTheme.all.count) themes designed for this window — material, elevation and gradient a terminal palette can't express.")
                    .font(Kind.caption)
                    .foregroundStyle(theme.color(\.textMuted))
            }
            .padding(.horizontal, Space.xl)
            .padding(.top, Space.xl)
            .padding(.bottom, Space.lg)
        } content: {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    LazyVGrid(columns: columns, spacing: Space.md) {
                        ForEach(AppTheme.all) { candidate in
                            ThemeSwatchButton(
                                theme: candidate,
                                isSelected: candidate.id == workspace.themeId,
                                action: { workspace.themeId = candidate.id }
                            )
                        }
                    }

                    SectionHeader(
                        "Terminal palettes",
                        subtitle: "The \(NexusTheme.all.count) palettes the CLI ships — same colours, rendered flat (no material, no elevation). Kept selectable for parity with the terminal, not because they suit a window."
                    )

                    LazyVGrid(columns: columns, spacing: Space.md) {
                        // Routed through the same bridge the environment itself
                        // uses (`NexusTheme.appTheme`) — one swatch type, one
                        // picker, regardless of which catalogue a theme is from.
                        ForEach(NexusTheme.all) { candidate in
                            ThemeSwatchButton(
                                theme: candidate.appTheme,
                                isSelected: candidate.id == workspace.themeId,
                                action: { workspace.themeId = candidate.id }
                            )
                        }
                    }

                    SectionHeader(
                        "Project",
                        accessory: AnyView(
                            Button("Change Directory…") {
                                presentDirectoryPicker(current: workspace.projectDirectory) {
                                    workspace.projectDirectory = $0
                                }
                            }
                            .buttonStyle(SoftButton(size: .compact))
                        )
                    )

                    Card {
                        VStack(alignment: .leading, spacing: Space.sm) {
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
                .padding(.horizontal, Space.xl)
                .padding(.bottom, Space.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct LabeledLine: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Text(label)
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textMuted))
                .frame(width: 70, alignment: .leading)
            Text(value)
                .font(Kind.mono)
                .foregroundStyle(theme.color(\.textSecondary))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A live preview of a theme, drawn entirely with that theme's own tokens —
/// the outer wrapper previews its `surfaceSunken` chrome, the inner tile its
/// `surfaceRaised` card, exactly the two layers the real window uses.
struct ThemeSwatch: View {
    let theme: AppTheme
    let isSelected: Bool

    private let chips: [KeyPath<ThemeTokens, String>] = [
        \.accentDefault, \.successFg, \.warningFg, \.errorFg,
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: 5) {
                ForEach(chips, id: \.self) { token in
                    Circle()
                        .fill(theme.color(token))
                        .frame(width: 15, height: 15)
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.color(\.accentDefault))
                }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(theme.name)
                    .font(Kind.bodyEmphasis)
                    .foregroundStyle(theme.color(\.textPrimary))
                    .lineLimit(1)
                Text(theme.isDark ? "Dark" : "Light")
                    .font(Kind.micro)
                    .foregroundStyle(theme.color(\.textMuted))
            }
        }
        .padding(Space.md)
        .background(theme.color(\.surfaceRaised))
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(
                    isSelected ? theme.color(\.accentDefault) : theme.color(\.chromeBorderSubtle),
                    lineWidth: isSelected ? 2 : 1
                )
        }
        .padding(4)
        .background(theme.color(\.surfaceSunken), in: RoundedRectangle(cornerRadius: Radius.card + 4, style: .continuous))
        .contentShape(Rectangle())
    }
}

/// `ThemeSwatch` wrapped in a real control.
///
/// The swatch used to be tappable only via `.onTapGesture` on a plain
/// `VStack` — that produces no `AXButton` role at all, so there was nothing
/// for a screen reader to name and no way to reach it with the keyboard. This
/// is strictly worse than an unnamed button: there is no element. Wrapping in
/// a real `Button` with `.buttonStyle(.plain)` preserves the exact visual
/// treatment `ThemeSwatch` already draws (including its `.contentShape` full-
/// tile hit target) while adding a genuine `AXButton` role, keyboard focus and
/// activation, and a proper name.
struct ThemeSwatchButton: View {
    let theme: AppTheme
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ThemeSwatch(theme: theme, isSelected: isSelected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(theme.name), \(theme.isDark ? "dark" : "light") theme")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Feeds the chat surface its live provider/model options.
///
/// `ConversationView` deliberately takes plain option lists rather than owning a
/// `ProvidersController`, so it stays renderable from previews and tests with no
/// process behind it. This is the one place that binds the real controller to
/// that seam.
struct ChatTab: View {
    @Environment(WorkspaceModel.self) private var workspace
    let controller: ConversationController

    @State private var providers: ProvidersController?
    @State private var models: [PickerOption] = []
    @State private var loadingModels = false

    var body: some View {
        ConversationView(
            controller: controller,
            providers: providerOptions,
            models: models,
            isLoadingModels: loadingModels,
            onLoadModels: loadModels
        )
        .task(id: workspace.projectDirectory) {
            guard let binary = workspace.binary else { return }
            let loaded = ProvidersController(
                client: NexusClient(binary: binary),
                workingDirectory: workspace.projectDirectory
            )
            providers = loaded
            await loaded.refresh()
            // Preselect whatever the CLI would have resolved anyway, so the
            // picker reflects reality instead of reading "none" while the
            // backend quietly uses its own default.
            if controller.provider == nil,
               let first = loaded.selectable.first(where: \.isUsable) {
                controller.provider = first.id
                loadModels(first.id)
            }
        }
    }

    private var providerOptions: [PickerOption] {
        (providers?.selectable ?? []).map { entry in
            PickerOption(
                id: entry.id,
                detail: entry.provider.detail,
                available: entry.isUsable,
                disabledReason: entry.reason,
                kind: entry.provider.kind,
                // A tripped circuit (quota/rate-limit/repeated failures) rides
                // `PickerOption.warning` — the SAME "visible but not blocking"
                // mechanism `ControlStrip.rolePicker` already uses for a
                // write-capable agent role, not `disabledReason`/`available`:
                // the provider stays fully selectable (see
                // `SelectableProvider.circuitWarning`'s doc for why).
                warning: entry.circuitWarning
            )
        }
    }

    private func loadModels(_ providerId: String) {
        guard let providers else { return }
        loadingModels = true
        Task {
            let loaded = await providers.models(for: providerId)
            models = loaded.map { PickerOption(id: $0.id, detail: $0.hint) }
            loadingModels = false
        }
    }
}
