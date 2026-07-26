import Foundation
import Observation

/// One tool call awaiting a real yes/no from the user.
///
/// Decoded from the CLI's `{"t":"approval",...}` `UiEvent` (see
/// `UiEvent.Approval`). On the wire `detail` is a JSON STRING, not a nested
/// object — `UiEvent.Approval` mirrors the TypeScript `approval` UiEvent
/// verbatim, and this type is what turns that string into fields a view can
/// render without re-parsing JSON itself. See `nexus chat --persistent -t`'s
/// usage text (`packages/cli/src/index.ts`) for the exact payload the CLI's
/// real approval broker sends:
/// `{toolName, permission, mode, reason, input, diff?}`.
public struct PendingApproval: Identifiable, Sendable, Hashable {
    public let id: String
    public let lane: String
    /// Coarse category from the wire's `action` field: `"file"` | `"shell"` |
    /// `"tool"`. Kept as a raw string because this same `UiEvent` case also
    /// carries the wrapped-coding-CLI approval flow (`nexus code`), whose
    /// categories don't line up 1:1 with `permission` below.
    public let action: String
    public let toolName: String
    /// The tool's permission class: `"read"` | `"write"` | `"exec"` | `"network"`.
    public let permission: String
    /// The active `PermissionGate` mode: `"read-only"` | `"ask"` |
    /// `"workspace-write"` | `"full-access"` | `"plan"`.
    public let mode: String
    public let reason: String
    public let input: JSONValue?
    /// Present only for a file write/patch — a unified-diff-shaped preview
    /// (see `buildApprovalDiff` on the CLI side). `nil` for shell/network tools,
    /// which have nothing file-shaped to preview.
    public let diff: String?
    public let receivedAt: Date

    /// Decode from a raw `approval` `UiEvent`. `nil` when `detail` isn't the
    /// JSON object shape the CLI's real approval broker sends — an unrelated or
    /// future producer of this event is not something to crash the app over.
    public init?(event: UiEvent.Approval, receivedAt: Date = Date()) {
        guard let data = event.detail.data(using: .utf8),
              let json = try? JSONDecoder().decode(JSONValue.self, from: data)
        else { return nil }
        guard let toolName = json["toolName"]?.stringValue,
              let permission = json["permission"]?.stringValue,
              let mode = json["mode"]?.stringValue
        else { return nil }
        self.id = event.id
        self.lane = event.lane
        self.action = event.action
        self.toolName = toolName
        self.permission = permission
        self.mode = mode
        self.reason = json["reason"]?.stringValue ?? ""
        self.input = json["input"]
        self.diff = json["diff"]?.stringValue
        self.receivedAt = receivedAt
    }

    #if DEBUG
    /// Test/preview-only constructor — production code only ever decodes from
    /// a real `UiEvent.Approval` via the initializer above.
    public init(
        id: String,
        lane: String = "main",
        action: String,
        toolName: String,
        permission: String,
        mode: String,
        reason: String,
        input: JSONValue? = nil,
        diff: String? = nil,
        receivedAt: Date = Date()
    ) {
        self.id = id
        self.lane = lane
        self.action = action
        self.toolName = toolName
        self.permission = permission
        self.mode = mode
        self.reason = reason
        self.input = input
        self.diff = diff
        self.receivedAt = receivedAt
    }
    #endif
}

/// The CLI's own settlement of an approval this app did not necessarily
/// decide itself — decoded from a `UiEvent.Approval` whose `resolution` is
/// set (a second wire event, same `id` as the original request).
///
/// `cause` is what a view reacts to instead of an explicit decision: `.explicit`
/// already happened locally via `allow`/`deny` (this just confirms it — no
/// further UI action needed); `.timeout` means no one answered in time (offer
/// "ask again", never imply a refusal the human never gave); `.cancelled`/
/// `.stdinClosed` mean the conversation is gone (dismiss as moot, don't show
/// it as a "no").
public struct ApprovalResolution: Identifiable, Sendable, Hashable {
    public let id: String
    public let granted: Bool
    public let cause: UiEvent.Approval.Cause
    public let receivedAt: Date

    public init(id: String, granted: Bool, cause: UiEvent.Approval.Cause, receivedAt: Date = Date()) {
        self.id = id
        self.granted = granted
        self.cause = cause
        self.receivedAt = receivedAt
    }
}

/// One yes/no decision, ready to become the persistent stdin control line
/// `nexus chat --persistent -t` documents.
public struct ApprovalDecision: Sendable, Hashable {
    public let id: String
    public let granted: Bool

    public init(id: String, granted: Bool) {
        self.id = id
        self.granted = granted
    }

    /// The exact stdin control line: one JSON object, one line, no trailing
    /// newline (the caller appends it — see `PersistentSession.send`, which
    /// already does `line + "\n"` for every write). The CLI decodes this as
    /// JSON, so exact key order/spacing is not load-bearing — only the shape
    /// `{"type":"approval","id":...,"decision":"allow"|"deny"}` is.
    public var controlLine: String {
        let escapedId = id
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let decision = granted ? "allow" : "deny"
        return "{\"type\":\"approval\",\"id\":\"\(escapedId)\",\"decision\":\"\(decision)\"}"
    }
}

/// Holds every approval the running conversation has asked for and not yet
/// resolved, oldest first.
///
/// This controller does NOT touch stdin itself — `PersistentSession` owns the
/// process and its pipes. The seam is deliberately one-directional: feed it
/// `UiEvent`s as they arrive (`ingest`), read `pending`/`current` to render a
/// sheet, and get an `ApprovalDecision` back from `allow`/`deny` to actually
/// send (`session.send(decision.controlLine)`). That wiring — wherever the app
/// already folds `UiEvent`s into `ConversationController` — is deliberately
/// left to the caller.
@MainActor
@Observable
public final class ApprovalsController {
    public private(set) var pending: [PendingApproval] = []

    /// The most recent settlement the CLI reported, for ANY approval — including
    /// ones this app itself decided (`cause == .explicit`, a simple echo/no-op
    /// by the time it arrives) and ones the harness decided on its own
    /// (`.timeout`/`.cancelled`/`.stdinClosed`), which a view DOES need to
    /// react to since nothing local already handled them. Overwritten by each
    /// new resolution — a view that needs the full history should keep its
    /// own log keyed off this.
    public private(set) var lastResolution: ApprovalResolution?

    public init() {}

    /// The approval a view should show right now, if any — the oldest
    /// unresolved one, so a burst of tool calls is worked through in order.
    public var current: PendingApproval? { pending.first }

    /// Fold one event in. Non-`.approval` events are ignored, so this can be
    /// wired straight into the same event stream `ConversationController`
    /// already consumes with no extra filtering at the call site.
    ///
    /// An `.approval` event is one of two things: a REQUEST (no `resolution` —
    /// added to `pending`) or a SETTLEMENT (`resolution` present — removes the
    /// matching pending entry, if still there, and records `lastResolution`).
    /// A malformed request (whose `detail` doesn't decode) is silently
    /// ignored; a malformed/settlement-shaped event is never treated as a new
    /// pending item even if it doesn't otherwise decode.
    public func ingest(_ event: UiEvent) {
        guard case .approval(let raw) = event else { return }
        if let resolution = raw.resolution {
            pending.removeAll { $0.id == raw.id }
            lastResolution = ApprovalResolution(id: raw.id, granted: resolution.granted, cause: resolution.cause)
            return
        }
        guard let approval = PendingApproval(event: raw) else { return }
        // A duplicate id (e.g. a replayed log, or a retried emit) replaces
        // rather than duplicates the queued entry.
        pending.removeAll { $0.id == approval.id }
        pending.append(approval)
    }

    /// Resolve an approval (defaulting to the front of the queue), removing it
    /// and returning the decision to send on the wire. `nil` when it is no
    /// longer pending — e.g. the CLI's own timeout already denied it and moved
    /// on, so there is nothing left here to answer.
    @discardableResult
    public func allow(_ id: String? = nil) -> ApprovalDecision? {
        resolve(id: id, granted: true)
    }

    @discardableResult
    public func deny(_ id: String? = nil) -> ApprovalDecision? {
        resolve(id: id, granted: false)
    }

    /// Drop an approval without producing a decision — e.g. its conversation's
    /// process just ended, so there is no stdin left to answer on.
    public func discard(_ id: String) {
        pending.removeAll { $0.id == id }
    }

    /// Clear every pending approval (e.g. the session ended or was cleared).
    public func clear() {
        pending.removeAll()
    }

    private func resolve(id: String?, granted: Bool) -> ApprovalDecision? {
        guard let targetId = id ?? pending.first?.id,
              let idx = pending.firstIndex(where: { $0.id == targetId })
        else { return nil }
        pending.remove(at: idx)
        return ApprovalDecision(id: targetId, granted: granted)
    }
}
