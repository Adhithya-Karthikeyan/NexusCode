import SwiftUI
import NexusKit

/// The conversation surface: transcript, controls, composer.
///
/// Every control here resolves to a flag on a `nexus` command — the mode picker
/// chooses the subcommand, the provider/model fields become `-p`/`-m`. The exact
/// invocation is shown in the composer, so the UI can never feel like a black
/// box relative to the terminal.
struct ConversationView: View {
    @Environment(\.nexusTheme) private var theme
    @Bindable var controller: ConversationController
    @State private var draft = ""
    @State private var showsReasoning = false

    var body: some View {
        VStack(spacing: 0) {
            ControlStrip(controller: controller)
            Divider().overlay(theme.color(\.chromeDivider))
            transcript
            composer
        }
    }

    private var laneOrder: [LaneState] { controller.view.orderedLanes }

    @ViewBuilder
    private var transcript: some View {
        if laneOrder.isEmpty {
            EmptyState(
                icon: "bubble.left.and.bubble.right",
                title: "Ask anything",
                message: controller.mode.isMultiLane
                    ? "Compare and Race fan the same prompt across backends and show every answer side by side."
                    : "This runs `nexus \(controller.mode.rawValue)` and renders its event stream."
            )
        } else if controller.mode.isMultiLane && laneOrder.count > 1 {
            // Fan-out: one column per lane, so answers are compared, not scrolled.
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(laneOrder) { lane in
                        LaneColumn(lane: lane, showsReasoning: showsReasoning)
                            .frame(width: 380)
                    }
                }
                .padding(14)
            }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(laneOrder) { lane in
                            ForEach(lane.finalized) { turn in
                                TurnView(turn: turn, showsReasoning: showsReasoning)
                            }
                            if let live = lane.live {
                                TurnView(turn: live, showsReasoning: showsReasoning, isStreaming: true)
                                    .id("live")
                            }
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: controller.view.eventCount) {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo("live", anchor: .bottom)
                    }
                }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if !controller.diagnostics.isEmpty {
                DiagnosticsStrip(lines: controller.diagnostics)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message NexusCode…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.color(\.textPrimary))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(theme.color(\.surfaceInset))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                    }
                    .onSubmit(send)

                if controller.isRunning {
                    Button(action: controller.cancel) {
                        Image(systemName: "stop.fill")
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .background(theme.color(\.errorBg))
                    .foregroundStyle(theme.color(\.errorFg))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .help("Stop the run (⌘.)")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .background(canSend ? theme.color(\.accentDefault) : theme.color(\.surfaceOverlay))
                    .foregroundStyle(canSend ? theme.color(\.accentFg) : theme.color(\.textMuted))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .disabled(!canSend)
                }
            }
            // The exact command this will run — the UI never hides the CLI.
            HStack(spacing: 6) {
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
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(theme.color(\.textMuted))
        }
        .padding(12)
        .background(theme.color(\.surfaceSunken))
        .overlay(alignment: .top) {
            Rectangle().fill(theme.color(\.chromeDivider)).frame(height: 1)
        }
    }

    private var canSend: Bool {
        controller.canSubmit && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var commandPreview: String {
        "nexus " + controller
            .plannedCommand(for: draft.isEmpty ? "…" : draft)
            .arguments
            .map { $0.contains(" ") ? "\"\($0)\"" : $0 }
            .joined(separator: " ")
    }

    private func send() {
        guard canSend else { return }
        controller.submit(draft)
        draft = ""
    }
}

/// Mode, provider/model or backends, and the reasoning toggle.
struct ControlStrip: View {
    @Environment(\.nexusTheme) private var theme
    @Bindable var controller: ConversationController
    @State private var backendDraft = ""

    var body: some View {
        HStack(spacing: 10) {
            Picker("", selection: $controller.mode) {
                ForEach(RunMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 250)
            .help(controller.mode.detail)

            if controller.mode.isMultiLane {
                ForEach(controller.backends, id: \.self) { backend in
                    Chip(text: backend) {
                        controller.backends.removeAll { $0 == backend }
                    }
                }
                TextField("add backend…", text: $backendDraft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(width: 110)
                    .onSubmit {
                        let value = backendDraft.trimmingCharacters(in: .whitespaces)
                        if !value.isEmpty && !controller.backends.contains(value) {
                            controller.backends.append(value)
                        }
                        backendDraft = ""
                    }
            } else {
                TextField("provider", text: Binding(
                    get: { controller.provider ?? "" },
                    set: { controller.provider = $0.isEmpty ? nil : $0 }
                ))
                .textFieldStyle(.plain)
                .font(.system(size: 11, design: .monospaced))
                .frame(width: 90)

                TextField("model", text: Binding(
                    get: { controller.model ?? "" },
                    set: { controller.model = $0.isEmpty ? nil : $0 }
                ))
                .textFieldStyle(.plain)
                .font(.system(size: 11, design: .monospaced))
                .frame(width: 130)
            }

            Spacer(minLength: 0)

            if let session = controller.sessionId {
                Metric(label: "session", value: String(session.suffix(8)))
                    .help("Follow-up turns resume this session: \(session)")
            }

            Button {
                controller.clear()
            } label: {
                Image(systemName: "trash").font(.system(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.color(\.textMuted))
            .help("Clear the transcript (the durable session is kept)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(theme.color(\.surfaceSunken))
    }
}

struct Chip: View {
    @Environment(\.nexusTheme) private var theme
    let text: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(text).font(.system(size: 10, design: .monospaced))
            Button(action: onRemove) {
                Image(systemName: "xmark").font(.system(size: 7))
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

/// One column of a fan-out run.
struct LaneColumn: View {
    @Environment(\.nexusTheme) private var theme
    let lane: LaneState
    let showsReasoning: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                StatusDot(isRunning: lane.isStreaming, isFailed: lane.live?.error != nil)
                Text(lane.lane)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(theme.color(\.textPrimary))
            }
            ForEach(lane.finalized) { turn in
                TurnView(turn: turn, showsReasoning: showsReasoning, compact: true)
            }
            if let live = lane.live {
                TurnView(turn: live, showsReasoning: showsReasoning, isStreaming: true, compact: true)
            }
        }
    }
}

/// One assistant turn: prompt, reasoning, answer, tools, diffs, error.
struct TurnView: View {
    @Environment(\.nexusTheme) private var theme
    let turn: Turn
    var showsReasoning = false
    var isStreaming = false
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let prompt = turn.prompt, !compact {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "person.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(theme.color(\.textMuted))
                        .padding(.top, 3)
                    Text(prompt)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.color(\.textPrimary))
                        .textSelection(.enabled)
                }
            }

            if showsReasoning && !turn.reasoning.isEmpty {
                Text(turn.reasoning)
                    .font(.system(size: 11.5).italic())
                    .foregroundStyle(theme.color(\.streamThinking))
                    .textSelection(.enabled)
            }

            if !turn.text.isEmpty {
                Text(turn.text)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.color(\.textSecondary))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
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
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.octagon.fill")
                        .foregroundStyle(theme.color(\.errorFg))
                        .font(.system(size: 10))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(error.code)
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        Text(error.message)
                            .font(.system(size: 11))
                        if error.retryable {
                            Text("retryable")
                                .font(.system(size: 9))
                                .foregroundStyle(theme.color(\.warningFg))
                        }
                    }
                    .foregroundStyle(theme.color(\.errorFg))
                }
                .padding(8)
                .background(theme.color(\.errorBg))
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }

            if isStreaming && turn.text.isEmpty && turn.tools.isEmpty {
                Text("…")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(theme.color(\.streamCursor))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A tool invocation — collapsed to one line, expandable to its arguments and
/// result. Structure is preserved end to end, so this can show the real payload
/// rather than a stringified summary.
struct ToolRow: View {
    @Environment(\.nexusTheme) private var theme
    let tool: ToolActivity
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.12)) { expanded.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8))
                    StatusDot(
                        isRunning: tool.status == .running,
                        isFailed: tool.status == .error
                    )
                    Text(tool.name)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                    if let args = tool.args {
                        Text(args.inlineDescription)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(theme.color(\.textMuted))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(theme.color(\.textSecondary))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                if let args = tool.args {
                    CodeBlock(text: prettyPrinted(args))
                }
                if let result = tool.result {
                    CodeBlock(text: prettyPrinted(result))
                }
            }
        }
        .padding(8)
        .background(theme.color(\.surfaceRaised))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
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
/// provider warning is visible instead of manifesting as an empty answer.
struct DiagnosticsStrip: View {
    @Environment(\.nexusTheme) private var theme
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.suffix(3).enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.color(\.warningFg))
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(theme.color(\.warningBg))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
}
