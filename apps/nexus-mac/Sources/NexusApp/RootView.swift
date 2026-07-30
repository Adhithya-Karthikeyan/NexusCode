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
            // `GeometryReader` here answers exactly one question — is the
            // WINDOW narrow — so `Sidebar` can collapse to icons-only below
            // the app's own documented minimum width (900pt). Before this,
            // the sidebar held a fixed 248pt at every window size, which
            // made it a LARGER proportion of the window the narrower the
            // window got — at 900pt it was eating close to 30% of the frame,
            // exactly backwards from every competitor, which narrows or
            // collapses the rail as the window does.
            GeometryReader { geometry in
                let presentation = workspace.sidebar.presentation(forWindowWidth: geometry.size.width)
                let railWidth = workspace.sidebar.renderedWidth(forWindowWidth: geometry.size.width)
                HStack(spacing: 0) {
                    // At zero width the sidebar is not merely invisible, it is
                    // gone — kept in the tree so the width animates to and from
                    // it rather than the column popping, and clipped ONLY then
                    // so nothing inside it can draw over the content.
                    //
                    // Conditional, because an unconditional `.clipped()` also
                    // clips the background's deliberate bleed into the title-bar
                    // safe area — which is exactly what left a black band above
                    // the sidebar, measured at (0, 0, 0), while the same fix on
                    // the content column worked.
                    Sidebar(presentation: presentation)
                        .frame(width: railWidth)
                        .clipped(presentation == .hidden)

                    // The divider IS the drag handle when the sidebar is
                    // expanded — a separate 1px rule plus a separate grab strip
                    // would put two different things in the same 4pt of screen.
                    // In rail state it goes back to being an inert hairline:
                    // a rail has exactly one correct width, so offering a drag
                    // that silently does nothing (see `SidebarState.resize`)
                    // would be a control that lies.
                    SidebarEdge(
                        isResizable: presentation == .expanded,
                        currentWidth: railWidth,
                        onResize: { workspace.sidebar.resize(to: $0) },
                        onReset: { workspace.sidebar.resetWidth() }
                    )

                    VStack(spacing: 0) {
                        if let problem = workspace.setupProblem {
                            SetupBanner(message: problem)
                        }
                        content
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    // The way back. With the sidebar hidden the toggle that
                    // hid it has gone with it, which would leave ⌃⌘S — a chord
                    // the user has no way to discover — as the only exit. This
                    // is the smallest affordance that is unambiguously a door.
                    .overlay(alignment: .topLeading) {
                        if presentation == .hidden {
                            SidebarRestoreButton()
                                .padding(.leading, Space.sm)
                                .padding(.top, Space.sm)
                        }
                    }
                    // Full-bleed, at level 1 — the LIGHTEST large surface in
                    // the window, and the brightest thing the eye lands on.
                    //
                    // This replaces `CanvasPanel`, which inset the content by
                    // 12pt and drew a bordered "instrument frame" around it.
                    // That idea was the previous thesis's self-described
                    // highest-leverage change and it failed on both counts:
                    // measured on screen the border was invisible (the panel
                    // and the floor behind it sat within a hair of each
                    // other's luminance), and the inset spent 24pt of width
                    // and height on a gutter that communicated nothing — on a
                    // screen whose central complaint was dead space. Content
                    // running edge to edge against a darker rail is what Zed,
                    // Linear, Xcode and Cursor all do, and it makes the
                    // depth story unambiguous: chrome recedes, content rises.
                    // `.ignoresSafeArea(edges: .top)` on the FILL only, never on
                    // the content: the column's own views must keep their
                    // title-bar inset (that inset is the only thing keeping the
                    // sidebar header out from under the traffic lights), but the
                    // colour behind them has to reach the window's top edge.
                    // Without it the top 32pt of this column paints nothing and
                    // the window wears a black band above its canvas —
                    // measured at (0,0,0) on all eleven captures, including the
                    // light themes where it is unmissable.
                    .background(theme.surface(1).ignoresSafeArea(edges: .top))
                }
                // Width, not opacity or offset: the content column must take
                // up the space the sidebar releases in the same frame it
                // releases it, or the two slide past each other and the
                // divider visibly detaches mid-animation.
                .animation(Motion.overlay, value: workspace.sidebar.preference)
                .animation(Motion.overlay, value: workspace.sidebar.width)
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
/// the sidebar's project switcher, the Settings project card, and `GitView`'s
/// "not a git repository" empty state, so there is exactly one "change
/// project" code path — not `private`, since that third call site lives in a
/// different file.
@MainActor
func presentDirectoryPicker(current: URL, onPick: (URL) -> Void) {
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
    /// Expanded, or collapsed to an icon rail. In rail state every row keeps
    /// its name as a hover tooltip and its existing `accessibilityLabel`, so
    /// nothing here becomes discoverable only by trial and error.
    let presentation: SidebarPresentation

    private var isRail: Bool { presentation == .rail }

    var body: some View {
        // A pinned head and foot around ONE scrolling middle, rather than the
        // single `List` this used to be.
        //
        // The old sidebar put brand, project switcher and nav into one List and
        // then stopped — eight rows ending 340pt down an 860pt column, with
        // roughly 520pt (60%) of unexplained black beneath them. That void is
        // the single most-cited reason the window read as unfinished, and the
        // fix is not padding: it is that a chat app's sidebar has an obvious
        // job for that space, which is the conversations you might go back to.
        // `RecentsSection` fills it with real, live data, scrolls when there is
        // more of it than room, and the head/foot stay put either way.
        VStack(spacing: 0) {
            VStack(spacing: Space.sm) {
                BrandHeader(isRail: isRail)
                // In the rail the toggle gets its own centred row rather than
                // riding beside the wordmark there is no longer room for. It
                // has to appear SOMEWHERE in this state: a collapse control
                // that vanishes on collapse leaves the only way back to a
                // keyboard chord the user has no way to discover.
                if isRail { SidebarToggleButton() }
                ProjectSwitcherRow(isRail: isRail)
                NewConversationButton(isRail: isRail)
            }
            .padding(.horizontal, isRail ? Space.sm : Space.lg)
            .padding(.bottom, Space.lg)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // Grouped, not one flat list of eight. Ungrouped peers read
                    // as equal, which is wrong: Settings is configured once,
                    // Chat is used every session. Group LABELS drop in the rail
                    // — there is no room for a tracked heading beside a 24pt
                    // icon column, and a truncated one would look worse than
                    // none.
                    ForEach(WorkspaceTab.Group.allCases) { group in
                        if !isRail {
                            SectionHeader(group.title)
                                .padding(.top, group == .work ? 0 : Space.lg)
                                .padding(.bottom, Space.xs)
                                .padding(.horizontal, Space.sm)
                        } else if group != .work {
                            RailGroupSeparator()
                        }

                        VStack(spacing: 1) {
                            ForEach(WorkspaceTab.tabs(in: group)) { tab in
                                SidebarNavRow(
                                    tab: tab,
                                    isSelected: workspace.tab == tab,
                                    badge: badge(for: tab),
                                    isRail: isRail,
                                    action: { workspace.tab = tab }
                                )
                            }
                        }
                    }

                    if !isRail {
                        RecentsSection()
                            .padding(.top, Space.lg)
                    }
                }
                .padding(.horizontal, isRail ? Space.sm : Space.lg)
                .padding(.bottom, Space.lg)
            }
            .scrollIndicators(.never)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .environment(\.colorScheme, theme.isDark ? .dark : .light)
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
        // ONLY the background bleeds under the title bar. Applying
        // `.ignoresSafeArea()` to the whole sidebar is the standard way to get
        // a native-looking material behind the traffic lights — and also the
        // standard way to drag your own content up into that dead zone,
        // because it applies to the entire subtree.
        //
        // `isDark:` is what stops the material from inverting the ladder here
        // — see `themedFill`'s doc comment for the measurement. Before it, the
        // sidebar rendered at twice the luminance of the canvas it sits
        // beside, making the darkest surface in the theme the brightest one on
        // screen.
        // No `alignment:` argument. `.background(alignment: .top) { … }` pins
        // the background to the sidebar's own frame, and a view pinned inside
        // that frame cannot then expand past it — so the `.ignoresSafeArea()`
        // below it did nothing, and the top 32pt of this column measured
        // (0, 0, 0) on every capture. Unaligned, the background is free to grow
        // into the safe area, which is the whole point of asking it to.
        //
        // `edges: .top` specifically, not the blanket form: the sidebar must
        // still respect the BOTTOM safe area or it would draw under the status
        // bar.
        .background {
            themedFill(
                theme.surface(0),
                treatment: theme.materials.sidebar,
                in: Rectangle(),
                isDark: theme.isDark
            )
            .ignoresSafeArea(edges: .top)
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
    let isRail: Bool

    var body: some View {
        HStack(spacing: Space.sm) {
            if isRail { Spacer(minLength: 0) }
            // The mark carries the theme's brand gradient — one of exactly two
            // places in the app that earns it (the other is a primary CTA).
            // A flat accent square was indistinguishable from any other
            // rounded rect on screen; a gradient plate with a specular edge
            // reads as an identity, which is what a wordmark is for.
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(theme.accentGradient)
                    .frame(width: 28, height: 28)
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(.white.opacity(0.22), lineWidth: 1)
                    }
                Image(systemName: "hexagon.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.color(\.textInverse).opacity(0.92))
            }
            if !isRail {
                Text("NexusCode")
                    .textStyle(Type.heading)
                    .foregroundStyle(theme.color(\.textPrimary))
            }
            Spacer(minLength: 0)
            // The toggle lives beside the wordmark, which is where every Mac
            // app with a hand-rolled rail puts it, and it stays visible in BOTH
            // states — a collapse control that disappears once you collapse is
            // how a sidebar becomes a one-way door.
            if !isRail { SidebarToggleButton() }
        }
        // Only touched in the rail: the icon-only mark otherwise has no text of
        // its own for VoiceOver to read. Untouched when the "NexusCode" text is
        // present — that Text already reads correctly on its own.
        .modifier(CompactAccessibilityLabel(isCompact: isRail, label: "NexusCode"))
    }
}

/// Collapses the sidebar to its icon rail and back.
///
/// `⌥⌘S` is not a guess: it is the key equivalent macOS itself uses for "Hide
/// Sidebar" in Finder, Mail, Notes and Reminders, so it is the one chord a Mac
/// user already has in their fingers. The `Cmd-B` that VS Code and Zed use is
/// deliberately NOT bound — this app is a Mac app first, and `⌘B` is bold.
private struct SidebarToggleButton: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    @State private var hovering = false

    private var isRail: Bool { workspace.sidebar.preference == .rail }

    var body: some View {
        Button {
            workspace.sidebar.toggle()
        } label: {
            Image(systemName: "sidebar.leading")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.color(hovering ? \.textPrimary : \.textMuted))
                .frame(width: 24, height: 24)
                .background(
                    theme.color(\.surfaceOverlay).opacity(hovering ? 1 : 0),
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Motion.state, value: hovering)
        .help(isRail ? "Expand sidebar (⌥⌘S)" : "Collapse sidebar (⌥⌘S)")
        .accessibilityLabel(isRail ? "Expand sidebar" : "Collapse sidebar")
    }
}

private extension View {
    /// `.clipped()`, but only when it is actually wanted.
    ///
    /// SwiftUI has no conditional clip, and the usual `if` inside a `ViewBuilder`
    /// would change the view's identity between branches — which on this
    /// particular view would restart the width animation the clip exists to
    /// support.
    @ViewBuilder
    func clipped(_ isClipped: Bool) -> some View {
        if isClipped { clipped() } else { self }
    }
}

/// Brings a hidden sidebar back.
///
/// Floats over the content's top-left corner — the position the sidebar itself
/// occupies, so the control sits where the thing it restores will appear. Only
/// rendered in the `hidden` state; the rail and expanded states carry their own
/// toggle inside the sidebar.
private struct SidebarRestoreButton: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    @State private var hovering = false

    var body: some View {
        Button {
            workspace.sidebar.toggleHidden()
        } label: {
            Image(systemName: "sidebar.leading")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.color(hovering ? \.textPrimary : \.textMuted))
                .frame(width: 26, height: 26)
                .background(
                    theme.color(\.surfaceOverlay).opacity(hovering ? 1 : 0.55),
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Motion.state, value: hovering)
        .help("Show sidebar (⌃⌘S)")
        .accessibilityLabel("Show Sidebar")
    }
}

/// Starts a fresh conversation, and switches to Chat if you were somewhere else.
///
/// The one primary action in the whole shell, and the reason it sits at the top
/// of the sidebar rather than inside the Chat screen: it is the thing a user
/// does most, it must be reachable from all eight destinations, and every chat
/// client this competes with (Claude, ChatGPT, Cursor, Raycast) puts it in
/// exactly this position. It is also the only place besides the wordmark that
/// spends the theme's brand gradient.
private struct NewConversationButton: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    let isRail: Bool
    @State private var hovering = false

    var body: some View {
        Button {
            workspace.tab = .chat
            workspace.conversation?.clear()
        } label: {
            HStack(spacing: Space.sm) {
                if isRail { Spacer(minLength: 0) }
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 12, weight: .semibold))
                    .accessibilityHidden(true)
                if !isRail {
                    Text("New Conversation")
                        .textStyle(Type.label)
                    Spacer(minLength: 0)
                    Text("⌘N")
                        .textStyle(Type.monoMicro)
                        .opacity(0.65)
                }
                if isRail { Spacer(minLength: 0) }
            }
            .foregroundStyle(theme.color(\.accentFg))
            .padding(.horizontal, isRail ? Space.xs : Space.md)
            .padding(.vertical, 7)
            .background(theme.accentGradient, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(.white.opacity(theme.isDark ? 0.22 : 0.10), lineWidth: 1)
            }
            .opacity(hovering ? 1 : 1 - theme.stateLayers.hover * 0.5)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Motion.state, value: hovering)
        .help(isRail ? "New Conversation (⌘N)" : "")
        .accessibilityLabel("New Conversation")
    }
}

/// The rail's stand-in for a group heading: a short centred hairline. A
/// truncated 10.5pt tracked label in a 60pt column would read as damage, but
/// dropping the grouping entirely turns eight icons into one undifferentiated
/// strip — this keeps the rhythm without pretending to carry the words.
private struct RailGroupSeparator: View {
    @Environment(\.nexusTheme) private var theme

    var body: some View {
        Rectangle()
            .fill(theme.hairline)
            .frame(width: 20, height: 1)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.md)
            .accessibilityHidden(true)
    }
}

/// Applies a single accessibility label ONLY when `isCompact`, leaving the
/// view's default (per-child) accessibility behaviour completely alone
/// otherwise. Shared by `BrandHeader` and `ProjectSwitcherRow` — both drop a
/// child `Text` in compact mode and need its name to survive somewhere.
private struct CompactAccessibilityLabel: ViewModifier {
    let isCompact: Bool
    let label: String

    func body(content: Content) -> some View {
        if isCompact {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
        } else {
            content
        }
    }
}

/// The current project, shown as a clickable row that opens a directory
/// picker — this is the entire mechanism for repointing the app at a
/// different checkout, so it has to read as a real control, not a label.
private struct ProjectSwitcherRow: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    let isRail: Bool
    @State private var hovering = false

    var body: some View {
        Button {
            presentDirectoryPicker(current: workspace.projectDirectory) {
                workspace.projectDirectory = $0
            }
        } label: {
            HStack(spacing: Space.sm) {
                if isRail { Spacer(minLength: 0) }
                Image(systemName: "folder.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.color(\.textMuted))
                    .accessibilityHidden(true)
                if !isRail {
                    Text(workspace.projectDirectory.lastPathComponent)
                        .textStyle(Type.bodyStrong)
                        .foregroundStyle(theme.color(\.textPrimary))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                if !isRail {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.color(\.textMuted))
                        .accessibilityHidden(true)
                }
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
    /// Icon-only, centred, no label — the name survives as a hover tooltip
    /// (`.help`) and the explicit `accessibilityLabel` below, same as every
    /// other rail-state row in this sidebar.
    let isRail: Bool
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
                if isRail { Spacer(minLength: 0) }
                Image(systemName: tab.systemImage)
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 16)
                    // The label below already names this control; a decorative
                    // glyph with its own default AX name (the SF Symbol's) is
                    // exactly what turned this row into a bare, unnamed
                    // `AXButton` in VoiceOver — hiding it lets the row's own
                    // `accessibilityLabel` win instead of competing with it.
                    .accessibilityHidden(true)
                if !isRail {
                    Text(tab.title)
                        .textStyle(Type.label)
                        // A half-step of weight, so selection survives being
                        // read at a glance without the row needing more colour.
                        .fontWeight(isSelected ? .semibold : .medium)
                }
                Spacer(minLength: 0)
                if badge > 0 {
                    // A plain dot when compact — a full `CountPill` needs
                    // more width than a 64pt icon column has to spare, and a
                    // pill number with no adjacent label reads as noise.
                    if isRail {
                        Circle()
                            .fill(theme.color(\.accentDefault))
                            .frame(width: 6, height: 6)
                            .accessibilityHidden(true)
                    } else {
                        CountPill(text: "\(badge)", tone: isSelected ? .neutral : .accent)
                            .accessibilityHidden(true)
                    }
                }
            }
            .foregroundStyle(isSelected ? theme.color(\.textPrimary) : theme.color(\.textSecondary))
            // Tighter horizontally when compact: a 64pt rail minus the list's
            // own insets leaves ~56pt, and 12pt of padding each side left the
            // selection pill crowding both edges with the accent rail hard
            // against the window's. 6pt gives the lifted surface room to read
            // as a distinct object at either width.
            .padding(.horizontal, isRail ? Space.xs : Space.sm)
            .padding(.vertical, 7)
            // Selection is a RAISED SURFACE, not a wash of accent colour.
            //
            // The old row filled with `accentMuted` — a large periwinkle block
            // that was, measurably, the single loudest object on every screen
            // in the app, for a control that only needs to be legible. It also
            // spent the accent on something permanently on screen, which is
            // exactly what the accent is not for. Here the selected row simply
            // sits one rung UP the same ladder the whole app uses (level 2,
            // with the specular edge), and the accent appears only as a 3pt
            // rail on the leading edge. The row reads as physically lifted
            // toward the viewer instead of painted, the accent stays a signal,
            // and the eye is free to go to the content.
            .background {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(
                        isSelected
                            ? theme.surface(2)
                            : (hovering ? theme.color(\.surfaceOverlay).opacity(0.6) : .clear)
                    )
            }
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .strokeBorder(Depth.specular(theme, level: 2, strength: 0.85), lineWidth: 1)
                }
            }
            .overlay(alignment: .leading) {
                // Drawn in BOTH states. It used to be suppressed in the rail on
                // the reasoning that the lifted surface said "selected" on its
                // own — but the rail is precisely where that is least true: the
                // label is gone, so a one-rung surface step under a 16pt glyph
                // is the entire signal. The rail is the only thing left that
                // says which of eight identical-looking icons you are on.
                if isSelected {
                    Capsule()
                        .fill(theme.color(\.accentDefault))
                        .frame(width: 3, height: isRail ? 14 : 15)
                        .padding(.leading, isRail ? 1 : 3)
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help(isRail ? tab.title : "")
        // Set explicitly rather than relying on the label + icon + badge
        // combining on their own: this is the exact control the accessibility
        // tree audit found reading as an unnamed button (see the file's
        // header task notes), so the name is asserted here instead of hoped for.
        .accessibilityLabel(badge > 0 ? "\(tab.title), \(badge) running" : tab.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// The boundary between sidebar and content: a hairline that is also the drag
/// handle when the sidebar is expanded.
///
/// The visible rule stays 1px — a thick grabbable bar would be a permanent
/// piece of furniture in exchange for an interaction used once a month — while
/// the hit area is 7pt wide and overhangs the content side, which is the
/// standard trick for making a hairline grabbable without moving it.
private struct SidebarEdge: View {
    @Environment(\.nexusTheme) private var theme
    let isResizable: Bool
    /// The sidebar's width right now. Captured at drag start so the gesture's
    /// cumulative `translation` is applied to a FIXED origin — applying it to
    /// the live width instead compounds every frame and makes the sidebar fly
    /// off the edge of the window on a slow drag.
    let currentWidth: CGFloat
    let onResize: (CGFloat) -> Void
    let onReset: () -> Void

    @State private var dragOrigin: CGFloat?
    @State private var hovering = false

    var body: some View {
        Rectangle()
            .fill(theme.hairline)
            .frame(width: 1)
            .overlay {
                if isResizable {
                    // Wider than the rule it sits on, and drawn clear, so the
                    // grab area is generous while the seam stays a hairline.
                    Color.clear
                        .frame(width: 7)
                        .contentShape(Rectangle())
                        .onHover { inside in
                            hovering = inside
                            // `push`/`pop` rather than `set`: `set` is undone by
                            // the next mouse-moved event the window sends, so
                            // the cursor flickers back to an arrow mid-drag.
                            if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 1)
                                .onChanged { value in
                                    let origin = dragOrigin ?? currentWidth
                                    if dragOrigin == nil { dragOrigin = origin }
                                    onResize(origin + value.translation.width)
                                }
                                .onEnded { _ in dragOrigin = nil }
                        )
                        .onTapGesture(count: 2) { onReset() }
                }
            }
            // The seam brightens under the cursor, which is the only signal
            // that a 1px rule is draggable at all.
            .overlay {
                if isResizable && hovering {
                    Rectangle().fill(theme.color(\.accentDefault).opacity(0.55)).frame(width: 1)
                }
            }
            .animation(Motion.state, value: hovering)
            .accessibilityHidden(true)
    }
}

/// The conversations you might go back to, live from `nexus session list`.
///
/// **This is what fills the sidebar's dead bottom** — see `Sidebar`'s own note
/// for the measurement. It is not decoration to occupy space: recents are the
/// single most-used navigation in every chat client this competes with, and
/// they were previously reachable only by going to a whole separate Sessions
/// screen and scrolling a 1,189-row list.
///
/// Capped at six. A sidebar recents list is a shortcut to *the thing you were
/// just doing*, not a browser — the seventh-most-recent session is what the
/// Sessions tab is for, and an uncapped list would put the nav above it into a
/// scroll view that never comes to rest.
private struct RecentsSection: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    @State private var controller: SessionsController?
    @State private var isOpening = false

    private static let limit = 6

    private var recents: [NexusSession] {
        Array((controller?.sessions ?? []).prefix(Self.limit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            SectionHeader(
                "Recent",
                accessory: recents.isEmpty ? nil : AnyView(
                    Button("All") { workspace.tab = .sessions }
                        .buttonStyle(.plain)
                        .textStyle(Type.micro)
                        .foregroundStyle(theme.color(\.textMuted))
                        .help("Open the Sessions screen")
                )
            )
            .padding(.horizontal, Space.sm)
            .padding(.bottom, Space.xs)

            if recents.isEmpty {
                // A quiet line, never a `HeroEmptyState` — this is a 200pt
                // column, and the shared hero composition is sized for a whole
                // screen. Says what will appear rather than that nothing has.
                Text(controller?.isLoading == true ? "Loading…" : "Conversations you start will appear here.")
                    .textStyle(Type.caption)
                    .foregroundStyle(theme.color(\.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs)
            } else {
                ForEach(recents) { session in
                    RecentRow(session: session, action: { open(session) })
                }
            }
        }
        .disabled(isOpening)
        // Same key as every other project-scoped controller in the app
        // (`ChatTab`, `ConversationView`): the session store is per-directory,
        // so pointing the window at another checkout must reload this list
        // rather than leave another project's conversations on screen.
        .task(id: workspace.projectDirectory) {
            guard let binary = workspace.binary else {
                controller = nil
                return
            }
            let loaded = SessionsController(
                client: NexusClient(binary: binary),
                workingDirectory: workspace.projectDirectory
            )
            controller = loaded
            await loaded.refresh()
        }
    }

    /// Reopens the session AND re-renders its recorded transcript — the same
    /// two steps `SessionsView.replay` takes, deliberately, rather than the
    /// bare `resume` that leaves the transcript empty. Clicking a named
    /// conversation and landing on a blank screen would read as data loss.
    private func open(_ session: NexusSession) {
        guard let conversation = workspace.conversation, let controller else { return }
        isOpening = true
        workspace.tab = .chat
        conversation.reopen(sessionId: session.sessionId, provider: session.provider, model: session.model)
        Task {
            let events = await controller.replayEvents(for: session.sessionId)
            conversation.ingest(events)
            isOpening = false
        }
    }
}

/// One recent conversation: what it was called, who answered, how long ago.
private struct RecentRow: View {
    @Environment(\.nexusTheme) private var theme
    let session: NexusSession
    let action: () -> Void

    @State private var hovering = false

    /// Sessions are usually unnamed, and `s_b27e96a9-9f97-…` is not a title.
    /// The short id is what the Sessions screen already shows and what the CLI
    /// accepts back, so it is at least a handle the user can act on — but it is
    /// rendered as mono metadata, not as prose pretending to be a name.
    private var label: String {
        session.name ?? String(session.sessionId.prefix(9))
    }

    private var isNamed: Bool { session.name != nil }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                ProviderDot(provider: session.provider, size: 5)
                Text(label)
                    .textStyle(isNamed ? Type.body : Type.monoMicro)
                    .foregroundStyle(theme.color(hovering ? \.textPrimary : \.textSecondary))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: Space.xs)
                if let updated = session.updatedAt {
                    Text(RelativeTime.short(updated))
                        .textStyle(Type.micro)
                        .foregroundStyle(theme.color(\.textMuted))
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 5)
            .background(
                theme.color(\.surfaceOverlay).opacity(hovering ? 0.7 : 0),
                in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Motion.state, value: hovering)
        .help(session.model.map { "\(label) — \($0)" } ?? label)
        .accessibilityLabel("Conversation \(label)")
    }
}

/// Compact elapsed-time labels for a 200pt column.
///
/// `SessionsView` renders "1 hr, 39 min" via a full `DateComponentsFormatter`,
/// which is right for a table with a whole column to spend and wrong here — at
/// this width it would truncate before the number. This is the same fact at
/// glance length: `2m`, `3h`, `5d`.
enum RelativeTime {
    static func short(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "now"
        case ..<3_600: return "\(Int(seconds / 60))m"
        case ..<86_400: return "\(Int(seconds / 3_600))h"
        case ..<604_800: return "\(Int(seconds / 86_400))d"
        default: return "\(Int(seconds / 604_800))w"
        }
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
                .textStyle(Type.caption)
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
            // No wordmark here. The sidebar header already carries it, in this
            // same window, and so do the Dock icon and the menu bar — a third
            // instance 800pt away from the second was spending the bar's most
            // valuable position (leading edge, read first) on the one fact the
            // user is least likely to need.
            if let omcLabel {
                HStack(spacing: 6) {
                    StatusDot(isRunning: workspace.omc?.isWatching == true, isFailed: false, size: 6, animate: false)
                    Text(omcLabel)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.color(\.textMuted))
                }
            }

            if let session = workspace.conversation?.view.session {
                if omcLabel != nil { StatusDivider() }
                Metric(label: "model", value: session.model, emphasis: true)
            }

            // `secondary: true` below: DESIGN.md names the status bar as
            // `accentSecondary`'s other legitimate home, alongside the
            // primary accent's running-state dot, specifically for live
            // cost/token counters — these three readouts (turn cost, session
            // cost, context %) are exactly that, and nothing else in the tree
            // consumed the parameter before this.
            if let totals = workspace.conversation?.view.totals, let cost = statusBarCost(totals) {
                if totals.costIncomplete {
                    Metric(label: "cost", value: cost, secondary: true)
                        .help(costIncompleteHelp)
                } else {
                    Metric(label: "cost", value: cost, secondary: true)
                }
            }

            if let hud = workspace.omc?.snapshot.hud {
                StatusDivider()
                if let percent = hud.contextUsedPercentage {
                    StatusMetric(label: "ctx", value: "\(percent)%", tone: percent > 80 ? .warning : .accent)
                }
                if let cost = hud.totalCostUsd {
                    Metric(label: "session", value: String(format: "$%.2f", cost), secondary: true)
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

/// Like the shared `Metric`, but with a fourth, more urgent tone — context
/// pressure needs to visibly escalate past 80%, past what `Metric`'s
/// muted/primary-accent/secondary-accent tones alone express.
private struct StatusMetric: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String
    var tone: Tone = .neutral

    enum Tone { case neutral, accent, warning }

    private var valueColor: Color {
        switch tone {
        case .neutral: return theme.color(\.textSecondary)
        // Same `accentSecondary` home as `Metric(secondary:)` — context % is
        // live token data, the other case DESIGN.md names for this tone.
        case .accent: return theme.accentSecondary
        case .warning: return theme.color(\.warningFg)
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Text(label.uppercased())
                .textStyle(Type.micro)
                .tracking(0.5)
                .foregroundStyle(theme.color(\.textMuted).opacity(0.8))
            Text(value)
                .textStyle(Type.monoMicro)
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
    @Environment(\.colorScheme) private var systemScheme

    private let columns = [GridItem(.adaptive(minimum: 168, maximum: 220), spacing: Space.md)]

    /// Picking a theme is an explicit statement of intent and must always
    /// win — see `AppTheme.displayed(for:matchSystemAppearance:)`'s doc for
    /// the bug this fixes. If the pick disagrees with the OS's current
    /// scheme, appearance-following is turned off FOR the user rather than
    /// leaving it on to silently swap the pick back to its pair the instant
    /// this returns; if it agrees, following (if already on) keeps working
    /// exactly as before untouched.
    private var darkThemes: [AppTheme] { AppTheme.all.filter(\.isDark) }
    private var lightThemes: [AppTheme] { AppTheme.all.filter { !$0.isDark } }

    private func themeGrid(_ themes: [AppTheme]) -> some View {
        LazyVGrid(columns: columns, spacing: Space.md) {
            ForEach(themes) { candidate in
                ThemeSwatchButton(
                    theme: candidate,
                    isSelected: candidate.id == workspace.themeId,
                    action: { selectTheme(candidate) }
                )
            }
        }
    }

    private func selectTheme(_ candidate: AppTheme) {
        workspace.themeId = candidate.id
        let systemWantsDark = systemScheme == .dark
        if candidate.isDark != systemWantsDark {
            workspace.matchSystemAppearance = false
        }
    }

    var body: some View {
        // Header pinned, body fills-or-scrolls — see `PageScaffold`'s doc
        // comment. This screen was a bare `ScrollView` with the "Theme"
        // heading trapped *inside* it alongside both grids and the project
        // card, which only avoided the dead-space symptom because 23
        // swatches happened to fill the window. Pinning the heading here and
        // letting the (genuinely tall) rest of the content own its own
        // `ScrollView` brings it into line with every other screen.
        PageScaffold {
            // `PageHeader`, not a hand-rolled title+subtitle stack — this was
            // the pattern every other screen's page title now shares
            // (`DESIGN.md`'s "one Type.title moment per screen").
            PageHeader("Settings")
        } content: {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    matchSystemAppearanceRow

                    // Split by appearance rather than shown as one grid of
                    // twelve. A theme picker is answered in two steps — "I want
                    // a dark one" and then "which dark one" — and a single
                    // twelve-up grid forces the eye to do the first step by
                    // scanning swatch brightness. Two labelled groups answer it
                    // before the user starts looking.
                    SectionHeader("Dark", subtitle: "\(darkThemes.count) themes")
                    themeGrid(darkThemes)

                    SectionHeader("Light", subtitle: "\(lightThemes.count) themes")
                        .padding(.top, Space.md)
                    themeGrid(lightThemes)

                    SectionHeader(
                        "Terminal palettes",
                        subtitle: "The \(NexusTheme.all.count) palettes the CLI ships — same colours, rendered flat (no material, no elevation). Kept selectable for parity with the terminal, not because they suit a window."
                    )
                    .padding(.top, Space.md)

                    LazyVGrid(columns: columns, spacing: Space.md) {
                        // Routed through the same bridge the environment itself
                        // uses (`NexusTheme.appTheme`) — one swatch type, one
                        // picker, regardless of which catalogue a theme is from.
                        ForEach(NexusTheme.all) { candidate in
                            ThemeSwatchButton(
                                theme: candidate.appTheme,
                                isSelected: candidate.id == workspace.themeId,
                                action: { selectTheme(candidate.appTheme) }
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
                .padding(.top, Space.xl)
                .padding(.bottom, Space.xl)
                // Wider than the other settings pages: this one is a swatch
                // grid, and the grid genuinely uses the width it is given —
                // capping it to 900 would drop it from six columns to four
                // and add scrolling for no benefit.
                .pageMeasure(1180)
            }
        }
    }

    /// The escape hatch for `AppTheme.displayed(for:matchSystemAppearance:)`
    /// — visible, adjustable, on by default. Turning it back on after an
    /// explicit pick auto-disabled it (see `selectTheme`) resumes normal
    /// pairing; turning it off deliberately pins whatever is picked next
    /// regardless of the OS scheme.
    private var matchSystemAppearanceRow: some View {
        Toggle(isOn: Binding(
            get: { workspace.matchSystemAppearance },
            set: { workspace.matchSystemAppearance = $0 }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Match system appearance")
                    .textStyle(Type.bodyStrong)
                    .foregroundStyle(theme.color(\.textPrimary))
                Text("A paired theme (e.g. Storm ↔ Porcelain) follows Light/Dark Mode. Off pins exactly the theme picked below.")
                    .textStyle(Type.caption)
                    .foregroundStyle(theme.color(\.textMuted))
            }
        }
        .toggleStyle(.switch)
    }
}

struct LabeledLine: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Text(label)
                .textStyle(Type.caption)
                .foregroundStyle(theme.color(\.textMuted))
                .frame(width: 70, alignment: .leading)
            Text(value)
                .textStyle(Type.mono)
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

            // The surface ladder, as four butted blocks.
            //
            // The chips above say what the theme's ACCENTS are, which is what
            // the old swatch showed and only ever answered "is it blue or
            // orange". The ladder is the thing that actually decides whether a
            // theme reads as flat — it is the property this catalogue was
            // rebuilt around — and four adjacent fills is the only honest way to
            // show whether its steps are visible before you pick it.
            HStack(spacing: 0) {
                ForEach(0...3, id: \.self) { level in
                    Rectangle().fill(theme.surface(level))
                }
            }
            .frame(height: 12)
            .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(theme.name)
                    .textStyle(Type.bodyStrong)
                    .foregroundStyle(theme.color(\.textPrimary))
                    .lineLimit(1)
                Text(theme.isDark ? "Dark" : "Light")
                    .textStyle(Type.micro)
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
    /// Whether the CURRENTLY loaded model list is entirely `.fallback` —
    /// computed here, once, from the raw `NexusModel.isVerified` before
    /// `PickerOption` (which deliberately drops it, see that init's doc)
    /// erases it. `ControlStrip` renders this as one set-level caption
    /// rather than a per-row warning — see its own doc for why.
    @State private var modelsAreUnverified = false

    var body: some View {
        ConversationView(
            controller: controller,
            providers: providerOptions,
            models: models,
            isLoadingModels: loadingModels,
            modelsAreUnverified: modelsAreUnverified,
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
            // backend quietly uses its own default. `isReadyForAutoSelect`,
            // not bare `isUsable` — a confirmed-unreachable local server
            // (lmstudio/vllm with nothing running) is structurally "usable"
            // but landing here on one anyway is the same experience as the
            // mock-fixture leak this picker cleanup started with, just with
            // a real provider's name on it (see that property's doc).
            if controller.provider == nil,
               let first = loaded.selectable.first(where: \.isReadyForAutoSelect) {
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
                // A tripped circuit (quota/rate-limit/repeated failures) OR a
                // confirmed-unreachable local server (lmstudio/vllm with
                // nothing running) rides `PickerOption.warning` — the SAME
                // "visible but not blocking" mechanism `ControlStrip
                // .rolePicker` already uses for a write-capable agent role,
                // not `disabledReason`/`available`: the provider stays fully
                // selectable either way (see `SelectableProvider
                // .circuitWarning`/`.localServerWarning`'s docs for why).
                // Circuit wins if somehow both are set — it is the more
                // urgent, live-operational one of the two.
                warning: entry.circuitWarning ?? entry.localServerWarning
                // No `reasoning:` here — `NexusProvider.reasoning` and the
                // `ReasoningCapability` it decoded are gone entirely (see
                // `Providers.swift`'s module note). The control strip's
                // effort picker (`ConversationView.swift`'s `ControlStrip
                // .effortPicker`) is instead backed by its OWN dedicated
                // controller (`EffortController`, `Effort.swift`), live-
                // probed per selected provider from `nexus effort <provider>
                // -o json` rather than joined off this list — that command
                // is the only place the CLI actually reports claude-code's/
                // codex's native scale, which `providers status`'s
                // `reasoning` field never could.
            )
        }
    }

    private func loadModels(_ providerId: String) {
        guard let providers else { return }
        loadingModels = true
        Task {
            let loaded = await providers.models(for: providerId)
            // `PickerOption(model:)`, not the bare id/hint pair this used to
            // build directly — that dropped `model.isVerified` on the floor,
            // which is exactly how an unconfirmed `.fallback` list (e.g.
            // gemini's) would have rendered identically to a live-verified
            // one (anthropic's) with no distinction at all.
            models = loaded.map { PickerOption(model: $0) }
            // Computed from the RAW list, before that mapping erases
            // `isVerified` — true only when every model came back unverified
            // together (see `ControlStrip.modelListVerificationCaption`'s
            // doc for why this is a set-level fact, not a per-row one).
            modelsAreUnverified = !loaded.isEmpty && loaded.allSatisfy { !$0.isVerified }
            loadingModels = false
            // Preselect the first model, same reasoning as the provider
            // preselect above: an empty "model" placeholder reads as broken
            // chrome, not as "nothing to configure here," and it's the exact
            // control the owner has twice reported as "not working." Guarded
            // on the provider still matching at completion — if the user
            // switched providers again while this load was in flight, that
            // NEWER call's own completion is what should win here, not this
            // now-stale one.
            if controller.provider == providerId, controller.model == nil, let first = loaded.first {
                controller.model = first.id
            }
        }
    }
}
