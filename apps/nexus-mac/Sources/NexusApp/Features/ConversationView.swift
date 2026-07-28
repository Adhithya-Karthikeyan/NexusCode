import SwiftUI
import AppKit
import NexusKit

/// The comfortable reading measure the transcript AND the composer are both
/// capped to. One shared constant, not two repeated `660`s: the composer sits
/// directly beneath the transcript column and IS where the next message in
/// it will appear, so drifting the two independently is how you get a
/// composer floating ~165pt away from the text it's replying to — measured,
/// not hypothetical, at the default 1280pt window before this existed.
private let readingColumnWidth: CGFloat = 660

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
    var onLoadModels: (String) -> Void = { _ in }

    init(
        controller: ConversationController,
        providers: [PickerOption] = [],
        models: [PickerOption] = [],
        isLoadingModels: Bool = false,
        onLoadModels: @escaping (String) -> Void = { _ in }
    ) {
        self.controller = controller
        self.providers = providers
        self.models = models
        self.isLoadingModels = isLoadingModels
        self.onLoadModels = onLoadModels
    }

    var body: some View {
        transcript
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Both bars are safe-area insets, not VStack siblings. An inset
            // shrinks the area the transcript lays out against, so neither bar
            // can be squeezed out by a greedy transcript — the failure that hid
            // the composer and control strip entirely.
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    ControlStrip(
                        controller: controller,
                        showsReasoning: $showsReasoning,
                        providers: providers,
                        models: models,
                        isLoadingModels: isLoadingModels,
                        onLoadModels: onLoadModels,
                        rolesController: rolesController
                    )
                    Divider().overlay(theme.color(\.chromeDivider))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composer
            }
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
            .task(id: workspace.projectDirectory) { await loadRoles() }
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

    private var laneOrder: [LaneState] { controller.view.orderedLanes }

    /// Lane ids to actually render. See `ViewState.visibleLaneIds`'s doc for
    /// why this is not simply `laneOrder`: a `switch` receipt can exist for a
    /// lane with no `LaneState` at all, and must still render somewhere
    /// rather than vanish behind the empty-state hero.
    private var visibleLaneIds: [String] { controller.view.visibleLaneIds }

    @ViewBuilder
    private var transcript: some View {
        if visibleLaneIds.isEmpty {
            // Bottom-anchored, not centered: `.fixedSize` collapses the
            // empty state to its own intrinsic height, and bottom-alignment
            // then settles it just above the composer, reading as one
            // column instead of two objects floating at opposite ends of
            // the window. That relationship is deliberately kept here — see
            // `emptyState`'s doc comment for how the void ABOVE it (the
            // remaining problem once this was fixed) gets addressed: by
            // giving this region a genuinely larger, more purposeful
            // composition rather than by moving it back toward centre.
            emptyState
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, Space.xxl)
        } else if controller.mode.isMultiLane && laneOrder.count > 1 {
            // Fan-out: one column per lane, so answers are compared, not scrolled.
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: Space.md) {
                    ForEach(laneOrder) { lane in
                        LaneColumn(lane: lane, showsReasoning: showsReasoning)
                            .frame(width: 400)
                    }
                }
                .padding(Space.lg)
            }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    // 24pt between turns, not `Space.lg` (12pt) — that scale is
                    // HIG's WITHIN-a-control-group spacing; reusing it between
                    // whole turns is what made the transcript read as a solid
                    // wall of text rather than a sequence of distinct answers.
                    LazyVStack(alignment: .leading, spacing: 24) {
                        ForEach(visibleLaneIds, id: \.self) { laneId in
                            ForEach(controller.view.timeline(forLane: laneId)) { entry in
                                switch entry {
                                case .turn(let turn, let isLive):
                                    TurnView(
                                        turn: turn, showsReasoning: showsReasoning, isStreaming: isLive,
                                        currentProvider: controller.view.session?.provider
                                    )
                                    .id(turn.id)
                                case .providerSwitch(let receipt):
                                    SwitchReceiptView(receipt: receipt)
                                        .id(receipt.id)
                                }
                            }
                        }
                    }
                    .padding(Space.xl)
                    // Capped and centered instead of stretched edge-to-edge —
                    // past roughly 70 characters a line gets hard to track
                    // back to its own start on a wide window, the "comfortable
                    // measure" every typographic source agrees on regardless
                    // of house style.
                    .frame(maxWidth: readingColumnWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: controller.view.eventCount) {
                    // Anchor on the turn's own (deterministic) id rather than a
                    // fixed "live" id — that id stops existing the instant a turn
                    // finalizes, which would silently stop the auto-scroll on
                    // exactly the event (`done`) that most needs it.
                    guard let anchor = scrollAnchor else { return }
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(anchor, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var scrollAnchor: String? {
        guard let laneId = visibleLaneIds.last else { return nil }
        return controller.view.timeline(forLane: laneId).last?.id
    }

    private static let suggestions: [(icon: String, text: String)] = [
        ("text.book.closed", "Explain this codebase"),
        ("arrow.triangle.branch", "Review my staged diff"),
        ("arrow.left.arrow.right", "Compare two models on one prompt"),
        ("ladybug", "Find the bug in the last commit"),
    ]

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

    /// Deliberately more substantial than a lone glyph in a void.
    ///
    /// This used to be a generic icon-in-a-glow-circle — the single most
    /// template-looking element in the app, and (see `transcript`'s doc
    /// comment) too small a composition to keep the region above it from
    /// reading as a large, unexplained empty band. `ChatHeroMark` replaces
    /// the glow with something specific to THIS product: a live echo of the
    /// exact `nexus <mode>` invocation the control strip above is currently
    /// configured to run, in the same monospace/caret language the
    /// composer's command preview and the transcript's streaming cursor
    /// already use — so it reads as "this app always shows you the real
    /// command" rather than "generic AI chat icon."
    ///
    /// The suggestions below grow from a single row of small capsules into a
    /// labelled, full-width LIST rather than a compact grid — measured
    /// against the actual window (see the doc comment on `transcript`), a
    /// 2x2 grid of small cards still left roughly half the transcript
    /// region a bare void above a small huddle of controls. A one-per-row
    /// list at the reading-column measure is real, legible content (each
    /// suggestion gets room to breathe, not a filler decoration) that
    /// genuinely occupies the space instead of merely gesturing at
    /// occupying it.
    private var emptyState: some View {
        VStack(spacing: Space.xxl) {
            ChatHeroMark(mode: controller.mode)

            VStack(spacing: Space.sm) {
                Text(heroTitle)
                    .font(Kind.hero)
                    .foregroundStyle(theme.color(\.textPrimary))
                Text(heroMessage)
                    .font(Kind.body)
                    .foregroundStyle(theme.color(\.textMuted))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 430)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: Space.sm) {
                Text("TRY ASKING")
                    .font(Kind.section)
                    .tracking(0.7)
                    .foregroundStyle(theme.color(\.textMuted))

                VStack(spacing: Space.sm) {
                    suggestionCard(0)
                    suggestionCard(1)
                    suggestionCard(2)
                    suggestionCard(3)
                }
            }
            .frame(maxWidth: readingColumnWidth)

            HStack(spacing: Space.lg) {
                KeyHint(keys: "⌘N", label: "new")
                KeyHint(keys: "⌘.", label: "stop")
                KeyHint(keys: "⏎", label: "send")
            }
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity)
    }

    private func suggestionCard(_ index: Int) -> some View {
        let suggestion = Self.suggestions[index]
        return SuggestionCard(icon: suggestion.icon, text: suggestion.text) {
            fillComposer(with: suggestion.text)
        }
    }

    /// Suggestions fill the composer rather than submitting immediately — the
    /// user should see (and can edit) exactly what they're about to run, same as
    /// every other path to a `nexus` invocation in this app.
    private func fillComposer(with text: String) {
        draft = text
        composerFocused = true
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if !controller.presentedDiagnostics.isEmpty {
                DiagnosticsStrip(notes: controller.presentedDiagnostics)
            }

            if controller.view.streaming {
                UsageReadout(view: controller.view)
            }

            composerCard

            // The exact command this will run — the UI never hides the CLI.
            HStack(spacing: Space.sm) {
                Image(systemName: "terminal")
                    .font(.system(size: 9))
                Text(commandPreview)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                if controller.mode.isMultiLane && controller.backends.count < 2 {
                    Text("add at least 2 backends")
                        .foregroundStyle(theme.color(\.warningFg))
                }
            }
            .font(Kind.monoSmall)
            .foregroundStyle(theme.color(\.textMuted))
        }
        .padding(Space.md)
        // Capped to `readingColumnWidth` — the SAME measure the transcript
        // above it is capped to, so the composer sits directly under the
        // text it's replying to instead of floating in its own gutter. Only
        // the CONTENT is capped; the sunken background band and top divider
        // stay full-bleed on purpose. A full-width toolbar/input BAND is
        // ordinary chrome (menu bars and browser toolbars span the window
        // constantly); it's the INPUT ITSELF drifting out of alignment with
        // the column above it that read as two unrelated layouts stacked.
        .frame(maxWidth: readingColumnWidth, alignment: .leading)
        .frame(maxWidth: .infinity)
        .background(theme.color(\.surfaceSunken))
        .overlay(alignment: .top) {
            Rectangle().fill(theme.color(\.chromeDivider)).frame(height: 1)
        }
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
        HStack(alignment: .bottom, spacing: Space.sm) {
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
                .lineLimit(1...8)
                .font(Kind.body)
                .foregroundStyle(theme.color(\.textPrimary))
                .focused($composerFocused)
                .onSubmit(send)

            composerButton
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm + 2)
        .background {
            themedFill(theme.color(\.surfaceRaised), treatment: theme.materials.composer, in: Rectangle())
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(
                    composerFocused ? theme.color(\.chromeBorderFocus) : theme.color(\.chromeBorderSubtle),
                    lineWidth: composerFocused ? 2 : 1
                )
        }
        .shadow(
            color: composerFocused
                ? theme.color(\.accentDefault).opacity(theme.isDark ? 0.3 : 0.16)
                : .clear,
            radius: 12, y: 3
        )
        .animation(.easeOut(duration: 0.15), value: composerFocused)
    }

    @ViewBuilder
    private var composerButton: some View {
        if controller.isRunning {
            Button(action: controller.cancel) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(SoftButton(tone: .danger))
            .help("Stop the run (⌘.)")
        } else {
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(SoftButton(tone: canSend ? .accent : .neutral))
            .disabled(!canSend)
            .help("Send (⏎)")
        }
    }

    private var canSend: Bool {
        controller.canSubmit && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var commandPreview: String {
        // No special-casing here: this is the exact same array the real spawn
        // builds from (`plannedCommand`), not a second copy that can drift
        // from it. The app never appends `--effort` (removed per the owner's
        // direction — see `runConfigGroup`'s doc), so the provider's own
        // configured effort governs whatever this preview shows.
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

/// Mode, provider/model or backends, the approval indicator, and the
/// reasoning-TRACES toggle — grouped by what they actually MEAN, not just
/// placed left to right in declaration order.
///
/// Three categories, in this order: what the run IS (`ModePicker`), what
/// answers it (provider/model, or backend chips in Compare/Race), and what
/// it is allowed to do (`approvalControl`). A fourth used to sit between the
/// first two — reasoning EFFORT (`EffortPicker`) — removed because the owner
/// configures it at the provider level and an app-side control could only
/// duplicate or override that; see `runConfigGroup`'s doc for the full
/// reasoning. `GroupDivider` hairlines make the remaining grouping visible
/// instead of leaving differently-shaped controls to read as "placed" rather
/// than designed. Session/reasoning-traces/clear are deliberately NOT part of
/// that sequence — they are utility actions on the conversation as a whole,
/// not part of configuring the next run, so they stay a separate trailing
/// tray.
///
/// `ViewThatFits` (not a hand-picked width breakpoint) decides whether that
/// whole sequence fits one row or needs two: a real measurement at this
/// file's required-clean width (900pt, `NexusApp.swift`'s `minWidth`) found
/// the leading run-config cluster alone needing ~636pt against ~345pt
/// available there once the trailing tray and its `Spacer` claimed the
/// rest — which pushed the provider and model pickers behind a horizontal
/// scroll with no visible indication they existed at all. Wrapping the same
/// controls onto a second line at that width keeps every one of them
/// visible without requiring the user to discover a hidden scroll; a scroll
/// INDICATOR alone would only have advertised the defect, not fixed it.
struct ControlStrip: View {
    @Environment(\.nexusTheme) private var theme
    @Bindable var controller: ConversationController
    @Binding var showsReasoning: Bool
    let providers: [PickerOption]
    let models: [PickerOption]
    let isLoadingModels: Bool
    let onLoadModels: (String) -> Void
    let rolesController: RolesController?

    // Clearing destroys an on-screen conversation with no undo, same class of
    // action as "Delete task" (`TasksView.swift`) and "Sign out" (`AuthView.
    // swift`) — both gated behind a `confirmationDialog` rather than firing on
    // tap, so this matches instead of being a fourth, ungated dialect.
    @State private var confirmingClear = false

    var body: some View {
        ViewThatFits(in: .horizontal) {
            singleRow
            twoRowStack
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(theme.color(\.surfaceSunken))
    }

    private var singleRow: some View {
        HStack(spacing: Space.md) {
            runConfigGroup
            GroupDivider()
            approvalControl
            Spacer(minLength: Space.lg)
            utilityTray
        }
    }

    private var twoRowStack: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            runConfigGroup
            HStack(spacing: Space.md) {
                approvalControl
                Spacer(minLength: Space.lg)
                utilityTray
            }
        }
    }

    /// What the run IS and what answers it — the two categories that
    /// together decide what `plannedCommand` builds.
    ///
    /// A third category, reasoning effort, used to live here as `EffortPicker`
    /// — removed per the owner's direction ("also thinking i enabled by
    /// default in all these models - so lets not have it separate"):
    /// they configure `--effort`/reasoning at the PROVIDER level (e.g.
    /// `~/.codex/config.toml`'s `model_reasoning_effort`), so an app-side
    /// control wasn't just redundant, it was harmful — sending `--effort`
    /// would silently override a value they deliberately set with whatever
    /// the picker happened to show. The app no longer sends `--effort` at all
    /// (see `persistentSessionArguments`/`oneShotArguments`); the provider's
    /// own configured effort governs, unopposed. The capability data behind
    /// the old control (`ReasoningCapability`, `NexusProvider
    /// .reasoningLabel(for:)`) stays in `NexusKit`, correct and tested, for
    /// whoever next needs to surface per-provider effort.
    private var runConfigGroup: some View {
        HStack(spacing: Space.md) {
            ModePicker(mode: $controller.mode)
                .help(controller.mode.detail)

            GroupDivider()

            if controller.mode.isMultiLane {
                backendControls
            } else {
                singleLaneControls
            }

            // Role only means anything in `.agent` mode — everywhere else
            // `ConversationController.role` is simply never read (see
            // `usesPersistentSession`/`oneShotArguments`), so showing the
            // picker outside `.agent` would offer a control with no effect,
            // exactly the kind of "looks interactive, does nothing" control
            // the approvals toggle was fixed to stop being.
            if controller.mode == .agent {
                GroupDivider()
                rolePicker
            }
        }
    }

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
            width: 148,
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

    /// Conversation-wide utility actions — not part of configuring the next
    /// run, so kept visually separate from `runConfigGroup` rather than
    /// chained onto the end of it.
    private var utilityTray: some View {
        HStack(spacing: Space.md) {
            if let session = controller.sessionId {
                Metric(label: "session", value: String(session.suffix(8)))
                    .help("Follow-up turns resume this session: \(session)")
            }

            Button {
                showsReasoning.toggle()
            } label: {
                Image(systemName: showsReasoning ? "brain.head.profile.fill" : "brain.head.profile")
                    .font(.system(size: 12))
            }
            .buttonStyle(SoftButton(tone: showsReasoning ? .accent : .neutral, size: .compact))
            .help(showsReasoning ? "Hide reasoning traces" : "Show reasoning traces")

            Button {
                confirmingClear = true
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 11))
            }
            .buttonStyle(SoftButton(tone: .neutral, size: .compact))
            .help("Clear the transcript (the durable session is kept)")
            .confirmationDialog("Clear the transcript?", isPresented: $confirmingClear) {
                Button("Clear", role: .destructive) { controller.clear() }
            } message: {
                Text("Removes this conversation from view. The durable session on disk is kept.")
            }
        }
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
                    width: 72,
                    emptyHint: providers.isEmpty ? "No providers loaded yet" : "All providers already added"
                ) { id in
                    if !controller.backends.contains(id) { controller.backends.append(id) }
                }
            }
        }
        // Bounded, rather than left to size itself: backend chip count has
        // no upper bound (a Compare run can grow past what any fixed width
        // holds), so this is the one piece of `runConfigGroup` that keeps
        // its own scroll. Bounding it also gives `ViewThatFits` an honest
        // width to measure — an unbounded `ScrollView` always reports
        // "fits" by clipping its content instead of overflowing, which
        // would have silently defeated the single-row/two-row decision
        // above exactly the way the old single, all-encompassing
        // `ScrollView` did for provider/model.
        .frame(maxWidth: 260)
    }

    private var singleLaneControls: some View {
        HStack(spacing: Space.xs) {
            DropdownPicker(
                placeholder: "provider",
                leadingDot: providerDotColor(for: controller.provider, in: providers, theme: theme),
                options: providers,
                selection: controller.provider,
                width: 96,
                emptyHint: "No providers loaded yet"
            ) { id in
                controller.provider = id
                controller.model = nil
                onLoadModels(id)
            }

            modelPicker
        }
    }

    @ViewBuilder
    private var modelPicker: some View {
        let picker = DropdownPicker(
            placeholder: "model",
            options: models,
            selection: controller.model,
            isLoading: isLoadingModels,
            width: 124,
            emptyHint: isLoadingModels ? "Loading models…" : "No models for this provider yet"
        ) { id in
            controller.model = id
        }
        .disabled(controller.provider == nil)
        .opacity(controller.provider == nil ? 0.5 : 1)

        if controller.provider == nil {
            picker.help("Pick a provider first")
        } else {
            picker
        }
    }

    /// A real toggle. `ConversationController.approvalsEnabled` already drives
    /// `-t --ask` on the actual `chat --persistent` argv (see
    /// `persistentSessionArguments()`, which both `commandPreview` and the
    /// real spawn call through) — so this switches genuine behavior rather
    /// than reading it back the way a disabled/dimmed readout would.
    private var approvalControl: some View {
        Button {
            controller.approvalsEnabled.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: controller.approvalsEnabled ? "hand.raised.fill" : "hand.raised.slash")
                    .font(.system(size: 9))
                Text("Ask first")
                    .font(Kind.monoSmall)
            }
        }
        .buttonStyle(SoftButton(tone: controller.approvalsEnabled ? .accent : .neutral, size: .compact))
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
}

/// A hairline separating two `ControlStrip` groups by MEANING — mode,
/// provider/model, approvals. Differently-shaped controls placed side by
/// side with nothing marking where one category ends and the next begins is
/// what made the strip read as controls dropped into a row rather than a
/// designed sequence; this is the one visual device that
/// fixes that without inventing a new spacing or color token.
private struct GroupDivider: View {
    @Environment(\.nexusTheme) private var theme

    var body: some View {
        Rectangle()
            .fill(theme.color(\.chromeDivider))
            .frame(width: 1, height: 20)
    }
}

/// One row in a `DropdownPicker` — a provider, a model, a role (for the
/// `.agent` role picker), or (for the compare/race "add backend" control) a
/// provider offered as a backend.
///
/// Callers that have nothing loaded yet default to `[]` and the pickers
/// render their empty state — `ChatTab` (`RootView.swift`) is what actually
/// binds live `ProvidersController`/`RolesController` data into these.
struct PickerOption: Identifiable, Equatable {
    let id: String
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
    /// (see `NexusRole.canWrite` and `ControlStrip.rolePicker`).
    var warning: String?

    init(
        id: String,
        detail: String? = nil,
        available: Bool = true,
        disabledReason: String? = nil,
        kind: String? = nil,
        warning: String? = nil
    ) {
        self.id = id
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
    var isLoading = false
    var width: CGFloat = 120
    var emptyHint: String?
    var onSelect: (String) -> Void

    @State private var isOpen = false

    private var displayText: String { selection ?? placeholder }

    /// The current selection's caution, if it has one — surfaced on the
    /// CLOSED button too (not just inside the popover), so picking a
    /// role that can write is never one click away from being invisible.
    private var selectedWarning: String? {
        options.first(where: { $0.id == selection })?.warning
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
            .font(Kind.monoSmall)
            .foregroundStyle(selection == nil ? theme.color(\.textMuted) : theme.color(\.textSecondary))
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 5)
            .frame(width: width, alignment: .leading)
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
            DropdownList(options: options, selection: selection, emptyHint: emptyHint) { id in
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
    let onSelect: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                if options.isEmpty {
                    Text(emptyHint ?? "Nothing available")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                        .padding(Space.md)
                } else {
                    ForEach(options) { option in
                        row(option)
                    }
                }
            }
            .padding(4)
        }
        .frame(minWidth: 220, maxHeight: 260)
        .background(theme.color(\.surfaceOverlay))
    }

    @ViewBuilder
    private func row(_ option: PickerOption) -> some View {
        let button = Button {
            onSelect(option.id)
        } label: {
            HStack(spacing: Space.sm) {
                if let dot = option.dotColor(theme: theme) {
                    Circle().fill(dot).frame(width: 6, height: 6)
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(option.id)
                            .font(Kind.monoSmall)
                        if option.warning != nil {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 8))
                                .foregroundStyle(theme.color(\.warningFg))
                        }
                    }
                    if let detail = option.detail {
                        Text(detail)
                            .font(Kind.micro)
                            .foregroundStyle(theme.color(\.textMuted))
                    }
                    if let warning = option.warning {
                        Text(warning)
                            .font(Kind.micro)
                            .foregroundStyle(theme.color(\.warningFg))
                    }
                }
                Spacer(minLength: 0)
                if option.id == selection {
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
        HStack(spacing: Space.md) {
            Metric(label: "in", value: "\(view.lastUsage.inputTokens)")
            Metric(label: "out", value: "\(view.lastUsage.outputTokens)")
            Metric(label: "turn cost", value: turnCostText, emphasis: true)
            Spacer(minLength: 0)
            Metric(
                label: "session total",
                value: formatted(view.totals.costUsd, incomplete: view.totals.costIncomplete)
            )
        }
        .foregroundStyle(theme.color(\.textMuted))
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

/// A themed stand-in for `.pickerStyle(.segmented)`. The native control draws
/// its selected segment from the system accent, which would ignore this app's
/// 16 palettes exactly where the mode switch is most prominent.
private struct ModePicker: View {
    @Environment(\.nexusTheme) private var theme
    @Binding var mode: RunMode

    var body: some View {
        HStack(spacing: 2) {
            ForEach(RunMode.allCases) { candidate in
                let selected = candidate == mode
                Button {
                    mode = candidate
                } label: {
                    Text(candidate.title)
                        .font(.system(size: 11.5, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? theme.color(\.accentFg) : theme.color(\.textSecondary))
                        .padding(.horizontal, Space.md)
                        .padding(.vertical, 5)
                        .background {
                            if selected {
                                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                    .fill(theme.color(\.accentDefault))
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(theme.color(\.surfaceInset))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control + 2, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control + 2, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
        .animation(.easeOut(duration: 0.15), value: mode)
    }
}

/// The empty state's hero visual: a live echo of the exact `nexus <mode>`
/// invocation the control strip is currently configured to run, in the same
/// monospace-plus-caret language the composer's command preview and the
/// transcript's own streaming cursor use elsewhere in this file. Reusing
/// `StreamingCaret` here (not a new blinking-cursor implementation) is
/// deliberate: it is the one piece of motion in this app that already means
/// "live," so it says "ready" here as literally as it says "streaming" in
/// `TurnView`, rather than inventing a second cue for the same idea.
///
/// Replaces what used to be a generic icon centred in a soft radial glow —
/// the most template-looking element in the app, and true of nearly any
/// chat product rather than this one specifically.
private struct ChatHeroMark: View {
    @Environment(\.nexusTheme) private var theme
    let mode: RunMode

    var body: some View {
        HStack(spacing: Space.sm) {
            Text("nexus")
                .foregroundStyle(theme.color(\.textMuted))
            Text(mode.rawValue)
                .fontWeight(.semibold)
                .foregroundStyle(theme.accentGradient)
            StreamingCaret()
        }
        .font(.system(size: 19, weight: .medium, design: .monospaced))
        .padding(.horizontal, Space.xl)
        .padding(.vertical, Space.lg)
        .background(theme.color(\.surfaceRaised))
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
        .animation(.easeOut(duration: 0.15), value: mode)
    }
}

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
                    .foregroundStyle(theme.color(\.accentDefault))
                    .frame(width: 18)
                Text(text)
                    .font(Kind.bodyEmphasis)
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
            Text(text).font(Kind.monoSmall)
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
/// with neither; the only differentiator here is a 2pt accent rule at low
/// opacity on the assistant's answer. A round avatar bubble next to every
/// single message is a consumer-chat-app tell (and, past the first turn,
/// carries no information position doesn't already give); a bordered card
/// around every answer is the reason this used to read as a stack of
/// distinct little boxes instead of one continuous conversation.
struct TurnView: View {
    @Environment(\.nexusTheme) private var theme
    let turn: Turn
    var showsReasoning = false
    var isStreaming = false
    var compact = false
    /// The provider CURRENTLY serving this conversation (`ViewState.session
    /// ?.provider`) — `nil` for a context (e.g. a compare/race `LaneColumn`)
    /// that has no single "current provider" concept to compare against.
    ///
    /// Only ever used to decide whether `providerBadge` renders, never to
    /// derive `turn`'s own attribution — `turn.provider`/`.model` already
    /// carry that, stamped once from folded events (see `Turn.provider`'s
    /// doc). Reading "what's current" for the COMPARISON is fine; it is
    /// reading it as the SOURCE of a turn's own attribution that would be
    /// the bug (a switch changes `session` on turns that started before the
    /// switch too, which is exactly what `Turn.provider` exists to survive).
    var currentProvider: String? = nil
    @State private var hoveringAnswer = false
    @State private var copied = false

    private var hasAnswerContent: Bool {
        !turn.text.isEmpty || !turn.tools.isEmpty || !turn.diffs.isEmpty || turn.error != nil || isStreaming
    }

    /// Whether this turn is worth labelling — only when it answered from a
    /// DIFFERENT provider than the one the conversation is currently on.
    /// Every turn of an ordinary, single-provider conversation must render
    /// identically to before this existed: badging every turn regardless
    /// would bury the one piece of information that is actually new here.
    private var showsProviderBadge: Bool {
        guard let turnProvider = turn.provider, let currentProvider else { return false }
        return turnProvider != currentProvider
    }

    /// `"provider/model"`, or bare `provider` when no model was recorded —
    /// same shape as `UiEvent.Switch.Target.label`, so this reads as the
    /// same vocabulary as the switch receipt just above it in the
    /// transcript rather than a second, differently-worded convention.
    private var providerBadgeLabel: String {
        guard let turnProvider = turn.provider else { return "" }
        return turn.model.map { "\(turnProvider)/\($0)" } ?? turnProvider
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? Space.sm : Space.lg) {
            if let prompt = turn.prompt, !compact {
                promptBlock(prompt)
            }
            if hasAnswerContent {
                if compact {
                    innerContent
                } else {
                    answerBlock
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func promptBlock(_ prompt: String) -> some View {
        Text(prompt)
            .font(Kind.bodyEmphasis)
            .foregroundStyle(theme.color(\.textPrimary))
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var answerBlock: some View {
        // The copy button used to sit in a `.topTrailing` overlay, which
        // worked while the card's own `Space.md` padding kept it clear of
        // the text. Now that the card is gone, that overlay had nothing to
        // hold it off the corner and it landed directly on top of the first
        // line — an H1 or a long opening sentence would run right under it.
        // A hover-revealed row below the content, not an overlay on top of
        // it, can never occlude a glyph, at the cost of a small reflow when
        // it appears — an accepted trade for "never covers real text".
        VStack(alignment: .leading, spacing: 4) {
            innerContent
                .padding(.leading, Space.md)
                // The one differentiator: a quiet accent rule in the left
                // gutter, present only on the assistant's answer — never a
                // card, never an avatar.
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(theme.color(\.accentDefault).opacity(0.35))
                        .frame(width: 2)
                }

            if hoveringAnswer && !turn.text.isEmpty {
                HStack {
                    Spacer(minLength: 0)
                    copyButton
                }
            }
        }
        .onHover { hovering in
            hoveringAnswer = hovering
            if !hovering { copied = false }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var copyButton: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(turn.text, forType: .string)
            copied = true
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 10, weight: .semibold))
        }
        .buttonStyle(SoftButton(tone: .neutral, size: .compact))
        .help("Copy answer")
        .padding(6)
    }

    /// The "this answer came from somewhere else" tell — quiet, inline,
    /// deliberately unlike a colored `CountPill`: this is provenance, not a
    /// status to call attention to. Reuses the same icon
    /// `SwitchReceiptView.acceptedRow` uses for the switch that likely
    /// produced this turn, so the two read as one vocabulary.
    @ViewBuilder
    private var providerBadge: some View {
        if showsProviderBadge {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 8))
                Text(providerBadgeLabel)
            }
            .font(Kind.micro)
            .foregroundStyle(theme.color(\.textMuted))
        }
    }

    @ViewBuilder
    private var innerContent: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            providerBadge

            if showsReasoning && !turn.reasoning.isEmpty {
                Text(turn.reasoning)
                    .font(Kind.caption.italic())
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
                VStack(alignment: .leading, spacing: 4) {
                    Text(diff.path)
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(theme.color(\.textLink))
                    CodeBlock(text: diff.patch, isDiff: true)
                }
            }

            if let error = turn.error {
                errorBlock(error)
            }
        }
    }

    @ViewBuilder
    private func errorBlock(_ error: TurnError) -> some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: "exclamationmark.octagon.fill")
                .foregroundStyle(theme.color(\.errorFg))
                .font(.system(size: 11))
            VStack(alignment: .leading, spacing: 2) {
                Text(error.code)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                Text(error.message)
                    .font(Kind.caption)
                if error.retryable {
                    Text("retryable")
                        .font(Kind.micro)
                        .foregroundStyle(theme.color(\.warningFg))
                }
            }
            .foregroundStyle(theme.color(\.errorFg))
        }
        .padding(Space.sm)
        .background(theme.color(\.errorBg))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
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

    private var acceptedRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: Space.sm) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.system(size: 10))
                    .foregroundStyle(theme.color(\.textMuted))
                // The exact wording `SwitchReceipt.preserved`'s doc comment
                // asks for — honest about what carries over and what never
                // did (tool-call history isn't in the transcript at ANY
                // turn boundary, switch or not), rather than a bare "done"
                // that implies more than it should.
                Text("switched to \(receipt.to.label) — conversation and context carried over; tool-call history is not (never was, any turn boundary).")
                    .font(Kind.caption)
                    .foregroundStyle(theme.color(\.textMuted))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !receipt.warnings.isEmpty {
                warningsList(receipt.warnings)
            }
        }
        .padding(.leading, Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
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
                        .font(Kind.caption)
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
            .font(Kind.caption)
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
        .font(Kind.micro)
        .foregroundStyle(theme.color(\.warningFg).opacity(0.85))
        .padding(.leading, Space.lg)
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
            .frame(width: 6, height: 14)
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
                    if let args = tool.args {
                        Text(args.inlineDescription)
                            .font(Kind.monoSmall)
                            .foregroundStyle(theme.color(\.textMuted))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.sm)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }

            if expanded {
                VStack(alignment: .leading, spacing: Space.sm) {
                    if let args = tool.args {
                        labeledPayload("args", prettyPrinted(args))
                    }
                    if let result = tool.result {
                        labeledPayload("result", prettyPrinted(result))
                    }
                }
                .padding(.horizontal, Space.sm)
                .padding(.bottom, Space.sm)
            }
        }
        .background(
            hovering ? theme.color(\.surfaceOverlay).opacity(0.5) : .clear,
            in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }

    @ViewBuilder
    private func labeledPayload(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased())
                .font(Kind.micro)
                .tracking(0.5)
                .foregroundStyle(theme.color(\.textMuted))
            CodeBlock(text: text)
        }
    }

    private func prettyPrinted(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(value),
              let text = String(data: data, encoding: .utf8)
        else { return value.inlineDescription }
        return text
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
                .font(Kind.monoSmall)
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
