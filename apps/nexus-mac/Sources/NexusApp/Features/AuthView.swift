import SwiftUI
import NexusKit

/// Sign-in, front and center.
///
/// This app is a harness over several vendor backends — Claude, ChatGPT,
/// Gemini and the rest — so knowing exactly who is signed in, and by which
/// REAL flow, is a first-class surface, not a settings checkbox. Every
/// action here maps onto a real `nexus` subcommand (`auth status`, `login`,
/// `logout`, `keys set --stdin`); nothing talks to a provider directly, and
/// no key value is ever held longer than the single write `AuthController`
/// makes into a child process's stdin — see that type for the full contract.
///
/// A no-argument `View`, like `AgentsView` and `SettingsView`: it reads the
/// active project directory from `WorkspaceModel` (for `NexusBinary`
/// discovery — the same repo-local dev-build fallback `WorkspaceModel`
/// itself uses) but owns its `AuthController` entirely, so it can be dropped
/// into `RootView`'s tab switch with no wiring beyond that.
struct AuthView: View {
    @Environment(WorkspaceModel.self) private var workspace
    @Environment(\.nexusTheme) private var theme
    @State private var controller: AuthController?

    var body: some View {
        Group {
            if let controller {
                AuthContent(controller: controller)
            } else {
                HeroEmptyState(
                    icon: "person.badge.key",
                    title: "No nexus executable",
                    message: "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                )
            }
        }
        .task {
            guard controller == nil else { return }
            guard let binary = NexusBinary.discover(repoRoot: workspace.projectDirectory) else { return }
            let created = AuthController(
                client: NexusClient(binary: binary),
                binary: binary,
                workingDirectory: workspace.projectDirectory
            )
            controller = created
            await created.refresh()
        }
    }
}

/// The loaded surface: signed-in providers, available ones, loading/empty/
/// error states, and every in-flight sign-in's live progress. Split from
/// `AuthView` so the per-provider streaming/draft state below only exists
/// once a controller is actually available.
private struct AuthContent: View {
    @Environment(\.nexusTheme) private var theme
    let controller: AuthController

    /// Accumulated progress lines per provider, for whichever `signIn` flows
    /// are currently running. `AuthController` streams; this view is what
    /// remembers what has scrolled by so far.
    @State private var progressLines: [String: [String]] = [:]
    /// The task consuming each provider's `signIn` stream — cancelling this
    /// is what actually tears down the live `nexus login` process (see
    /// `AuthController.signIn`'s cancellation contract).
    @State private var streamTasks: [String: Task<Void, Never>] = [:]
    @State private var pastedCode: [String: String] = [:]
    @State private var keyDrafts: [String: String] = [:]
    @State private var savingKey: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                if controller.isLoading && controller.providers.isEmpty {
                    HStack(spacing: Space.sm) {
                        ProgressView().controlSize(.small)
                        Text("Loading auth status…")
                            .font(Kind.body)
                            .foregroundStyle(theme.color(\.textMuted))
                    }
                    .frame(maxWidth: .infinity, minHeight: 300)
                } else if controller.providers.isEmpty {
                    HeroEmptyState(
                        icon: "person.badge.key",
                        title: "No providers found",
                        message: "`nexus auth status` returned nothing to show."
                    )
                    .frame(minHeight: 380)
                } else {
                    if !controller.signedIn.isEmpty {
                        providerSection(
                            title: "Signed in",
                            subtitle: "\(controller.signedIn.count) provider\(controller.signedIn.count == 1 ? "" : "s") ready to use",
                            rows: controller.signedIn
                        )
                    }
                    if !controller.available.isEmpty {
                        providerSection(
                            title: "Available",
                            subtitle: "Not signed in yet",
                            rows: controller.available
                        )
                    }
                }

                if let error = controller.error {
                    ErrorBanner(message: error)
                }
            }
            .padding(Space.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(theme.color(\.surfaceBase))
        .task { await controller.refresh() }
        .onDisappear {
            for task in streamTasks.values { task.cancel() }
        }
    }

    @ViewBuilder
    private func providerSection(title: String, subtitle: String, rows: [ProviderAuth]) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SectionHeader(title, subtitle: subtitle)
            VStack(spacing: Space.md) {
                ForEach(rows) { provider in
                    ProviderRow(
                        provider: provider,
                        isSigningIn: controller.isSigningIn(provider.providerId),
                        progressLines: progressLines[provider.providerId] ?? [],
                        pastedCode: bindingForCode(provider.providerId),
                        keyDraft: bindingForKey(provider.providerId),
                        isSavingKey: savingKey.contains(provider.providerId),
                        onSignIn: { startSignIn(provider.providerId) },
                        onCancelSignIn: { cancelSignIn(provider.providerId) },
                        onSubmitCode: { submitCode(provider.providerId) },
                        onSaveKey: { saveKey(provider.providerId) },
                        onSignOut: { Task { await controller.signOut(provider: provider.providerId) } }
                    )
                }
            }
        }
    }

    private func bindingForCode(_ id: String) -> Binding<String> {
        Binding(get: { pastedCode[id] ?? "" }, set: { pastedCode[id] = $0 })
    }

    private func bindingForKey(_ id: String) -> Binding<String> {
        Binding(get: { keyDrafts[id] ?? "" }, set: { keyDrafts[id] = $0 })
    }

    private func startSignIn(_ id: String) {
        guard streamTasks[id] == nil else { return }
        progressLines[id] = []
        streamTasks[id] = Task {
            let stream = await controller.signIn(provider: id)
            for await line in stream {
                if Task.isCancelled { break }
                progressLines[id, default: []].append(line)
            }
            streamTasks[id] = nil
            pastedCode[id] = ""
        }
    }

    /// Cancels both layers: the local task consuming the stream, and the
    /// controller's own record of the flow (which is what actually
    /// terminates the `nexus login` process — see `AuthController.
    /// cancelSignIn`). Belt-and-suspenders rather than relying on
    /// cancellation propagating through the stream alone.
    private func cancelSignIn(_ id: String) {
        streamTasks[id]?.cancel()
        streamTasks[id] = nil
        Task { await controller.cancelSignIn(for: id) }
    }

    private func submitCode(_ id: String) {
        let code = pastedCode[id] ?? ""
        guard !code.isEmpty else { return }
        Task { await controller.submitCode(code, for: id) }
        pastedCode[id] = ""
    }

    private func saveKey(_ id: String) {
        let key = keyDrafts[id] ?? ""
        guard !key.isEmpty else { return }
        savingKey.insert(id)
        Task {
            await controller.signInWithKey(provider: id, key: key)
            keyDrafts[id] = ""
            savingKey.remove(id)
        }
    }
}

/// One provider: name, method, status, expiry, and the one action that
/// matches its `kind` — never a generic "sign in" button that papers over
/// four genuinely different flows.
private struct ProviderRow: View {
    @Environment(\.nexusTheme) private var theme
    let provider: ProviderAuth
    let isSigningIn: Bool
    let progressLines: [String]
    @Binding var pastedCode: String
    @Binding var keyDraft: String
    let isSavingKey: Bool
    let onSignIn: () -> Void
    let onCancelSignIn: () -> Void
    let onSubmitCode: () -> Void
    let onSaveKey: () -> Void
    let onSignOut: () -> Void

    private var kindIcon: String {
        switch provider.kind {
        case .oauth: return "globe"
        case .apiKey: return "key.fill"
        case .cliDelegate: return "terminal.fill"
        case .cloudSso: return "cloud.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    private var kindLabel: String {
        switch provider.kind {
        case .oauth: return "OAuth"
        case .apiKey: return "API key"
        case .cliDelegate: return "CLI session"
        case .cloudSso: return "Cloud SSO"
        case .unknown: return "Unknown"
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Space.sm) {
                HStack(alignment: .top, spacing: Space.sm) {
                    StatusDot(isRunning: isSigningIn, isFailed: false, size: 8)
                        .padding(.top, 4)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: Space.xs) {
                            Text(provider.providerId)
                                .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(theme.color(\.textPrimary))
                            KindBadge(icon: kindIcon, label: kindLabel)
                        }
                        Text(provider.loggedIn ? provider.method : "not signed in")
                            .font(Kind.caption)
                            .foregroundStyle(provider.loggedIn ? theme.color(\.successFg) : theme.color(\.textMuted))
                    }

                    Spacer(minLength: Space.sm)

                    if let expiresIn = provider.expiresIn {
                        CountPill(text: "expires \(expiresIn)", tone: .neutral)
                    }
                }

                // The CLI's `detail` already explains exactly what's missing
                // (which env var, which vendor CLI to install) — shown
                // verbatim rather than summarized into something vaguer.
                if let detail = provider.detail {
                    Text(detail)
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textSecondary))
                        .fixedSize(horizontal: false, vertical: true)
                }

                actionArea
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(
                    isSigningIn ? theme.color(\.accentDefault).opacity(0.5) : .clear,
                    lineWidth: isSigningIn ? 1.4 : 0
                )
        }
    }

    @ViewBuilder
    private var actionArea: some View {
        switch provider.kind {
        case .oauth, .cloudSso:
            if isSigningIn {
                OAuthProgress(
                    lines: progressLines,
                    pastedCode: $pastedCode,
                    onSubmitCode: onSubmitCode,
                    onCancel: onCancelSignIn
                )
            } else if provider.loggedIn {
                signOutRow
            } else {
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack {
                        Spacer(minLength: 0)
                        Button(provider.kind == .cloudSso ? "Connect" : "Sign in with browser", action: onSignIn)
                            .buttonStyle(SoftButton(tone: .accent, size: .compact))
                    }
                    if provider.kind == .cloudSso {
                        Text("Delegates to the cloud CLI's own login (e.g. `aws sso login` / `gcloud auth login`) — nothing is reimplemented here.")
                            .font(Kind.micro)
                            .foregroundStyle(theme.color(\.textMuted))
                    }
                }
            }

        case .apiKey:
            if provider.loggedIn {
                signOutRow
            } else {
                HStack(spacing: Space.sm) {
                    SecureField("API key", text: $keyDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(Kind.mono)
                    Button("Save") { onSaveKey() }
                        .buttonStyle(SoftButton(tone: .accent, size: .compact))
                        .disabled(keyDraft.isEmpty || isSavingKey)
                    if isSavingKey {
                        ProgressView().controlSize(.small)
                    }
                }
            }

        case .cliDelegate:
            HStack(spacing: Space.xs) {
                Image(systemName: provider.loggedIn ? "checkmark.circle.fill" : "xmark.circle")
                    .font(.system(size: 11))
                    .foregroundStyle(provider.loggedIn ? theme.color(\.successFg) : theme.color(\.textMuted))
                Text(
                    provider.loggedIn
                        ? "Session detected — reuses the vendor CLI's own login."
                        : "Not detected — install and sign in to the vendor CLI directly; no login needed here."
                )
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textMuted))
            }

        case .unknown:
            EmptyView()
        }
    }

    private var signOutRow: some View {
        HStack {
            Spacer(minLength: 0)
            Button("Sign out", role: .destructive, action: onSignOut)
                .buttonStyle(SoftButton(tone: .danger, size: .compact))
        }
    }
}

/// Live progress for an in-flight `signIn` flow: the streamed lines (the
/// authorize URL especially), an optional code-paste field for flows that
/// need one (Anthropic's manual-code paste — see `LoginSession`'s doc), and
/// a Cancel button. The paste field is harmless to show for a flow that
/// never reads it — it simply never gets submitted.
private struct OAuthProgress: View {
    @Environment(\.nexusTheme) private var theme
    let lines: [String]
    @Binding var pastedCode: String
    let onSubmitCode: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if lines.isEmpty {
                HStack(spacing: Space.xs) {
                    ProgressView().controlSize(.small)
                    Text("Starting…")
                        .font(Kind.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                }
            } else {
                CodeBlock(text: lines.joined(separator: "\n"), maxHeight: 140)
            }

            HStack(spacing: Space.sm) {
                TextField("Paste the code shown in your browser, if asked", text: $pastedCode)
                    .textFieldStyle(.roundedBorder)
                    .font(Kind.mono)
                    .onSubmit(onSubmitCode)
                Button("Submit", action: onSubmitCode)
                    .buttonStyle(SoftButton(size: .compact))
                    .disabled(pastedCode.isEmpty)
                Button("Cancel", role: .cancel, action: onCancel)
                    .buttonStyle(SoftButton(tone: .danger, size: .compact))
            }
        }
    }
}

/// The small "which kind of auth is this" chip — every provider gets one, so
/// the four genuinely different flows never blur together at a glance.
private struct KindBadge: View {
    @Environment(\.nexusTheme) private var theme
    let icon: String
    let label: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 8))
            Text(label.uppercased())
        }
        .font(Kind.micro)
        .padding(.horizontal, 5)
        .padding(.vertical, 1.5)
        .background(theme.color(\.surfaceOverlay), in: Capsule())
        .foregroundStyle(theme.color(\.textMuted))
    }
}

private struct ErrorBanner: View {
    @Environment(\.nexusTheme) private var theme
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(theme.color(\.errorFg))
            Text(message)
                .font(Kind.caption)
                .foregroundStyle(theme.color(\.textSecondary))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Space.md)
        .background(theme.color(\.errorBg), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}
