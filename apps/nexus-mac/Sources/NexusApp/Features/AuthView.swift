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
/// A no-argument `View`, like `AgentsView` and `SettingsView`: it reads
/// `workspace.binary` — the ONE binary `WorkspaceModel.attach()` already
/// resolved, not a fresh `NexusBinary.discover` — but owns its
/// `AuthController` entirely, so it can be dropped into `RootView`'s tab
/// switch with no wiring beyond that.
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
                    message: workspace.setupProblem ?? "The app drives the `nexus` CLI. Point it at a checkout, or set NEXUS_BIN."
                )
            }
        }
        .task {
            guard controller == nil else { return }
            guard let binary = workspace.binary else { return }
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
        // The error banner is a top-pinned caveat, shown across every state
        // below it (loading, empty, or the real provider list) rather than
        // living inside whichever branch happens to render — a failed
        // refresh must stay visible even while the loading spinner or the
        // empty state is what's on screen. The state below it fills the rest
        // of the window instead of top-aligning inside a `ScrollView`, which
        // is what let "No providers found" float with a dead void beneath it.
        VStack(alignment: .leading, spacing: 0) {
            // This screen had no page title at all before — straight from
            // the window background into "Signed in"/"Available" subsection
            // labels, so its own name never appeared anywhere on it.
            PageHeader("Accounts", subtitle: "Provider sign-in — nexus auth status/login")

            // Dismissible: whatever provider list is already loaded below
            // (or the empty/loading state) stays exactly as valid either
            // way — see `InlineBanner`'s doc for why that's unconditional.
            // `.warning`, not `.error`: every one of `AuthController.error`'s
            // sources (a failed refresh, a failed key save, a failed sign
            // out) is retryable, none is a state the user is blocked on —
            // the same shape `SessionsView`/`IntegrationsView` already use
            // this tone for, not a harder failure that earns the alarm colour.
            if let error = controller.error {
                InlineBanner(message: error, tone: .warning) { controller.error = nil }
                    .padding(.horizontal, Space.xl)
                    .padding(.top, Space.xl)
                    .padding(.bottom, Space.sm)
            }

            Group {
                if controller.isLoading && controller.providers.isEmpty {
                    LoadingState(message: "Loading auth status…", style: .inline)
                } else if controller.providers.isEmpty {
                    HeroEmptyState(
                        icon: "person.badge.key",
                        title: "No providers found",
                        message: "`nexus auth status` returned nothing to show."
                    )
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Space.lg) {
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
                        .padding(Space.xl)
                        .padding(.top, controller.error == nil ? 0 : Space.sm)
                        .pageMeasure()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
    @State private var confirmingSignOut = false
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
                HStack(alignment: .top, spacing: Space.md) {
                    // Identity at rest, status while working. This row IS
                    // provenance — it is the list of who you can talk to — so
                    // the provider's own colour belongs here (see
                    // `ProviderIdentity`). A `StatusDot` showing only
                    // "signing in" left every row a neutral grey the rest of
                    // the time, which is exactly the information this screen
                    // exists to convey being thrown away. The animated dot
                    // still wins while a sign-in is in flight, because motion
                    // means "live" and that outranks identity for the moment
                    // it applies.
                    Group {
                        if isSigningIn {
                            StatusDot(isRunning: true, isFailed: false, size: 8)
                        } else {
                            ProviderDot(provider: provider.providerId, size: 8)
                        }
                    }
                    .padding(.top, 4)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: Space.sm) {
                            Text(provider.providerId)
                                .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(theme.color(\.textPrimary))
                            KindBadge(icon: kindIcon, label: kindLabel)
                        }
                        Text(provider.loggedIn ? provider.method : "not signed in")
                            .textStyle(Type.caption)
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
                        .textStyle(Type.caption)
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
                            .textStyle(Type.micro)
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
                        .textStyle(Type.mono)
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
                    // The text beside it already says "detected"/"not
                    // detected" — this glyph repeats that, it doesn't add to it.
                    .accessibilityHidden(true)
                Text(
                    provider.loggedIn
                        ? "Session detected — reuses the vendor CLI's own login."
                        : "Not detected — install and sign in to the vendor CLI directly; no login needed here."
                )
                .textStyle(Type.caption)
                .foregroundStyle(theme.color(\.textMuted))
            }

        case .unknown:
            EmptyView()
        }
    }

    // Confirmed like every other action that requires re-authentication to
    // undo: signing out revokes the live session, and getting back in means
    // running the whole OAuth/API-key flow again, not a simple undo. Matches
    // the gate already on "Delete task" and "Commit" (see `TasksView.swift:
    // 373-375`, `GitView.swift:548-552`).
    private var signOutRow: some View {
        HStack {
            Spacer(minLength: 0)
            Button("Sign out", role: .destructive) {
                confirmingSignOut = true
            }
            .buttonStyle(SoftButton(tone: .danger, size: .compact))
        }
        .confirmationDialog("Sign out of \(provider.providerId)?", isPresented: $confirmingSignOut) {
            Button("Sign Out", role: .destructive, action: onSignOut)
        } message: {
            Text("Revokes the current session. You'll need to sign in again to use \(provider.providerId).")
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
                        .textStyle(Type.caption)
                        .foregroundStyle(theme.color(\.textMuted))
                }
            } else {
                CodeBlock(text: lines.joined(separator: "\n"), maxHeight: 140)
            }

            HStack(spacing: Space.sm) {
                TextField("Paste the code shown in your browser, if asked", text: $pastedCode)
                    .textFieldStyle(.roundedBorder)
                    .textStyle(Type.mono)
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
            // `label` (e.g. "OAUTH", "API KEY") already names the kind this
            // badge shows — the glyph is a visual accent on that same fact.
            Image(systemName: icon).font(.system(size: 10))
                .accessibilityHidden(true)
            Text(label.uppercased())
        }
        .textStyle(Type.micro)
        .padding(.horizontal, 5)
        .padding(.vertical, 1.5)
        .background(theme.color(\.surfaceOverlay), in: Capsule())
        .foregroundStyle(theme.color(\.textMuted))
    }
}
