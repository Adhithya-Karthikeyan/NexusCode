import Foundation

/// A long-lived `nexus` conversation.
///
/// The first implementation spawned a fresh process per message and tried to
/// stitch context back together with `--resume`. That was wrong twice over: a
/// process spawn per keystroke-worth-of-thought is slow, and the id it was
/// resuming with was a RUN id rather than a session id, so every turn silently
/// started from nothing.
///
/// This holds ONE process open for the whole conversation and writes each
/// prompt to its stdin. The engine keeps the session — and therefore the
/// transcript, the context budget, the provider circuit and the cost tally —
/// alive across turns, which is what makes this a harness rather than a
/// sequence of unrelated one-shot calls.
public actor PersistentSession {
    /// Lifecycle of the underlying process, surfaced so the UI can distinguish
    /// "thinking" from "the backend died".
    public enum State: Sendable, Hashable {
        case idle
        case starting
        case ready(sessionId: String?)
        case failed(String)
        case stopped(exitCode: Int32)
    }

    public private(set) var state: State = .idle

    private let binary: NexusBinary
    private let workingDirectory: URL?
    private let arguments: [String]

    private var process: Process?
    private var stdin: FileHandle?
    private var continuation: AsyncStream<NexusStreamItem>.Continuation?

    /// Prompts submitted before the process was ready. Held rather than dropped
    /// so a message typed during startup is not silently lost.
    private var pending: [String] = []
    private var isReady = false

    /// - Parameter extraArguments: provider/model selection etc. The persistent
    ///   flag and ndjson output are always applied — they are what make this a
    ///   machine-readable session rather than a REPL.
    public init(
        binary: NexusBinary,
        workingDirectory: URL? = nil,
        resume sessionId: String? = nil,
        extraArguments: [String] = []
    ) {
        self.binary = binary
        self.workingDirectory = workingDirectory
        var args = ["chat", "--persistent", "-o", "ndjson"]
        if let sessionId { args += ["--resume", sessionId] }
        args += extraArguments
        self.arguments = args
    }

    /// The event stream for the whole conversation. Call once.
    public func start() -> AsyncStream<NexusStreamItem> {
        AsyncStream { continuation in
            self.continuation = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.stop() }
            }
            launch(continuation)
        }
    }

    /// Queue a prompt. Safe to call before the process is ready.
    public func send(_ prompt: String) {
        let line = prompt
            .trimmingCharacters(in: .whitespacesAndNewlines)
            // A newline is the turn delimiter on the wire, so an embedded one
            // would be read as two prompts. Collapse them; the CLI takes one
            // prompt per line.
            .replacingOccurrences(of: "\n", with: " ")
        guard !line.isEmpty else { return }
        guard isReady, let stdin else {
            pending.append(line)
            return
        }
        write(line, to: stdin)
    }

    /// Close stdin and let the process exit cleanly. Idempotent.
    public func stop() {
        guard let process else { return }
        // Closing stdin is the graceful shutdown: persistent mode exits on EOF,
        // which lets it dispose its session, engine and stores properly.
        // Terminating outright would skip that.
        try? stdin?.close()
        stdin = nil
        if process.isRunning {
            process.terminate()
        }
        self.process = nil
        isReady = false
        continuation?.finish()
        continuation = nil
    }

    // MARK: - Private

    private func write(_ line: String, to handle: FileHandle) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        do {
            try handle.write(contentsOf: data)
        } catch {
            // A broken pipe means the backend is gone; report it rather than
            // leaving the UI waiting for a reply that can never arrive.
            continuation?.yield(.terminated(.failedToLaunch("stdin closed: \(error.localizedDescription)")))
            isReady = false
        }
    }

    private func markReady(sessionId: String?) {
        guard !isReady else { return }
        isReady = true
        state = .ready(sessionId: sessionId)
        guard let stdin else { return }
        for line in pending { write(line, to: stdin) }
        pending.removeAll()
    }

    private func launch(_ continuation: AsyncStream<NexusStreamItem>.Continuation) {
        state = .starting

        let process = Process()
        let (executable, leading) = binary.launch
        process.executableURL = executable
        process.arguments = leading + arguments
        if let workingDirectory { process.currentDirectoryURL = workingDirectory }

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

        let buffer = PersistentLineBuffer()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            for line in buffer.append(data) {
                guard let event = UiEventDecoder.decodeLine(line) else { continue }
                continuation.yield(.event(event))
                // The first session event names the conversation. Once it
                // arrives the backend is accepting input, so anything typed
                // during startup can be flushed.
                if case .session(let session) = event {
                    Task { await self?.markReady(sessionId: session.sessionId ?? session.id) }
                }
            }
        }

        let errorBuffer = PersistentLineBuffer()
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            for line in errorBuffer.append(data) {
                continuation.yield(.diagnostic(line))
                // Persistent mode announces itself on stderr before any event;
                // treat that as the readiness signal too, so a backend that
                // emits no session event still accepts queued input.
                if line.contains("[session]") {
                    let id = line.split(separator: " ").last.map(String.init)
                    Task { await self?.markReady(sessionId: id) }
                }
            }
        }

        process.terminationHandler = { [weak self] finished in
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            for line in buffer.flush() {
                if let event = UiEventDecoder.decodeLine(line) { continuation.yield(.event(event)) }
            }
            continuation.yield(.terminated(.finished(exitCode: finished.terminationStatus)))
            continuation.finish()
            Task { await self?.markStopped(finished.terminationStatus) }
        }

        do {
            try process.run()
            self.process = process
            self.stdin = input.fileHandleForWriting
        } catch {
            state = .failed(error.localizedDescription)
            continuation.yield(.terminated(.failedToLaunch(error.localizedDescription)))
            continuation.finish()
        }
    }

    private func markStopped(_ code: Int32) {
        isReady = false
        process = nil
        stdin = nil
        state = .stopped(exitCode: code)
    }
}

/// Same line-splitting contract as the one-shot client: only complete lines are
/// decoded, so a JSON object split across two reads is never parsed in halves.
private final class PersistentLineBuffer: @unchecked Sendable {
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
