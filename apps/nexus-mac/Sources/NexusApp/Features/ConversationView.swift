import SwiftUI
import AppKit
import NexusKit

/// The INK measure — the width prose actually occupies, before any gutter.
///
/// One shared constant, not two repeated `660`s: the composer sits directly
/// beneath the transcript column and IS where the next message in it will
/// appear, so drifting the two independently is how you get a composer
/// floating ~165pt away from the text it's replying to — measured, not
/// hypothetical, at the default 1280pt window before this existed.
///
/// **What changed, and why it is the whole fix for the alignment bug.** Both
/// surfaces used to cap to 720 but applied the gutter on OPPOSITE sides of
/// that cap: the transcript padded INSIDE it (720 box, 680 of ink), the
/// composer padded OUTSIDE it (720 card, ink starting 20pt further in). Same
/// number, two different meanings — so the composer card overhung the column
/// it feeds by exactly one gutter on each side. Naming the ink measure rather
/// than the box is what makes the ordering un-get-wrong-able: you cap
/// `textColumnWidth` and THEN pad `columnGutter`, in that order, everywhere.
/// The card's leading edge then lands exactly on the prose's first ink.
private let textColumnWidth: CGFloat = 680

/// The gutter padded around `textColumnWidth`. Applied AFTER the cap, always.
private let columnGutter: CGFloat = Space.xl

/// The identity `ConversationView`'s effort `.task(id:)` re-fires on.
/// Every other `.task(id:)` in this app keys on a single `Equatable` value
/// (`workspace.projectDirectory` alone, in `RootView`/`GitView`/`SessionsView`/
/// `TasksView`/`IntegrationsView`) — this is the first that needs to react to
/// TWO independent values changing together (the project directory AND the
/// active provider — see `effortController`'s doc for why). A bare tuple
/// isn't itself `Equatable` in a way `.task(id:)`'s generic constraint
/// accepts, hence this one-purpose wrapper rather than a tuple literal.
private struct EffortTaskKey: Equatable {
    let directory: URL?
    let provider: String?
}

/// The conversation surface: transcript, controls, composer.
///
/// Every control here resolves to a flag on a `nexus` command — the mode picker
/// chooses the subcommand, the provider/model fields become `-p`/`-m`. The exact
/// invocation is shown in the composer, so the UI can never feel like a black
/// box relative to the terminal. Layout otherwise leans on `DesignSystem` tokens
/// throughout, so this reads as a designed product surface rather than a debug
/// dump of the event stream it renders.
struct ConversationView: View {
    @Environment(\.nexusTheme) private var theme
    @Environment(WorkspaceModel.self) private var workspace
    @Bindable var controller: ConversationController
    @State private var draft = ""
    @State private var showsReasoning = false
    @FocusState private var composerFocused: Bool

    // Clearing destroys an on-screen conversation with no undo, same class of
    // action as "Delete task" (`TasksView.swift`) and "Sign out" (`AuthView.
    // swift`) — both gated behind a `confirmationDialog` rather than firing on
    // tap, so this matches instead of being a fourth, ungated dialect. Lives
    // on the view rather than the footer because the footer's overflow menu is
    // rebuilt on every draft keystroke; a `@State` flag owned there would be
    // torn down mid-confirmation.
    @State private var confirmingClear = false

    // MARK: - Auto-scroll lock (§6.7)
    //
    // The transcript used to call `scrollTo(anchor, .bottom)` on EVERY event
    // with no check for where the user actually was, which made reading
    // scrollback during a long turn impossible — every delta yanked the view
    // back to the tail. These three values are the whole lock: follow the tail
    // only while the user is already at it, otherwise stop dead and count what
    // they have not seen.

    /// Distance in points from the bottom of the scrollable content, measured
    /// by `transcriptMetrics` from geometry read in `.background`/`.overlay`
    /// position only — those never influence the size of what they measure, so
    /// this cannot become a layout feedback loop.
    @State private var distanceFromBottom: CGFloat = 0
    /// `eventCount` as of the last time the tail was actually on screen — the
    /// baseline `unseenCount` counts up from.
    @State private var seenEventCount = 0
    /// Turn/receipt ids in render order, kept so ⌘↑/⌘↓ can step between turn
    /// boundaries without re-deriving the timeline on every keypress.
    @State private var anchorIds: [String] = []
    /// Which anchor ⌘↑/⌘↓ last moved to. `nil` = the caret is at the tail.
    @State private var focusedAnchor: String?

    /// Within this many points of the bottom, the transcript is considered
    /// "at the tail" and keeps following. 120pt is a little under three lines
    /// of `Type.prose` — close enough that a user who scrolled up by one
    /// wheel-notch still gets the tail-follow they expect, far enough that a
    /// deliberate scroll into history is never overridden.
    private static let tailLockThreshold: CGFloat = 120

    // MARK: - Role picker
    //
    // Unlike providers/models (which stay plain data fed in from `ChatTab` in
    // `RootView.swift`, so this view stays renderable with no process behind
    // it), the role picker owns its `RolesController` directly: a role
    // listing is a single self-contained call with no per-provider chaining
    // to coordinate, and `WorkspaceModel` is already available via the
    // environment at this point in the tree (`ChatTab` reads the same
    // environment object one level up) — reaching for it here needed no
    // change to `RootView.swift`/`NexusApp.swift` at all. `nexus roles` is
    // never hardcoded (see `NexusRole`'s doc): a stale Swift copy of the role
    // list is exactly the mistake this avoids.
    @State private var rolesController: RolesController?

    // MARK: - Effort picker
    //
    // Same self-contained shape as `rolesController` above, for the same
    // reason — but keyed on the ACTIVE provider too, not just the project
    // directory: `nexus effort <provider>` is a per-provider live probe (see
    // `EffortCapability`'s doc, `Effort.swift`), so a provider switch must
    // re-fetch, never keep showing the previous provider's scale. `authController`
    // sits beside it rather than folded in: it answers a different question
    // (is the SIGN-IN method for this provider one that can't do extended
    // thinking at all — the Claude-subscription-OAuth case, see
    // `effortUnavailableCaption`), and `nexus auth status` is a snapshot of
    // every provider at once, so it only needs to reload with the project,
    // not with every provider switch.
    @State private var effortController: EffortController?
    @State private var authController: AuthController?

    // MARK: - Provider/model picker seam
    //
    // `ProvidersController` (NexusKit) is being built concurrently by another
    // agent and may not exist yet. Rather than block on it, this view takes
    // plain option lists plus a load callback; once the controller lands the
    // caller wires `providers`, `models` and `onLoadModels` from it — nothing
    // in this file needs to change.
    var providers: [PickerOption] = []
    var models: [PickerOption] = []
    var isLoadingModels = false
    /// Whether EVERY model in `models` is an unconfirmed `.fallback` guess
    /// rather than a live-probed catalog — a fact about the whole list, set
    /// once by `ChatTab.loadModels` from the raw `NexusModel.isVerified`
    /// before it gets erased mapping down to `PickerOption`. Surfaced as one
    /// neutral caption inside `ProviderModelPicker`'s model section — see
    /// there for why this is one marker on the SET, never one per row.
    var modelsAreUnverified = false
    var onLoadModels: (String) -> Void = { _ in }

    init(
        controller: ConversationController,
        providers: [PickerOption] = [],
        models: [PickerOption] = [],
        isLoadingModels: Bool = false,
        modelsAreUnverified: Bool = false,
        onLoadModels: @escaping (String) -> Void = { _ in }
    ) {
        self.controller = controller
        self.providers = providers
        self.models = models
        self.isLoadingModels = isLoadingModels
        self.modelsAreUnverified = modelsAreUnverified
        self.onLoadModels = onLoadModels
    }

    var body: some View {
        // The composer's position depends on whether there is a conversation
        // yet, which is the fix for the largest visual defect in the old
        // build: an empty chat put the hero composition in the vertical centre
        // and pinned the composer to the window's bottom edge, leaving roughly
        // 40% of a 1440x900 window as unexplained black between the two — the
        // "enormous dead canvas with a small block of content floating in it"
        // the owner has reacted to four times.
        //
        // Empty, the composer is PART of the opening composition: title,
        // suggestions and input sit together as one centred group, so the
        // thing you are meant to do next is inside the thing you are looking
        // at. Once a turn exists the transcript owns the height and the
        // composer docks to the bottom, which is the correct behaviour there
        // and the only place the old layout was right.
        Group {
            if visibleLaneIds.isEmpty {
                openingComposition
            } else {
                transcript
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // A safe-area inset, not a VStack sibling: an inset shrinks
                    // the area the transcript lays out against, so the composer
                    // cannot be squeezed out by a greedy transcript — the
                    // failure that once hid it entirely.
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        composer
                    }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The 71pt control band that used to sit here is gone (§6.5). It
            // put eleven controls roughly 700pt above the field they
            // configure, with ~270pt of dead air across the middle of the row
            // and a full-window amber caption underneath. Every one of those
            // controls now sits in `ComposerFooter`, directly beneath the text
            // field they act on — configuration belongs next to the thing it
            // configures, not at the opposite end of the window.
            //
            // Deleting the band also deletes `ViewThatFits`/`singleRow`/
            // `twoRowStack`. That fallback never worked: `singleRow` contained
            // a `Spacer(minLength:)`, which is infinitely flexible, so it
            // reported that it fit at ANY width and `twoRowStack` could never
            // be chosen — the two-row path was unreachable code defended by a
            // long comment about a measurement it never actually performed.
            // A single flat row of uniformly-sized controls needs no such
            // decision in the first place.
            //
            // A sheet, deliberately: a blocked tool call is modal in fact — the
            // turn is genuinely halted waiting on this answer — so making it
            // modal in the UI matches reality rather than letting the user keep
            // typing into a conversation that cannot advance.
            .sheet(item: Binding(
                get: { controller.approvals.current },
                set: { _ in }
            )) { approval in
                ApprovalSheet(
                    approval: approval,
                    onAllow: { controller.respondToApproval(allow: true) },
                    onDeny: { controller.respondToApproval(allow: false) }
                )
            }
            // Mirrors `ChatTab`'s own `.task(id: workspace.projectDirectory)`
            // for `ProvidersController` — reload whenever the project (and so
            // the resolved `nexus` binary) changes.
            .task(id: workspace.projectDirectory) {
                await loadRoles()
                await loadAuth()
            }
            // A SEPARATE `.task(id:)`, keyed on provider too — see
            // `effortController`'s doc for why this can't share the task
            // above: it must re-fire on every provider switch, not just a
            // project change.
            .task(id: EffortTaskKey(directory: workspace.projectDirectory, provider: controller.provider)) {
                await loadEffort()
            }
    }

    private func loadRoles() async {
        guard let binary = workspace.binary else {
            rolesController = nil
            return
        }
        let loaded = RolesController(client: NexusClient(binary: binary), workingDirectory: workspace.projectDirectory)
        rolesController = loaded
        await loaded.refresh()
    }

    private func loadAuth() async {
        guard let binary = workspace.binary else {
            authController = nil
            return
        }
        let loaded = AuthController(client: NexusClient(binary: binary), binary: binary, workingDirectory: workspace.projectDirectory)
        authController = loaded
        await loaded.refresh()
    }

    /// A fresh `EffortController` per (directory, provider) pair — never one
    /// reused across a provider switch, so `capability` starts `nil` on
    /// every load rather than briefly showing the PREVIOUS provider's scale
    /// while the new probe is in flight (see `EffortController`'s doc).
    private func loadEffort() async {
        guard let binary = workspace.binary, let provider = controller.provider else {
            effortController = nil
            return
        }
        let loaded = EffortController(client: NexusClient(binary: binary), workingDirectory: workspace.projectDirectory)
        effortController = loaded
        await loaded.refresh(provider: provider)
    }

    private var laneOrder: [LaneState] { controller.view.orderedLanes }

    /// Lane ids to actually render. See `ViewState.visibleLaneIds`'s doc for
    /// why this is not simply `laneOrder`: a `switch` receipt can exist for a
    /// lane with no `LaneState` at all, and must still render somewhere
    /// rather than vanish behind the empty-state hero.
    private var visibleLaneIds: [String] { controller.view.visibleLaneIds }

    /// The whole opening screen as one vertically-centred group — hero,
    /// suggestions, and the composer itself. See `body` for why the composer
    /// belongs here rather than pinned to the window's bottom edge.
    private var openingComposition: some View {
        VStack(spacing: 0) {
            Spacer(minLength: Space.xl)
            emptyState
            composerCard
                .frame(maxWidth: textColumnWidth)
                .padding(.top, Space.section)
            composerFootnote
                .frame(maxWidth: textColumnWidth)
                .padding(.top, Space.lg)
            Spacer(minLength: Space.xl)
        }
        .padding(.horizontal, columnGutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var transcript: some View {
        if controller.mode.isMultiLane && laneOrder.count > 1 {
            compareTranscript
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    // `Space.turn` (34pt) between turns. A turn boundary is
                    // the largest structural break the transcript has and has
                    // to outrank every gap inside a turn by a clear margin;
                    // the old 24pt sat too close to the 12pt used within a
                    // turn for the eye to read the difference as hierarchy.
                    LazyVStack(alignment: .leading, spacing: Space.turn) {
                        ForEach(visibleLaneIds, id: \.self) { laneId in
                            ForEach(controller.view.timeline(forLane: laneId)) { entry in
                                switch entry {
                                case .turn(let turn, let isLive):
                                    TurnView(
                                        turn: turn,
                                        showsReasoning: showsReasoning,
                                        isStreaming: isLive,
                                        // Only the LIVE turn can carry this:
                                        // `lastUsage`/`currentTurnCost` are
                                        // conversation-level counters that
                                        // describe whatever ran most recently,
                                        // so hanging them on a settled turn
                                        // would relabel old history with new
                                        // numbers. See §6.11 in the report for
                                        // the per-turn version this is waiting
                                        // on.
                                        liveUsage: isLive ? controller.view : nil
                                    )
                                        .id(turn.id)
                                        .transition(.opacity.combined(with: .offset(y: Motion.enterOffset)))
                                case .providerSwitch(let receipt):
                                    SwitchReceiptView(receipt: receipt)
                                        .id(receipt.id)
                                }
                            }
                        }

                        // Diagnostics are HISTORY, so they live at the end of
                        // the transcript rather than inside the composer band
                        // (§6.6). Gated on `streaming` inside the band, they
                        // translated the text field down the instant a turn
                        // started and back up when it ended — while the user
                        // was typing into it.
                        if !controller.presentedDiagnostics.isEmpty {
                            DiagnosticsStrip(notes: controller.presentedDiagnostics)
                                .id(Self.diagnosticsAnchorId)
                        }
                    }
                    // Cap the INK, then pad the gutter — the same two
                    // statements in the same order as the composer below. See
                    // `textColumnWidth`.
                    .frame(maxWidth: textColumnWidth, alignment: .leading)
                    .padding(.horizontal, columnGutter)
                    .padding(.top, Space.section)
                    .padding(.bottom, Space.xxl)
                    .frame(maxWidth: .infinity)
                    .background { transcriptContentProbe }
                }
                .coordinateSpace(name: Self.transcriptSpace)
                .background { transcriptViewportProbe }
                .onPreferenceChange(TranscriptMetricsKey.self) { metrics in
                    distanceFromBottom = metrics.distanceFromBottom
                    // Reaching the tail is what marks everything seen — including
                    // when the user scrolls back down by hand, not just when the
                    // pill is clicked.
                    if metrics.distanceFromBottom <= Self.tailLockThreshold {
                        seenEventCount = controller.view.eventCount
                    }
                }
                .onChange(of: controller.view.eventCount) {
                    anchorIds = currentAnchorIds
                    // The lock. Anchor on the turn's own (deterministic) id
                    // rather than a fixed "live" id — that id stops existing
                    // the instant a turn finalizes, which would silently stop
                    // the auto-scroll on exactly the event (`done`) that most
                    // needs it.
                    guard isTailPinned, let anchor = scrollAnchor else { return }
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(anchor, anchor: .bottom)
                    }
                    seenEventCount = controller.view.eventCount
                }
                .onAppear {
                    anchorIds = currentAnchorIds
                    seenEventCount = controller.view.eventCount
                }
                // Zero-sized and invisible, but a real part of the hierarchy —
                // that is what puts ⌘↑/⌘↓ on the responder chain. A bare
                // `.keyboardShortcut` needs a `Button` to hang off.
                .background { turnNavigationShortcuts(proxy: proxy) }
                .overlay(alignment: .bottom) { newMessagesPill(proxy: proxy) }
            }
        }
    }

    /// The id given to the trailing diagnostics block so `scrollAnchor` can
    /// still find the true bottom of the transcript once it is present.
    private static let diagnosticsAnchorId = "transcript-diagnostics"

    private static let transcriptSpace = "transcript"

    /// Whether the transcript should keep following the tail. True while the
    /// user is at (or within `tailLockThreshold` of) the bottom.
    private var isTailPinned: Bool { distanceFromBottom <= Self.tailLockThreshold }

    /// Events that have arrived since the tail was last on screen.
    private var unseenCount: Int { max(0, controller.view.eventCount - seenEventCount) }

    private var scrollAnchor: String? {
        if !controller.presentedDiagnostics.isEmpty { return Self.diagnosticsAnchorId }
        guard let laneId = visibleLaneIds.last else { return nil }
        return controller.view.timeline(forLane: laneId).last?.id
    }

    /// Every scroll anchor in render order — turn ids and switch-receipt ids
    /// interleaved exactly as the transcript draws them, so ⌘↑/⌘↓ step through
    /// what the eye sees rather than through turns only.
    private var currentAnchorIds: [String] {
        visibleLaneIds.flatMap { controller.view.timeline(forLane: $0).map(\.id) }
    }

    /// Measures the scrollable content: its height, and how far its top has
    /// been pushed above the viewport. Lives in `.background`, so it takes its
    /// size FROM the content and can never contribute to it.
    private var transcriptContentProbe: some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: TranscriptMetricsKey.self,
                value: TranscriptMetrics(
                    contentHeight: geo.size.height,
                    offset: -geo.frame(in: .named(Self.transcriptSpace)).minY,
                    viewportHeight: 0
                )
            )
        }
    }

    /// Measures the viewport. Separate from the content probe because the two
    /// sizes come from different levels of the hierarchy; `TranscriptMetrics`
    /// merges them in its `reduce`.
    private var transcriptViewportProbe: some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: TranscriptMetricsKey.self,
                value: TranscriptMetrics(contentHeight: 0, offset: 0, viewportHeight: geo.size.height)
            )
        }
    }

    /// `↓ N new` — the counterpart to the lock. Once the transcript stops
    /// following the tail, something has to say that the conversation is still
    /// moving; without it, a detached reader cannot tell a finished turn from
    /// one still streaming off-screen.
    @ViewBuilder
    private func newMessagesPill(proxy: ScrollViewProxy) -> some View {
        if !isTailPinned && unseenCount > 0 {
            Button {
                guard let anchor = scrollAnchor else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(anchor, anchor: .bottom)
                }
                seenEventCount = controller.view.eventCount
            } label: {
                HStack(spacing: Space.xs) {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 9, weight: .bold))
                    Text("\(unseenCount) new")
                }
            }
            .buttonStyle(SoftButton(tone: .accent, size: .compact))
            .padding(.bottom, Space.md)
            .transition(.opacity.combined(with: .offset(y: Motion.enterOffset)))
            .animation(Motion.state, value: unseenCount)
        }
    }

    /// ⌘↑ / ⌘↓ — step to the previous/next turn boundary. Stable per-turn ids
    /// already exist, so this needs no new identity scheme.
    private func turnNavigationShortcuts(proxy: ScrollViewProxy) -> some View {
        VStack(spacing: 0) {
            Button("Previous turn") { stepAnchor(-1, proxy: proxy) }
                .keyboardShortcut(.upArrow, modifiers: .command)
            Button("Next turn") { stepAnchor(1, proxy: proxy) }
                .keyboardShortcut(.downArrow, modifiers: .command)
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .accessibilityHidden(true)
    }

    private func stepAnchor(_ delta: Int, proxy: ScrollViewProxy) {
        guard !anchorIds.isEmpty else { return }
        // With no anchor focused the caret is conceptually at the tail, so ⌘↑
        // starts from the end and ⌘↓ has nowhere further to go.
        let current = focusedAnchor.flatMap { anchorIds.firstIndex(of: $0) } ?? anchorIds.count
        let next = min(max(current + delta, 0), anchorIds.count - 1)
        let id = anchorIds[next]
        focusedAnchor = id
        withAnimation(.easeOut(duration: 0.18)) {
            proxy.scrollTo(id, anchor: .top)
        }
    }

    // MARK: - Compare / Race (§6.13)

    /// Fan-out: one column per lane, so answers are compared, not scrolled.
    ///
    /// The prompt is hoisted OUT of the lanes and shown once above them. Every
    /// lane in a fan-out run answers the identical prompt by construction, so
    /// repeating it per column spent the scarcest thing on this screen — column
    /// width — on saying the same sentence three times.
    private var comparePrompt: String? {
        laneOrder.lazy.compactMap { $0.live?.prompt ?? $0.finalized.last?.prompt }.first
    }

    private var compareTranscript: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            if let comparePrompt {
                HStack(alignment: .top, spacing: Space.sm) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.color(\.textMuted))
                        .accessibilityHidden(true)
                    Text(comparePrompt)
                        .textStyle(Type.prose)
                        .foregroundStyle(theme.color(\.textPrimary))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, columnGutter)
                .padding(.top, Space.lg)
            }

            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: Space.md) {
                    ForEach(laneOrder) { lane in
                        LaneColumn(lane: lane, showsReasoning: showsReasoning)
                            // Was a flat `width: 400`, which at 13pt markdown
                            // gave every Compare answer ~45 characters a line —
                            // a starved column for the one screen whose entire
                            // purpose is reading several answers carefully. A
                            // range instead of a fixed width lets 2–3 lanes sit
                            // comfortably at 1440pt and still fit at 900pt.
                            .frame(minWidth: 340, idealWidth: 460, maxWidth: 560)
                    }
                }
                .padding(.horizontal, columnGutter)
                .padding(.bottom, Space.lg)
            }
        }
    }

    /// The four opening suggestions.
    ///
    /// Only the Compare one is conditional, and it is conditional on a fact
    /// this view already holds: `providers` is passed in from `ChatTab`'s live
    /// `ProvidersController`. Offering "compare anthropic and openai" to
    /// someone with one backend configured proposes a run that cannot happen,
    /// and naming two real configured providers is strictly better than naming
    /// none.
    ///
    /// The other three are static, deliberately. §6.14 also asks for "Review
    /// the 7 staged files", "Explain ⟨largest recently-changed file⟩" and
    /// "Resume: ⟨last session⟩" — each needs data this view is not given (a
    /// git status, a file-tree walk, a session list). Guessing at those
    /// strings without the data behind them would put a number on screen that
    /// is not true, which is worse than a general prompt. See the report.
    private var suggestions: [(icon: String, text: String)] {
        var items: [(icon: String, text: String)] = [
            ("text.book.closed", "Explain this codebase"),
            ("arrow.triangle.branch", "Review my staged diff"),
        ]
        let configured = providers.filter(\.available).map(\.id)
        if configured.count >= 2 {
            // No trailing "on one prompt" here: two real provider ids are
            // already long, and the pair together overran the card onto a
            // second line, leaving one suggestion taller than the three beside
            // it. The mode name carries the rest of the meaning.
            items.append(("arrow.left.arrow.right", "Compare \(configured[0]) and \(configured[1])"))
        } else {
            items.append(("arrow.left.arrow.right", "Compare two models on one prompt"))
        }
        items.append(("ladybug", "Find the bug in the last commit"))
        return items
    }

    private var heroTitle: String {
        switch controller.mode {
        case .ask: return "Ask anything"
        case .agent: return "Give it a task"
        case .compare, .race: return "Compare backends"
        }
    }

    private var heroMessage: String {
        controller.mode.isMultiLane
            ? "Compare and Race fan the same prompt across backends and show every answer side by side."
            : "This runs `nexus \(controller.mode.rawValue)` and renders its event stream."
    }

    /// The opening statement: kicker, headline, one line of explanation, and
    /// four suggestions — left-aligned on the same margin the composer below
    /// it uses, so the whole screen reads as one block.
    ///
    /// The kicker is the identity moment. It carries the live provider's own
    /// colour and the exact `nexus <mode> -p <provider>` this window will run
    /// — the one thing on the opening screen that could not appear in any
    /// other app, which is what an opening screen is for. It replaces a
    /// glyph-in-a-radial-glow that was the most template-looking element in
    /// the build.
    ///
    /// Suggestions are two columns, not a full-width list: at this measure a
    /// single column left a long empty tail after every 3–5 word label, so
    /// the row was never the right unit.
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A kicker, set in mono and carrying the live provider's identity
            // colour: the exact `nexus <mode>` this window will run. It is the
            // one thing on the opening screen that could not appear in any
            // other app, which is what an opening screen is for.
            HStack(spacing: Space.sm) {
                ProviderDot(provider: controller.provider, size: 6)
                Text(commandKicker)
                    .textStyle(Type.monoMicro)
                    .foregroundStyle(theme.color(\.textSecondary))
            }
            .padding(.bottom, Space.lg)

            Text(heroTitle)
                .textStyle(Type.display)
                .foregroundStyle(theme.color(\.textPrimary))
                .padding(.bottom, Space.md)

            Text(heroMessage)
                .textStyle(Type.body)
                .foregroundStyle(theme.color(\.textMuted))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Space.section)

            // A plain 2-row stack, not `LazyVGrid` — the grid once put every
            // icon in the wrong cell, detached from its own card (confirmed on
            // screen at both widths). Four fixed items never needed a lazy,
            // dynamically-sized grid; two ordinary rows lay out exactly as
            // written.
            VStack(spacing: Space.md) {
                HStack(spacing: Space.md) {
                    suggestionCard(0)
                    suggestionCard(1)
                }
                HStack(spacing: Space.md) {
                    suggestionCard(2)
                    suggestionCard(3)
                }
            }
        }
        // Left-aligned, not centred. Centred text under a centred headline
        // above centred cards gave the composition no edge to sit against, so
        // it read as floating regardless of how much padding surrounded it.
        // A single shared left margin, aligned with the composer directly
        // beneath, is what makes the group read as one deliberate block.
        .frame(maxWidth: textColumnWidth, alignment: .leading)
    }

    /// `nexus ask -p anthropic` — the invocation, trimmed to the part that
    /// identifies the run rather than the full argument vector the composer
    /// footnote already prints verbatim.
    private var commandKicker: String {
        var parts = ["nexus", controller.mode.rawValue]
        if let provider = controller.provider { parts.append("-p \(provider)") }
        return parts.joined(separator: " ")
    }

    @ViewBuilder
    private func suggestionCard(_ index: Int) -> some View {
        let items = suggestions
        if index < items.count {
            SuggestionCard(icon: items[index].icon, text: items[index].text) {
                fillComposer(with: items[index].text)
            }
        }
    }

    /// Suggestions fill the composer rather than submitting immediately — the
    /// user should see (and can edit) exactly what they're about to run, same as
    /// every other path to a `nexus` invocation in this app.
    private func fillComposer(with text: String) {
        draft = text
        composerFocused = true
    }

    /// The docked composer, used once a conversation exists. The opening
    /// screen composes `composerCard` and `composerFootnote` itself so they
    /// can sit inside the hero group instead of against the window edge.
    private var composer: some View {
        // A solid band on the canvas's own surface, separated by one hairline.
        //
        // Two gradient scrims were tried here first and both were discarded on
        // screen. A gradient across the whole composer left the input card
        // itself semi-transparent, so a code block scrolling under it showed
        // through. A short scrim above an opaque band failed for a subtler
        // reason worth recording: a scrim can only dissolve content it shares
        // a colour with, and a fenced code block carries its own darker
        // `surfaceInset` fill — so instead of fading, the scrim painted a
        // visible lighter rectangle across the code. The illusion cannot hold
        // for arbitrary content.
        //
        // What is left is honest and always correct: the composer shares the
        // canvas surface (so it adds no new luminance band — the specific
        // defect measured in the old build, where composer, strip and canvas
        // sat in random value order) and one hairline says where the scroll
        // ends. Content clipping at a fixed toolbar edge is ordinary, legible
        // behaviour; a half-working dissolve is not.
        VStack(spacing: 0) {
            Rectangle()
                .fill(theme.hairline)
                .frame(height: 1)

            // NOTHING conditional lives in this stack any more, and that is
            // the entire point of §6.6. `DiagnosticsStrip` and `UsageReadout`
            // both used to sit here gated on `streaming`, so the text field
            // translated down the instant a turn began and jumped back when it
            // ended — while the user was typing into it. Both facts moved to
            // where they belong (diagnostics to the end of the transcript,
            // usage onto the live turn's own attribution row), which leaves
            // this band's height a pure function of the draft's line count.
            VStack(alignment: .leading, spacing: Space.md) {
                composerCard
                composerFootnote
            }
            // Cap the INK, then pad the gutter — same two statements in the
            // same order as the transcript above. This is what puts the card's
            // leading edge exactly on the prose's first ink instead of one
            // gutter outside it. Only the CONTENT is capped; the band behind
            // it stays full-bleed, which is ordinary chrome.
            .frame(maxWidth: textColumnWidth, alignment: .leading)
            .padding(.horizontal, columnGutter)
            .frame(maxWidth: .infinity)
            .padding(.top, Space.lg)
            .padding(.bottom, Space.lg)
            .background(theme.surface(1))
        }
    }

    /// The exact command this will run — the UI never hides the CLI.
    private var composerFootnote: some View {
        HStack(spacing: Space.md) {
            Image(systemName: "chevron.right")
                .font(.system(size: 8, weight: .bold))
                .accessibilityHidden(true)
            // `.tail`, not `.middle`: eliding the MIDDLE of a real command
            // makes it read as corrupted text rather than shortened, which is
            // the opposite of "the UI never hides the CLI".
            Text(commandPreview)
                .lineLimit(1)
                .truncationMode(.tail)
                .textSelection(.enabled)
            Spacer(minLength: Space.md)
            if controller.mode.isMultiLane && controller.backends.count < 2 {
                Text("add at least 2 backends")
                    .foregroundStyle(theme.color(\.warningFg))
            } else {
                HStack(spacing: Space.lg) {
                    KeyHint(keys: "⌘N", label: "new")
                    KeyHint(keys: "⌘.", label: "stop")
                    KeyHint(keys: "⏎", label: "send")
                }
            }
        }
        .textStyle(Type.monoMicro)
        .foregroundStyle(theme.color(\.textMuted))
    }

    /// The centrepiece control: an elevated card that visibly lights up on
    /// focus, so it reads as the one place input goes rather than one field
    /// among several.
    ///
    /// This is `AppTheme.materials.composer`'s one consumer — the surface
    /// name literally describes this view. A theme that wants the input bar
    /// to read as glass (Cinder, Nightfall) gets that; one that wants it
    /// perfectly flat (Basalt, Vantage — no material anywhere, by design)
    /// gets exactly the plain fill this already was.
    private var composerCard: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            // **Cannot be driven via the accessibility API — verified, not a
            // defect. Do not re-investigate this.** Setting this field's
            // `kAXValueAttribute` via `AXUIElementSetAttributeValue` updates
            // what AX reports back (and what's drawn) but never reaches
            // `draft`'s `@State` storage, so `canSend` below stays false and
            // no submit fires even though the text visibly "took" — a
            // convincing-looking false negative if you don't know the cause.
            //
            // Reproduced in total isolation: a throwaway one-file SwiftUI
            // app with nothing but `TextField(text:) + @State + Button
            // (disabled:)` — no NexusCode/NexusKit code at all — shows the
            // identical failure on this toolchain (Swift 6.3.3 / macOS
            // 26.5.2), for BOTH a plain single-line field and this
            // `axis: .vertical` one. Also tried the "replace selection" AX
            // shape (`kAXSelectedTextRangeAttribute` +
            // `kAXSelectedTextAttribute`, the closer analogue to how an
            // IME/AT commits text) instead of a raw value slam: same
            // failure. So this is a general SwiftUI-on-AppKit accessibility-
            // bridge limitation, not something wrong with this view.
            //
            // This does NOT mean real assistive tech is blocked here.
            // Dictation and Voice Control deliver typed text through the
            // standard text-input/first-responder pipeline — the same route
            // a live keystroke takes — not by writing `kAXValueAttribute`
            // directly, so they reach `draft` the normal way real typing
            // does. (Not independently re-verified against live Dictation/
            // Voice Control in this pass — enabling either is a system-wide
            // toggle, judged too invasive to flip and revert just to
            // confirm this; the conclusion rests on the isolated repro
            // above plus the documented shape of macOS text-input delivery.)
            //
            // Implication for automation: don't set this field's AX value
            // and expect the Send button/submit to react — it structurally
            // can't. To verify submit behavior, call
            // `ConversationController.submit(_:)` directly (NexusKit has a
            // test target); to verify the composer's on-screen appearance,
            // screenshots/the §C2 headless render are unaffected by any of
            // this.
            TextField("Message NexusCode…", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                // Was `1...10`. A vertical-axis `TextField` grows to its line
                // ceiling and then scrolls internally, so this number IS the
                // growth cap: 8 lines of `Type.prose` (15pt on 5.5pt extra
                // leading) is ~180pt, past which the composer would start
                // taking real height from the transcript it is replying to.
                .lineLimit(1...Self.composerMaxLines)
                // 15pt, matching the transcript's own prose: what you type
                // here becomes a turn in that column, and typing at 13pt into
                // a field whose output renders at 15pt is a seam the eye
                // notices even when it cannot name it.
                .textStyle(Type.prose)
                .foregroundStyle(theme.color(\.textPrimary))
                .focused($composerFocused)
                .onSubmit(send)

            ComposerFooter(
                controller: controller,
                showsReasoning: $showsReasoning,
                confirmingClear: $confirmingClear,
                providers: providers,
                models: models,
                isLoadingModels: isLoadingModels,
                modelsAreUnverified: modelsAreUnverified,
                onLoadModels: onLoadModels,
                rolesController: rolesController,
                effortController: effortController,
                authController: authController,
                canSend: canSend,
                onSend: send
            )
        }
        // Substantially taller than before. The composer is the one control
        // the whole screen exists to serve, and at 6pt vertical padding it
        // read as an afterthought strip below a huge empty canvas. This is
        // the single most-used target in the app and now has the presence to
        // match.
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.lg)
        .background {
            themedFill(
                // `surface(2)`, not the `surfaceRaised` token. Measured, the
                // card sat at 1.012:1 against the band behind it — a delta of
                // two values in 255 per channel, which is not a step anyone
                // can see. Going through the ladder accessor puts it a real
                // rung above the canvas and keeps it there when the ladder is
                // re-derived, instead of pinning it to one token's current
                // value. This is a solid fill: the gradient scrim was tried
                // here twice and both attempts are recorded in `composer`.
                theme.surface(2),
                treatment: theme.materials.composer,
                in: Rectangle(),
                isDark: theme.isDark
            )
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay {
            // Focused: a 2px accent ring, the whole focus signal on its own.
            // Unfocused: the specular edge every other raised surface carries,
            // so the composer reads as a real object at rest rather than a
            // rectangle that only becomes one when clicked.
            RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
                .strokeBorder(
                    composerFocused
                        ? AnyShapeStyle(theme.color(\.chromeBorderFocus))
                        : AnyShapeStyle(Depth.specular(theme, level: 2, strength: 0.9)),
                    lineWidth: composerFocused ? 2 : 1
                )
        }
        // No shadow here, on purpose — a supplementary focus shadow was
        // tried and measured (Meridian, focused, at full window size) before
        // this: the 2px `chromeBorderFocus` border already reads as an
        // unmissable, unambiguous focus signal entirely on its own, so a
        // shadow underneath it is a SECOND signal for the same one meaning
        // — exactly the thing "one signal per meaning" rules out. It also
        // risks the specific failure this project already reverted once
        // (`Card`'s at-rest shadow reading as a grey smudge on a near-black
        // canvas) and is the same register as the bright focus glow the
        // owner called out as cheap before. The border alone is the
        // decision; `DESIGN.md`'s "surfaces + hairlines, never drop
        // shadows" stays unqualified rather than growing an exception here.
        .animation(.easeOut(duration: 0.15), value: composerFocused)
    }

    /// The composer's growth ceiling, in lines — see the `.lineLimit` call
    /// above for why this number is the cap rather than a hint.
    private static let composerMaxLines = 8

    private var canSend: Bool {
        controller.canSubmit && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var commandPreview: String {
        // No special-casing here: this is the exact same array the real spawn
        // builds from (`plannedCommand`), not a second copy that can drift
        // from it — including `--effort`, which only appears when
        // `controller.effort` was explicitly set via the composer footer's
        // effort picker (see `ComposerFooter.effortPicker`); otherwise the
        // provider's own configured default governs, exactly as this
        // preview shows.
        let args = controller.plannedCommand(for: draft.isEmpty ? "…" : draft).arguments
        return "nexus " + args
            .map { $0.contains(" ") ? "\"\($0)\"" : $0 }
            .joined(separator: " ")
    }

    private func send() {
        guard canSend else { return }
        controller.submit(draft)
        draft = ""
    }
}

/// Every control that configures the next run, on one flat row directly
/// beneath the field it configures.
///
/// This replaces `ControlStrip`, a 71pt band pinned to the TOP of the window.
/// Three things were wrong with that arrangement and all three are structural
/// rather than cosmetic. The controls sat roughly 700pt above the text field
/// whose behaviour they decide, so the two never appeared in one glance. The
/// row was `[run config] … Spacer … [utility tray]`, which at any real window
/// width left ~270pt of empty band across the middle. And its two failure
/// captions rendered full-width underneath, so a note about ONE picker became
/// a banner across the entire window.
///
/// The categories the old strip's doc comment named are still right — what the
/// run IS, what answers it, how hard it reasons, what it is allowed to do —
/// and they are still in that order here. What changed is that the sequence no
/// longer needs `GroupDivider` hairlines to be legible, because every control
/// is now the same height and radius and reads as one row of one kind of
/// thing. Divider hairlines between differently-shaped controls were
/// compensating for the shapes not matching in the first place.
///
/// **No `ViewThatFits` here, deliberately.** The old strip wrapped its
/// contents in `ViewThatFits { singleRow; twoRowStack }`, and `singleRow`
/// contained a `Spacer(minLength:)` — infinitely flexible, so it always
/// reported that it fit and `twoRowStack` was unreachable at every width. This
/// row instead compresses in one defined place: the model half of the combined
/// provider control truncates, exactly as the old `modelPicker` doc already
/// argued it should ("the long, technical value — this is where truncation
/// belongs if the strip is tight, never the provider id beside it"). One flat
/// `HStack` of fixed-height controls also has no nested flexible children for
/// SwiftUI to re-measure combinatorially.
struct ComposerFooter: View {
    @Environment(\.nexusTheme) private var theme
    @Bindable var controller: ConversationController
    @Binding var showsReasoning: Bool
    @Binding var confirmingClear: Bool
    let providers: [PickerOption]
    let models: [PickerOption]
    let isLoadingModels: Bool
    let modelsAreUnverified: Bool
    let onLoadModels: (String) -> Void
    let rolesController: RolesController?
    /// Backs `effortPicker` — `nil` while loading or when nothing is
    /// selected yet, `capability.supported == false` when the active
    /// provider has no reasoning-effort concept at all. See
    /// `ConversationView.effortController`'s doc for why this is fetched
    /// per-provider rather than joined off `providers`.
    let effortController: EffortController?
    /// Backs `effortUnavailableWarning` — every provider's sign-in state
    /// from `nexus auth status`, used to detect the one case this control
    /// must warn about rather than silently offer: anthropic while signed
    /// in via Claude subscription OAuth. See that property's doc.
    let authController: AuthController?
    let canSend: Bool
    let onSend: () -> Void

    /// ONE control height for the entire row. Every control in this file goes
    /// through it; nothing sets its own vertical padding any more. The old
    /// strip mixed a segmented tab bar, three dropdowns and two icon buttons
    /// at four different heights, which is most of why it read as parts placed
    /// beside each other rather than one designed row.
    static let controlHeight: CGFloat = 28

    var body: some View {
        HStack(spacing: Space.sm) {
            modePicker

            if controller.mode.isMultiLane {
                backendControls
            } else {
                providerModelPicker
            }

            // Multi-lane (compare/race) has no SINGLE active provider for a
            // level to be scoped to — mirrors provider/model being withheld
            // the same way in `backendControls`/`oneShotArguments`.
            if !controller.mode.isMultiLane, showsEffortPicker {
                effortPicker
            }

            // Role only means anything in `.agent` mode — everywhere else
            // `ConversationController.role` is simply never read (see
            // `usesPersistentSession`/`oneShotArguments`), so showing the
            // picker outside `.agent` would offer a control with no effect,
            // exactly the kind of "looks interactive, does nothing" control
            // the approvals toggle was fixed to stop being.
            if controller.mode == .agent {
                rolePicker
            }

            Spacer(minLength: Space.sm)

            overflowMenu
            approvalControl
            sendButton
        }
    }

    // MARK: - Mode

    /// The four modes as one dropdown, replacing a four-tab segmented control.
    ///
    /// The tabs cost ~250pt of the row to render four words, three of which
    /// are always the wrong answer — and mode is the control a user touches
    /// least often in a session, not most. Collapsing it to a dropdown is the
    /// same trade Cursor made for the same reason. The lifted-segment
    /// treatment the tabs used is not lost so much as no longer needed: a
    /// dropdown states the current mode in words.
    private var modePicker: some View {
        DropdownPicker(
            placeholder: "mode",
            options: RunMode.allCases.map { PickerOption(id: $0.rawValue, label: $0.title, detail: $0.detail) },
            selection: controller.mode.rawValue,
            selectionLabel: controller.mode.title,
            minWidth: 92,
            maxWidth: 110,
            truncates: false
        ) { id in
            guard let picked = RunMode(rawValue: id) else { return }
            controller.mode = picked
        }
        .help(controller.mode.detail)
    }

    // MARK: - Provider + model

    /// Provider and model as ONE control carrying the identity dot.
    ///
    /// They were two adjacent dropdowns with a combined ~310pt appetite for
    /// what is really one fact — which backend, on which model, is answering.
    /// Merging them reclaims roughly 150pt of the row and removes one of the
    /// six shapes it had to hold. It is also honest about the dependency the
    /// two controls always had: a model is only meaningful relative to its
    /// provider, and the old pair expressed that with a disabled second picker
    /// and a "Pick a provider first" tooltip.
    private var providerModelPicker: some View {
        ProviderModelPicker(
            providers: providers,
            models: models,
            provider: controller.provider,
            model: controller.model,
            isLoadingModels: isLoadingModels,
            modelsAreUnverified: modelsAreUnverified,
            isDefaultModelSelected: isDefaultModelSelected,
            onSelectProvider: { id in
                controller.provider = id
                controller.model = nil
                // A level picked for the OLD provider's scale (e.g.
                // claude-code's `"xhigh"`) is meaningless — or actively
                // wrong — the instant a different provider is selected;
                // `effortController`'s own `.task(id:)` will re-probe the
                // new provider's scale separately (see `ConversationView
                // .effortController`'s doc), but nothing else resets a
                // stale explicit pick.
                controller.effort = nil
                onLoadModels(id)
            },
            onSelectModel: { controller.model = $0 }
        )
    }

    /// Whether `controller.model` is still the provider's first model —
    /// i.e. what `ChatTab.loadModels` auto-selected, not a deliberate pick.
    private var isDefaultModelSelected: Bool {
        controller.model != nil && controller.model == models.first?.id
    }

    private var backendControls: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.xs) {
                ForEach(controller.backends, id: \.self) { backend in
                    Chip(text: backend) {
                        controller.backends.removeAll { $0 == backend }
                    }
                }
                DropdownPicker(
                    placeholder: "+ add",
                    options: providers.filter { !controller.backends.contains($0.id) },
                    selection: nil,
                    minWidth: 72,
                    maxWidth: 72,
                    emptyHint: providers.isEmpty ? "No providers loaded yet" : "All providers already added"
                ) { id in
                    if !controller.backends.contains(id) { controller.backends.append(id) }
                }
            }
        }
        // Bounded, rather than left to size itself: backend chip count has
        // no upper bound (a Compare run can grow past what any fixed width
        // holds), so this is the one piece of the row that keeps its own
        // scroll rather than compressing its neighbours.
        .frame(maxWidth: 260, maxHeight: Self.controlHeight)
    }

    // MARK: - Effort

    /// Whether `effortPicker` should render at all — hidden outright (never
    /// a disabled dead control, per this feature's "no dead controls" rule,
    /// same as `NexusProvider`/`EffortCapability`'s "hide, don't grey out"
    /// discipline elsewhere) until the live probe CONFIRMS the active
    /// provider has a reasoning-effort concept with at least one real level
    /// to offer. `nil` (no provider selected yet, still loading, or the
    /// probe failed) and a confirmed `supported == false` read identically
    /// here — neither is a reason to show anything.
    private var showsEffortPicker: Bool {
        guard let capability = effortController?.capability else { return false }
        return capability.supported && !capability.levels.isEmpty
    }

    /// A sentinel id for "nothing explicitly picked" — mirrors
    /// `nativeToolLoopId` below exactly, including WHY: `controller.effort
    /// == nil` is a real, first-class choice (leave the provider's own
    /// default alone, see that property's doc), not merely "nothing picked
    /// yet", so the picker needs an explicit row to return TO it.
    private static let effortDefaultId = "default"

    /// `nexus effort <provider>`'s live per-provider scale, never a shared
    /// lowest-common-denominator list (see `EffortCapability`'s doc for why
    /// that assumption is exactly what got this control deleted once
    /// already) — driven entirely by `effortController.capability`, with NO
    /// per-provider special-casing in this view beyond the one documented,
    /// narrowly-scoped exception (`effortUnavailableWarning`).
    private var effortPicker: some View {
        DropdownPicker(
            placeholder: "effort",
            options: effortOptions,
            selection: controller.effort ?? Self.effortDefaultId,
            isLoading: effortController?.isLoading ?? false,
            minWidth: 84,
            maxWidth: 128,
            // The warning that used to be a full-window amber banner under
            // the whole strip. It concerns exactly this control, so it lives
            // ON it — a triangle on the closed button and the full sentence
            // in the popover the button opens.
            controlWarning: effortUnavailableWarning,
            emptyHint: effortController?.error ?? "No reasoning-effort levels"
        ) { id in
            controller.effort = id == Self.effortDefaultId ? nil : id
        }
        .help("Reasoning effort for \(controller.provider ?? "the active provider") — the provider's own default is used unless you pick a level here")
    }

    /// A caution that reasoning is silently unusable on the CURRENT
    /// credential — narrowly scoped to the one case actually verified live:
    /// `anthropic` while signed in via a Claude subscription OAuth token
    /// (see `reasoningUnavailableForOAuth`, `packages/providers/anthropic/
    /// src/index.ts`). That adapter proved the `/v1/messages` request
    /// returns 200 and silently drops every thinking block for a bearer
    /// token — never an error — so the effort picker itself would look
    /// fully functional while doing nothing. `offDisablesReasoning == true`
    /// is used as the general marker of "this is the token-budget family
    /// the OAuth defect applies to" rather than hardcoding a `kind` this
    /// wire shape doesn't even carry (`EffortCapability` has no `kind`
    /// field — see its doc) — narrowed to `provider == "anthropic"` because
    /// that is the ONLY provider this was actually proven on; generalizing
    /// further would be a guess this codebase's own discipline elsewhere
    /// (`ModelListSource`, `NexusProvider.localServerReachable`) argues
    /// against making.
    ///
    /// Same "visible, not blocking" contract as `circuitWarning`/
    /// `localServerWarning` (`SelectableProvider`, `Providers.swift`): the
    /// picker stays fully selectable — this app is advisory, never the
    /// enforcement point — but the reason a level does nothing is never left
    /// for the user to discover only by watching nothing happen. What changed
    /// is placement, not weight: amber still, but attached to the control it
    /// describes instead of spanning the window above an unrelated transcript.
    private var effortUnavailableWarning: String? {
        guard controller.provider == "anthropic",
              effortController?.capability?.offDisablesReasoning == true,
              authController?.providers.first(where: { $0.providerId == "anthropic" })?.kind == .oauth
        else { return nil }
        return "Extended thinking isn't available for a Claude subscription (OAuth) sign-in — picking a level below has no effect. Sign in with an API key instead to use it."
    }

    /// Options for `effortPicker`, built from the live probe:
    ///  - `"default"` (`effortDefaultId`), mapping back to `nil` — the
    ///    provider's own already-configured default, left UNOPPOSED (see
    ///    `ConversationController.effort`'s doc).
    ///  - `"off"`, ONLY when `offDisablesReasoning` is true. Omitted
    ///    entirely — never shown disabled or relabelled — for claude-code/
    ///    codex, which always reason and have no off to offer at all (see
    ///    `EffortCapability.offDisablesReasoning`'s doc); present for the
    ///    token-budget family (anthropic/gemini/bedrock/vertex), where off
    ///    genuinely disables extended thinking.
    ///  - every level the live probe reported, verbatim — claude-code's
    ///    seven, anthropic's three, whatever codex's own scale is — with the
    ///    CURRENT provider-side default (`capability.defaultLevel`) marked
    ///    so it's visible without having to be re-selected.
    private var effortOptions: [PickerOption] {
        guard let capability = effortController?.capability else { return [] }
        var options = [
            PickerOption(id: Self.effortDefaultId, detail: "Provider's own configured default"),
        ]
        if capability.offDisablesReasoning {
            options.append(PickerOption(id: "off", detail: "No extended thinking"))
        }
        options += capability.levels.map { level in
            PickerOption(id: level.id, detail: effortLevelDetail(level, isCurrentDefault: level.id == capability.defaultLevel))
        }
        return options
    }

    /// `level.description` (e.g. "24k thinking tokens" for a token-budget
    /// provider) with the live-probed CURRENT default folded in — mirrors
    /// `cmdEffort`'s own text-mode `●` marker (`commands.ts`) rather than
    /// inventing a different convention for the same fact.
    private func effortLevelDetail(_ level: EffortLevelOption, isCurrentDefault: Bool) -> String? {
        switch (level.description, isCurrentDefault) {
        case (let description?, true): return "\(description) · current default"
        case (let description?, false): return description
        case (nil, true): return "current default"
        case (nil, false): return nil
        }
    }

    // MARK: - Role

    /// The OODA role picker — `nexus agent --role <id>`'s only UI entry
    /// point today. Backed by `RolesController` (`nexus roles`), never a
    /// hardcoded Swift list (see `NexusRole`'s doc for why). A role whose
    /// `permissionMode` is anything but `"read-only"` gets a visible warning
    /// on both the closed picker and its row in the popover — see
    /// `PickerOption.warning` — per the house rule that a client warns
    /// BEFORE running something that can write: four of the nine shipped
    /// roles (coordinator, coder, tester, doc-writer) are `workspace-write`.
    private var rolePicker: some View {
        DropdownPicker(
            placeholder: "role",
            options: roleOptions,
            selection: controller.role ?? Self.nativeToolLoopId,
            isLoading: rolesController?.isLoading ?? false,
            minWidth: 110,
            maxWidth: 148,
            emptyHint: rolesController?.error ?? "No roles found"
        ) { id in
            controller.role = id == Self.nativeToolLoopId ? nil : id
        }
        .help("OODA role for the tool loop — the fast native loop runs when none is picked")
    }

    /// A sentinel id, not a real role: no shipped role preset is this short,
    /// plain a word (they're all multi-syllable descriptive names — coder,
    /// reviewer, tester, …), so this can't collide with anything `nexus
    /// roles` ever returns. Maps back to `role == nil` in `rolePicker`'s
    /// `onSelect` — the native tool loop is a first-class, default CHOICE
    /// here, not merely "nothing picked yet".
    private static let nativeToolLoopId = "native"

    private var roleOptions: [PickerOption] {
        let native = PickerOption(
            id: Self.nativeToolLoopId,
            detail: "Fast native tool loop — no plan/reflect/replan"
        )
        let roles = (rolesController?.roles ?? []).map { role in
            PickerOption(
                id: role.id,
                detail: role.description,
                warning: role.canWrite ? "Can write files and run shell commands" : nil
            )
        }
        return [native] + roles
    }

    // MARK: - Approvals

    /// A real toggle. `ConversationController.approvalsEnabled` already drives
    /// `-t --ask` on the actual `chat --persistent` argv (see
    /// `persistentSessionArguments()`, which both `commandPreview` and the
    /// real spawn call through) — so this switches genuine behavior rather
    /// than reading it back the way a disabled/dimmed readout would.
    ///
    /// Neutral tone regardless of state — see `DESIGN.md`'s colour system:
    /// accent is earned by selection, the one primary action, or live state,
    /// never by "this setting happens to be on." A persistent configuration
    /// toggle read accent when enabled used to be one of the four unrelated
    /// places accent showed up with no shared meaning; the filled vs.
    /// slashed glyph already carries the on/off distinction on its own.
    private var approvalControl: some View {
        Button {
            controller.approvalsEnabled.toggle()
        } label: {
            HStack(spacing: Space.xs) {
                Image(systemName: controller.approvalsEnabled ? "hand.raised.fill" : "hand.raised.slash")
                    .font(.system(size: 10))
                // Prose UI label, not machine output — `Type.mono` is
                // reserved for literal CLI/JSON text (the command preview,
                // provider/model ids), not English button copy.
                Text("Ask first")
                    .textStyle(Type.caption)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, Space.sm)
            .frame(height: Self.controlHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.color(\.textSecondary))
        .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
        .disabled(!approvalsApply)
        .opacity(approvalsApply ? 1 : 0.5)
        .help(
            approvalsApply
                ? (controller.approvalsEnabled
                    ? "Write/exec/network tools require your approval before running"
                    : "Tools run without confirmation — click to require approval")
                : "No tool loop in this mode — approval gating doesn't apply"
        )
    }

    /// Mirrors `ConversationController.usesPersistentSession` (private to that
    /// type): approvals only gate the persistent `chat --persistent -t --ask`
    /// path, so a Compare/Race run or a role-based Agent run — neither of
    /// which ever opens that path (see `oneShotArguments`) — has no tool loop
    /// for this switch to affect.
    private var approvalsApply: Bool {
        !controller.mode.isMultiLane && !(controller.mode == .agent && controller.role != nil)
    }

    // MARK: - Overflow

    /// Conversation-wide utility actions — the session id, the reasoning-
    /// traces toggle, and clear.
    ///
    /// These are NOT part of configuring the next run (which is what every
    /// other control on this row does), and the old strip already kept them
    /// visually separate for that reason. Behind a `···` they keep that
    /// separation while costing one control's width instead of three. A
    /// native `Menu` is right here specifically because the objection that
    /// ruled menus out for `DropdownPicker` — no reliable hover tooltip on a
    /// DISABLED row — does not apply: nothing in here is ever disabled.
    private var overflowMenu: some View {
        Menu {
            if let session = controller.sessionId {
                Button("Copy session id — …\(session.suffix(8))") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(session, forType: .string)
                }
            }
            Toggle("Reasoning traces", isOn: $showsReasoning)
            Divider()
            Button("Clear transcript…", role: .destructive) { confirmingClear = true }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(theme.color(\.textSecondary))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        // An EXPLICIT frame, then the chrome — not `.fixedSize()` and not a
        // background inside the label. A `Menu` reserves its own layout box
        // independently of its label, so both of those paint a rectangle that
        // does not line up with the glyph; the observable result was a
        // borderless ellipsis sitting beside four boxed controls. Pinning the
        // menu itself to `controlHeight` square is what makes the box and the
        // glyph the same object.
        .frame(width: Self.controlHeight, height: Self.controlHeight)
        .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
        .help("Session, reasoning traces, clear")
    }

    // MARK: - Send

    /// `SoftButton(size: .compact)` adds 8pt of horizontal and 5pt of vertical
    /// padding of its own, so the glyph frame is sized to what is LEFT of
    /// `controlHeight` after that padding — 18pt tall, 12pt wide. Framing the
    /// glyph at the full 28 instead produced a 38pt-tall button sitting beside
    /// four 28pt ones, which is the exact defect ("one control height") this
    /// row was rebuilt to remove.
    private static let sendGlyph = (width: controlHeight - 16, height: controlHeight - 10)

    @ViewBuilder
    private var sendButton: some View {
        if controller.isRunning {
            Button(action: controller.cancel) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: Self.sendGlyph.width, height: Self.sendGlyph.height)
            }
            .buttonStyle(SoftButton(tone: .danger, size: .compact))
            .help("Stop the run (⌘.)")
        } else {
            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: Self.sendGlyph.width, height: Self.sendGlyph.height)
            }
            .buttonStyle(SoftButton(tone: canSend ? .accent : .neutral, size: .compact))
            .disabled(!canSend)
            .help("Send (⏎)")
        }
    }
}

/// Provider and model in ONE control — see `ComposerFooter
/// .providerModelPicker` for why they merged.
///
/// The popover holds both lists, provider above model, because picking a
/// provider is nearly always immediately followed by looking at what models it
/// has. Keeping the popover open across a provider pick is what makes that one
/// gesture instead of two: the model list reloads underneath (`isLoadingModels`
/// drives the spinner in place) and the user chooses without reopening
/// anything.
private struct ProviderModelPicker: View {
    @Environment(\.nexusTheme) private var theme
    let providers: [PickerOption]
    let models: [PickerOption]
    let provider: String?
    let model: String?
    let isLoadingModels: Bool
    /// Whether EVERY model in `models` is an unconfirmed `.fallback` guess
    /// rather than a live-probed catalog.
    let modelsAreUnverified: Bool
    let isDefaultModelSelected: Bool
    let onSelectProvider: (String) -> Void
    let onSelectModel: (String) -> Void

    @State private var isOpen = false

    private var dotColor: Color { ProviderIdentity.color(provider, theme: theme) }

    var body: some View {
        Button { isOpen = true } label: {
            HStack(spacing: 5) {
                Circle().fill(dotColor).frame(width: 6, height: 6)
                // The provider id never truncates — it is short, human-facing
                // and the identity half of this control. `.fixedSize` makes it
                // report its true unwrapped width during layout negotiation
                // rather than accepting a too-small proposal, which is what
                // reproduced "ant…opic" the last time a control was added to
                // this row. See `DropdownPicker.truncates`.
                Text(provider ?? "provider")
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                if let model {
                    Text("·")
                        .foregroundStyle(theme.color(\.textMuted))
                    // The model is the long technical value and therefore the
                    // one place this control gives ground when the row is
                    // tight.
                    Text(model)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if isLoadingModels {
                    ProgressView().controlSize(.mini).scaleEffect(0.6)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(theme.color(\.textMuted))
            }
            .textStyle(Type.monoMicro)
            .foregroundStyle(provider == nil ? theme.color(\.textMuted) : theme.color(\.textSecondary))
            .padding(.horizontal, Space.sm)
            .frame(minWidth: 128, maxWidth: 232, alignment: .leading)
            .frame(height: ComposerFooter.controlHeight)
            .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .help(helpText)
        .popover(isPresented: $isOpen, arrowEdge: .bottom) { popoverBody }
    }

    private var helpText: String {
        if provider == nil { return "Pick a provider and model" }
        if isDefaultModelSelected {
            // The value shown is real either way — `ChatTab.loadModels`
            // preselects `models.first` so this is never blank — but the
            // tooltip still tells the two states apart: a provider default
            // the user never looked at vs. a deliberate pick.
            return "Provider default — not explicitly chosen. Click to pick a specific model."
        }
        return "Provider and model for this run"
    }

    private var popoverBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                sectionHeader("Provider")
                if providers.isEmpty {
                    hint("No providers loaded yet")
                } else {
                    ForEach(providers) { option in
                        PickerRow(option: option, isSelected: option.id == provider) {
                            onSelectProvider(option.id)
                        }
                    }
                }

                sectionHeader("Model")
                // ONE quiet line for the whole model list, not a warning per
                // row — and now attached to the list it describes rather than
                // stretched across the window.
                //
                // `no-mocks` proposed reusing `PickerOption.warning` (the amber
                // triangle `rolePicker` puts on a write-capable role) per
                // unverified model. Overruled: that mechanism is for a PER-ROW
                // condition. Verification isn't per-row — when a probe can't
                // run, EVERY model in the list is `.fallback` together
                // (confirmed: `nexus models gemini -o json` returns six models,
                // every one `"fallback"`), so six amber triangles would paint
                // one fact as six. The general rule: a condition that applies
                // to an entire SET gets one marker on the set, never one per
                // member. Neutral, no icon, no amber — this is a
                // data-provenance gap, not a dead end.
                if modelsAreUnverified && !models.isEmpty {
                    Text("Unverified — sign in to load the real model list")
                        .textStyle(Type.micro)
                        .foregroundStyle(theme.color(\.textMuted))
                        .padding(.horizontal, Space.sm)
                        .padding(.bottom, 3)
                }
                if provider == nil {
                    hint("Pick a provider first")
                } else if models.isEmpty {
                    hint(isLoadingModels ? "Loading models…" : "No models for this provider yet")
                } else {
                    ForEach(models) { option in
                        PickerRow(option: option, isSelected: option.id == model) {
                            isOpen = false
                            onSelectModel(option.id)
                        }
                    }
                }
            }
            .padding(4)
        }
        .frame(minWidth: 260, maxHeight: 340)
        .background(theme.color(\.surfaceOverlay))
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .textStyle(Type.eyebrow)
            .foregroundStyle(theme.color(\.textMuted))
            .padding(.horizontal, Space.sm)
            .padding(.top, Space.sm)
            .padding(.bottom, 3)
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .textStyle(Type.caption)
            .foregroundStyle(theme.color(\.textMuted))
            .padding(Space.sm)
    }
}

// `GroupDivider` used to live here — a 1x20 hairline placed between the
// control strip's groups. It is deleted rather than moved: it existed to make
// a sequence of differently-shaped, differently-sized controls read as
// deliberate groups, and `ComposerFooter` removed the thing it was
// compensating for by giving every control one height and one radius. A
// divider between controls that already match is just another mark to explain.

/// One row in a `DropdownPicker` — a provider, a model, a role (for the
/// `.agent` role picker), or (for the compare/race "add backend" control) a
/// provider offered as a backend.
///
/// Callers that have nothing loaded yet default to `[]` and the pickers
/// render their empty state — `ChatTab` (`RootView.swift`) is what actually
/// binds live `ProvidersController`/`RolesController` data into these.
struct PickerOption: Identifiable, Equatable {
    let id: String
    /// Display text, when the id is not what a human should read. `nil` for
    /// every provider/model/role/backend option — those ARE their ids, and
    /// showing anything else would hide the exact string that ends up on the
    /// `nexus` command line. Set only by the mode picker, whose ids are wire
    /// values (`ask`) with real titles beside them (`Ask`).
    var label: String?
    var detail: String?
    var available: Bool
    var disabledReason: String?
    /// Provider kind (`"anthropic"`, `"openai"`, …) — colors the status dot
    /// only. `nil` for options that don't need one (models, roles).
    var kind: String?
    /// A caution to surface for this option, shown on BOTH the popover row
    /// and the closed picker button once selected — never buried behind a
    /// click. `nil` for every provider/model/backend option today; only a
    /// `.agent` role whose `permissionMode` isn't `"read-only"` sets this
    /// (see `NexusRole.canWrite` and `ComposerFooter.rolePicker`).
    var warning: String?

    init(
        id: String,
        label: String? = nil,
        detail: String? = nil,
        available: Bool = true,
        disabledReason: String? = nil,
        kind: String? = nil,
        warning: String? = nil
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.available = available
        self.disabledReason = disabledReason
        self.kind = kind
        self.warning = warning
    }

    fileprivate func dotColor(theme: AppTheme) -> Color? {
        guard let kind else { return nil }
        return providerDotColor(kind: kind, theme: theme).opacity(available ? 1 : 0.4)
    }
}

extension PickerOption {
    /// Maps `ProvidersController`'s `NexusProvider` onto this picker's option
    /// shape. `ProvidersController` lives in NexusKit and needs a `NexusClient`
    /// this view has no access to (`ConversationController` keeps its own
    /// private) — so it is instantiated and refreshed by whoever owns
    /// `RootView.swift`, which then maps `.selectable`/`.providers` through
    /// this initializer to fill `ConversationView`'s `providers:` parameter.
    init(provider: NexusProvider) {
        self.init(
            id: provider.id,
            detail: provider.isUsable ? nil : provider.detail,
            available: provider.isUsable,
            disabledReason: provider.isUsable ? nil : provider.detail,
            kind: provider.kind
        )
    }

    /// Maps `ProvidersController.models(for:)`'s `NexusModel` onto this
    /// picker's option shape, preferring the parsed context window over the
    /// raw hint string when both are available.
    ///
    /// No per-row `warning` here on purpose. `model.isVerified` was first
    /// wired to `warning` (the same amber-triangle mechanism a write-capable
    /// role uses), then overruled: verification is a fact about the whole
    /// LIST, not about any one row in it — when a probe can't run, EVERY
    /// model in that provider's list is `.fallback` together, so a per-row
    /// treatment would paint N identical amber warnings for ONE fact. See
    /// `ProviderModelPicker`'s model-section caption for the set-level
    /// treatment that replaced it, and `DESIGN.md`'s colour system for the
    /// rule this established: a condition that applies to an entire set gets
    /// one marker on the set, never one per member.
    init(model: NexusModel) {
        self.init(
            id: model.id,
            detail: model.contextWindow.map { "\($0 / 1_000)k ctx" } ?? model.hint
        )
    }
}

/// Maps a provider kind onto its themed status-dot color, falling back to the
/// generic "custom" token for anything unrecognized (local models, future
/// providers) instead of guessing or hardcoding a color.
private func providerDotColor(kind: String, theme: AppTheme) -> Color {
    switch kind.lowercased() {
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

/// The dot color for the currently selected provider id, looked up in the
/// loaded provider list rather than re-deriving a kind from the id string.
private func providerDotColor(for id: String?, in providers: [PickerOption], theme: AppTheme) -> Color? {
    guard let id, let match = providers.first(where: { $0.id == id }) else { return nil }
    return match.dotColor(theme: theme)
}

/// A themed dropdown for a list of `PickerOption`s — the provider and model
/// pickers, and the compare/race "add backend" control, all share this one
/// implementation. A native `Menu` was ruled out: macOS menu items have no
/// reliable hover tooltip for a *disabled* row, and the provider list
/// specifically needs an unavailable/needs-key provider to stay visible with
/// its reason on hover rather than vanish or go silently inert.
private struct DropdownPicker: View {
    @Environment(\.nexusTheme) private var theme
    var placeholder: String
    var leadingDot: Color?
    var options: [PickerOption]
    var selection: String?
    /// Display text for the current selection, when the id is not what should
    /// be read back. Mirrors `PickerOption.label`; see that property for why
    /// only the mode picker sets it.
    var selectionLabel: String?
    var isLoading = false
    /// A floor, not a fixed size — the button grows to fit whatever
    /// `displayText` actually is, up to `maxWidth` (`nil` = unbounded). Before
    /// this, every picker used a single fixed `width`, which is exactly how
    /// the provider name ("anthropic") ended up truncating mid-word
    /// ("ant…opic") in the app's single most prominent control while the
    /// model picker beside it — genuinely the longer, more technical value —
    /// sat mostly empty at nearly double the width. The short, human-facing
    /// value gets room to breathe; the long, technical one is where
    /// truncation belongs if it has to happen at all.
    var minWidth: CGFloat = 120
    var maxWidth: CGFloat? = 120
    /// Whether `displayText` may compress under pressure — `true` (the
    /// default) for every ordinary picker (model/role/backend), which may
    /// legitimately give ground when the strip is tight. `false` for the
    /// MODE picker specifically, and for the provider half of
    /// `ProviderModelPicker`: the doc above already names "ant…opic" as a
    /// fixed, closed defect, and a squeezed `HStack` reproduced it again the
    /// instant a fourth control (the effort picker) was added — not by lying
    /// about `minWidth`/`maxWidth`, but because `Text` alone is flexible
    /// enough to shrink and truncate well below either bound while `.frame`
    /// stayed silent about it. `false` wraps the text in
    /// `.fixedSize(horizontal:)`, which makes it report its TRUE unwrapped
    /// width during layout negotiation instead of accepting a too-small
    /// proposal.
    ///
    /// This used to exist to force the deficit up to a `ViewThatFits` that
    /// would then pick a two-row layout. That mechanism is gone (see
    /// `ComposerFooter`'s doc — the two-row candidate was unreachable), and
    /// the flag's job is now simpler and entirely local: name the ONE control
    /// on the row that is allowed to give ground, and hold every other one to
    /// its real width.
    var truncates: Bool = true
    /// A caution about this CONTROL as a whole, rather than about one option
    /// in it — e.g. "the effort scale is real but your credential silently
    /// ignores it". Renders as a triangle on the closed button plus the full
    /// sentence at the top of the popover.
    ///
    /// This is what the full-window amber caption under the old control strip
    /// became. The fact never justified a banner across the window: it is
    /// about one picker, so it belongs on that picker, where it is legible in
    /// the same glance as the control it invalidates.
    var controlWarning: String?
    var emptyHint: String?
    var onSelect: (String) -> Void

    @State private var isOpen = false

    private var displayText: String { selectionLabel ?? selection ?? placeholder }

    /// The caution to surface on the CLOSED button — the control-level one if
    /// there is one, otherwise the current selection's own. Surfaced on the
    /// closed button, not just inside the popover, so picking a role that can
    /// write is never one click away from being invisible.
    private var selectedWarning: String? {
        controlWarning ?? options.first(where: { $0.id == selection })?.warning
    }

    var body: some View {
        Button {
            isOpen = true
        } label: {
            HStack(spacing: 5) {
                if let leadingDot {
                    Circle().fill(leadingDot).frame(width: 6, height: 6)
                }
                Text(displayText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .fixedSize(horizontal: !truncates, vertical: false)
                if let selectedWarning {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(theme.color(\.warningFg))
                        .help(selectedWarning)
                }
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.6)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.down")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(theme.color(\.textMuted))
            }
            .textStyle(Type.monoMicro)
            .foregroundStyle(selection == nil ? theme.color(\.textMuted) : theme.color(\.textSecondary))
            .padding(.horizontal, Space.sm)
            .frame(minWidth: minWidth, maxWidth: maxWidth, alignment: .leading)
            // One height for every control on the composer footer, set here
            // rather than by each caller's own vertical padding.
            .frame(height: ComposerFooter.controlHeight)
            .background(theme.color(\.surfaceInset))
            .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(
                        selectedWarning != nil ? theme.color(\.warningFg).opacity(0.6) : theme.color(\.chromeBorderSubtle),
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            DropdownList(
                options: options,
                selection: selection,
                emptyHint: emptyHint,
                controlWarning: controlWarning
            ) { id in
                isOpen = false
                onSelect(id)
            }
        }
    }
}

/// The popover body `DropdownPicker` opens — one row per option, unavailable
/// ones dimmed and inert but still visible with their reason on hover.
private struct DropdownList: View {
    @Environment(\.nexusTheme) private var theme
    let options: [PickerOption]
    let selection: String?
    let emptyHint: String?
    /// See `DropdownPicker.controlWarning`. Rendered above the rows, in full,
    /// because a caution that invalidates every row is not something to learn
    /// one row at a time.
    var controlWarning: String?
    let onSelect: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                if let controlWarning {
                    HStack(alignment: .top, spacing: Space.xs) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 8))
                            .padding(.top, 2)
                        Text(controlWarning)
                            .textStyle(Type.micro)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(theme.color(\.warningFg))
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.sm)
                }
                if options.isEmpty {
                    Text(emptyHint ?? "Nothing available")
                        .textStyle(Type.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                        .padding(Space.md)
                } else {
                    ForEach(options) { option in
                        PickerRow(option: option, isSelected: option.id == selection) {
                            onSelect(option.id)
                        }
                    }
                }
            }
            .padding(4)
        }
        .frame(minWidth: 220, maxHeight: 300)
        .background(theme.color(\.surfaceOverlay))
    }
}

/// One selectable row, shared by `DropdownList` and `ProviderModelPicker`'s
/// two-section popover so the two cannot drift into different row treatments
/// for the same kind of choice. Unavailable options stay visible, dimmed and
/// inert, with their reason on hover — the behaviour a native `Menu` could not
/// provide and the reason this control is hand-rolled at all.
private struct PickerRow: View {
    @Environment(\.nexusTheme) private var theme
    let option: PickerOption
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        let button = Button(action: onSelect) {
            HStack(spacing: Space.sm) {
                if let dot = option.dotColor(theme: theme) {
                    Circle().fill(dot).frame(width: 6, height: 6)
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(option.label ?? option.id)
                            .textStyle(Type.monoMicro)
                        if option.warning != nil {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 8))
                                .foregroundStyle(theme.color(\.warningFg))
                        }
                    }
                    if let detail = option.detail {
                        Text(detail)
                            .textStyle(Type.micro)
                            .foregroundStyle(theme.color(\.textMuted))
                    }
                    if let warning = option.warning {
                        Text(warning)
                            .textStyle(Type.micro)
                            .foregroundStyle(theme.color(\.warningFg))
                    }
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                }
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(option.available ? theme.color(\.textPrimary) : theme.color(\.textMuted))
        .opacity(option.available ? 1 : 0.45)
        .disabled(!option.available)

        if let reason = option.disabledReason, !option.available {
            button.help(reason)
        } else {
            button
        }
    }
}

/// Live token/cost readout, shown only while a turn is streaming — the
/// composer's "how much is this costing" tell, right next to the "what will
/// this run" command preview below it.
private struct UsageReadout: View {
    @Environment(\.nexusTheme) private var theme
    let view: ViewState

    var body: some View {
        Text(summary)
            .textStyle(Type.monoMicro)
            .monospacedDigit()
            .foregroundStyle(theme.color(\.textMuted))
            .lineLimit(1)
            .fixedSize()
            .help("This turn: \(view.lastUsage.inputTokens) in, \(view.lastUsage.outputTokens) out, \(turnCostText). Session total \(formatted(view.totals.costUsd, incomplete: view.totals.costIncomplete)).")
    }

    /// `8.2k in · 1.1k out · $0.04` — one line, dimmed, sized to its content.
    ///
    /// Compact because of where this now renders. It used to be a four-`Metric`
    /// row INSIDE the composer band, gated on `streaming`, which is what made
    /// the text field jump the moment a turn began. On the live turn's own
    /// attribution row it has to share a line with the provider label and the
    /// copy button, so it is one string rather than four labelled readouts.
    private var summary: String {
        [
            "\(abbreviated(view.lastUsage.inputTokens)) in",
            "\(abbreviated(view.lastUsage.outputTokens)) out",
            turnCostText,
        ].joined(separator: " · ")
    }

    /// `8231` → `8.2k`. A token count's exact units are never the question
    /// being asked of this readout; its order of magnitude always is.
    private func abbreviated(_ count: Int) -> String {
        guard count >= 1_000 else { return "\(count)" }
        return String(format: "%.1fk", Double(count) / 1_000)
    }

    /// Display text for `view.currentTurnCost` — see that property's doc for
    /// why this is a real three-way distinction and not just `formatted`
    /// applied to an optional.
    private var turnCostText: String {
        switch view.currentTurnCost {
        case .cached: return "cached"
        case .unknown: return formatted(nil)
        case .priced(let usd): return formatted(usd)
        }
    }

    /// `nil` means genuinely unknown pricing (an unpriced model's turn) —
    /// shown as "—", never coerced into a confident "$0.00" the way a real
    /// mock/local $0 run is. Mirrors `SessionsView`'s `costLabel`, which draws
    /// the identical distinction for the Sessions tab's own cost readout,
    /// including the edge case a bare `usd <= 0` check would miss: a PARTIAL
    /// sum (`incomplete == true`) that happens to total exactly zero is still
    /// "unknown", not a confirmed free run, so it reads as "—" too rather than
    /// a confident "$0.00". `*` marks a nonzero-but-partial total instead.
    private func formatted(_ usd: Double?, incomplete: Bool = false) -> String {
        guard let usd else { return "—" }
        guard usd > 0 else { return incomplete ? "—" : "$0.00" }
        let amount = usd < 0.01 ? "<$0.01" : String(format: "$%.2f", usd)
        return incomplete ? "\(amount)*" : amount
    }
}

// `ModePicker` — a themed stand-in for `.pickerStyle(.segmented)` — used to
// live here. It is deleted with the control strip it belonged to: four tabs
// spent ~250pt of a row to render four words, three of which are always the
// wrong answer, for the control a session touches least often. `ComposerFooter
// .modePicker` states the current mode in words at a fifth of the width. The
// judgement the tabs encoded is not lost — a selected segment RISES on a
// level-2 surface rather than filling with accent, so the accent stays
// reserved for Send — because there is no longer a segment to treat.

/// One row of the empty state's "try asking" grid — a full-width card rather
/// than the small capsule this used to be, so the four suggestions read as
/// real, chosen content occupying the transcript region rather than a thin
/// afterthought pinned above the composer.
private struct SuggestionCard: View {
    @Environment(\.nexusTheme) private var theme
    let icon: String
    let text: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.md) {
                Image(systemName: icon)
                    .font(.system(size: 13))
                    // `.monochrome` forced explicitly: SF Symbols with a
                    // designed multicolor palette (`ladybug` is one) render
                    // in their own built-in colours by default and silently
                    // IGNORE `.foregroundStyle` otherwise — which is exactly
                    // why the fourth suggestion's icon still looked like a
                    // stray emoji next to three neutral ones.
                    .symbolRenderingMode(.monochrome)
                    // Neutral, not accent — a decorative per-row icon tint is
                    // exactly the pattern `DESIGN.md`'s colour system rules out.
                    .foregroundStyle(theme.color(\.textSecondary))
                    .frame(width: 18)
                Text(text)
                    .textStyle(Type.bodyStrong)
                    .foregroundStyle(theme.color(\.textSecondary))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.left")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.color(\.textMuted))
                    .opacity(hovering ? 1 : 0)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.color(\.surfaceOverlay).opacity(hovering ? 1 : 0.6), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .onHover { hovering = $0 }
    }
}

struct Chip: View {
    @Environment(\.nexusTheme) private var theme
    let text: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(text).textStyle(Type.monoMicro)
            Button(action: onRemove) {
                Image(systemName: "xmark").font(.system(size: 7, weight: .bold))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(theme.color(\.surfaceOverlay))
        .foregroundStyle(theme.color(\.textSecondary))
        .clipShape(Capsule())
    }
}

/// One column of a fan-out run — a whole card, so several answers read as
/// panels to compare rather than a list to scroll past.
struct LaneColumn: View {
    @Environment(\.nexusTheme) private var theme
    let lane: LaneState
    let showsReasoning: Bool

    private var isFailed: Bool {
        lane.live?.error != nil || lane.finalized.last?.error != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            header
            Divider().overlay(theme.color(\.chromeDivider))
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    ForEach(lane.finalized) { turn in
                        TurnView(turn: turn, showsReasoning: showsReasoning, compact: true)
                    }
                    if let live = lane.live {
                        TurnView(turn: live, showsReasoning: showsReasoning, isStreaming: true, compact: true)
                    }
                }
            }
        }
        .padding(Space.md)
        .background(theme.color(\.surfaceRaised))
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
    }

    private var header: some View {
        HStack(spacing: Space.sm) {
            StatusDot(isRunning: lane.isStreaming, isFailed: isFailed)
            Text(lane.lane)
                .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(theme.color(\.textPrimary))
            Spacer(minLength: 0)
            if lane.isStreaming {
                CountPill(text: "live", tone: .accent)
            } else if isFailed {
                CountPill(text: "failed", tone: .danger)
            } else if lane.finalized.last?.finishReason != nil {
                CountPill(text: "done", tone: .neutral)
            }
        }
    }
}

/// One assistant turn: prompt, reasoning, answer, tools, diffs, error.
///
/// Prompt and answer share the SAME plain-text treatment — no per-message
/// avatar, no elevated card. Claude.ai renders both on the page background
/// with neither; the only differentiator here is a 2pt neutral rule at low
/// opacity on the assistant's answer — neutral, not accent: a static
/// per-message marker is none of the three things accent is rationed to
/// (selection / primary action / live state; see `DESIGN.md`). A round
/// avatar bubble next to every
/// single message is a consumer-chat-app tell (and, past the first turn,
/// carries no information position doesn't already give); a bordered card
/// around every answer is the reason this used to read as a stack of
/// distinct little boxes instead of one continuous conversation.
struct TurnView: View {
    @Environment(\.nexusTheme) private var theme
    let turn: Turn
    var showsReasoning = false
    var isStreaming = false
    /// Lane rendering: the prompt is suppressed (a fan-out run shows it once
    /// above all lanes — see `ConversationView.compareTranscript`) and turns
    /// sit closer together to fit a column.
    ///
    /// It no longer suppresses `attributionRow`. That was the single most
    /// self-defeating thing about Compare: the screen whose entire purpose is
    /// telling you WHICH backend said what was the one screen that dropped the
    /// provider label, the cost, and the copy button. Compare now renders
    /// identically to the single-lane transcript in every respect except the
    /// prompt.
    var compact = false
    /// The live token/cost counters, passed ONLY for a streaming turn.
    ///
    /// `ViewState.lastUsage`/`currentTurnCost` describe whatever ran most
    /// recently at conversation scope, not this turn specifically, so handing
    /// them to a settled turn would relabel finished history with the numbers
    /// from a later run. `Turn` carries no usage of its own yet, which is the
    /// one thing standing between this and §6.11's per-turn receipt.
    var liveUsage: ViewState?
    @State private var hoveringAnswer = false
    @State private var copied = false

    private var hasAnswerContent: Bool {
        !turn.text.isEmpty || !turn.tools.isEmpty || !turn.diffs.isEmpty || turn.error != nil || isStreaming
    }

    /// `"provider/model"`, or bare `provider` when no model was recorded —
    /// same shape as `UiEvent.Switch.Target.label`, so this reads as the same
    /// vocabulary as a switch receipt elsewhere in the transcript rather than
    /// a second, differently-worded convention.
    private var attributionLabel: String {
        guard let turnProvider = turn.provider else { return "assistant" }
        return turn.model.map { "\(turnProvider)/\($0)" } ?? turnProvider
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? Space.md : Space.xl) {
            if let prompt = turn.prompt, !compact {
                promptBlock(prompt)
            }
            if hasAnswerContent {
                answerBlock
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The user's own turn: a slab, inset from the leading edge and filled at
    /// level 2.
    ///
    /// It is deliberately NOT a bubble — no tail, no capsule, no saturated
    /// fill. Round coloured bubbles read as casual texting and undercut the
    /// tool framing, which is the one judgement the previous thesis got right
    /// and this keeps. But the previous treatment (bold 13pt body text, no
    /// container at all) failed the other half: with the assistant's answer
    /// set in the same 13pt a few points below it, the only thing telling the
    /// two apart was font weight, so the transcript read as one undifferentiated
    /// column. A filled, inset slab makes the alternation structural — you can
    /// see the shape of the conversation from across the room without reading
    /// a word of it, which is what "the transcript has rhythm" actually means.
    ///
    /// Inset from the leading edge rather than right-aligned to the measure:
    /// the answer below it starts at the column's left edge, and a prompt that
    /// began there too would give the eye no reason to register a new speaker.
    @ViewBuilder
    private func promptBlock(_ prompt: String) -> some View {
        HStack(spacing: 0) {
            Spacer(minLength: Space.xxl)
            Text(prompt)
                .textStyle(Type.prose)
                .foregroundStyle(theme.color(\.textPrimary))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, Space.xl)
                .padding(.vertical, Space.lg)
                .modifier(SpeakerSlab())
                // Capped well short of the full measure. Left to grow, a long
                // prompt filled the column edge to edge and stopped reading as
                // an inset block at all — it looked like a heading over the
                // answer rather than the other speaker's turn. The indent is
                // the entire signal, so it has to survive the longest prompt,
                // not just short ones.
                .frame(maxWidth: textColumnWidth * 0.78, alignment: .trailing)
        }
    }

    @ViewBuilder
    private var answerBlock: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            attributionRow
            innerContent
        }
        .onHover { hovering in
            hoveringAnswer = hovering
            if !hovering { copied = false }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Who answered — the app's signature line, and the assistant turn's
    /// entire role marker.
    ///
    /// This replaces a 2px grey rule in the left gutter. That rule was the
    /// only thing distinguishing an answer from a prompt, and it failed twice
    /// over: it carried no information (it was identical on every turn) and
    /// it was too quiet to read as deliberate, so the transcript looked like
    /// plain paragraphs with a stray line beside them.
    ///
    /// Attribution is shown on EVERY turn, not only when the provider changed
    /// mid-conversation as before. That earlier rule optimised for suppressing
    /// repetition, but repetition is exactly what a transcript needs: a
    /// recurring anchor at a fixed rhythm is what lets the eye find turn
    /// boundaries while scrolling. It also puts the product's whole premise —
    /// many interchangeable backends, always labelled — on the surface the
    /// user actually looks at, instead of only in the status bar.
    ///
    /// The copy control lives here rather than in an overlay on the prose or
    /// in a hover-revealed row beneath it. An overlay landed on top of the
    /// first line of text; a row beneath reflowed the answer every time the
    /// pointer entered. A dedicated row above the content can do neither.
    private var attributionRow: some View {
        HStack(spacing: Space.sm) {
            ProviderDot(provider: turn.provider, size: 7)
            Text(attributionLabel)
                .textStyle(Type.monoMicro)
                .foregroundStyle(theme.color(\.textSecondary))
            if turn.cacheHit == true {
                // A cache hit emits no `usage` event at all, so without this
                // the turn is indistinguishable from one whose cost tracking
                // failed. Saying so is the difference between "$0.00,
                // confirmed" and "cost unknown".
                Text("cached")
                    .textStyle(Type.monoMicro)
                    .foregroundStyle(theme.color(\.successFg))
            }
            Spacer(minLength: Space.sm)
            // Cost lives on the turn, not in the composer. Gated on
            // `streaming` down there, what a turn cost vanished the instant it
            // finished — the one moment the number becomes final and worth
            // keeping. Right-aligned and dimmed so it reads as a receipt on
            // the turn rather than a second label competing with the provider.
            if let liveUsage {
                UsageReadout(view: liveUsage)
            }
            if hoveringAnswer && !turn.text.isEmpty {
                copyButton
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Answer from \(attributionLabel)")
    }

    private var copyButton: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(turn.text, forType: .string)
            copied = true
        } label: {
            HStack(spacing: Space.xs) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 9, weight: .semibold))
                Text(copied ? "Copied" : "Copy")
            }
        }
        .buttonStyle(SoftButton(tone: .neutral, size: .compact))
        .help("Copy answer")
    }

    @ViewBuilder
    private var innerContent: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            if showsReasoning && !turn.reasoning.isEmpty {
                Text(turn.reasoning)
                    .font(Type.caption.font.italic())
                    .lineSpacing(3)
                    .foregroundStyle(theme.color(\.streamThinking))
                    .textSelection(.enabled)
            }

            if !turn.text.isEmpty {
                // Markdown, not literal text: the raw `**bold**`/`# heading`/
                // `- bullet` the user was staring at is exactly the bug this
                // renders. `MarkdownView` owns its own trailing caret (see
                // its doc comment) since a multi-block answer has no single
                // baseline to hang a plain `HStack` caret off of anymore.
                MarkdownView(text: turn.text, isStreaming: isStreaming)
            } else if isStreaming && turn.tools.isEmpty {
                ThinkingIndicator()
            }

            ForEach(turn.tools) { tool in
                ToolRow(tool: tool)
            }

            ForEach(Array(turn.diffs.enumerated()), id: \.offset) { _, diff in
                DiffCard(diff: diff)
            }

            if let error = turn.error {
                errorBlock(error)
            }
        }
    }

    /// A failed turn. Bordered as well as filled, unlike the old fill-only
    /// treatment: `errorBg` is a very dark wash on most themes, so on its own
    /// it barely separated from the canvas and a failure could be scrolled
    /// past without registering.
    @ViewBuilder
    private func errorBlock(_ error: TurnError) -> some View {
        HStack(alignment: .top, spacing: Space.md) {
            Image(systemName: "exclamationmark.octagon.fill")
                .foregroundStyle(theme.color(\.errorFg))
                .font(.system(size: 12))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(error.code)
                    .textStyle(Type.monoMicro)
                Text(error.message)
                    .textStyle(Type.caption)
                    .fixedSize(horizontal: false, vertical: true)
                if error.retryable {
                    Text("retryable")
                        .textStyle(Type.monoMicro)
                        .foregroundStyle(theme.color(\.warningFg))
                        .padding(.top, 1)
                }
            }
            .foregroundStyle(theme.color(\.errorFg))
            Spacer(minLength: 0)
        }
        .padding(Space.lg)
        .background(theme.color(\.errorBg), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.errorBorder).opacity(0.55), lineWidth: 1)
        }
    }
}

/// One `switch` control-line outcome, rendered inline in the transcript at
/// the point it happened — chronologically merged with turns by
/// `ViewState.timeline(forLane:)`, never a transient toast pinned to the
/// composer: a blocked switch is real, permanent history exactly like a
/// turn is, and must survive scrollback the same way.
///
/// Two registers, matching this file's existing vocabulary for "caveat over
/// real content" vs "the thing itself failed" (`InlineBanner`/`ErrorState`
/// in `DesignSystem.swift`): a REFUSED switch is unmissable — full-width,
/// error-toned, `blockers` shown verbatim, because the specific reason is
/// the entire value of a refusal a user would otherwise read as silence. An
/// ACCEPTED switch is the opposite: the conversation underneath did not
/// change shape, so this is one quiet line, not a card.
struct SwitchReceiptView: View {
    @Environment(\.nexusTheme) private var theme
    let receipt: SwitchReceipt

    var body: some View {
        if receipt.accepted {
            acceptedRow
        } else {
            blockedCard
        }
    }

    // MARK: - Accepted

    /// A hairline across the measure, broken by a centred chip naming the two
    /// endpoints.
    ///
    /// This was a 22-word sentence at `Type.caption` that wrapped to two lines
    /// and so outweighed the attribution row of the turn above it — a
    /// successful switch, the least eventful thing in the transcript, drawn
    /// heavier than the answers around it. It also carried a stray
    /// `.padding(.leading, Space.md)` that aligned it to nothing: not the
    /// prose, not the slab, not the gutter.
    ///
    /// A rule broken by a chip is the conventional typographic mark for "the
    /// document continues, under new conditions", and it states the one fact
    /// that matters — from what, to what — at a weight matching how much the
    /// reader needs to care. The caveat about what carries over is real and
    /// kept verbatim, but it answers a question the reader only sometimes
    /// asks, so it moves to the tooltip.
    private var acceptedRow: some View {
        HStack(spacing: Space.md) {
            rule
            HStack(spacing: Space.xs) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 9))
                Text(receipt.from.label)
                Image(systemName: "arrow.right")
                    .font(.system(size: 8, weight: .bold))
                Text(receipt.to.label)
            }
            .textStyle(Type.monoMicro)
            .foregroundStyle(theme.color(\.textMuted))
            .lineLimit(1)
            .fixedSize()
            rule
        }
        .frame(maxWidth: .infinity)
        .help(caveat)
    }

    private var rule: some View {
        Rectangle()
            .fill(theme.color(\.chromeDivider))
            .frame(height: 1)
    }

    /// The exact wording `SwitchReceipt.preserved`'s doc comment asks for —
    /// honest about what carries over and what never did (tool-call history
    /// isn't in the transcript at ANY turn boundary, switch or not), rather
    /// than a bare "done" that implies more than it should. Non-fatal
    /// warnings join it here rather than rendering as their own row: on an
    /// ACCEPTED switch the conversation underneath did not change shape, so
    /// nothing here has earned space in the column.
    private var caveat: String {
        var parts = ["Conversation and context carried over; tool-call history is not (never was, any turn boundary)."]
        parts.append(contentsOf: receipt.warnings)
        return parts.joined(separator: "\n")
    }

    // MARK: - Blocked

    private var blockedCard: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .top, spacing: Space.sm) {
                Image(systemName: "exclamationmark.octagon.fill")
                    .font(.system(size: 12))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Switch to \(receipt.to.label) blocked")
                        .font(.system(size: 12, weight: .semibold))
                    Text("Staying on \(receipt.from.label).")
                        .textStyle(Type.caption)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(theme.color(\.errorFg))

            // Verbatim, one per line — never summarised into a generic
            // "switch failed": the specific reason IS the value of a
            // refusal (see `SwitchReceipt.blockers`'s doc).
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(receipt.blockers.enumerated()), id: \.offset) { _, blocker in
                    HStack(alignment: .top, spacing: 6) {
                        Text("•")
                        Text(blocker).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .textStyle(Type.caption)
            .foregroundStyle(theme.color(\.errorFg).opacity(0.9))

            if !receipt.warnings.isEmpty {
                warningsList(receipt.warnings)
            }
        }
        .padding(Space.md)
        .background(theme.color(\.errorBg))
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(theme.color(\.errorBorder), lineWidth: 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Shared

    /// Non-fatal caveats either way (e.g. "requires compaction") — visible,
    /// but deliberately calmer than `blockers`: smaller type, warning (not
    /// error) tone, no bullet competing for attention.
    @ViewBuilder
    private func warningsList(_ warnings: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
                Text(warning).fixedSize(horizontal: false, vertical: true)
            }
        }
        .textStyle(Type.micro)
        .foregroundStyle(theme.color(\.warningFg).opacity(0.85))
        .padding(.leading, Space.lg)
    }
}

/// One file's patch, as a card in the same family as `ToolRow` (§6.9).
///
/// What this replaces was a bare path label above a `CodeBlock` — and
/// `CodeBlock` is a `ScrollView([.horizontal, .vertical])` capped at 300pt.
/// Nesting a bidirectional scroll view inside the transcript's own scroll view
/// has two specific consequences on macOS: a trackpad gesture that begins over
/// the patch is captured by the inner view, so the transcript stops scrolling
/// under the pointer for no visible reason; and the 300pt cap guillotines the
/// patch mid-line with no indication of how much is below.
///
/// A card fixes both by not competing. The body scrolls in NO direction: long
/// lines wrap, and the line count is capped with a stated remainder the reader
/// can lift. The same chevron affordance as `ToolRow` is deliberate — a diff
/// and a tool call are both "something the model did, expandable", and they
/// should read as one family rather than two conventions.
private struct DiffCard: View {
    @Environment(\.nexusTheme) private var theme
    /// Optional because `TurnView` is rendered wherever a transcript is, and
    /// binding a hard requirement on `WorkspaceModel` here would make the view
    /// uninstantiable outside the one tree that provides it. `Open` is simply
    /// withheld when there is no project to resolve a relative path against.
    @Environment(WorkspaceModel.self) private var workspace: WorkspaceModel?
    let diff: TurnDiff
    @State private var expanded = true
    @State private var showingAllLines = false

    private var lines: [String] {
        diff.patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    /// `+41 −7`, counted off the patch body. Hunk headers (`@@`) and the
    /// `+++`/`---` file markers are excluded — they start with the same
    /// characters but are not changed lines, and counting them inflates every
    /// diff by two.
    private var stats: (added: Int, removed: Int) {
        lines.reduce(into: (0, 0)) { counts, line in
            if line.hasPrefix("+") && !line.hasPrefix("+++") { counts.0 += 1 }
            if line.hasPrefix("-") && !line.hasPrefix("---") { counts.1 += 1 }
        }
    }

    private var resolvedURL: URL? {
        guard let root = workspace?.projectDirectory else { return nil }
        return root.appendingPathComponent(diff.path)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded { body(for: showingAllLines ? lines : Array(lines.prefix(Self.lineCap))) }
        }
        // Rises one rung off the canvas, same rule as `ToolRow` — see §6.4.
        // The patch text INSIDE it is machine output nested in a raised
        // object, so that recesses to `surfaceInset`; the two together are
        // what make a diff read as a card holding a code well rather than as
        // two unrelated rectangles.
        .background(theme.surface(2), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        // The nested code well is a full-bleed rectangle, so without this it
        // squares off the card's own bottom corners.
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
    }

    private var header: some View {
        HStack(spacing: Space.sm) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: Space.sm) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(theme.color(\.textMuted))
                    pathLabel
                    Spacer(minLength: Space.md)
                    Text("+\(stats.added)")
                        .foregroundStyle(theme.color(\.diffAddedFg))
                    Text("−\(stats.removed)")
                        .foregroundStyle(theme.color(\.diffRemovedFg))
                }
                .textStyle(Type.monoMicro)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let resolvedURL {
                Button("Open") { NSWorkspace.shared.open(resolvedURL) }
                    .buttonStyle(.plain)
                    .textStyle(Type.micro)
                    .foregroundStyle(theme.color(\.textLink))
                    .help("Open \(diff.path)")
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, 7)
    }

    /// Leading directories dimmed, filename at full contrast. The filename is
    /// what identifies the change; the path to it is context, and setting both
    /// at one weight made every diff header read as an undifferentiated run of
    /// mono text.
    private var pathLabel: some View {
        let parts = diff.path.split(separator: "/").map(String.init)
        let file = parts.last ?? diff.path
        let prefix = parts.dropLast().joined(separator: "/")
        return HStack(spacing: 0) {
            if !prefix.isEmpty {
                Text(prefix + "/")
                    .foregroundStyle(theme.color(\.textMuted))
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Text(file)
                .foregroundStyle(theme.color(\.textPrimary))
                .lineLimit(1)
                .layoutPriority(1)
        }
    }

    private func body(for shown: [String]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .textStyle(Type.mono)
                        .foregroundStyle(color(for: line))
                        .textSelection(.enabled)
                        // Wraps rather than scrolling sideways. A wrapped
                        // continuation is unambiguous in a diff — it cannot be
                        // mistaken for a changed line, because it carries no
                        // +/- marker of its own.
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.color(\.surfaceInset))

            if !showingAllLines && lines.count > Self.lineCap {
                Button("Show \(lines.count - Self.lineCap) more lines") { showingAllLines = true }
                    .buttonStyle(.plain)
                    .textStyle(Type.micro)
                    .foregroundStyle(theme.color(\.textLink))
                    .padding(.horizontal, Space.lg)
                    .padding(.bottom, Space.md)
            }
        }
    }

    private func color(for line: String) -> Color {
        if line.hasPrefix("+") { return theme.color(\.diffAddedFg) }
        if line.hasPrefix("-") { return theme.color(\.diffRemovedFg) }
        if line.hasPrefix("@@") { return theme.color(\.diffGutter) }
        return theme.color(\.diffContext)
    }

    private static let lineCap = 20
}

/// Where the transcript is scrolled to, assembled from two separate geometry
/// reads (§6.7).
///
/// The content probe knows the content's height and how far it has been pushed
/// up; the viewport probe knows the visible height. Neither knows the other, so
/// they publish through one preference and `reduce` merges them — each probe
/// contributes zeros for the field it cannot see, so the merge is a plain sum
/// and does not depend on which probe reports first.
///
/// Both probes live in `.background`, which is the property that makes this
/// safe: a background takes its size FROM its parent and never contributes to
/// the parent's own sizing, so measuring the transcript here cannot feed back
/// into laying the transcript out.
private struct TranscriptMetrics: Equatable {
    var contentHeight: CGFloat = 0
    var offset: CGFloat = 0
    var viewportHeight: CGFloat = 0

    /// How far the bottom of the content sits below the bottom of the
    /// viewport. Clamped at zero: content shorter than the viewport is
    /// trivially "at the tail", and a negative distance would otherwise read
    /// as scrolled-past-the-end.
    var distanceFromBottom: CGFloat {
        max(0, contentHeight - viewportHeight - offset)
    }
}

private struct TranscriptMetricsKey: PreferenceKey {
    static let defaultValue = TranscriptMetrics()

    static func reduce(value: inout TranscriptMetrics, nextValue: () -> TranscriptMetrics) {
        let next = nextValue()
        value.contentHeight += next.contentHeight
        value.offset += next.offset
        value.viewportHeight += next.viewportHeight
    }
}

/// A blinking caret — motion that means exactly one thing: this turn is still
/// producing text right now. Not `private`: `Markdown.swift` reuses it to cap
/// off a streaming markdown answer, wherever in the block structure that
/// answer currently ends.
struct StreamingCaret: View {
    @Environment(\.nexusTheme) private var theme
    @State private var dim = false

    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(theme.color(\.streamCursor))
            // 2.5pt, down from 6. At 6pt this was a terminal block cursor —
            // wider than the stems of the 15pt prose it sits against, so it
            // read as a filled rectangle punctuating the sentence rather than
            // as a caret continuing it. A caret should be about the weight of
            // the strokes around it.
            .frame(width: 2.5, height: 14)
            .opacity(dim ? 0.15 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) {
                    dim = true
                }
            }
    }
}

/// Shown before the first token of a turn arrives — a caret has nothing to
/// ride yet, so this is the "the model is working" tell instead.
private struct ThinkingIndicator: View {
    @Environment(\.nexusTheme) private var theme
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(theme.color(\.streamThinking))
                    .frame(width: 5, height: 5)
                    .opacity(pulse ? 1 : 0.25)
                    .animation(
                        .easeInOut(duration: 0.6).repeatForever().delay(Double(index) * 0.15),
                        value: pulse
                    )
            }
        }
        .onAppear { pulse = true }
    }
}

/// A tool invocation — collapsed to one line, expandable to its arguments and
/// result. Structure is preserved end to end, so this can show the real payload
/// rather than a stringified summary.
struct ToolRow: View {
    @Environment(\.nexusTheme) private var theme
    let tool: ToolActivity
    @State private var expanded = false
    @State private var hovering = false
    /// Whether the 20-line payload cap has been lifted for this row. Per-row
    /// and non-persistent on purpose: lifting it is a decision about one
    /// output you are looking at now, not a preference.
    @State private var showingFullPayload = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: Space.sm) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(theme.color(\.textMuted))
                    StatusDot(isRunning: tool.status == .running, isFailed: tool.status == .error, size: 6)
                    Text(tool.name)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(theme.color(\.textPrimary))
                    if let subtitle = ToolSummary.arguments(name: tool.name, args: tool.args) {
                        Text(subtitle)
                            .textStyle(Type.monoMicro)
                            .foregroundStyle(theme.color(\.textMuted))
                            .lineLimit(1)
                            // `.middle`: these are paths, and a path's two
                            // ends (the repo-relative root and the filename)
                            // are what identify it. Tail-truncating
                            // `Sources/NexusApp/Features/ConversationView
                            // .swift` throws away the only part anyone reads.
                            .truncationMode(.middle)
                    }
                    if let outcome = ToolSummary.outcome(tool) {
                        Spacer(minLength: Space.md)
                        Text(outcome.text)
                            .textStyle(Type.monoMicro)
                            .foregroundStyle(outcome.failed ? theme.color(\.errorFg) : theme.color(\.textMuted))
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }

            if expanded {
                VStack(alignment: .leading, spacing: Space.md) {
                    if let args = tool.args {
                        argumentsSection(args)
                    }
                    if let result = tool.result {
                        payloadSection(
                            "result",
                            ToolSummary.plainText(result),
                            // A command's interesting output is at the END
                            // (the error, the summary line, the prompt it
                            // returned to); a file read's is at the START.
                            // One rule for both directions gets one of them
                            // wrong every time.
                            keepingTail: ToolSummary.isCommandLike(tool.name)
                        )
                    }
                }
                .padding(.horizontal, Space.lg)
                .padding(.bottom, Space.lg)
            }
        }
        // Sized to its own content rather than stretched across the reading
        // measure. A collapsed tool call is three or four words; spanning it
        // edge to edge drew a wide empty rectangle through the middle of the
        // answer and broke the column's vertical flow for no information.
        .fixedSize(horizontal: !expanded, vertical: false)
        // RISES off the canvas, rather than recessing into it (§6.4).
        //
        // Measured, a tool row sat at `#111218` under a `#14161C` canvas — it
        // sank. The transcript therefore ran in two directions at once: the
        // user slab rose, the tool row sank, the code well inside it sank
        // further, and the canvas ended up the lightest large surface on
        // screen. One rule instead: an object distinct from the canvas rises
        // one rung, and only machine output NESTED inside such an object
        // recesses (which is what the expanded payload below still does).
        .background(
            hovering ? theme.color(\.surfaceOverlay) : theme.surface(2),
            in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
        .animation(Motion.state, value: hovering)
    }

    /// Arguments as a small key/value table, not a JSON blob in a code well.
    ///
    /// A tool call's arguments are a handful of short named values — that is a
    /// table, and rendering it as pretty-printed JSON inside a `CodeBlock`
    /// spent a scrolling container and four lines of braces to show two facts.
    /// Falls back to the raw encoding only for the shapes a table genuinely
    /// cannot express (a bare array, a nested object).
    @ViewBuilder
    private func argumentsSection(_ args: JSONValue) -> some View {
        if case .object(let fields) = args, !fields.isEmpty, fields.values.allSatisfy(ToolSummary.isScalar) {
            VStack(alignment: .leading, spacing: 3) {
                sectionLabel("args")
                // Emitted order is not recoverable from a Swift dictionary, so
                // this sorts — but by SALIENCE, not alphabetically. `path`
                // before `limit` is the difference between reading the
                // argument list and decoding it. (The old code used
                // `.sortedKeys`, which put `limit` first for every file read
                // in the transcript.)
                ForEach(ToolSummary.orderedKeys(fields), id: \.self) { key in
                    HStack(alignment: .top, spacing: Space.sm) {
                        Text(key)
                            .textStyle(Type.monoMicro)
                            .foregroundStyle(theme.color(\.textMuted))
                            .frame(width: 72, alignment: .leading)
                        Text(fields[key]?.inlineDescription ?? "")
                            .textStyle(Type.monoMicro)
                            .foregroundStyle(theme.color(\.textSecondary))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        } else {
            payloadSection("args", ToolSummary.plainText(args), keepingTail: false)
        }
    }

    /// A capped payload with an honest footer saying what was withheld.
    ///
    /// The cap is the point: a 4,000-line command output rendered in full
    /// inside the transcript buries every turn after it, and the old
    /// `CodeBlock` "solved" that with a nested scroll view that stole
    /// trackpad momentum from the transcript's own. Twenty lines plus a
    /// stated count is the honest version — you can always see how much you
    /// are not being shown, and lift the cap deliberately.
    @ViewBuilder
    private func payloadSection(_ label: String, _ text: String, keepingTail: Bool) -> some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let capped = showingFullPayload || lines.count <= Self.payloadLineCap
        let shown = capped
            ? lines
            : (keepingTail ? Array(lines.suffix(Self.payloadLineCap)) : Array(lines.prefix(Self.payloadLineCap)))

        VStack(alignment: .leading, spacing: 3) {
            sectionLabel(label)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : line)
                        .textStyle(Type.monoMicro)
                        .foregroundStyle(theme.color(\.textSecondary))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.sm)
            .background(theme.color(\.surfaceInset), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))

            if !capped {
                HStack(spacing: Space.md) {
                    Text("Showing \(keepingTail ? "last" : "first") \(Self.payloadLineCap) of \(lines.count) lines")
                    Button("Show all") { showingFullPayload = true }
                        .buttonStyle(.plain)
                        .foregroundStyle(theme.color(\.textLink))
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(theme.color(\.textLink))
                }
                .textStyle(Type.micro)
                .foregroundStyle(theme.color(\.textMuted))
            }
        }
    }

    private func sectionLabel(_ label: String) -> some View {
        Text(label.uppercased())
            .textStyle(Type.micro)
            .tracking(0.5)
            .foregroundStyle(theme.color(\.textMuted))
    }

    private static let payloadLineCap = 20
}

/// How a tool call reads as one line: which of its arguments is the fact worth
/// showing, and what its result amounted to.
///
/// This replaces `JSONValue.inlineDescription` at the `ToolRow` call site,
/// which returned `fields.keys.sorted().prefix(3)` — so a file read rendered
/// as `read_file {limit, path}`. That is a description of the SHAPE of the
/// arguments, and by construction it can never show a value: the one fact a
/// reader wants from a tool row (which file? which command?) was the one fact
/// it was structurally incapable of printing.
///
/// `inlineDescription` itself is untouched and still right for what it does —
/// summarising an arbitrary payload of unknown shape. This is the per-tool
/// knowledge that call site needed and it did not have.
private enum ToolSummary {
    /// The salient argument VALUE for a known tool, or a key summary for one
    /// this does not recognise. Unknown tools keep the old behaviour rather
    /// than guessing at a field name — a wrong value shown confidently is
    /// worse than an honest shape.
    static func arguments(name: String, args: JSONValue?) -> String? {
        guard let args else { return nil }
        switch normalised(name) {
        case "read_file", "read", "open_file", "view":
            return args["path"]?.stringValue ?? args["file"]?.stringValue ?? args.inlineDescription
        case "bash", "shell", "run", "exec", "run_command", "terminal":
            return (args["command"]?.stringValue ?? args["cmd"]?.stringValue).map(firstLine)
                ?? args.inlineDescription
        case "edit", "write", "write_file", "str_replace", "apply_patch", "create_file":
            return args["path"]?.stringValue ?? args["file"]?.stringValue ?? args.inlineDescription
        case "grep", "search", "ripgrep", "search_files":
            return args["pattern"]?.stringValue ?? args["query"]?.stringValue ?? args.inlineDescription
        case "web_fetch", "fetch", "http", "curl":
            return (args["url"]?.stringValue).map(host) ?? args.inlineDescription
        case "glob", "list_files", "ls":
            return args["pattern"]?.stringValue ?? args["path"]?.stringValue ?? args.inlineDescription
        default:
            return args.inlineDescription
        }
    }

    /// The right-hand fact: what the call amounted to. `nil` while a call is
    /// still running — an outcome that has not happened yet is not a blank,
    /// it is absent.
    ///
    /// Duration belongs here too per §6.5's sketch, and is deliberately not
    /// faked: `ToolActivity` carries `id`/`name`/`args`/`status`/`result` and
    /// no timestamps at all, so there is nothing to compute one from. See the
    /// report.
    static func outcome(_ tool: ToolActivity) -> (text: String, failed: Bool)? {
        if tool.status == .running { return nil }
        if tool.status == .error { return ("failed", true) }
        guard let result = tool.result else { return nil }

        if let code = result["exitCode"]?.intValue ?? result["exit_code"]?.intValue {
            return ("exit \(code)", code != 0)
        }
        if let matches = result["matches"]?.arrayValue?.count {
            return ("\(matches) \(matches == 1 ? "match" : "matches")", false)
        }
        let text = plainText(result)
        guard !text.isEmpty else { return nil }
        let count = text.split(separator: "\n", omittingEmptySubsequences: false).count
        return ("\(count) \(count == 1 ? "line" : "lines")", false)
    }

    /// Whether this tool's output reads bottom-up. See `payloadSection`.
    static func isCommandLike(_ name: String) -> Bool {
        ["bash", "shell", "run", "exec", "run_command", "terminal"].contains(normalised(name))
    }

    /// Argument keys in reading order: the identifying value first, its
    /// modifiers after, anything unrecognised last but still alphabetical so
    /// the order is at least stable.
    static func orderedKeys(_ fields: [String: JSONValue]) -> [String] {
        let salient = ["path", "file", "command", "cmd", "pattern", "query", "url"]
        let known = salient.filter { fields.keys.contains($0) }
        let rest = fields.keys.filter { !salient.contains($0) }.sorted()
        return known + rest
    }

    static func isScalar(_ value: JSONValue) -> Bool {
        switch value {
        case .object, .array: return false
        default: return true
        }
    }

    /// A payload as readable text. A tool result is very often already a
    /// string (or the CLI's `[{type:"text", text:…}]` content-block array), and
    /// re-encoding that as JSON just to display it wraps real output in quotes
    /// and escapes every newline into a literal `\n`.
    static func plainText(_ value: JSONValue) -> String {
        if let string = value.stringValue { return string }
        if let items = value.arrayValue {
            let texts = items.compactMap { $0["text"]?.stringValue }
            if texts.count == items.count, !texts.isEmpty { return texts.joined(separator: "\n") }
        }
        if let text = value["text"]?.stringValue { return text }
        if let content = value["content"], let text = content.stringValue { return text }

        let encoder = JSONEncoder()
        // No `.sortedKeys`: it destroys the order the CLI emitted, which is
        // the order the tool's own author chose to present its fields in.
        encoder.outputFormatting = [.prettyPrinted]
        guard let data = try? encoder.encode(value),
              let text = String(data: data, encoding: .utf8)
        else { return value.inlineDescription }
        return text
    }

    private static func normalised(_ name: String) -> String {
        name.lowercased().split(separator: "-").joined(separator: "_")
    }

    private static func firstLine(_ command: String) -> String {
        let line = command.split(separator: "\n").first.map(String.init) ?? command
        return line.count > 60 ? String(line.prefix(60)) + "…" : line
    }

    private static func host(_ url: String) -> String {
        URL(string: url)?.host ?? url
    }
}

/// stderr from the CLI, already triaged by `DiagnosticClassifier` — a raw line
/// never reaches this view untriaged. Surfaced rather than swallowed, so a
/// launch failure or a genuine provider problem is visible instead of
/// manifesting as an empty answer, but each line renders in the tone its own
/// classification earned: `.warning` keeps the amber treatment every
/// diagnostic used to get regardless of content; `.quiet` gets a calm,
/// informational one, so amber only ever appears when something is actually
/// wrong.
struct DiagnosticsStrip: View {
    @Environment(\.nexusTheme) private var theme
    let notes: [DiagnosticPresentation]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(Array(notes.suffix(3).enumerated()), id: \.offset) { _, note in
                row(for: note)
            }
        }
    }

    @ViewBuilder
    private func row(for note: DiagnosticPresentation) -> some View {
        switch note {
        // The controller already drops `.hidden` lines before they reach
        // `presentedDiagnostics`; handled here too so this view stays correct
        // even if a future caller feeds it an unfiltered list.
        case .hidden:
            EmptyView()
        case .quiet(let text):
            line(text, icon: "info.circle", fg: theme.color(\.infoFg), bg: theme.color(\.infoBg))
        case .warning(let text):
            line(text, icon: "exclamationmark.triangle", fg: theme.color(\.warningFg), bg: theme.color(\.warningBg))
        }
    }

    private func line(_ text: String, icon: String, fg: Color, bg: Color) -> some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(fg.opacity(0.85))
            Text(text)
                .textStyle(Type.monoMicro)
                .foregroundStyle(fg.opacity(0.85))
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 6)
        .background(bg.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}
