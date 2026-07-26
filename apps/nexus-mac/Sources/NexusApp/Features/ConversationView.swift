import SwiftUI
import AppKit
import NexusKit

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
    @Bindable var controller: ConversationController
    @State private var draft = ""
    @State private var showsReasoning = false
    @FocusState private var composerFocused: Bool

    // MARK: - Provider/model picker seam
    //
    // `ProvidersController` (NexusKit) is being built concurrently by another
    // agent and may not exist yet. Rather than block on it, this view takes
    // plain option lists plus a load callback; once the controller lands the
    // caller wires `providers`, `models` and `onLoadModels` from it — nothing
    // in this file needs to change. `effort` below is local for the same
    // reason: the controller has no such property yet, so it stays view state
    // until the lead lifts it — `commandPreview` already treats it as
    // authoritative for the `--effort` flag it appends.
    var providers: [PickerOption] = []
    var models: [PickerOption] = []
    var isLoadingModels = false
    var onLoadModels: (String) -> Void = { _ in }
    @State private var effort: EffortLevel = .off

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
                        effort: $effort,
                        providers: providers,
                        models: models,
                        isLoadingModels: isLoadingModels,
                        onLoadModels: onLoadModels
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
    }

    private var laneOrder: [LaneState] { controller.view.orderedLanes }

    @ViewBuilder
    private var transcript: some View {
        if laneOrder.isEmpty {
            emptyState
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
                    LazyVStack(alignment: .leading, spacing: Space.lg) {
                        ForEach(laneOrder) { lane in
                            ForEach(lane.finalized) { turn in
                                TurnView(turn: turn, showsReasoning: showsReasoning)
                                    .id(turn.id)
                            }
                            if let live = lane.live {
                                TurnView(turn: live, showsReasoning: showsReasoning, isStreaming: true)
                                    .id(live.id)
                            }
                        }
                    }
                    .padding(Space.xl)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
        guard let lane = laneOrder.last else { return nil }
        return lane.live?.id ?? lane.finalized.last?.id
    }

    private static let suggestions = [
        "Explain this codebase",
        "Review my staged diff",
        "Compare two models on one prompt",
        "Find the bug in the last commit",
    ]

    private var emptyState: some View {
        HeroEmptyState(
            icon: "bubble.left.and.bubble.right",
            title: "Ask anything",
            message: controller.mode.isMultiLane
                ? "Compare and Race fan the same prompt across backends and show every answer side by side."
                : "This runs `nexus \(controller.mode.rawValue)` and renders its event stream."
        ) {
            VStack(spacing: Space.lg) {
                FlowLayout(spacing: Space.sm) {
                    ForEach(Self.suggestions, id: \.self) { suggestion in
                        SuggestionChip(text: suggestion) { fillComposer(with: suggestion) }
                    }
                }
                .frame(maxWidth: 460)

                HStack(spacing: Space.lg) {
                    KeyHint(keys: "⌘N", label: "new")
                    KeyHint(keys: "⌘.", label: "stop")
                    KeyHint(keys: "⏎", label: "send")
                }
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

    private var composer: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if !controller.diagnostics.isEmpty {
                DiagnosticsStrip(lines: controller.diagnostics)
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
        .background(theme.color(\.surfaceSunken))
        .overlay(alignment: .top) {
            Rectangle().fill(theme.color(\.chromeDivider)).frame(height: 1)
        }
    }

    /// The centrepiece control: an elevated card that visibly lights up on
    /// focus, so it reads as the one place input goes rather than one field
    /// among several.
    private var composerCard: some View {
        HStack(alignment: .bottom, spacing: Space.sm) {
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
        .background(theme.color(\.surfaceRaised))
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
        var args = controller.plannedCommand(for: draft.isEmpty ? "…" : draft).arguments
        // `effort` has no home on the controller yet (see the seam note above),
        // so the flag is spliced in here rather than inside `plannedCommand` —
        // the one place this view already promises to show the exact `nexus`
        // invocation, so it can't silently omit a flag the user picked.
        if effort != .off { args += ["--effort", effort.rawValue] }
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

/// Mode, effort, provider/model or backends, the approval indicator, and the
/// reasoning toggle.
///
/// The leading cluster (mode, effort, provider/model or backend chips) sits
/// in its own horizontal `ScrollView` rather than a bare `HStack`. Backend
/// chips in particular have no upper bound — a Compare run with several
/// backends added would otherwise overflow the strip at exactly the width
/// this file is required to stay clean at (900pt). The trailing cluster
/// (approval, session, reasoning, clear) stays fixed outside the scroll so
/// those controls can never be the thing that scrolls out of reach.
struct ControlStrip: View {
    @Environment(\.nexusTheme) private var theme
    @Bindable var controller: ConversationController
    @Binding var showsReasoning: Bool
    @Binding var effort: EffortLevel
    let providers: [PickerOption]
    let models: [PickerOption]
    let isLoadingModels: Bool
    let onLoadModels: (String) -> Void

    var body: some View {
        HStack(spacing: Space.md) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.md) {
                    ModePicker(mode: $controller.mode)
                        .help(controller.mode.detail)

                    EffortPicker(effort: $effort)

                    if controller.mode.isMultiLane {
                        backendControls
                    } else {
                        singleLaneControls
                    }
                }
            }
            Spacer(minLength: Space.sm)

            approvalControl

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
                controller.clear()
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 11))
            }
            .buttonStyle(SoftButton(tone: .neutral, size: .compact))
            .help("Clear the transcript (the durable session is kept)")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(theme.color(\.surfaceSunken))
    }

    private var backendControls: some View {
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

    private var singleLaneControls: some View {
        HStack(spacing: Space.xs) {
            DropdownPicker(
                placeholder: "provider",
                leadingDot: providerDotColor(for: controller.provider, in: providers, theme: theme),
                options: providers,
                selection: controller.provider,
                width: 104,
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
            width: 136,
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

    /// A manual-approval readout, not a toggle. The CLI approval gate behind it
    /// isn't wired up yet, so this stays a static, dimmed display of the true
    /// current behavior (every action runs unconfirmed) rather than a control
    /// that would look interactive while silently doing nothing on tap.
    private var approvalControl: some View {
        HStack(spacing: 4) {
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 9))
            Text("Ask first")
                .font(Kind.monoSmall)
        }
        .foregroundStyle(theme.color(\.textMuted))
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 5)
        .background(theme.color(\.surfaceInset).opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle).opacity(0.6), lineWidth: 1)
        }
        .help("Approval gating isn't wired up yet — every action currently runs without confirmation")
    }
}

/// `--effort` has no home on `ConversationController` yet (see the seam note
/// on `ConversationView`), so this lives as view state until the lead lifts
/// it — `commandPreview` already treats it as authoritative for what actually
/// gets appended to the `nexus` invocation.
enum EffortLevel: String, CaseIterable, Identifiable {
    case off, low, medium, high
    var id: String { rawValue }

    var title: String {
        switch self {
        case .off: return "Off"
        case .low: return "Low"
        case .medium: return "Med"
        case .high: return "High"
        }
    }
}

/// A themed 4-way segmented control — the same visual language as
/// `ModePicker` but generic over `EffortLevel`, so the strip doesn't read as
/// two different segmented-control styles side by side.
private struct EffortPicker: View {
    @Environment(\.nexusTheme) private var theme
    @Binding var effort: EffortLevel

    var body: some View {
        HStack(spacing: 1) {
            ForEach(EffortLevel.allCases) { level in
                let selected = level == effort
                Button {
                    effort = level
                } label: {
                    Text(level.title)
                        .font(.system(size: 10, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? theme.color(\.accentFg) : theme.color(\.textSecondary))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4.5)
                        .background {
                            if selected {
                                RoundedRectangle(cornerRadius: Radius.control - 2, style: .continuous)
                                    .fill(theme.color(\.accentDefault))
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(1.5)
        .background(theme.color(\.surfaceInset))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
        }
        .animation(.easeOut(duration: 0.15), value: effort)
        .help("Reasoning effort — appended as --effort when not Off")
    }
}

/// One row in a `DropdownPicker` — a provider, a model, or (for the compare/
/// race "add backend" control) a provider offered as a backend.
///
/// This is the seam described on `ConversationView`: `ProvidersController` in
/// NexusKit is being built concurrently and may supply these from real
/// provider/model data once it lands. Until then callers default to `[]` and
/// the pickers render their empty state.
struct PickerOption: Identifiable, Equatable {
    let id: String
    var detail: String?
    var available: Bool
    var disabledReason: String?
    /// Provider kind (`"anthropic"`, `"openai"`, …) — colors the status dot
    /// only. `nil` for options that don't need one (models, effort).
    var kind: String?

    init(
        id: String,
        detail: String? = nil,
        available: Bool = true,
        disabledReason: String? = nil,
        kind: String? = nil
    ) {
        self.id = id
        self.detail = detail
        self.available = available
        self.disabledReason = disabledReason
        self.kind = kind
    }

    fileprivate func dotColor(theme: NexusTheme) -> Color? {
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
private func providerDotColor(kind: String, theme: NexusTheme) -> Color {
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
private func providerDotColor(for id: String?, in providers: [PickerOption], theme: NexusTheme) -> Color? {
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
                    .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
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
                    Text(option.id)
                        .font(Kind.monoSmall)
                    if let detail = option.detail {
                        Text(detail)
                            .font(Kind.micro)
                            .foregroundStyle(theme.color(\.textMuted))
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
            Metric(label: "turn cost", value: formatted(view.runUsd), emphasis: true)
            Spacer(minLength: 0)
            Metric(label: "session total", value: formatted(view.totals.costUsd))
        }
        .foregroundStyle(theme.color(\.textMuted))
    }

    private func formatted(_ usd: Double) -> String {
        guard usd > 0 else { return "$0.00" }
        return usd < 0.01 ? "<$0.01" : String(format: "$%.2f", usd)
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

/// A tappable prompt starter shown only on the empty state.
private struct SuggestionChip: View {
    @Environment(\.nexusTheme) private var theme
    let text: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textSecondary))
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .background(theme.color(\.surfaceOverlay).opacity(hovering ? 1 : 0.7), in: Capsule())
                .overlay {
                    Capsule().strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .scaleEffect(hovering ? 1.03 : 1)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .onHover { hovering = $0 }
    }
}

/// Wraps chips onto as many rows as the available width needs, instead of a
/// hardcoded row count that would either waste space or clip on a narrow window.
private struct FlowLayout: Layout {
    var spacing: CGFloat = Space.sm

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var origin = CGPoint.zero
        var rowHeight: CGFloat = 0
        var width: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if origin.x + size.width > maxWidth, origin.x > 0 {
                origin.x = 0
                origin.y += rowHeight + spacing
                rowHeight = 0
            }
            origin.x += size.width + spacing
            width = max(width, origin.x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width, height: origin.y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var origin = bounds.origin
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if origin.x + size.width > bounds.maxX, origin.x > bounds.origin.x {
                origin.x = bounds.origin.x
                origin.y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: origin, proposal: .unspecified)
            origin.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
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
/// The prompt and the answer are deliberately NOT the same shape: a small
/// role avatar plus flat surface for the user, versus an elevated card for the
/// assistant — so which is which is legible at a glance, not just by position.
struct TurnView: View {
    @Environment(\.nexusTheme) private var theme
    let turn: Turn
    var showsReasoning = false
    var isStreaming = false
    var compact = false
    @State private var hoveringAnswer = false
    @State private var copied = false

    private var hasAnswerContent: Bool {
        !turn.text.isEmpty || !turn.tools.isEmpty || !turn.diffs.isEmpty || turn.error != nil || isStreaming
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
        HStack(alignment: .top, spacing: Space.sm) {
            RoleAvatar(systemImage: "person.fill")
            Text(prompt)
                .font(Kind.bodyEmphasis)
                .foregroundStyle(theme.color(\.textPrimary))
                .textSelection(.enabled)
                .padding(.top, 3)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var answerBlock: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            RoleAvatar(systemImage: "sparkles", tone: .accent)
            innerContent
                .padding(Space.md)
                .background(theme.color(\.surfaceRaised))
                .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                        .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                }
                .overlay(alignment: .topTrailing) {
                    if hoveringAnswer && !turn.text.isEmpty {
                        copyButton
                    }
                }
                .onHover { hovering in
                    hoveringAnswer = hovering
                    if !hovering { copied = false }
                }
        }
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

    @ViewBuilder
    private var innerContent: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if showsReasoning && !turn.reasoning.isEmpty {
                Text(turn.reasoning)
                    .font(Kind.caption.italic())
                    .foregroundStyle(theme.color(\.streamThinking))
                    .textSelection(.enabled)
            }

            if !turn.text.isEmpty {
                // The caret rides the last baseline of the answer rather than
                // being folded into the `Text` itself, so its blink can animate
                // independently of the (unanimated) answer text.
                HStack(alignment: .lastTextBaseline, spacing: 3) {
                    Text(turn.text)
                        .font(Kind.body)
                        .foregroundStyle(theme.color(\.textSecondary))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if isStreaming {
                        StreamingCaret()
                    }
                }
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

/// The small role indicator on a turn — a person for the prompt, a spark for
/// the answer. Deliberately tiny: it identifies, it doesn't compete with the
/// content next to it.
private struct RoleAvatar: View {
    @Environment(\.nexusTheme) private var theme
    let systemImage: String
    var tone: Tone = .neutral

    enum Tone { case neutral, accent }

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(tone == .accent ? theme.color(\.accentFg) : theme.color(\.textSecondary))
            .frame(width: 22, height: 22)
            .background(tone == .accent ? theme.color(\.accentMuted) : theme.color(\.surfaceOverlay), in: Circle())
    }
}

/// A blinking caret — motion that means exactly one thing: this turn is still
/// producing text right now.
private struct StreamingCaret: View {
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

/// stderr from the CLI. Surfaced rather than swallowed, so a launch failure or a
/// provider warning is visible instead of manifesting as an empty answer — kept
/// visually quiet, though, since most runs never produce a line here.
struct DiagnosticsStrip: View {
    @Environment(\.nexusTheme) private var theme
    let lines: [String]

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10))
                .foregroundStyle(theme.color(\.warningFg).opacity(0.85))
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(lines.suffix(3).enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(Kind.monoSmall)
                        .foregroundStyle(theme.color(\.warningFg).opacity(0.85))
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, 6)
        .background(theme.color(\.warningBg).opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}
