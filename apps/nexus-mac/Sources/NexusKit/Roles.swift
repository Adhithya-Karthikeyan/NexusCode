import Foundation
import Observation

/// One row of `nexus roles -o json`'s `roles` array — the OODA agent
/// framework's catalog, which `agent --role <id>` resolves against.
///
/// `nexus roles` exists SPECIFICALLY so a client can list what's runnable
/// without hardcoding it — its own doc comment in `packages/cli/src/
/// commands.ts` names "the app's role picker" as the reason it was written.
/// Every field here mirrors that command's `RoleListing` shape, decoded
/// defensively rather than modeled as a closed Swift enum: a hardcoded list
/// would go stale exactly the way the model picker once did (see
/// `ConversationController.role`'s doc for that history).
public struct NexusRole: Sendable, Hashable, Identifiable {
    public let id: String
    /// A short, third-person, plain-words summary of what the role is FOR —
    /// e.g. "Implements code changes to satisfy a plan, and verifies them."
    /// This is picker copy, never the (much longer) system prompt the CLI
    /// assembles from the role preset — `cmdRoles` deliberately omits that.
    public let description: String?
    /// Tool-name allowlist; `["*"]` means every registered tool.
    public let tools: [String]
    /// Hard cap on OODA iterations for this role.
    public let maxSteps: Int?
    /// The sandbox class this role runs under — `"read-only"`,
    /// `"workspace-write"`, `"full-access"`, `"ask"`, or `"plan"` per
    /// `packages/tools/src/permission.ts`'s `PermissionMode`. Kept a plain
    /// `String`, not a closed enum, for the same reason `tools` is: the CLI
    /// owns that vocabulary and can grow it without this decode breaking.
    public let permissionMode: String?

    /// Whether running this role can write files, run shell commands, or
    /// otherwise act beyond reading — i.e. anything that is NOT the safe
    /// `"read-only"` sandbox. A picker warns before letting the user run one
    /// of these (see `ControlStrip`'s role picker in `ConversationView`).
    ///
    /// `permissionMode == nil` reads as `true` (warn) rather than `false`
    /// (assume safe): the CLI's own fallback for an absent value is
    /// `"read-only"` (`cmdRoles`: `def.permissionMode ?? "read-only"`), but
    /// this client has no way to tell "the CLI applied its safe default"
    /// apart from "this build's `nexus roles` doesn't emit the field at
    /// all" — so an unreadable permission class errs toward the visible
    /// warning, the same "never silently assume safe" rule already applied
    /// to approval timeouts and indeterminate agent verdicts.
    public var canWrite: Bool { permissionMode != "read-only" }

    /// Plain memberwise construction — for previews and tests. Kept separate
    /// from `init?(json:)` below, which is the only one that talks to the
    /// CLI's wire format.
    public init(
        id: String,
        description: String? = nil,
        tools: [String] = [],
        maxSteps: Int? = nil,
        permissionMode: String? = nil
    ) {
        self.id = id
        self.description = description
        self.tools = tools
        self.maxSteps = maxSteps
        self.permissionMode = permissionMode
    }

    /// `nil` only when the row has no `id` at all — every other field
    /// tolerates absence, the same defensive style as `NexusProvider`/
    /// `NexusModel`.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        self.description = json["description"]?.stringValue
        self.tools = json["tools"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.maxSteps = json["maxSteps"]?.intValue
        self.permissionMode = json["permissionMode"]?.stringValue
    }
}

/// Loads and holds the OODA role catalog, backed by `nexus roles`. Mirrors
/// `ProvidersController`'s shape — the same "one refresh, no per-item second
/// round trip" style, minus the pricing-merge complexity models need, since a
/// role listing is self-contained on one call.
@MainActor
@Observable
public final class RolesController {
    public private(set) var roles: [NexusRole] = []
    public private(set) var isLoading = false
    public var error: String?

    private let client: NexusClient
    private let workingDirectory: URL?

    public init(client: NexusClient, workingDirectory: URL? = nil) {
        self.client = client
        self.workingDirectory = workingDirectory
    }

    /// Reloads from `nexus roles -o json`.
    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        switch await client.runJSON(.roles(cwd: workingDirectory)) {
        case .success(let value):
            guard let items = value["roles"]?.arrayValue else {
                error = "unexpected response shape from `nexus roles`"
                return
            }
            roles = items.compactMap(NexusRole.init(json:))
            error = nil
        case .failure(let commandError):
            error = commandError.message
        }
    }
}

// MARK: - Command factory

extension NexusCommand {
    public static func roles(cwd: URL? = nil) -> NexusCommand {
        .json(["roles"], cwd: cwd)
    }
}
