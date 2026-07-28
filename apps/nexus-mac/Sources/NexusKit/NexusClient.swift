import Foundation

/// Why `NexusClient.runJSON` failed to produce a value.
///
/// A typed enum rather than a bare string so a caller — the UI in particular —
/// can distinguish "nexus isn't installed" from "the command itself failed"
/// from "we got output back but couldn't parse it", instead of pattern-matching
/// on prose.
public enum NexusCommandError: Error, Sendable, Hashable {
    /// The process could not even be started (e.g. the binary vanished).
    case launchFailed(String)
    /// The process ran and exited non-zero; `stderr` is whatever it wrote.
    case nonZeroExit(code: Int32, stderr: String)
    /// The process exited 0, but stdout wasn't a single valid JSON document.
    case malformedJSON(String)
    case cancelled
    /// The process was still running when its deadline expired, so we killed
    /// it. Deliberately NOT folded into `cancelled` or `nonZeroExit`: those
    /// mean "something answered" (the user, or the process itself), whereas
    /// this means **nothing ever answered** — the same distinction the CLI
    /// draws between a real failure and an inconclusive probe. A caller that
    /// collapses the two tells the user a server is broken when the truth is
    /// only that it was slow.
    case timedOut(seconds: Double)

    /// A short, user-facing rendering — for call sites (like the controllers
    /// below) that just want something to display.
    public var message: String {
        switch self {
        case .launchFailed(let detail):
            return "failed to launch nexus: \(detail)"
        case .nonZeroExit(let code, let stderr):
            return stderr.isEmpty ? "nexus exited with code \(code)" : stderr
        case .malformedJSON(let text):
            return "nexus did not print valid JSON: \(text)"
        case .cancelled:
            return "cancelled"
        case .timedOut(let seconds):
            return "nexus did not respond within \(Int(seconds))s"
        }
    }
}

/// One `nexus` invocation.
///
/// The app never constructs provider calls — it constructs COMMANDS. Every
/// button in the UI resolves to one of these, which is what keeps the CLI
/// authoritative: a capability cannot exist in the app without existing as a
/// `nexus` subcommand first.
public struct NexusCommand: Sendable, Hashable {
    public var arguments: [String]
    public var workingDirectory: URL?

    public init(_ arguments: [String], workingDirectory: URL? = nil) {
        self.arguments = arguments
        self.workingDirectory = workingDirectory
    }

    /// A streaming run that emits `UiEvent` ndjson.
    public static func ask(
        prompt: String,
        provider: String? = nil,
        model: String? = nil,
        resume sessionId: String? = nil,
        cwd: URL? = nil
    ) -> NexusCommand {
        var args = ["ask", prompt, "-o", "ndjson"]
        if let provider { args += ["-p", provider] }
        if let model { args += ["-m", model] }
        if let sessionId { args += ["--resume", sessionId] }
        return NexusCommand(args, workingDirectory: cwd)
    }

    /// A one-shot command that returns a single JSON document.
    public static func json(_ arguments: [String], cwd: URL? = nil) -> NexusCommand {
        NexusCommand(arguments + ["-o", "json"], workingDirectory: cwd)
    }

    public static func providers(cwd: URL? = nil) -> NexusCommand {
        .json(["providers", "list"], cwd: cwd)
    }

    // MARK: - Sessions

    public static func sessionList(cwd: URL? = nil) -> NexusCommand {
        .json(["session", "list"], cwd: cwd)
    }

    public static func sessionShow(id: String, cwd: URL? = nil) -> NexusCommand {
        .json(["session", "show", id], cwd: cwd)
    }

    /// Streams a recorded session's whole `UiEvent` log — fed through
    /// `ConversationController.ingest` to reopen it (see that method's doc).
    public static func replay(sessionId: String, cwd: URL? = nil) -> NexusCommand {
        NexusCommand(["replay", sessionId, "-o", "ndjson"], workingDirectory: cwd)
    }

    // MARK: - Tasks

    public static func taskList(cwd: URL? = nil) -> NexusCommand {
        .json(["task", "list"], cwd: cwd)
    }

    public static func taskAdd(title: String, cwd: URL? = nil) -> NexusCommand {
        .json(["task", "add", title], cwd: cwd)
    }

    public static func taskRemove(id: String, cwd: URL? = nil) -> NexusCommand {
        .json(["task", "rm", id], cwd: cwd)
    }

    /// `nil` when `status` has no direct `nexus task` subcommand — only
    /// `in_progress`/`blocked`/`done`/`cancelled` do (`start`/`block`/`done`/
    /// `cancel`); there is no subcommand that reverts a task to `todo`.
    public static func taskSetStatus(_ status: TaskStatus, id: String, cwd: URL? = nil) -> NexusCommand? {
        let sub: String
        switch status {
        case .inProgress: sub = "start"
        case .done: sub = "done"
        case .blocked: sub = "block"
        case .cancelled: sub = "cancel"
        case .todo, .unknown: return nil
        }
        return .json(["task", sub, id], cwd: cwd)
    }
}

/// Why a run ended.
public enum NexusTermination: Sendable, Hashable {
    case finished(exitCode: Int32)
    case failedToLaunch(String)
    case cancelled
}

/// One item from a streaming run.
public enum NexusStreamItem: Sendable {
    case event(UiEvent)
    /// A line the CLI wrote to stderr. Surfaced rather than swallowed so a
    /// launch problem or a provider warning is visible in the UI.
    case diagnostic(String)
    case terminated(NexusTermination)
}

/// Locates the `nexus` executable.
///
/// Resolution order matters for a GUI app: a `.app` launched from Finder does
/// NOT inherit the shell's `PATH`, so relying on `PATH` alone is the classic way
/// a Mac app "works from Xcode, broken when double-clicked".
public struct NexusBinary: Sendable {
    public let url: URL

    public init(url: URL) { self.url = url }

    /// Common install locations, plus the repo-local build for development.
    ///
    /// `NEXUS_BIN` is resolved SEPARATELY from, and before, every other
    /// candidate — deliberately fail-closed rather than fall through. It is
    /// the one candidate here that is a DELIBERATE user override (unlike the
    /// install locations and `PATH`, which are best-effort guesses), so a
    /// value that does not resolve to a real executable returns `nil`
    /// outright instead of quietly trying the repo-local build or an install
    /// location instead. The alternative — silently substituting a DIFFERENT
    /// `nexus` than the one the user explicitly pointed at — is exactly the
    /// class of confident-but-wrong state this app spent a long night
    /// removing everywhere else (unknown cost was never `$0.00`, a tripped
    /// circuit was never plainly "usable"; a missing `NEXUS_BIN` target is
    /// not silently "whatever else happened to be installed" either).
    public static func discover(
        explicit: URL? = nil,
        repoRoot: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileExists: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        // `nil` rather than a closure literal as the default: the default
        // NEEDS to search using the `environment` actually passed in above
        // (its `HOME`/`PATH`), not whatever the real process happens to
        // have — a closure literal used as a parameter's default value can't
        // see this function's OTHER parameters, only a value computed in the
        // body (below) can.
        canLaunch: (@Sendable (String) -> Bool)? = nil
    ) -> NexusBinary? {
        let canLaunch = canLaunch ?? { defaultCanLaunch($0, environment: environment) }
        if let explicit, fileExists(explicit.path) { return NexusBinary(url: explicit) }

        // Blank or whitespace-only is treated as unset, never as a literal
        // path — `trimmingCharacters` first, not just `isEmpty`, so
        // `NEXUS_BIN="   "` (a real way an env var ends up set-but-blank,
        // e.g. from an unquoted shell substitution) falls through to the
        // normal candidates below instead of being treated as an explicit
        // override that then predictably fails to resolve.
        //
        // Neither `explicit` nor `NEXUS_BIN` is run through `canLaunch`
        // below: both are a deliberate user override, not a best-effort
        // guess, and `explainMissing` promises a very specific message for
        // "NEXUS_BIN is set but nothing executable exists there" — a
        // launchability rejection here would make that message wrong (it DID
        // find something) in exactly the way this whole mechanism exists to
        // avoid. A `NEXUS_BIN` that exists but can't actually run still
        // surfaces honestly — just later, as a launch-time error with the
        // real stderr, not as a misleading "not found."
        if let override = environment["NEXUS_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            return fileExists(override) ? NexusBinary(url: URL(fileURLWithPath: override)) : nil
        }

        // `fileExists` alone is a false positive for a script whose shebang
        // interpreter can't be found anywhere — it passes `isExecutableFile`
        // and then fails the moment it's actually run. Filtering with
        // `canLaunch` too means a candidate like that is skipped in favor of
        // a LATER one that would actually work, instead of `discover`
        // confidently handing back something dead.
        return candidatePaths(repoRoot: repoRoot, environment: environment)
            .first(where: { fileExists($0) && canLaunch($0) })
            .map { NexusBinary(url: URL(fileURLWithPath: $0)) }
    }

    /// The best-effort candidate list shared by `discover` (which returns the
    /// first workable one) and `explainMissing` (which needs the same list to
    /// tell "nothing exists anywhere" apart from "something exists but can't
    /// run" — see that function). Never includes `explicit`/`NEXUS_BIN`,
    /// which are deliberate overrides handled separately by both callers.
    private static func candidatePaths(repoRoot: URL?, environment: [String: String]) -> [String] {
        var candidates: [String] = []
        // Repo-local dist build — the development case.
        if let repoRoot {
            candidates.append(repoRoot.appendingPathComponent("packages/cli/dist/index.js").path)
        }
        candidates += [
            "/opt/homebrew/bin/nexus",
            "/usr/local/bin/nexus",
            "\(environment["HOME"] ?? "")/.local/bin/nexus",
        ]
        for path in environment["PATH"]?.split(separator: ":") ?? [] {
            candidates.append("\(path)/nexus")
        }
        return candidates
    }

    /// Explains why `discover` returned `nil` — the ONE place that knows how
    /// to turn that failure into a message a user can act on. Before this,
    /// `WorkspaceModel` (the one caller that gets it right) and six
    /// view-level fallbacks each said something different — most of them the
    /// same generic string, unable to tell "nothing anywhere" apart from "you
    /// pointed `NEXUS_BIN` somewhere and it's wrong." Every caller routes
    /// through here now, so there is exactly one explanation to keep honest.
    ///
    /// Distinguishing those two causes is unambiguous BECAUSE of `discover`'s
    /// own contract: a set `NEXUS_BIN` that fails to resolve fails the WHOLE
    /// lookup outright rather than falling through to a repo build or an
    /// install location (see that function's doc). So if it's set at all,
    /// that is always the reason a `nil` came back — never a coincidence
    /// alongside some other gap this message would otherwise have to guess at.
    public static func explainMissing(
        repoRoot: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileExists: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        // See `discover`'s matching parameter for why `nil` rather than a
        // closure literal: the default must search using THIS call's
        // `environment`, not whatever the real process happens to have.
        canLaunch: (@Sendable (String) -> Bool)? = nil
    ) -> String {
        let canLaunch = canLaunch ?? { defaultCanLaunch($0, environment: environment) }
        if let override = environment["NEXUS_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !override.isEmpty {
            return "NEXUS_BIN is set to \"\(override)\", but nothing executable exists there."
        }
        // `discover` can also come back `nil` because a candidate WAS found
        // but couldn't actually run (see `canLaunch`) — a different problem
        // from "nothing here," and the generic message below would be
        // actively wrong about it: the file is right there, it just can't
        // execute. Naming that path and the real cause is exactly the
        // distinction `NEXUS_BIN`'s branch above already draws; this extends
        // the same honesty to the best-effort candidates.
        if let brokenPath = candidatePaths(repoRoot: repoRoot, environment: environment)
            .first(where: { fileExists($0) && !canLaunch($0) }) {
            return """
                Found `nexus` at \(brokenPath), but couldn't run it — its \
                interpreter (e.g. node) isn't installed or reachable from \
                this app. Install it where `nexus` can find it, or set \
                NEXUS_BIN to a `nexus` that can actually run.
                """
        }
        return """
            Could not find the `nexus` executable. Install it, or set NEXUS_BIN \
            to its path, or point this window at a NexusCode checkout that has \
            been built.
            """
    }

    /// A `.js` entrypoint is run through `node`; a native binary runs directly.
    var launch: (executable: URL, leadingArguments: [String]) {
        if url.pathExtension == "js" {
            let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
                .first { FileManager.default.isExecutableFile(atPath: $0) }
                ?? "/usr/bin/env"
            return (URL(fileURLWithPath: node), [url.path])
        }
        return (url, [])
    }

    /// The environment a spawned `nexus` child process should run with.
    ///
    /// A GUI app launched from Finder/Spotlight inherits the OS-minimal
    /// `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) — it never sees the user's
    /// shell profile. That's invisible for a native binary, but it breaks
    /// every SCRIPT-shaped `nexus`: a `.js` entrypoint run via `#!/usr/bin/env
    /// node`, or a `/bin/sh` wrapper that does `exec node …`, both need
    /// `node` findable on `PATH` at the moment they run, not at the moment
    /// this app's window was resolved.
    ///
    /// `base`'s existing `PATH` is kept in front, never replaced — a `PATH`
    /// the user set deliberately (a specific node pinned first, say) keeps
    /// priority, and the additions below are only reached once that search
    /// comes up empty. The directory holding this binary itself is listed
    /// first among them because it generalizes furthest: nvm, fnm, volta, and
    /// asdf all place a given Node version's `node` in the SAME bin directory
    /// as anything installed globally under that version — `nexus` included
    /// — so this one entry finds the right `node` for any of them without
    /// this file needing to know which manager, or which version, is in use.
    /// `extraSearchDirectories` rounds it out with the realistic common
    /// cases that AREN'T colocated with `nexus` (a plain Homebrew or system
    /// install of node, reached via a differently-installed `nexus`).
    func spawnEnvironment(base: [String: String]) -> [String: String] {
        var environment = base
        let extraDirs = [url.deletingLastPathComponent().path] + Self.extraSearchDirectories(environment: base)
        let pieces = (base["PATH"].map { [$0] } ?? []) + extraDirs
        environment["PATH"] = pieces.joined(separator: ":")
        environment["NO_COLOR"] = "1"
        return environment
    }

    /// Directories worth adding to a `PATH` (or a name lookup) on top of
    /// whatever it already has: common Homebrew/system locations, plus the
    /// common Node version-manager locations that install to a fixed path
    /// regardless of which Node version is active (`volta`, `asdf` shims).
    /// Deliberately NOT exhaustive — `nvm`'s and `fnm`'s own directories are
    /// versioned/per-shell and can't be guessed at without spawning those
    /// tools, which `spawnEnvironment`'s colocated-directory trick above
    /// covers instead for any install where `nexus` and `node` live side by
    /// side. Kept in one place so the spawn-time `PATH` and `canLaunch`
    /// below always agree about "the realistic set of places node lives."
    private static func extraSearchDirectories(environment: [String: String]) -> [String] {
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin"]
        if let home = environment["HOME"], !home.isEmpty {
            dirs += ["\(home)/.volta/bin", "\(home)/.asdf/shims"]
        }
        dirs += ["/usr/bin", "/bin"]
        return dirs
    }

    /// True unless `path` is a script whose shebang names an interpreter that
    /// can't be found anywhere `extraSearchDirectories`/`PATH` know to look.
    /// Never spawns a process — reads at most the first line of the file —
    /// so calling it for every `discover` candidate stays cheap. Defaults to
    /// `true` whenever it can't tell (no shebang, unreadable, or a shebang
    /// shape it doesn't recognize): a false "yes" here is just the old
    /// `fileExists`-only behavior, never a NEW failure mode, because the goal
    /// is to catch the specific failure this app actually hit — `env node`
    /// resolving to nothing under a GUI's minimal `PATH` — not to become a
    /// general-purpose launch simulator.
    public static func defaultCanLaunch(_ path: String, environment: [String: String]) -> Bool {
        guard let interpreter = shebangInterpreter(of: path) else { return true }
        return resolveOnDisk(interpreter, environment: environment) != nil
    }

    /// Parses a `#!` line into the interpreter it names: `#!/usr/bin/env
    /// node` and `#!/usr/bin/env node --foo` both yield `"node"` (the
    /// argument `env` searches `PATH` for, not `env` itself); `#!/bin/sh`
    /// yields `/bin/sh` unchanged (an absolute interpreter path, checked
    /// directly rather than searched for). `nil` for anything without a
    /// recognizable `#!` line — callers treat that as "nothing to verify."
    private static func shebangInterpreter(of path: String) -> String? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        // A shebang line is always near the top of the file, so this never
        // reads more than a couple hundred bytes even for a large binary —
        // it just won't decode as UTF-8 starting with "#!" and bails below.
        guard let chunk = try? handle.read(upToCount: 256),
              let text = String(data: chunk, encoding: .utf8),
              text.hasPrefix("#!")
        else { return nil }
        let firstLine = text.split(separator: "\n", maxSplits: 1)[0].dropFirst(2)
        let parts = firstLine.split(separator: " ").map(String.init)
        guard let head = parts.first else { return nil }
        if head.hasSuffix("/env"), let name = parts.dropFirst().first {
            return name
        }
        return head
    }

    /// Best-effort search for `name` — an interpreter a shebang names, or
    /// anything else a script might shell out to — across the places a GUI
    /// launch won't otherwise see: `extraSearchDirectories` plus whatever
    /// `PATH` this environment actually carries. An absolute name (already a
    /// full path, e.g. from a `#!/bin/sh` shebang) is checked directly rather
    /// than searched for.
    private static func resolveOnDisk(_ name: String, environment: [String: String]) -> String? {
        if name.hasPrefix("/") {
            return FileManager.default.isExecutableFile(atPath: name) ? name : nil
        }
        var dirs = extraSearchDirectories(environment: environment)
        dirs += environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        return dirs
            .map { "\($0)/\(name)" }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}

/// Runs `nexus` and turns its stdout into a stream of `UiEvent`s.
///
/// Deliberately thin: spawn, split stdout on newlines, decode, forward. All
/// interpretation lives in `ViewState`. Nothing here knows what a provider is.
public actor NexusClient {
    private let binary: NexusBinary
    private let environmentProvider: @Sendable () -> [String: String]

    /// `environment` is injectable so a test can spawn a REAL process (not a
    /// fixture) under a simulated GUI-minimal environment and prove the
    /// whole launch chain, not just `NexusBinary`'s pure resolution logic —
    /// see `NexusClientIntegrationTests`. Defaults to this app's own
    /// environment, which is what every real call site wants.
    public init(
        binary: NexusBinary,
        environment: @escaping @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment }
    ) {
        self.binary = binary
        self.environmentProvider = environment
    }

    /// Stream a command's events. Cancelling the returned stream's task
    /// terminates the child process.
    public nonisolated func stream(_ command: NexusCommand) -> AsyncStream<NexusStreamItem> {
        AsyncStream { continuation in
            let process = Process()
            // Set before `launch` runs the process, so a synchronous launch
            // failure (see `launch`'s catch below) can never fire before this
            // is armed.
            continuation.onTermination = { reason in
                if case .cancelled = reason, process.isRunning {
                    process.terminate()
                }
            }
            launch(
                process, command,
                onLine: { line in
                    if let event = UiEventDecoder.decodeLine(line) {
                        continuation.yield(.event(event))
                    }
                },
                onDiagnostic: { line in
                    continuation.yield(.diagnostic(line))
                },
                onTerminated: { reason in
                    continuation.yield(.terminated(reason))
                    continuation.finish()
                }
            )
        }
    }

    /// Run a command to completion and fold its events into a `ViewState`.
    /// Used by tests and by non-interactive refreshes.
    public func collect(_ command: NexusCommand) async -> (state: ViewState, diagnostics: [String]) {
        var state = ViewState()
        var diagnostics: [String] = []
        var index = 0.0
        for await item in stream(command) {
            switch item {
            case .event(let event):
                state.reduce(event, ts: index)
                index += 1
            case .diagnostic(let line):
                diagnostics.append(line)
            case .terminated:
                break
            }
        }
        return (state, diagnostics)
    }

    /// Run a one-shot `-o json` command and decode its single stdout document.
    ///
    /// Sessions and tasks have no event log to fold — `session list`/`task
    /// list` and friends print exactly one JSON document (the CLI never
    /// interleaves anything else onto stdout in `-o json` mode) — so every
    /// collected line is rejoined in order and parsed once, rather than
    /// decoded line-by-line as a `UiEvent` the way `stream` does.
    /// - Parameter timeoutSeconds: kill the process and fail with
    ///   ``NexusCommandError/timedOut(seconds:)`` if it has not exited by
    ///   then. Pass `nil` only for a call that genuinely has no bound.
    ///
    ///   There is a default rather than an opt-in because the failure this
    ///   prevents is silent: `mcp tools` STARTS every enabled MCP server, and
    ///   one wedged server (or a pending macOS permission prompt in front of
    ///   one) used to leave the Integrations screen spinning forever with no
    ///   failure state and no way out but quitting. An unbounded wait is the
    ///   wrong default for a subprocess you do not control.
    ///
    ///   The timer **terminates the process** rather than merely abandoning
    ///   the `await`: dropping the continuation would leak a live `nexus`
    ///   child (and, for `mcp tools`, every MCP server it had started) for
    ///   the lifetime of the app. Killing it is what makes `onTerminated`
    ///   fire, which is what resumes the continuation exactly once — so this
    ///   races nothing and cannot double-resume.
    public nonisolated func runJSON(
        _ command: NexusCommand,
        timeoutSeconds: Double? = 20
    ) async -> Result<JSONValue, NexusCommandError> {
        let process = Process()
        let collector = OutputCollector()
        let expiry = ExpiryFlag()
        let termination = await withCheckedContinuation { (continuation: CheckedContinuation<NexusTermination, Never>) in
            launch(
                process, command,
                onLine: { collector.addLine($0) },
                onDiagnostic: { collector.addDiagnostic($0) },
                onTerminated: { reason in continuation.resume(returning: reason) }
            )
            guard let timeoutSeconds else { return }
            Task.detached {
                try? await Task.sleep(for: .seconds(timeoutSeconds))
                guard process.isRunning else { return }
                // Mark BEFORE terminating, never after: the termination this
                // triggers is what wakes the continuation, so a flag set
                // afterwards could lose the race against the reader below and
                // a timeout would masquerade as an ordinary `cancelled`.
                expiry.markExpired()
                process.terminate()
            }
        }

        // Checked first — a killed process reports `.cancelled` (or a signal
        // exit), and reporting "cancelled" for something the user never
        // cancelled is exactly the kind of dishonest state this codebase
        // works to avoid.
        if expiry.didExpire, let timeoutSeconds {
            return .failure(.timedOut(seconds: timeoutSeconds))
        }

        switch termination {
        case .failedToLaunch(let message):
            return .failure(.launchFailed(message))
        case .cancelled:
            return .failure(.cancelled)
        case .finished(let exitCode):
            guard exitCode == 0 else {
                return .failure(.nonZeroExit(code: exitCode, stderr: collector.diagnostics.joined(separator: "\n")))
            }
            let text = collector.lines.joined(separator: "\n")
            guard let data = text.data(using: .utf8),
                  let value = try? JSONDecoder().decode(JSONValue.self, from: data)
            else {
                return .failure(.malformedJSON(text))
            }
            return .success(value)
        }
    }

    /// Configures, starts, and wires up `process` for `command`, forwarding
    /// stdout lines / stderr lines / the exit reason through the given
    /// callbacks (invoked off the main actor, on the pipes' readability
    /// queue). The only place `Process`/`Pipe`/`LineBuffer` are touched —
    /// `stream` decodes each stdout line as a `UiEvent` as it arrives, while
    /// `runJSON` collects every line and parses them as one document at the
    /// end. `process` is a parameter rather than created here so a caller can
    /// capture it (for cancellation) before it is ever run.
    private nonisolated func launch(
        _ process: Process,
        _ command: NexusCommand,
        onLine: @escaping @Sendable (String) -> Void,
        onDiagnostic: @escaping @Sendable (String) -> Void,
        onTerminated: @escaping @Sendable (NexusTermination) -> Void
    ) {
        let (executable, leading) = binary.launch
        process.executableURL = executable
        process.arguments = leading + command.arguments
        if let cwd = command.workingDirectory {
            process.currentDirectoryURL = cwd
        }
        // A GUI process has a minimal environment (no shell profile) — see
        // `NexusBinary.spawnEnvironment`'s doc for why that breaks a
        // script-shaped `nexus` and what this adds back.
        process.environment = binary.spawnEnvironment(base: environmentProvider())

        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        // stdout arrives in arbitrary chunks, so hold a buffer and only emit
        // on a complete newline — a split JSON object must never be decoded.
        let buffer = LineBuffer()
        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            for line in buffer.append(data) { onLine(line) }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            for line in text.split(separator: "\n") where !line.isEmpty {
                onDiagnostic(String(line))
            }
        }

        process.terminationHandler = { finished in
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil

            // Read the pipe to EOF before flushing. `readabilityHandler` is
            // delivered ASYNCHRONOUSLY, so when a process exits there is
            // routinely still data sitting in the OS pipe that the handler was
            // never called for — and clearing the handler above means it never
            // will be. Those bytes used to be dropped silently.
            //
            // This is why `Sessions` intermittently rendered "nexus did not
            // print valid JSON:" followed by raw text ending mid-object: with
            // 1000+ sessions the payload is large enough that its last chunks
            // are usually still in flight at exit, whereas a small payload
            // almost always lands in one read before the process ends. It
            // presents as "malformed JSON" but nothing was malformed — the
            // document was simply cut off. The same loss applies to `stream`,
            // where it silently drops trailing EVENTS rather than text.
            //
            // Safe to block: the child has exited, so the write end is closed
            // and EOF arrives immediately. `LineBuffer` is lock-guarded, so a
            // last in-flight handler invocation racing this cannot corrupt it.
            let remainingOut = out.fileHandleForReading.readDataToEndOfFile()
            if !remainingOut.isEmpty {
                for line in buffer.append(remainingOut) { onLine(line) }
            }
            let remainingErr = err.fileHandleForReading.readDataToEndOfFile()
            if !remainingErr.isEmpty, let text = String(data: remainingErr, encoding: .utf8) {
                for line in text.split(separator: "\n") where !line.isEmpty {
                    onDiagnostic(String(line))
                }
            }

            // Whatever is left after the last newline.
            for line in buffer.flush() { onLine(line) }
            onTerminated(.finished(exitCode: finished.terminationStatus))
        }

        do {
            try process.run()
        } catch {
            onTerminated(.failedToLaunch(error.localizedDescription))
        }
    }
}

/// Thread-safe accumulator for `runJSON`'s callbacks, which fire on the pipes'
/// readability queue rather than any actor — mirrors `LineBuffer` below.
/// A one-way "the deadline fired" latch, shared between the timeout task and
/// the awaiting caller. Same shape as `OutputCollector` below — a lock rather
/// than an actor, because both sides touch it from arbitrary threads and the
/// read happens on a path that cannot `await`.
private final class ExpiryFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _expired = false

    func markExpired() {
        lock.lock(); defer { lock.unlock() }
        _expired = true
    }

    var didExpire: Bool {
        lock.lock(); defer { lock.unlock() }
        return _expired
    }
}

private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    private var _diagnostics: [String] = []

    func addLine(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        _lines.append(line)
    }

    func addDiagnostic(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        _diagnostics.append(line)
    }

    var lines: [String] {
        lock.lock(); defer { lock.unlock() }
        return _lines
    }

    var diagnostics: [String] {
        lock.lock(); defer { lock.unlock() }
        return _diagnostics
    }
}

/// Accumulates process output and yields only complete lines.
///
/// A `final class` guarded by a lock rather than an actor: the `readabilityHandler`
/// is a synchronous callback on a background queue and cannot await.
private final class LineBuffer: @unchecked Sendable {
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
            if let line = String(data: lineData, encoding: .utf8) {
                lines.append(line)
            }
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
