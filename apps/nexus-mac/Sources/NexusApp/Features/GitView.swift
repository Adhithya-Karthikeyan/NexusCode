import SwiftUI
import NexusKit
import Foundation

/// The git flows as real actions: explain, review, commit, and describe a PR
/// — backed by `nexus explain` / `nexus review` / `nexus commit` / `nexus pr`.
///
/// Verified against the real CLI (`nexus <cmd> --help` and `wave6.ts`) before
/// writing this: none of the four streams `UiEvent` ndjson. Each is a
/// one-shot command that prints either plain text or, with `-o json`, a
/// single JSON document (`parseOutput` in `wave6.ts` only recognizes
/// `json`/`text`; passing `ndjson` silently falls back to `text`). So this
/// view runs them with `NexusClient.runJSON` — a spinner while in flight, the
/// parsed result after — the same shape `SessionsView`/`TasksView` use for
/// their one-shot calls, not a live streaming panel.
///
/// Staged/working-tree state is read directly via a local, read-only `git`
/// (rev-parse/diff --quiet/diff) rather than through `nexus` — there is no
/// read-only `nexus git status`-equivalent subcommand to ask, and every git
/// flow above already shells out to the local `git` binary itself
/// (`packages/git/src/index.ts`, execFile, no shell), so this mirrors what the
/// CLI already assumes rather than adding a new dependency. Nothing here
/// mutates or calls a provider; only `nexus commit --approve` does that.
struct GitView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme

    @State private var client: NexusClient?
    @State private var repoState: GitRepoState?

    var body: some View {
        // Header pinned, body fills-or-scrolls — see `PageScaffold`'s doc
        // comment. The populated case (status card + four action cards) is
        // real, often-tall content, so it keeps its own `ScrollView`; the
        // "not a repo" / "no executable" / loading states are single hero
        // moments that now fill and centre in the space below the header
        // instead of sitting pinned to the top of a mostly-black window.
        PageScaffold {
            headerRow
                .padding(.horizontal, Space.xl)
                .padding(.top, Space.xl)
                .padding(.bottom, Space.lg)
        } content: {
            if let client {
                if let repoState {
                    if !repoState.isRepo {
                        HeroEmptyState(
                            icon: "exclamationmark.triangle",
                            title: "Not a git repository",
                            message: "\(workspace.projectDirectory.path) isn't a git checkout, so there's nothing to commit, review, explain, or describe."
                        )
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: Space.lg) {
                                repoStatusCard(repoState)
                                ExplainCard(client: client, cwd: workspace.projectDirectory, repoState: repoState)
                                ReviewCard(client: client, cwd: workspace.projectDirectory, repoState: repoState)
                                CommitCard(
                                    client: client, cwd: workspace.projectDirectory, repoState: repoState,
                                    onCommitted: { await refreshRepoState() }
                                )
                                PrCard(client: client, cwd: workspace.projectDirectory, repoState: repoState)
                            }
                            .padding(.horizontal, Space.xl)
                            .padding(.bottom, Space.xl)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } else {
                    LoadingState(message: "Checking repository state…")
                }
            } else {
                HeroEmptyState(
                    icon: "terminal",
                    title: "No nexus executable",
                    message: workspace.setupProblem ?? "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                )
            }
        }
        .background(theme.color(\.surfaceBase))
        .task(id: workspace.projectDirectory) { await attach() }
    }

    // MARK: - Header

    private var headerRow: some View {
        PageHeader(
            "Git",
            subtitle: "Commit, review, explain, and describe — nexus commit/review/explain/pr",
            accessory: AnyView(
                Button {
                    Task { await refreshRepoState() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(SoftButton(size: .compact))
            )
        )
    }

    private func repoStatusCard(_ state: GitRepoState) -> some View {
        Card(padding: Space.md) {
            HStack(spacing: Space.lg) {
                Metric(
                    label: "staged",
                    value: state.hasStaged ? "\(state.stagedFileCount) file\(state.stagedFileCount == 1 ? "" : "s")" : "none",
                    emphasis: state.hasStaged
                )
                Metric(
                    label: "working tree",
                    value: state.hasWorking ? "\(state.workingFileCount) file\(state.workingFileCount == 1 ? "" : "s")" : "clean"
                )
                Spacer(minLength: 0)
                if !state.hasAnyChanges {
                    CountPill(text: "clean", tone: .neutral)
                }
            }
        }
    }

    // MARK: - Attach

    private func attach() async {
        guard let binary = workspace.binary else {
            client = nil
            repoState = nil
            return
        }
        client = NexusClient(binary: binary)
        await refreshRepoState()
    }

    private func refreshRepoState() async {
        repoState = await GitRepoState.load(cwd: workspace.projectDirectory)
    }
}

// MARK: - Local repo state

/// Staged/working-tree state, read locally and read-only. `stagedDiff`/
/// `workingDiff` are only fetched when their `--quiet` probe says there's
/// something there, so a clean repo never pays for a diff it doesn't need.
private struct GitRepoState {
    let isRepo: Bool
    let hasStaged: Bool
    let hasWorking: Bool
    let stagedDiff: String
    let workingDiff: String

    var hasAnyChanges: Bool { hasStaged || hasWorking }

    /// What a git flow will actually see: staged wins (it's what `nexus
    /// commit` generates from), else the working tree — matching
    /// `resolveDiff`'s own precedence in `wave6.ts`.
    var previewDiff: String { hasStaged ? stagedDiff : workingDiff }

    static func fileCount(in diff: String) -> Int {
        diff.split(separator: "\n", omittingEmptySubsequences: true)
            .filter { $0.hasPrefix("diff --git ") }
            .count
    }
    var stagedFileCount: Int { Self.fileCount(in: stagedDiff) }
    var workingFileCount: Int { Self.fileCount(in: workingDiff) }

    static func load(cwd: URL) async -> GitRepoState {
        let repoCheck = await LocalGit.run(["rev-parse", "--is-inside-work-tree"], cwd: cwd)
        guard repoCheck.exitCode == 0 else {
            return GitRepoState(isRepo: false, hasStaged: false, hasWorking: false, stagedDiff: "", workingDiff: "")
        }

        async let stagedProbe = LocalGit.run(["diff", "--cached", "--quiet"], cwd: cwd)
        async let workingProbe = LocalGit.run(["diff", "--quiet"], cwd: cwd)
        let (staged, working) = await (stagedProbe, workingProbe)
        // `git diff --quiet` exits 1 when there IS a difference, 0 when clean;
        // any other code (no HEAD yet, etc.) is treated as "nothing to show"
        // rather than misread as a diff.
        let hasStaged = staged.exitCode == 1
        let hasWorking = working.exitCode == 1

        async let stagedDiffText = hasStaged ? LocalGit.run(["diff", "--cached"], cwd: cwd).stdout : ""
        async let workingDiffText = hasWorking ? LocalGit.run(["diff"], cwd: cwd).stdout : ""

        return GitRepoState(
            isRepo: true,
            hasStaged: hasStaged,
            hasWorking: hasWorking,
            stagedDiff: await stagedDiffText,
            workingDiff: await workingDiffText
        )
    }
}

/// Runs a read-only `git` subprocess. Deliberately not `NexusClient` — this
/// never talks to `nexus` or a provider, only the local `git` binary, exactly
/// as `@nexuscode/git` does under the hood for these same flows.
private enum LocalGit {
    static func run(_ arguments: [String], cwd: URL) async -> (exitCode: Int32, stdout: String) {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: binaryPath())
            process.arguments = arguments
            process.currentDirectoryURL = cwd
            let out = Pipe()
            process.standardOutput = out
            process.standardError = Pipe()
            process.terminationHandler = { finished in
                let data = out.fileHandleForReading.readDataToEndOfFile()
                let text = String(data: data, encoding: .utf8) ?? ""
                continuation.resume(returning: (finished.terminationStatus, text))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: (-1, ""))
            }
        }
    }

    /// `/usr/bin/git` ships with the Xcode command-line tools on every Mac
    /// this app targets; Homebrew installs are checked first in case a newer
    /// `git` is what the user's repo actually expects.
    private static func binaryPath() -> String {
        ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
            .first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/git"
    }
}

// MARK: - Action state

/// Shared run state for the four action cards below — deliberately not tied
/// to `ViewState`/`UiEvent`, since none of these commands stream one.
private enum ActionState<T> {
    case idle
    case running
    case success(T)
    case failure(String)

    var isRunning: Bool { if case .running = self { return true } else { return false } }
}

/// A run/regenerate button that swaps in a spinner while its action is in
/// flight — the one control every card below uses.
private struct RunButton: View {
    let title: String
    let tone: SoftButton.Tone
    let isRunning: Bool
    let isDisabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if isRunning {
                ProgressView().controlSize(.small)
            } else {
                Text(title)
            }
        }
        .buttonStyle(SoftButton(tone: tone))
        .disabled(isRunning || isDisabled)
    }
}

private struct ActionErrorText: View {
    @Environment(\.nexusTheme) private var theme
    let message: String

    var body: some View {
        Text(message)
            .font(Kind.caption)
            .foregroundStyle(theme.color(\.errorFg))
            .textSelection(.enabled)
    }
}

// MARK: - Explain

private struct ExplainCard: View {
    @Environment(\.nexusTheme) private var theme
    let client: NexusClient
    let cwd: URL
    let repoState: GitRepoState

    @State private var state: ActionState<String> = .idle

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader("Explain", subtitle: "Plain-language summary of the diff — nexus explain")

                if !repoState.hasAnyChanges {
                    Text("Nothing to explain — the working tree is clean.")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                } else {
                    CodeBlock(text: repoState.previewDiff, isDiff: true, maxHeight: 160)

                    HStack {
                        RunButton(title: "Explain diff", tone: .accent, isRunning: state.isRunning, isDisabled: false, action: run)
                        Spacer(minLength: 0)
                    }

                    switch state {
                    case .idle, .running: EmptyView()
                    case .failure(let message): ActionErrorText(message: message)
                    case .success(let text): CodeBlock(text: text, isDiff: false)
                    }
                }
            }
        }
    }

    private func run() {
        state = .running
        Task {
            switch await client.runJSON(NexusCommand.json(["explain"], cwd: cwd)) {
            case .success(let value):
                state = .success(value["explanation"]?.stringValue ?? "")
            case .failure(let error):
                state = .failure(error.message)
            }
        }
    }
}

// MARK: - Review

private struct ReviewComment: Identifiable {
    let id = UUID()
    let severity: String
    let file: String?
    let line: Int?
    let message: String

    init?(json: JSONValue) {
        guard let message = json["message"]?.stringValue else { return nil }
        self.severity = json["severity"]?.stringValue ?? "info"
        self.file = json["file"]?.stringValue
        self.line = json["line"]?.intValue
        self.message = message
    }
}

private struct ReviewResult {
    let summary: String
    let comments: [ReviewComment]
}

private struct ReviewCard: View {
    @Environment(\.nexusTheme) private var theme
    let client: NexusClient
    let cwd: URL
    let repoState: GitRepoState

    @State private var state: ActionState<ReviewResult> = .idle

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader("Review", subtitle: "Correctness, clarity, security, and style — nexus review")

                if !repoState.hasAnyChanges {
                    Text("Nothing to review — the working tree is clean.")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                } else {
                    CodeBlock(text: repoState.previewDiff, isDiff: true, maxHeight: 160)

                    HStack {
                        RunButton(title: "Review changes", tone: .accent, isRunning: state.isRunning, isDisabled: false, action: run)
                        Spacer(minLength: 0)
                    }

                    switch state {
                    case .idle, .running: EmptyView()
                    case .failure(let message): ActionErrorText(message: message)
                    case .success(let review):
                        VStack(alignment: .leading, spacing: Space.sm) {
                            if !review.summary.isEmpty {
                                Text(review.summary)
                                    .font(Kind.body)
                                    .foregroundStyle(theme.color(\.textPrimary))
                            }
                            if review.comments.isEmpty {
                                Text("No issues flagged.")
                                    .font(Kind.caption)
                                    .foregroundStyle(theme.color(\.textMuted))
                            } else {
                                VStack(alignment: .leading, spacing: Space.xs) {
                                    ForEach(review.comments) { comment in
                                        ReviewCommentRow(comment: comment)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func run() {
        state = .running
        Task {
            switch await client.runJSON(NexusCommand.json(["review"], cwd: cwd)) {
            case .success(let value):
                let summary = value["summary"]?.stringValue ?? ""
                let comments = value["comments"]?.arrayValue?.compactMap(ReviewComment.init(json:)) ?? []
                state = .success(ReviewResult(summary: summary, comments: comments))
            case .failure(let error):
                state = .failure(error.message)
            }
        }
    }
}

private struct ReviewCommentRow: View {
    @Environment(\.nexusTheme) private var theme
    let comment: ReviewComment

    private var tone: CountPill.Tone {
        switch comment.severity {
        case "error": return .danger
        case "warning": return .warning
        default: return .neutral
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            CountPill(text: comment.severity, tone: tone)
            VStack(alignment: .leading, spacing: 2) {
                if let file = comment.file {
                    Text(comment.line.map { "\(file):\($0)" } ?? file)
                        .font(Kind.monoSmall)
                        .foregroundStyle(theme.color(\.textMuted))
                }
                Text(comment.message)
                    .font(Kind.body)
                    .foregroundStyle(theme.color(\.textSecondary))
            }
        }
    }
}

// MARK: - Commit

private struct CommitMessage {
    let message: String
    let header: String
    let type: String?
    let scope: String?
    let breaking: Bool

    init(json: JSONValue) {
        self.message = json["message"]?.stringValue ?? ""
        self.header = json["header"]?.stringValue ?? ""
        self.type = json["type"]?.stringValue
        self.scope = json["scope"]?.stringValue
        self.breaking = json["breaking"]?.boolValue ?? false
    }
}

/// `nexus commit`'s two effects — message generation (safe, repeatable) and
/// `--approve` (a real `git commit`) — are genuinely two separate CLI calls;
/// there is no "commit exactly this text" flag, so `--approve` REGENERATES
/// the message from the current staged diff rather than applying the one
/// shown above. That's disclosed in the UI rather than left implicit, since
/// the two calls can legitimately disagree.
private struct CommitCard: View {
    @Environment(\.nexusTheme) private var theme
    let client: NexusClient
    let cwd: URL
    let repoState: GitRepoState
    let onCommitted: () async -> Void

    @State private var messageState: ActionState<CommitMessage> = .idle
    @State private var applyState: ActionState<Bool> = .idle
    @State private var confirmingApply = false

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader("Commit", subtitle: "Conventional Commit message from the staged diff — nexus commit")

                if !repoState.hasStaged {
                    Text(
                        repoState.hasWorking
                            ? "Nothing staged. `nexus commit` will generate a message from the unstaged working-tree diff, but applying it needs staged changes first (git add)."
                            : "Nothing staged, and the working tree is clean — nothing to commit."
                    )
                    .font(Kind.caption)
                    .foregroundStyle(theme.color(\.warningFg))
                }

                if repoState.hasAnyChanges {
                    CodeBlock(text: repoState.previewDiff, isDiff: true, maxHeight: 160)

                    HStack {
                        RunButton(title: "Generate message", tone: .accent, isRunning: messageState.isRunning, isDisabled: false, action: generate)
                        Spacer(minLength: 0)
                    }

                    switch messageState {
                    case .idle, .running: EmptyView()
                    case .failure(let message): ActionErrorText(message: message)
                    case .success(let commitMessage):
                        VStack(alignment: .leading, spacing: Space.sm) {
                            CodeBlock(text: commitMessage.message, isDiff: false)

                            HStack(spacing: Space.sm) {
                                RunButton(
                                    title: "Commit",
                                    tone: .danger,
                                    isRunning: applyState.isRunning,
                                    isDisabled: !repoState.hasStaged,
                                    action: { confirmingApply = true }
                                )
                                Spacer(minLength: 0)
                            }

                            Text("Re-generates the message from the current staged diff and runs `git commit` — this applies a real commit and cannot be undone from here.")
                                .font(Kind.caption)
                                .foregroundStyle(theme.color(\.textMuted))

                            switch applyState {
                            case .idle, .running: EmptyView()
                            case .failure(let message): ActionErrorText(message: message)
                            case .success:
                                Text("Committed.")
                                    .font(Kind.caption)
                                    .foregroundStyle(theme.color(\.successFg))
                            }
                        }
                    }
                }
            }
        }
        .confirmationDialog("Commit staged changes?", isPresented: $confirmingApply) {
            Button("Commit", role: .destructive, action: apply)
        } message: {
            Text("Runs `nexus commit --approve`: regenerates the commit message from the staged diff and applies it with `git commit`. This cannot be undone from here.")
        }
    }

    private func generate() {
        messageState = .running
        Task {
            switch await client.runJSON(NexusCommand.json(["commit"], cwd: cwd)) {
            case .success(let value):
                messageState = .success(CommitMessage(json: value))
            case .failure(let error):
                messageState = .failure(error.message)
            }
        }
    }

    private func apply() {
        applyState = .running
        Task {
            switch await client.runJSON(NexusCommand.json(["commit", "--approve"], cwd: cwd)) {
            case .success(let value):
                messageState = .success(CommitMessage(json: value))
                applyState = .success(true)
                await onCommitted()
            case .failure(let error):
                applyState = .failure(error.message)
            }
        }
    }
}

// MARK: - PR

private struct PrResult {
    let title: String
    let body: String
}

private struct PrCard: View {
    @Environment(\.nexusTheme) private var theme
    let client: NexusClient
    let cwd: URL
    let repoState: GitRepoState

    @State private var baseRef = ""
    @State private var state: ActionState<PrResult> = .idle

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionHeader("Pull request", subtitle: "Title + description from commits/diff — nexus pr")

                HStack(spacing: Space.sm) {
                    Text("Base ref")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                    TextField("main (optional)", text: $baseRef)
                        .textFieldStyle(.plain)
                        .font(Kind.body)
                        .foregroundStyle(theme.color(\.textPrimary))
                        .padding(.horizontal, Space.sm)
                        .padding(.vertical, 5)
                        .background(theme.color(\.surfaceOverlay), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                                .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
                        }
                        .frame(maxWidth: 200)
                }

                HStack {
                    RunButton(title: "Generate PR description", tone: .accent, isRunning: state.isRunning, isDisabled: false, action: run)
                    Spacer(minLength: 0)
                }

                switch state {
                case .idle, .running: EmptyView()
                case .failure(let message): ActionErrorText(message: message)
                case .success(let pr):
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(pr.title)
                            .font(Kind.bodyEmphasis)
                            .foregroundStyle(theme.color(\.textPrimary))
                        CodeBlock(text: pr.body, isDiff: false)
                    }
                }
            }
        }
    }

    private func run() {
        state = .running
        let base = baseRef.trimmingCharacters(in: .whitespacesAndNewlines)
        var args = ["pr"]
        if !base.isEmpty { args += ["--base", base] }
        Task {
            switch await client.runJSON(NexusCommand.json(args, cwd: cwd)) {
            case .success(let value):
                state = .success(PrResult(title: value["title"]?.stringValue ?? "", body: value["body"]?.stringValue ?? ""))
            case .failure(let error):
                state = .failure(error.message)
            }
        }
    }
}
