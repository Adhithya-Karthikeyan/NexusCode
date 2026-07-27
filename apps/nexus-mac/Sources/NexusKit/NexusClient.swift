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
        fileExists: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> NexusBinary? {
        if let explicit, fileExists(explicit.path) { return NexusBinary(url: explicit) }

        // Blank or whitespace-only is treated as unset, never as a literal
        // path — `trimmingCharacters` first, not just `isEmpty`, so
        // `NEXUS_BIN="   "` (a real way an env var ends up set-but-blank,
        // e.g. from an unquoted shell substitution) falls through to the
        // normal candidates below instead of being treated as an explicit
        // override that then predictably fails to resolve.
        if let override = environment["NEXUS_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            return fileExists(override) ? NexusBinary(url: URL(fileURLWithPath: override)) : nil
        }

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
        return candidates.first(where: fileExists).map { NexusBinary(url: URL(fileURLWithPath: $0)) }
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
    public static func explainMissing(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let override = environment["NEXUS_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !override.isEmpty {
            return "NEXUS_BIN is set to \"\(override)\", but nothing executable exists there."
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
}

/// Runs `nexus` and turns its stdout into a stream of `UiEvent`s.
///
/// Deliberately thin: spawn, split stdout on newlines, decode, forward. All
/// interpretation lives in `ViewState`. Nothing here knows what a provider is.
public actor NexusClient {
    private let binary: NexusBinary

    public init(binary: NexusBinary) {
        self.binary = binary
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
    public nonisolated func runJSON(_ command: NexusCommand) async -> Result<JSONValue, NexusCommandError> {
        let process = Process()
        let collector = OutputCollector()
        let termination = await withCheckedContinuation { (continuation: CheckedContinuation<NexusTermination, Never>) in
            launch(
                process, command,
                onLine: { collector.addLine($0) },
                onDiagnostic: { collector.addDiagnostic($0) },
                onTerminated: { reason in continuation.resume(returning: reason) }
            )
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
        // A GUI process has a minimal environment; pass a usable PATH so any
        // tool the CLI shells out to can still be found.
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = (environment["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        environment["NO_COLOR"] = "1"
        process.environment = environment

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
            // Drain whatever was buffered after the last newline.
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
