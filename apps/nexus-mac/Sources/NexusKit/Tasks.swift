import Foundation
import Observation

/// Lifecycle state of a `nexus task`, mirroring `TaskStatus` in
/// `@nexuscode/tasks`.
public enum TaskStatus: String, Sendable, Hashable {
    case todo
    case inProgress = "in_progress"
    case blocked
    case done
    case cancelled
    /// A status this build doesn't recognize. Never dropped — an older app
    /// build against a newer CLI that adds a lifecycle state still shows the
    /// task under an "unknown" bucket instead of hiding it.
    case unknown

    public init(wire: String?) {
        self = wire.flatMap(TaskStatus.init(rawValue:)) ?? .unknown
    }

    /// Buckets in the order the Tasks tab groups them.
    public static let displayOrder: [TaskStatus] = [.inProgress, .blocked, .todo, .done, .cancelled, .unknown]
}

/// One row of `nexus task list -o json` (`Task` on the CLI side).
///
/// Decoded from the already-parsed `JSONValue` `NexusClient.runJSON` hands
/// back, following the same defensive style as `NexusSession`.
public struct NexusTask: Sendable, Hashable, Identifiable {
    public let id: String
    public let title: String
    public let status: TaskStatus
    public let parentId: String?
    public let deps: [String]
    public let notes: String?
    public let createdAt: Date?
    public let updatedAt: Date?

    /// Plain memberwise construction — for previews and tests. Kept separate
    /// from `init?(json:)` below, which is the only one that talks to the
    /// CLI's wire format.
    public init(
        id: String,
        title: String,
        status: TaskStatus = .todo,
        parentId: String? = nil,
        deps: [String] = [],
        notes: String? = nil,
        createdAt: Date? = nil,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.parentId = parentId
        self.deps = deps
        self.notes = notes
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// `nil` only when the row has no `id` at all. Unlike `OMCAgent`'s
    /// synthesized placeholder id, a missing id here is NOT papered over with
    /// a generated one: this id is round-tripped straight into a real command
    /// (`task done <id>`), so a fabricated value would silently build a
    /// command that mutates nothing instead of failing loudly.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        self.title = json["title"]?.stringValue ?? "untitled task"
        self.status = TaskStatus(wire: json["status"]?.stringValue)
        self.parentId = json["parentId"]?.stringValue
        self.deps = json["deps"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.notes = json["notes"]?.stringValue
        self.createdAt = NexusEpoch.date(json["createdAt"])
        self.updatedAt = NexusEpoch.date(json["updatedAt"])
    }
}

/// Loads and mutates the Tasks tab's plan, backed by `nexus task …`.
@MainActor
@Observable
public final class TasksController {
    public private(set) var tasks: [NexusTask] = []
    public private(set) var isLoading = false
    public var error: String?

    private let client: NexusClient
    private let workingDirectory: URL?

    public init(client: NexusClient, workingDirectory: URL? = nil) {
        self.client = client
        self.workingDirectory = workingDirectory
    }

    /// Reloads from `nexus task list -o json`.
    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        switch await client.runJSON(.taskList(cwd: workingDirectory)) {
        case .success(let value):
            guard let items = value.arrayValue else {
                error = "unexpected response shape from `nexus task list`"
                return
            }
            tasks = items.compactMap(NexusTask.init(json:))
            error = nil
        case .failure(let commandError):
            error = commandError.message
        }
    }

    /// Adds a task and reloads the list so the new row's server-assigned
    /// fields (id, timestamps) are exactly what the CLI persisted.
    @discardableResult
    public func add(title: String) async -> Bool {
        switch await client.runJSON(.taskAdd(title: title, cwd: workingDirectory)) {
        case .success:
            await refresh()
            return true
        case .failure(let commandError):
            error = commandError.message
            return false
        }
    }

    /// Moves a task to `status`. Fails without running anything for `.todo`/
    /// `.unknown`, since no `nexus task` subcommand targets those directly
    /// (see `NexusCommand.taskSetStatus`).
    @discardableResult
    public func setStatus(_ status: TaskStatus, for id: String) async -> Bool {
        guard let command = NexusCommand.taskSetStatus(status, id: id, cwd: workingDirectory) else {
            error = "no `nexus task` subcommand sets status \"\(status.rawValue)\" directly"
            return false
        }
        switch await client.runJSON(command) {
        case .success:
            await refresh()
            return true
        case .failure(let commandError):
            error = commandError.message
            return false
        }
    }

    @discardableResult
    public func remove(id: String) async -> Bool {
        switch await client.runJSON(.taskRemove(id: id, cwd: workingDirectory)) {
        case .success:
            await refresh()
            return true
        case .failure(let commandError):
            error = commandError.message
            return false
        }
    }

    /// Mirrors the CLI's own `Progress` (`@nexuscode/tasks`): the denominator
    /// excludes cancelled tasks, so cancelling work doesn't depress the score.
    public var progress: (total: Int, completed: Int, percent: Int) {
        let countable = tasks.filter { $0.status != .cancelled }
        let completed = tasks.filter { $0.status == .done }.count
        let percent = countable.isEmpty ? 0 : Int((Double(completed) / Double(countable.count) * 100).rounded())
        return (tasks.count, completed, percent)
    }

    /// Tasks bucketed by status, in the Tasks tab's display order — including
    /// empty buckets, so the tab can render a stable set of sections.
    public var grouped: [(status: TaskStatus, tasks: [NexusTask])] {
        TaskStatus.displayOrder.map { status in (status, tasks.filter { $0.status == status }) }
    }
}
