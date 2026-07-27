import Foundation

/// One normalized event from `nexus … -o ndjson`.
///
/// This mirrors the TypeScript `UiEvent` union in
/// `packages/core/src/projection.ts` (plus the client-injected `prompt` marker
/// from `packages/tui/src/store/events.ts`). It is the ONLY contract between
/// the CLI and this app.
///
/// It is hand-written rather than generated because the source is a TypeScript
/// *type* union, and parsing types out of source is brittle. Drift is caught
/// instead by `UiEventDecodingTests`, which decodes a fixture containing every
/// variant: if the CLI changes a field, the decode fails loudly in CI rather
/// than silently rendering an empty panel. The repo already documents this exact
/// hazard for its own CLI/TUI projection copies, so the guard is deliberate.
public enum UiEvent: Sendable, Hashable {
    case session(Session)
    case route(Route)
    case failover(Failover)
    case prompt(Prompt)
    case text(Delta)
    case reasoning(Delta)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    case diff(Diff)
    case approval(Approval)
    case agent(Agent)
    case usage(Usage)
    case error(RunError)
    case done(Done)

    /// An event whose `t` this build does not know. Never dropped: an unknown
    /// event still reaches the UI so a newer CLI degrades to "something
    /// happened" instead of silence.
    case unknown(type: String, raw: JSONValue)

    public struct Session: Sendable, Hashable, Codable {
        /// The RUN id — one per dispatched run, NOT stable across turns.
        public let id: String
        /// The engine SESSION id — stable for the whole conversation and the
        /// only value `--resume` accepts.
        ///
        /// Optional because older CLI builds omit it: the event was originally
        /// emitted with only `id`, which is a run id, so a client that passed it
        /// to `--resume` silently got a brand-new session every turn. Decoding
        /// it as optional means this app works against both old and new CLIs and
        /// can tell when resume is genuinely unavailable rather than guessing.
        public let sessionId: String?
        public let provider: String
        public let model: String
        public let ts: Double
    }

    public enum RouteReason: String, Sendable, Hashable, Codable {
        case explicit, cost, latency, capability, local
    }

    public struct Route: Sendable, Hashable, Codable {
        public let chosen: String
        public let reason: RouteReason
        public let candidates: [String]
    }

    public struct Failover: Sendable, Hashable, Codable {
        public let lane: String
        public let from: String
        public let to: String
        public let code: String
        public let message: String
    }

    public struct Prompt: Sendable, Hashable, Codable {
        public let lane: String
        public let id: String
        public let text: String
    }

    /// Shared shape of the two streaming-text events (`text`, `reasoning`).
    public struct Delta: Sendable, Hashable, Codable {
        public let lane: String
        public let delta: String
    }

    public struct ToolCall: Sendable, Hashable {
        public let lane: String
        public let id: String
        public let name: String
        public let args: JSONValue?
    }

    public struct ToolResult: Sendable, Hashable {
        public let lane: String
        public let id: String
        public let ok: Bool
        public let result: JSONValue?
    }

    public struct Diff: Sendable, Hashable, Codable {
        public let lane: String
        public let path: String
        public let patch: String
    }

    public struct Approval: Sendable, Hashable, Codable {
        public let lane: String
        public let id: String
        public let action: String
        public let detail: String
        /// Present only on a SECOND `approval` event carrying the same `id` as
        /// an earlier request — the CLI's own settlement of that approval.
        /// `nil` on the original request (still pending) and on the
        /// wrapped-coding-CLI's unrelated approval-request flow, which never
        /// resolves this way.
        public let resolution: Resolution?

        /// The structured outcome of an approval, alongside (not instead of)
        /// the human-readable `reason` prose the CLI still records in the
        /// corresponding `tool_result` — this is what a client switches on
        /// instead of parsing that prose.
        public struct Resolution: Sendable, Hashable, Codable {
            public let granted: Bool
            public let cause: Cause
        }

        /// A closed set — exactly what `nexus chat --persistent -t`'s real
        /// approval broker can report. `.explicit` is a real human (or
        /// scripted client) decision — final, show it and stop. The other
        /// three are the HARNESS deciding FOR the human and want different
        /// treatment: `.timeout` is NOT a decision (offer to ask again);
        /// `.cancelled`/`.stdinClosed` mean the conversation is gone (the
        /// approval is moot — dismiss it, don't report it as a refusal).
        public enum Cause: String, Sendable, Hashable, Codable {
            case explicit
            case timeout
            case cancelled
            case stdinClosed = "stdin-closed"
        }
    }

    /// One step of NexusCode's own OODA agent loop (`nexus agent --role …`).
    ///
    /// Emitted ALONGSIDE — never instead of — the `reasoning` event carrying the
    /// same narration, so a plain chat renderer keeps showing the prose while a
    /// richer view (the Agents tab) draws structure from these fields. Expect
    /// the pair `[agent, reasoning]` back to back.
    ///
    /// This is the framework NexusCode owns, and it is provider-agnostic by
    /// construction: no role preset pins a model or a provider, so the identical
    /// loop runs on anthropic, codex, or any other registered adapter. That is
    /// what makes an "agents" view meaningful for every provider rather than
    /// just for Claude.
    public struct Agent: Sendable, Hashable, Codable {
        public let lane: String
        /// `"plan"`, `"observe"`, `"reflect"`, `"replan"`, `"retry"`,
        /// `"delegate"`, `"progress"`, `"goal"`, `"stop"`, `"step-start"`.
        ///
        /// Deliberately a `String` and not an enum: the phase vocabulary lives
        /// in the agent package and grows there. A closed Swift enum would fail
        /// to decode — and so blank the whole event — the first time the CLI
        /// added a phase. A view switches on the values it knows and shows the
        /// raw string otherwise.
        public let phase: String
        public let role: String
        public let step: Int
        /// The same human-readable narration the paired `reasoning` event
        /// carries, duplicated here so one agent step is self-contained.
        ///
        /// Optional because the alternative — having the fold assume the NEXT
        /// event is always this step's narration — would couple a pure
        /// `(state, event) -> state` reducer to wire adjacency, and break the
        /// moment a reasoning delta interleaved. An absent `text` costs
        /// nothing: the prose is still accumulated on the turn either way.
        public let text: String?
        /// Phase-specific detail, keyed by `phase`:
        /// `progress` → `{percent}`; `stop` → `{stopReason, verdict}`;
        /// `goal` → `{verdict}`; `delegate` → `{role, goal}`;
        /// `reflect` → `{reflection}`; `replan` → a task subtree.
        /// Shape varies, so it stays untyped here.
        public let data: JSONValue?
    }

    public struct Usage: Sendable, Hashable, Codable {
        public let lane: String
        public let inputTokens: Int
        public let outputTokens: Int
        public let cacheRead: Int?
        public let cacheWrite: Int?
        public let costUsd: Double
    }

    public struct RunError: Sendable, Hashable, Codable {
        public let lane: String
        public let code: String
        public let message: String
        public let retryable: Bool
    }

    public struct Done: Sendable, Hashable, Codable {
        public let lane: String
        public let finishReason: String
    }

    /// The lane this event belongs to, when it has one.
    ///
    /// Lanes are how a multi-provider run keeps concurrent agents apart: a
    /// single run collapses to `"main"`, while a race/compare run keys each lane
    /// by adapter id. This is what the Agents view groups on.
    public var lane: String? {
        switch self {
        case .session, .route: return nil
        case .failover(let e): return e.lane
        case .prompt(let e): return e.lane
        case .text(let e), .reasoning(let e): return e.lane
        case .toolCall(let e): return e.lane
        case .toolResult(let e): return e.lane
        case .diff(let e): return e.lane
        case .approval(let e): return e.lane
        case .agent(let e): return e.lane
        case .usage(let e): return e.lane
        case .error(let e): return e.lane
        case .done(let e): return e.lane
        case .unknown: return nil
        }
    }

    /// The discriminant, as it appears on the wire.
    public var wireType: String {
        switch self {
        case .session: return "session"
        case .route: return "route"
        case .failover: return "failover"
        case .prompt: return "prompt"
        case .text: return "text"
        case .reasoning: return "reasoning"
        case .toolCall: return "tool_call"
        case .toolResult: return "tool_result"
        case .diff: return "diff"
        case .approval: return "approval"
        case .agent: return "agent"
        case .usage: return "usage"
        case .error: return "error"
        case .done: return "done"
        case .unknown(let type, _): return type
        }
    }
}

// MARK: - Decoding

extension UiEvent: Decodable {
    private enum Tag: CodingKey { case t }

    public init(from decoder: Decoder) throws {
        let tagged = try decoder.container(keyedBy: Tag.self)
        let type = try tagged.decode(String.self, forKey: .t)
        let single = try decoder.singleValueContainer()

        switch type {
        case "session": self = .session(try single.decode(Session.self))
        case "route": self = .route(try single.decode(Route.self))
        case "failover": self = .failover(try single.decode(Failover.self))
        case "prompt": self = .prompt(try single.decode(Prompt.self))
        case "text": self = .text(try single.decode(Delta.self))
        case "reasoning": self = .reasoning(try single.decode(Delta.self))
        case "diff": self = .diff(try single.decode(Diff.self))
        case "approval": self = .approval(try single.decode(Approval.self))
        case "agent": self = .agent(try single.decode(Agent.self))
        case "usage": self = .usage(try single.decode(Usage.self))
        case "error": self = .error(try single.decode(RunError.self))
        case "done": self = .done(try single.decode(Done.self))

        // `args` / `result` are `unknown` on the wire, so these two decode
        // through JSONValue rather than a generated struct.
        case "tool_call":
            let raw = try single.decode(JSONValue.self)
            self = .toolCall(
                ToolCall(
                    lane: raw["lane"]?.stringValue ?? "main",
                    id: raw["id"]?.stringValue ?? "",
                    name: raw["name"]?.stringValue ?? "",
                    args: raw["args"]
                )
            )
        case "tool_result":
            let raw = try single.decode(JSONValue.self)
            var ok = false
            if case .bool(let value)? = raw["ok"] { ok = value }
            self = .toolResult(
                ToolResult(
                    lane: raw["lane"]?.stringValue ?? "main",
                    id: raw["id"]?.stringValue ?? "",
                    ok: ok,
                    result: raw["result"]
                )
            )

        default:
            self = .unknown(type: type, raw: try single.decode(JSONValue.self))
        }
    }
}

// MARK: - Stream decoding

public enum UiEventDecoder {
    /// Decode one ndjson line. Returns `nil` for blank lines.
    ///
    /// A line that is not valid JSON, or not an object with a `t`, is surfaced
    /// as `.unknown` rather than thrown away — a CLI that interleaves a stray
    /// warning on stdout must not be able to silently truncate the UI's view of
    /// a run.
    public static func decodeLine(_ line: String) -> UiEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        do {
            return try JSONDecoder().decode(UiEvent.self, from: data)
        } catch {
            return .unknown(type: "malformed", raw: .string(trimmed))
        }
    }

    /// Decode a whole ndjson document (used by tests and by session replay).
    public static func decodeStream(_ text: String) -> [UiEvent] {
        text.split(separator: "\n", omittingEmptySubsequences: true)
            .compactMap { decodeLine(String($0)) }
    }
}
