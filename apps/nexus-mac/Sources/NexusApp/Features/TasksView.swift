import SwiftUI
import NexusKit

/// The durable task queue — backed by `nexus task …`.
///
/// Like `SessionsView`, `WorkspaceModel` holds no `TasksController` of its
/// own, so this view builds one from `NexusBinary.discover` + `NexusClient`
/// and rebuilds it whenever the project directory changes.
struct TasksView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    @State private var controller: TasksController?
    @State private var newTitle = ""

    var body: some View {
        ScrollView {
            // Every piece of content below handles its own padding — nothing
            // here stacks a flexible frame under a trailing `.padding()`.
            VStack(alignment: .leading, spacing: Space.lg) {
                headerRow

                if let controller {
                    ProgressSummary(progress: controller.progress)

                    AddTaskField(title: $newTitle) { title in
                        Task { await controller.add(title: title) }
                    }

                    if let error = controller.error, !controller.tasks.isEmpty {
                        ErrorBanner(message: error) { controller.error = nil }
                    }

                    if controller.isLoading && controller.tasks.isEmpty {
                        loadingState
                    } else if let error = controller.error, controller.tasks.isEmpty {
                        errorState(error) { Task { await controller.refresh() } }
                    } else if controller.tasks.isEmpty {
                        HeroEmptyState(
                            icon: "checklist",
                            title: "No tasks yet",
                            message: "Add one above to start the durable queue — it persists across sessions via `nexus task`."
                        )
                        .frame(minHeight: 320)
                    } else {
                        // `grouped` always returns all six buckets, including
                        // empty ones, so this renders a stable set of section
                        // headers rather than reshuffling as tasks move status.
                        ForEach(controller.grouped, id: \.status) { group in
                            if !group.tasks.isEmpty {
                                TaskSection(status: group.status, tasks: group.tasks, allTasks: controller.tasks) { id, status in
                                    Task { await controller.setStatus(status, for: id) }
                                } onDelete: { id in
                                    Task { await controller.remove(id: id) }
                                }
                            } else {
                                SectionHeader(group.status.label, accessory: AnyView(CountPill(text: "0", tone: .neutral)))
                            }
                        }
                    }
                } else {
                    HeroEmptyState(
                        icon: "terminal",
                        title: "No nexus executable",
                        message: "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                    )
                }
            }
            .padding(Space.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(theme.color(\.surfaceBase))
        .task(id: workspace.projectDirectory) { await attach() }
    }

    private var headerRow: some View {
        SectionHeader(
            "Tasks",
            subtitle: "The durable task queue — nexus task list",
            accessory: AnyView(
                Button {
                    Task { await controller?.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(SoftButton(size: .compact))
            )
        )
    }

    private var loadingState: some View {
        VStack(spacing: Space.sm) {
            ProgressView()
            Text("Loading tasks…")
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textMuted))
        }
        .frame(maxWidth: .infinity, minHeight: 220)
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
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private func attach() async {
        guard let binary = NexusBinary.discover(repoRoot: workspace.projectDirectory) else {
            controller = nil
            return
        }
        let newController = TasksController(client: NexusClient(binary: binary), workingDirectory: workspace.projectDirectory)
        controller = newController
        await newController.refresh()
    }
}

/// Total progress readout — mirrors the CLI's own `Progress` (cancelled tasks
/// excluded from the denominator), shown as a bar plus the raw counts.
private struct ProgressSummary: View {
    @Environment(\.nexusTheme) private var theme
    let progress: (total: Int, completed: Int, percent: Int)

    var body: some View {
        Card(padding: Space.md, radius: Radius.panel) {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(progress.completed) of \(progress.total) done")
                        .font(Kind.bodyEmphasis)
                        .foregroundStyle(theme.color(\.textPrimary))
                    Spacer(minLength: Space.sm)
                    Text("\(progress.percent)%")
                        .font(Kind.mono)
                        .foregroundStyle(theme.color(\.accentDefault))
                        .monospacedDigit()
                }
                ProgressView(value: Double(progress.percent), total: 100)
                    .tint(theme.color(\.accentDefault))
            }
        }
    }
}

/// The composer for new tasks — a bound text field plus a submit button,
/// styled like `ProjectSwitcherRow`'s field rather than reinventing chrome.
private struct AddTaskField: View {
    @Environment(\.nexusTheme) private var theme
    @Binding var title: String
    let onSubmit: (String) -> Void

    private var trimmed: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        HStack(spacing: Space.sm) {
            TextField("Add a task…", text: $title)
                .textFieldStyle(.plain)
                .font(Kind.body)
                .foregroundStyle(theme.color(\.textPrimary))
                .padding(.horizontal, Space.sm)
                .padding(.vertical, 7)
                .background(theme.color(\.surfaceOverlay), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                        .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                }
                .onSubmit(submit)

            Button("Add", action: submit)
                .buttonStyle(SoftButton(tone: .accent, size: .compact))
                .disabled(trimmed.isEmpty)
        }
    }

    private func submit() {
        guard !trimmed.isEmpty else { return }
        onSubmit(trimmed)
        title = ""
    }
}

/// A dismissible, non-fatal notice — for an action that failed (add/status/
/// delete) without wiping out the list that's still showing.
private struct ErrorBanner: View {
    @Environment(\.nexusTheme) private var theme
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: Space.xs) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 10))
            Text(message)
                .font(Kind.caption)
                .lineLimit(2)
            Spacer(minLength: Space.sm)
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(theme.color(\.warningFg))
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(theme.color(\.warningBg).opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}

/// One status bucket: a header with a live count, then its task cards.
private struct TaskSection: View {
    let status: TaskStatus
    let tasks: [NexusTask]
    let allTasks: [NexusTask]
    let onSetStatus: (String, TaskStatus) -> Void
    let onDelete: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(status.label, accessory: AnyView(CountPill(text: "\(tasks.count)", tone: status.tone)))
            VStack(spacing: Space.sm) {
                ForEach(tasks) { task in
                    TaskRow(
                        task: task,
                        allTasks: allTasks,
                        onSetStatus: { onSetStatus(task.id, $0) },
                        onDelete: { onDelete(task.id) }
                    )
                }
            }
        }
    }
}

/// One task: title (struck through once settled), deps/parent when present,
/// status transitions, and delete — behind a confirmation, since removal is
/// not reversible from this UI.
private struct TaskRow: View {
    @Environment(\.nexusTheme) private var theme
    let task: NexusTask
    let allTasks: [NexusTask]
    let onSetStatus: (TaskStatus) -> Void
    let onDelete: () -> Void

    @State private var confirmingDelete = false

    /// Every status `setStatus` can actually reach, minus the one the task is
    /// already in — `.todo`/`.unknown` never appear, since no `nexus task`
    /// subcommand targets them directly.
    private var availableTransitions: [TaskStatus] {
        [TaskStatus.inProgress, .blocked, .done, .cancelled].filter { $0 != task.status }
    }

    private var isSettled: Bool { task.status == .done || task.status == .cancelled }

    private func title(for id: String) -> String {
        allTasks.first(where: { $0.id == id })?.title ?? id
    }

    var body: some View {
        Card(padding: Space.md) {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(alignment: .top, spacing: Space.sm) {
                    StatusDot(isRunning: task.status == .inProgress, isFailed: task.status == .unknown, size: 8)
                        .padding(.top, 3)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.title)
                            .font(Kind.bodyEmphasis)
                            .foregroundStyle(isSettled ? theme.color(\.textMuted) : theme.color(\.textPrimary))
                            .strikethrough(isSettled)
                            .lineLimit(2)

                        if let parentId = task.parentId {
                            Text("parent: \(title(for: parentId))")
                                .font(Kind.caption)
                                .foregroundStyle(theme.color(\.textMuted))
                                .lineLimit(1)
                        }
                        if !task.deps.isEmpty {
                            Text("depends on: \(task.deps.map(title(for:)).joined(separator: ", "))")
                                .font(Kind.caption)
                                .foregroundStyle(theme.color(\.textMuted))
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: Space.sm)

                    if let updatedAt = task.updatedAt {
                        Text(updatedAt, style: .relative)
                            .font(Kind.caption)
                            .foregroundStyle(theme.color(\.textMuted))
                    }
                }

                HStack(spacing: Space.xs) {
                    ForEach(availableTransitions, id: \.self) { status in
                        Button(actionLabel(for: status)) { onSetStatus(status) }
                            .buttonStyle(SoftButton(tone: status == .done ? .accent : .neutral, size: .compact))
                    }
                    Spacer(minLength: 0)
                    Button {
                        confirmingDelete = true
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(SoftButton(tone: .danger, size: .compact))
                    .help("Delete task")
                }
            }
        }
        .confirmationDialog("Delete this task?", isPresented: $confirmingDelete) {
            Button("Delete", role: .destructive, action: onDelete)
        }
    }

    private func actionLabel(for status: TaskStatus) -> String {
        switch status {
        case .inProgress: return "Start"
        case .blocked: return "Block"
        case .done: return "Done"
        case .cancelled: return "Cancel"
        case .todo, .unknown: return status.rawValue
        }
    }
}

/// Display metadata `TaskStatus` itself doesn't carry — kept as an extension
/// here rather than in `Tasks.swift`, which stays free of view-layer concerns.
private extension TaskStatus {
    var label: String {
        switch self {
        case .todo: return "To Do"
        case .inProgress: return "In Progress"
        case .blocked: return "Blocked"
        case .done: return "Done"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    var tone: CountPill.Tone {
        switch self {
        case .inProgress: return .accent
        case .blocked: return .warning
        case .unknown: return .danger
        case .todo, .done, .cancelled: return .neutral
        }
    }
}
