import Foundation

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
    public static func discover(
        explicit: URL? = nil,
        repoRoot: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileExists: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> NexusBinary? {
        if let explicit, fileExists(explicit.path) { return NexusBinary(url: explicit) }

        var candidates: [String] = []
        if let override = environment["NEXUS_BIN"], !override.isEmpty {
            candidates.append(override)
        }
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
                for line in buffer.append(data) {
                    if let event = UiEventDecoder.decodeLine(line) {
                        continuation.yield(.event(event))
                    }
                }
            }
            err.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                for line in text.split(separator: "\n") where !line.isEmpty {
                    continuation.yield(.diagnostic(String(line)))
                }
            }

            process.terminationHandler = { finished in
                out.fileHandleForReading.readabilityHandler = nil
                err.fileHandleForReading.readabilityHandler = nil
                // Drain whatever was buffered after the last newline.
                for line in buffer.flush() {
                    if let event = UiEventDecoder.decodeLine(line) {
                        continuation.yield(.event(event))
                    }
                }
                continuation.yield(.terminated(.finished(exitCode: finished.terminationStatus)))
                continuation.finish()
            }

            continuation.onTermination = { reason in
                if case .cancelled = reason, process.isRunning {
                    process.terminate()
                }
            }

            do {
                try process.run()
            } catch {
                continuation.yield(.terminated(.failedToLaunch(error.localizedDescription)))
                continuation.finish()
            }
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
