import Foundation
import Observation

/// One MCP server row, backed by `nexus mcp tools -o json`'s `servers` array
/// — which mirrors the CLI's own `McpServerReport` (`packages/cli/src/mcp.ts`)
/// exactly: `name`/`transport`/`connected`/`toolCount`/`error`.
///
/// `mcp tools` only ever reports servers that were both DECLARED and ENABLED
/// (`enabledMcpServers` filters the config before anything connects), so a
/// disabled server would otherwise vanish from the list entirely instead of
/// showing up greyed out — the same "never hide it, show the reason" rule
/// `NexusProvider`/`SelectableProvider` follow. `IntegrationsController`
/// restores those rows by falling back to `nexus mcp list -o json` (the
/// declared config) for any server `mcp tools` never attempted.
public struct McpServer: Sendable, Hashable, Identifiable {
    public let name: String
    public let transport: String?
    public let enabled: Bool
    public let connected: Bool
    public let toolCount: Int
    /// Failure detail when `connected` is false. Absent for a merely-disabled
    /// server — that's a configuration choice, not a failure.
    public let error: String?

    public var id: String { name }

    /// Plain memberwise construction — for previews and tests.
    public init(
        name: String,
        transport: String? = nil,
        enabled: Bool = true,
        connected: Bool = false,
        toolCount: Int = 0,
        error: String? = nil
    ) {
        self.name = name
        self.transport = transport
        self.enabled = enabled
        self.connected = connected
        self.toolCount = toolCount
        self.error = error
    }

    /// Decodes one entry of `mcp tools -o json`'s `servers` array. Every
    /// server reported there was enabled (see the type doc), so `enabled` is
    /// always `true` here — only `init(listEntry:)` below can produce `false`.
    public init?(toolsReport json: JSONValue) {
        guard let name = json["name"]?.stringValue else { return nil }
        self.name = name
        self.transport = json["transport"]?.stringValue
        self.enabled = true
        self.connected = json["connected"]?.boolValue ?? false
        self.toolCount = json["toolCount"]?.intValue ?? 0
        self.error = json["error"]?.stringValue
    }

    /// Decodes one entry of `mcp list -o json` — the declared config. Used
    /// only to fill in servers `mcp tools` never attempted a connection for
    /// (i.e. disabled ones); carries no live connection data.
    public init?(listEntry json: JSONValue) {
        guard let name = json["name"]?.stringValue else { return nil }
        self.name = name
        self.transport = json["transport"]?.stringValue
        self.enabled = json["enabled"]?.boolValue ?? false
        self.connected = false
        self.toolCount = 0
        self.error = nil
    }
}

/// One optional-package hint from `tools list -o json`'s per-group
/// `integrations` array (e.g. `{"name":"playwright","kind":"npm","available":
/// false,"hint":"npm i playwright"}`).
public struct ToolIntegration: Sendable, Hashable, Identifiable {
    public let name: String
    public let kind: String?
    public let available: Bool
    public let hint: String?

    public var id: String { name }

    public init?(json: JSONValue) {
        guard let name = json["name"]?.stringValue else { return nil }
        self.name = name
        self.kind = json["kind"]?.stringValue
        self.available = json["available"]?.boolValue ?? false
        self.hint = json["hint"]?.stringValue
    }
}

/// One entry of `tools list -o json`'s top-level `groups` array — the
/// human-facing description and optional-package install hints that explain
/// WHY a group (and every tool inside it) is enabled or disabled, the same
/// role `NexusProvider.detail` plays for providers.
public struct ToolGroupInfo: Sendable, Hashable, Identifiable {
    public let group: String
    public let description: String?
    public let enabled: Bool
    public let integrations: [ToolIntegration]

    public var id: String { group }

    public init?(json: JSONValue) {
        guard let group = json["group"]?.stringValue else { return nil }
        self.group = group
        self.description = json["description"]?.stringValue
        self.enabled = json["enabled"]?.boolValue ?? false
        self.integrations = json["integrations"]?.arrayValue?.compactMap(ToolIntegration.init(json:)) ?? []
    }
}

/// The `PermissionGate` class a tool call falls under, mirroring the CLI's own
/// classes (`read`/`write`/`exec`/`network`).
public enum ToolPermission: String, Sendable, Hashable {
    case read
    case write
    case exec
    case network
    /// A class this build doesn't recognize. Never dropped — same rationale
    /// as `TaskStatus.unknown`: a future CLI adding a permission class must
    /// not crash the decode or silently disappear the tool.
    case unknown

    public init(wire: String?) {
        self = wire.flatMap(ToolPermission.init(rawValue:)) ?? .unknown
    }
}

/// One row of `tools list -o json`'s flat top-level `tools` array — distinct
/// from its `groups` array, which nests only tool NAMES; this is the one with
/// `permission`/`enabled`/`integrationAvailable` per tool.
public struct NexusTool: Sendable, Hashable, Identifiable {
    public let name: String
    public let permission: ToolPermission
    public let group: String?
    /// Whether this tool's group is in `config.tools.enabledGroups` — NOT
    /// whether its optional package/binary is installed; see
    /// `integrationAvailable` for that axis.
    public let enabled: Bool
    /// `nil` when the tool has no optional dependency at all (e.g.
    /// `web_search` needs nothing extra, so the CLI reports `null`); `true`/
    /// `false` once it does.
    public let integrationAvailable: Bool?

    public var id: String { name }

    /// Plain memberwise construction — for previews and tests.
    public init(
        name: String,
        permission: ToolPermission = .unknown,
        group: String? = nil,
        enabled: Bool = false,
        integrationAvailable: Bool? = nil
    ) {
        self.name = name
        self.permission = permission
        self.group = group
        self.enabled = enabled
        self.integrationAvailable = integrationAvailable
    }

    /// `nil` only when the row has no `name` at all.
    public init?(json: JSONValue) {
        guard let name = json["name"]?.stringValue else { return nil }
        self.name = name
        self.permission = ToolPermission(wire: json["permission"]?.stringValue)
        self.group = json["group"]?.stringValue
        self.enabled = json["enabled"]?.boolValue ?? false
        self.integrationAvailable = json["integrationAvailable"]?.boolValue
    }
}

/// Loads and holds the Integrations tab's data, backed by `nexus mcp …` and
/// `nexus tools …`.
@MainActor
@Observable
public final class IntegrationsController {
    public private(set) var mcpServers: [McpServer] = []
    public private(set) var tools: [NexusTool] = []
    public private(set) var groups: [ToolGroupInfo] = []
    public private(set) var isLoading = false
    public var error: String?

    private let client: NexusClient
    private let workingDirectory: URL?

    public init(client: NexusClient, workingDirectory: URL? = nil) {
        self.client = client
        self.workingDirectory = workingDirectory
    }

    /// Reloads MCP servers (merging `mcp list`'s declared config with `mcp
    /// tools`'s live connection report — see `McpServer`'s doc for why both
    /// are needed) and the tool registry, all three requests in flight at
    /// once since none depends on another's result.
    ///
    /// - Parameter timeoutSeconds: forwarded to every `runJSON` call below.
    ///   Non-optional and always on, unlike `runJSON`'s own `nil`-means-
    ///   unbounded parameter: `mcp tools` starts every enabled MCP server to
    ///   report on it, so a caller here can never opt back into the
    ///   "Loading integrations…forever" bug this exists to fix. Defaults to
    ///   `runJSON`'s own default (20s); overridable so a test can prove the
    ///   bound without a real 20-second wait.
    public func refresh(timeoutSeconds: Double = 20) async {
        isLoading = true
        defer { isLoading = false }

        async let listResult = client.runJSON(.mcpList(cwd: workingDirectory), timeoutSeconds: timeoutSeconds)
        async let toolsReportResult = client.runJSON(.mcpTools(cwd: workingDirectory), timeoutSeconds: timeoutSeconds)
        async let toolsListResult = client.runJSON(.toolsList(cwd: workingDirectory), timeoutSeconds: timeoutSeconds)

        var messages: [String] = []

        let declared: [McpServer]
        switch await listResult {
        case .success(let value):
            if let items = value.arrayValue {
                declared = items.compactMap { McpServer(listEntry: $0) }
            } else {
                declared = []
                messages.append("nexus mcp list: unexpected response shape")
            }
        case .failure(let commandError):
            declared = []
            // Prefixed with the literal command, not just the raw error: a
            // wedged/failed `nexus` process is exactly when a user needs to
            // know WHICH of the three concurrent requests didn't answer, not
            // only that something didn't — `commandError.message` alone
            // (e.g. "nexus did not respond within 20s") doesn't say which one.
            messages.append("nexus mcp list: \(commandError.message)")
        }

        var reportedByName: [String: McpServer] = [:]
        switch await toolsReportResult {
        case .success(let value):
            for item in value["servers"]?.arrayValue ?? [] {
                if let server = McpServer(toolsReport: item) {
                    reportedByName[server.name] = server
                }
            }
        case .failure(let commandError):
            messages.append("nexus mcp tools: \(commandError.message)")
        }

        // A live connection report wins when a server is both declared and
        // was attempted; a declared-but-never-attempted (disabled) server
        // falls back to its config row so it still shows up, just greyed out.
        let declaredNames = Set(declared.map(\.name))
        mcpServers = declared.map { reportedByName[$0.name] ?? $0 }
            + reportedByName.values.filter { !declaredNames.contains($0.name) }

        switch await toolsListResult {
        case .success(let value):
            guard let toolItems = value["tools"]?.arrayValue else {
                messages.append("nexus tools list: unexpected response shape")
                tools = []
                groups = []
                break
            }
            tools = toolItems.compactMap(NexusTool.init(json:))
            groups = value["groups"]?.arrayValue?.compactMap(ToolGroupInfo.init(json:)) ?? []
        case .failure(let commandError):
            messages.append("nexus tools list: \(commandError.message)")
        }

        error = messages.isEmpty ? nil : messages.joined(separator: "; ")
    }
}

// MARK: - Command factories

extension NexusCommand {
    public static func mcpList(cwd: URL? = nil) -> NexusCommand {
        .json(["mcp", "list"], cwd: cwd)
    }

    public static func mcpTools(cwd: URL? = nil) -> NexusCommand {
        .json(["mcp", "tools"], cwd: cwd)
    }

    public static func toolsList(cwd: URL? = nil) -> NexusCommand {
        .json(["tools", "list"], cwd: cwd)
    }
}
