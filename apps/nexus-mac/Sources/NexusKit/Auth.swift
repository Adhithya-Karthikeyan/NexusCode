import Foundation
import Observation

/// The four honest ways a provider authenticates — mirrors `AuthStrategyKind`
/// in `@nexuscode/auth` (`"oauth" | "cli-delegate" | "api-key" | "cloud-sso"`,
/// see `packages/auth/src/strategies/types.ts`). Never a faked fifth kind:
/// every provider genuinely is one of these four.
public enum AuthKind: String, Sendable, Hashable {
    case oauth
    case apiKey = "api-key"
    case cliDelegate = "cli-delegate"
    case cloudSso = "cloud-sso"
    /// A kind this build doesn't recognize yet. Never dropped — an older app
    /// build against a newer CLI that adds a fifth kind still shows the
    /// provider (with a generic treatment) instead of hiding it. Mirrors
    /// `TaskStatus.unknown`.
    case unknown

    public init(wire: String?) {
        self = wire.flatMap(AuthKind.init(rawValue:)) ?? .unknown
    }
}

/// One row of `nexus auth status -o json` (`AuthStatusRow` on the CLI side,
/// see `packages/cli/src/auth.ts`).
///
/// Decoded from the already-parsed `JSONValue` `NexusClient.runJSON` hands
/// back, following the same defensive style as `NexusSession`/`NexusTask`:
/// every field but `providerId` degrades independently rather than failing
/// the whole row. Never carries a secret/token value — the CLI's own row
/// type makes the same promise.
public struct ProviderAuth: Sendable, Hashable, Identifiable {
    public let providerId: String
    public let kind: AuthKind
    public let loggedIn: Bool
    public let method: String
    /// Extra, non-secret detail (e.g. "no key (set OPENAI_API_KEY or run
    /// login)", "gcloud not found") — often the ONE line that tells the user
    /// exactly what to do next, so it is shown verbatim rather than
    /// summarized.
    public let detail: String?
    /// Human "~5h"/"~42m" relative expiry (bearer tokens only), already
    /// formatted by the CLI — never a raw timestamp to compute here.
    public let expiresIn: String?

    public var id: String { providerId }

    /// Plain memberwise construction — for previews and tests. Kept separate
    /// from `init?(json:)` below, which is the only one that talks to the
    /// CLI's wire format.
    public init(
        providerId: String,
        kind: AuthKind = .unknown,
        loggedIn: Bool = false,
        method: String = "",
        detail: String? = nil,
        expiresIn: String? = nil
    ) {
        self.providerId = providerId
        self.kind = kind
        self.loggedIn = loggedIn
        self.method = method
        self.detail = detail
        self.expiresIn = expiresIn
    }

    /// `nil` only when the row has no `providerId` at all — every other
    /// field tolerates absence or an unrecognized value rather than dropping
    /// the row.
    public init?(json: JSONValue) {
        guard let providerId = json["providerId"]?.stringValue else { return nil }
        self.providerId = providerId
        self.kind = AuthKind(wire: json["kind"]?.stringValue)
        self.loggedIn = json["loggedIn"]?.boolValue ?? false
        self.method = json["method"]?.stringValue ?? ""
        self.detail = json["detail"]?.stringValue
        self.expiresIn = json["expiresIn"]?.stringValue
    }
}

// MARK: - Command factories
//
// Kept as an extension in this file rather than edits to `NexusClient.swift`
// (out of scope for this feature) — exactly the same seam `Sessions.swift`/
// `Tasks.swift` already use for their own command factories.

extension NexusCommand {
    /// `nexus auth status -o json` — every registered provider's sign-in
    /// state, never a secret value.
    public static func authStatus(cwd: URL? = nil) -> NexusCommand {
        .json(["auth", "status"], cwd: cwd)
    }

    /// `nexus login <provider>` — the REAL per-provider flow (browser OAuth,
    /// a delegated vendor-CLI login, or a cloud-SSO delegate).
    ///
    /// Deliberately NOT built through `.json(...)`: this is a long-lived,
    /// interactive process — it prints a URL and waits on a browser
    /// round-trip (and, for Anthropic's `manualCode` flow specifically, on a
    /// `code#state` string pasted back from the callback page) — not a
    /// one-shot command with a single parseable document on stdout.
    /// `AuthController.signIn` streams it and calls `refresh()` once it
    /// exits, rather than parsing its final line.
    public static func login(provider: String, cwd: URL? = nil) -> NexusCommand {
        NexusCommand(["login", provider], workingDirectory: cwd)
    }

    /// `nexus logout <provider>`. Prints PLAIN TEXT on success (never JSON —
    /// see `cmdLogout` on the CLI side), so this is run through
    /// `AuthController`'s own `runPlain`, never `NexusClient.runJSON`.
    public static func logout(provider: String, cwd: URL? = nil) -> NexusCommand {
        NexusCommand(["logout", provider], workingDirectory: cwd)
    }

    /// `nexus logout --all`.
    public static func logoutAll(cwd: URL? = nil) -> NexusCommand {
        NexusCommand(["logout", "--all"], workingDirectory: cwd)
    }

    /// `nexus keys set <ref> --stdin` — `ref` is the provider id, the CLI's
    /// own default (`apiKeyRef ?? providerId` in `createApiKeyStrategy`,
    /// `@nexuscode/auth`) for every api-key provider this app offers a key
    /// field for.
    ///
    /// Deliberately takes NO secret parameter. The key value is written
    /// straight to the child process's stdin pipe by
    /// `AuthController.signInWithKey` — it is never handed to this builder,
    /// so it can never land in `arguments` (visible to every process on the
    /// machine via `ps`/argv) no matter how this command is constructed,
    /// logged, or inspected.
    public static func keysSet(ref: String, cwd: URL? = nil) -> NexusCommand {
        NexusCommand(["keys", "set", ref, "--stdin"], workingDirectory: cwd)
    }
}

/// One in-flight `nexus login <provider>` process.
///
/// Every other command this app runs is either a quick one-shot (`auth
/// status`, `logout`) or a single write-then-EOF (`keys set --stdin`). A real
/// OAuth login is neither. Anthropic's flow — the only `manualCode` provider
/// today (see `ANTHROPIC_OAUTH_CONFIG` in `packages/auth/src/strategies/
/// providers.ts`) — prints an authorize URL, opens the system browser, and
/// then BLOCKS reading stdin to EOF for a `<code>#<state>` string the user
/// copies from the callback page: Anthropic's authorize endpoint rejects a
/// loopback `redirect_uri`, so unlike Google's flow there is no local listener
/// to auto-complete it. Every other provider's flow (a real loopback
/// listener, a device code, or a delegated vendor-CLI login) never reads
/// stdin at all, so leaving this pipe open costs nothing for those.
///
/// This actor keeps the process's stdin pipe open for the whole flow so
/// `submitCode` can feed a paste back in whenever the user actually has it —
/// seconds or minutes after the URL first appeared, once they've finished in
/// the browser — and merges stdout (the final "signed in to…" line) with
/// stderr (the URL + progress notes) into one ordered line stream, since a
/// user watching a live sign-in does not care which fd a given line arrived
/// on.
actor LoginSession {
    private let binary: NexusBinary
    private let arguments: [String]
    private let workingDirectory: URL?

    private var process: Process?
    private var stdin: FileHandle?

    init(binary: NexusBinary, provider: String, workingDirectory: URL?) {
        self.binary = binary
        self.arguments = ["login", provider]
        self.workingDirectory = workingDirectory
    }

    /// The line stream for this one flow. Call once.
    func start() -> AsyncStream<String> {
        AsyncStream { continuation in
            let process = Process()
            let (executable, leading) = binary.launch
            process.executableURL = executable
            process.arguments = leading + arguments
            if let workingDirectory { process.currentDirectoryURL = workingDirectory }

            // A GUI process has a minimal environment; pass a usable PATH so
            // the CLI's own child lookups (a browser opener, a vendor CLI for
            // cli-delegate/cloud-sso) can still find things. Mirrors
            // `NexusClient`'s own launch setup.
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = (environment["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            environment["NO_COLOR"] = "1"
            process.environment = environment

            let input = Pipe()
            let output = Pipe()
            let errors = Pipe()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = errors

            let outBuffer = LoginLineBuffer()
            output.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                for line in outBuffer.append(data) { continuation.yield(line) }
            }
            let errBuffer = LoginLineBuffer()
            errors.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                for line in errBuffer.append(data) { continuation.yield(line) }
            }

            process.terminationHandler = { [weak self] _ in
                output.fileHandleForReading.readabilityHandler = nil
                errors.fileHandleForReading.readabilityHandler = nil
                for line in outBuffer.flush() { continuation.yield(line) }
                for line in errBuffer.flush() { continuation.yield(line) }
                continuation.finish()
                Task { await self?.clear() }
            }

            // Fires on normal completion too (see `PersistentSession.start`'s
            // identical contract) — `cancel()` is idempotent, so that is
            // harmless; it is the ONLY path that terminates the process when
            // the caller instead stops consuming the stream early.
            continuation.onTermination = { [weak self] _ in
                Task { await self?.cancel() }
            }

            do {
                try process.run()
                self.process = process
                self.stdin = input.fileHandleForWriting
            } catch {
                continuation.yield("failed to launch nexus: \(error.localizedDescription)")
                continuation.finish()
            }
        }
    }

    /// Feed a pasted `code#state` (Anthropic's manual-code flow) back to the
    /// process, then close stdin so its EOF-based read returns immediately
    /// instead of waiting for the whole process to exit on its own. A no-op
    /// once the flow has already finished (stdin already closed).
    func submitCode(_ code: String) {
        guard let stdin else { return }
        let text = code.trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
        if let data = text.data(using: .utf8) {
            try? stdin.write(contentsOf: data)
        }
        try? stdin.close()
        self.stdin = nil
    }

    /// Terminate the flow early. Idempotent, and safe even after the process
    /// has already exited on its own.
    func cancel() {
        try? stdin?.close()
        stdin = nil
        if let process, process.isRunning {
            process.terminate()
        }
        process = nil
    }

    private func clear() {
        stdin = nil
        process = nil
    }
}

/// Same line-splitting contract as `NexusClient`'s own buffer (see that
/// file): only complete lines are yielded, so a line split across two reads
/// is never surfaced in halves. A private, file-scoped copy rather than a
/// shared type, since `NexusClient.swift` is out of scope for this feature.
private final class LoginLineBuffer: @unchecked Sendable {
    private var pending = Data()
    private let lock = NSLock()

    func append(_ data: Data) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        pending.append(data)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = pending[pending.startIndex..<newline]
            pending.removeSubrange(pending.startIndex...newline)
            if let line = String(data: lineData, encoding: .utf8) { lines.append(line) }
        }
        return lines
    }

    func flush() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        guard !pending.isEmpty, let line = String(data: pending, encoding: .utf8) else { return [] }
        pending.removeAll()
        return [line]
    }
}

/// Thread-safe byte accumulator for `AuthController.runWithSecret`'s stderr
/// pipe, which is drained from a background readability-handler queue rather
/// than any actor. Only the whole text matters (a short error message on
/// failure) so this collects raw bytes rather than splitting lines.
private final class SecretErrorCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()

    func append(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        bytes.append(chunk)
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return String(data: bytes, encoding: .utf8) ?? ""
    }
}

/// Loads and drives the Auth tab, backed by `nexus auth status` / `login` /
/// `logout` / `keys set --stdin`.
///
/// Authentication is a first-class feature here, not a settings afterthought
/// — this app is a harness over several vendor backends, and knowing exactly
/// who is signed in (and by which REAL flow — never a faked one) is as
/// central as the chat surface itself. Every action below maps onto a real
/// `nexus` subcommand; nothing here talks to a provider or stores a
/// credential itself — the CLI's `SecretStore` owns that entirely. A key
/// value passes through this app exactly once, written straight into a
/// child process's stdin pipe, and is never logged, echoed, or persisted
/// (not even to `UserDefaults`) by this code.
@MainActor
@Observable
public final class AuthController {
    public private(set) var providers: [ProviderAuth] = []
    public private(set) var isLoading = false
    public var error: String?

    private let client: NexusClient
    private let binary: NexusBinary
    private let workingDirectory: URL?

    /// One entry per provider with a `signIn` flow currently in progress.
    private var loginSessions: [String: LoginSession] = [:]

    public init(client: NexusClient, binary: NexusBinary, workingDirectory: URL? = nil) {
        self.client = client
        self.binary = binary
        self.workingDirectory = workingDirectory
    }

    /// Reloads from `nexus auth status -o json`.
    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        switch await client.runJSON(.authStatus(cwd: workingDirectory)) {
        case .success(let value):
            guard let items = value.arrayValue else {
                error = "unexpected response shape from `nexus auth status`"
                return
            }
            providers = items.compactMap(ProviderAuth.init(json:))
                .sorted { $0.providerId < $1.providerId }
            error = nil
        case .failure(let commandError):
            error = commandError.message
        }
    }

    /// Providers with a usable credential right now.
    public var signedIn: [ProviderAuth] { providers.filter(\.loggedIn) }
    /// Providers not yet signed in — kept in a separate group in the UI so
    /// "what works right now" is never mixed with "what still needs setup".
    public var available: [ProviderAuth] { providers.filter { !$0.loggedIn } }

    /// Whether a `signIn` flow for `providerId` is currently streaming.
    public func isSigningIn(_ providerId: String) -> Bool {
        loginSessions[providerId] != nil
    }

    // MARK: - OAuth / device / cli-delegate / cloud-sso sign-in

    /// Starts `nexus login <provider>` and streams its progress lines (the
    /// authorize URL, "waiting for you to finish signing in…", the final
    /// "signed in to…" line, or an error) as they arrive.
    ///
    /// A real login is long-lived and interactive, never fire-and-forget —
    /// the caller drives this like any other live process: keep iterating to
    /// show progress, and either let it run to completion or stop consuming
    /// the stream (or call `cancelSignIn`) to abort it, mirroring
    /// `NexusClient.stream`'s own cancel-by-abandoning-the-stream contract.
    /// Replaces any flow already running for this provider.
    ///
    /// Anthropic's flow specifically pauses partway through, waiting on a
    /// `code#state` string the user copies from the callback page — feed it
    /// back with `submitCode(_:for:)`. Every other provider's flow completes
    /// on its own and `submitCode` is simply never called for it.
    public func signIn(provider: String) async -> AsyncStream<String> {
        if let existing = loginSessions[provider] {
            await existing.cancel()
        }
        let session = LoginSession(binary: binary, provider: provider, workingDirectory: workingDirectory)
        loginSessions[provider] = session
        let inner = await session.start()
        return AsyncStream { continuation in
            let task = Task { [weak self] in
                for await line in inner {
                    if Task.isCancelled { break }
                    continuation.yield(line)
                }
                continuation.finish()
                await self?.finishSignIn(provider: provider, session: session)
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Feed a pasted `code#state` back into `provider`'s in-flight `signIn`
    /// flow. A no-op if nothing is running for it (e.g. the user pasted
    /// after the flow already finished or was cancelled).
    public func submitCode(_ code: String, for provider: String) async {
        await loginSessions[provider]?.submitCode(code)
    }

    /// Stop an in-flight `signIn` flow early.
    public func cancelSignIn(for provider: String) async {
        guard let session = loginSessions[provider] else { return }
        loginSessions[provider] = nil
        await session.cancel()
        await refresh()
    }

    /// Normal end-of-flow cleanup. Only clears the slot if it still belongs
    /// to THIS flow — a newer `signIn` call for the same provider may already
    /// have replaced it while this one's cleanup was still in flight (e.g.
    /// cancelling an old flow immediately before starting a new one).
    private func finishSignIn(provider: String, session: LoginSession) async {
        if loginSessions[provider] === session {
            loginSessions[provider] = nil
        }
        await refresh()
    }

    // MARK: - API key sign-in

    /// Stores `key` for `provider` via `nexus keys set <provider> --stdin`.
    /// The value goes straight into the child process's stdin pipe and the
    /// pipe is closed immediately after — never passed as a command-line
    /// argument (visible to every process on the machine via argv) and never
    /// logged or held anywhere else in this app.
    @discardableResult
    public func signInWithKey(provider: String, key: String) async -> Bool {
        let command = NexusCommand.keysSet(ref: provider, cwd: workingDirectory)
        switch await runWithSecret(command, secret: key) {
        case .success:
            await refresh()
            return true
        case .failure(let commandError):
            error = commandError.message
            return false
        }
    }

    // MARK: - Sign out

    @discardableResult
    public func signOut(provider: String) async -> Bool {
        switch await runPlain(.logout(provider: provider, cwd: workingDirectory)) {
        case .success:
            await refresh()
            return true
        case .failure(let commandError):
            error = commandError.message
            return false
        }
    }

    @discardableResult
    public func signOutAll() async -> Bool {
        switch await runPlain(.logoutAll(cwd: workingDirectory)) {
        case .success:
            await refresh()
            return true
        case .failure(let commandError):
            error = commandError.message
            return false
        }
    }

    // MARK: - Private process plumbing
    //
    // `logout` and `keys set` both print PLAIN TEXT on success (never JSON —
    // see `cmdLogout`/`cmdKeys` on the CLI side). `NexusClient.runJSON`
    // treats any non-JSON stdout on a clean exit as `.malformedJSON` — i.e. a
    // FAILURE — so it is the wrong tool for either. `runPlain` judges success
    // purely by exit code, via the same `client.stream` used everywhere else,
    // so a real success is never misreported as one.

    private func runPlain(_ command: NexusCommand) async -> Result<Void, NexusCommandError> {
        var diagnostics: [String] = []
        for await item in client.stream(command) {
            switch item {
            case .diagnostic(let line):
                diagnostics.append(line)
            case .event:
                break
            case .terminated(let reason):
                switch reason {
                case .finished(let code):
                    return code == 0
                        ? .success(())
                        : .failure(.nonZeroExit(code: code, stderr: diagnostics.joined(separator: "\n")))
                case .failedToLaunch(let message):
                    return .failure(.launchFailed(message))
                case .cancelled:
                    return .failure(.cancelled)
                }
            }
        }
        return .failure(.launchFailed("process ended without a termination signal"))
    }

    /// `keys set --stdin` needs an actual stdin PIPE wired up before the
    /// process starts. `NexusClient` (left unedited — out of scope for this
    /// feature) never sets `Process.standardInput`, which means it is `nil`
    /// and the child inherits the PARENT's stdin — not something this app
    /// controls, and not a channel a secret should ever cross. This is the
    /// one place a secret value passes through this app at all: it goes
    /// straight into the pipe and the pipe is closed immediately after — the
    /// same "write, then close for EOF" contract the CLI's own integration
    /// test for `keys set --stdin` exercises.
    private func runWithSecret(_ command: NexusCommand, secret: String) async -> Result<Void, NexusCommandError> {
        let process = Process()
        let (executable, leading) = binary.launch
        process.executableURL = executable
        process.arguments = leading + command.arguments
        if let cwd = command.workingDirectory { process.currentDirectoryURL = cwd }

        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = (environment["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        environment["NO_COLOR"] = "1"
        process.environment = environment

        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors

        // Drain both pipes so a chattier-than-expected response can never
        // block the child on a full pipe buffer. stdout's content is
        // discarded outright — success/failure is judged by exit code alone,
        // never by trying to parse this plain-text output as JSON.
        let errorCollector = SecretErrorCollector()
        output.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            errorCollector.append(data)
        }

        return await withCheckedContinuation { continuation in
            process.terminationHandler = { finished in
                output.fileHandleForReading.readabilityHandler = nil
                errors.fileHandleForReading.readabilityHandler = nil
                if finished.terminationStatus == 0 {
                    continuation.resume(returning: .success(()))
                } else {
                    continuation.resume(
                        returning: .failure(
                            .nonZeroExit(code: finished.terminationStatus, stderr: errorCollector.text)
                        )
                    )
                }
            }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: .failure(.launchFailed(error.localizedDescription)))
                return
            }
            // Never let the secret touch argv or a log — written straight to
            // the child's stdin pipe, then the pipe is closed (EOF) so `keys
            // set --stdin` reads exactly one value and stops waiting.
            if let data = (secret + "\n").data(using: .utf8) {
                try? input.fileHandleForWriting.write(contentsOf: data)
            }
            try? input.fileHandleForWriting.close()
        }
    }
}
