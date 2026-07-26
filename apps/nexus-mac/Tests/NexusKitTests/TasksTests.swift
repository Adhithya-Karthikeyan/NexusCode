import XCTest
@testable import NexusKit

/// `NexusTask` decodes straight from the `JSONValue` `NexusClient.runJSON`
/// hands back, driven by a fixture shaped like `nexus task list -o json` that
/// deliberately mixes a normal task, one missing every optional field, one
/// with a status this build has never heard of, and one with no `id` at all —
/// the four ways a real task list actually goes sideways.
final class TasksTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    }

    private func fixtureText(_ name: String) throws -> String {
        try String(contentsOf: try fixtureURL(name), encoding: .utf8)
    }

    private func fixtureJSON(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: try fixtureURL(name)))
    }

    private func decodedTasks() throws -> [NexusTask] {
        try XCTUnwrap(try fixtureJSON("tasks-list").arrayValue).compactMap(NexusTask.init(json:))
    }

    // MARK: - NexusTask decode

    func testDecodesANormalTaskWithAllItsFields() throws {
        let task = try XCTUnwrap(try decodedTasks().first { $0.id == "t1" })
        XCTAssertEqual(task.title, "Write tests")
        XCTAssertEqual(task.status, .inProgress)
        XCTAssertEqual(task.parentId, "t0")
        XCTAssertEqual(task.deps, ["t-dep1", "t-dep2"])
        XCTAssertEqual(task.notes, "in progress, on track")
    }

    func testMissingOptionalFieldsDefaultSensiblyRatherThanFailingTheRow() throws {
        let task = try XCTUnwrap(try decodedTasks().first { $0.id == "t2" })
        XCTAssertEqual(task.status, .done)
        XCTAssertNil(task.parentId)
        XCTAssertNil(task.notes)
        XCTAssertEqual(task.deps, [], "an absent `deps` must default to empty, not crash the decode")
    }

    func testUnknownStatusValueDecodesToTheUnknownCaseNotAThrow() throws {
        let task = try XCTUnwrap(try decodedTasks().first { $0.id == "t3" })
        // "waiting-on-review" is not a status this build knows about — a
        // future CLI adding a lifecycle state must not crash the decode.
        XCTAssertEqual(task.status, .unknown)
        // Absent createdAt/updatedAt/deps on the same row degrade too.
        XCTAssertNil(task.createdAt)
        XCTAssertEqual(task.deps, [])
    }

    func testRowsWithNoIdAreDroppedRatherThanCrashingTheWholeDecode() throws {
        let items = try XCTUnwrap(try fixtureJSON("tasks-list").arrayValue)
        XCTAssertEqual(items.count, 4, "fixture shape changed")

        let tasks = try decodedTasks()
        XCTAssertEqual(tasks.count, 3, "the row without an id must be dropped, not fail the array")
    }

    func testEpochMillisAreConvertedNotTreatedAsSeconds() throws {
        let task = try XCTUnwrap(try decodedTasks().first { $0.id == "t1" })
        XCTAssertEqual(task.createdAt, Date(timeIntervalSince1970: 1_750_000_000))
        XCTAssertEqual(task.updatedAt, Date(timeIntervalSince1970: 1_750_003_600))
    }

    func testEmptyArrayProducesAnEmptyListNotAFailure() {
        XCTAssertTrue([JSONValue]().compactMap(NexusTask.init(json:)).isEmpty)
    }

    // MARK: - TaskStatus

    func testTaskStatusWireValuesRoundTrip() {
        XCTAssertEqual(TaskStatus(wire: "todo"), .todo)
        XCTAssertEqual(TaskStatus(wire: "in_progress"), .inProgress)
        XCTAssertEqual(TaskStatus(wire: "blocked"), .blocked)
        XCTAssertEqual(TaskStatus(wire: "done"), .done)
        XCTAssertEqual(TaskStatus(wire: "cancelled"), .cancelled)
        XCTAssertEqual(TaskStatus(wire: nil), .unknown)
        XCTAssertEqual(TaskStatus(wire: "something-new"), .unknown)
    }

    // MARK: - Command factories

    func testTaskListBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.taskList().arguments, ["task", "list", "-o", "json"])
    }

    func testTaskAddBuildsAJsonCommandWithTheTitle() {
        XCTAssertEqual(NexusCommand.taskAdd(title: "write docs").arguments, ["task", "add", "write docs", "-o", "json"])
    }

    func testTaskRemoveBuildsAJsonCommandWithTheId() {
        XCTAssertEqual(NexusCommand.taskRemove(id: "t1").arguments, ["task", "rm", "t1", "-o", "json"])
    }

    func testTaskSetStatusMapsEachSupportedStatusToItsSubcommand() {
        XCTAssertEqual(NexusCommand.taskSetStatus(.inProgress, id: "t1")?.arguments, ["task", "start", "t1", "-o", "json"])
        XCTAssertEqual(NexusCommand.taskSetStatus(.done, id: "t1")?.arguments, ["task", "done", "t1", "-o", "json"])
        XCTAssertEqual(NexusCommand.taskSetStatus(.blocked, id: "t1")?.arguments, ["task", "block", "t1", "-o", "json"])
        XCTAssertEqual(NexusCommand.taskSetStatus(.cancelled, id: "t1")?.arguments, ["task", "cancel", "t1", "-o", "json"])
    }

    func testTaskSetStatusHasNoCommandForTodoOrUnknown() {
        // No `nexus task` subcommand reverts a task to `todo`, and `.unknown`
        // isn't a real target status — both must fail to build a command
        // rather than silently constructing a bogus one.
        XCTAssertNil(NexusCommand.taskSetStatus(.todo, id: "t1"))
        XCTAssertNil(NexusCommand.taskSetStatus(.unknown, id: "t1"))
    }

    // MARK: - TasksController: progress / grouped
    //
    // Driven through `refresh()` against a fake `nexus` (rather than seeding
    // `tasks` directly, which the controller deliberately exposes no setter
    // for) so these exercise the exact same path the UI does.

    private static let tasksWithACancelledOneJSON = """
    [
      { "id": "a1", "title": "one", "status": "in_progress" },
      { "id": "a2", "title": "two", "status": "done" },
      { "id": "a3", "title": "three", "status": "cancelled" },
      { "id": "a4", "title": "four", "status": "todo" }
    ]
    """

    private static let allCancelledJSON = """
    [ { "id": "a1", "title": "one", "status": "cancelled" } ]
    """

    @MainActor
    func testProgressExcludesCancelledTasksFromThePercentDenominator() async throws {
        let binary = try fakeNexusBinary(printing: Self.tasksWithACancelledOneJSON)
        let controller = TasksController(client: NexusClient(binary: binary))
        await controller.refresh()

        let progress = controller.progress
        XCTAssertEqual(progress.total, 4)
        XCTAssertEqual(progress.completed, 1)
        // Denominator is 3 (the cancelled task excluded): 1/3 rounds to 33%.
        XCTAssertEqual(progress.percent, 33)
    }

    @MainActor
    func testProgressIsZeroPercentWhenEverythingIsCancelled() async throws {
        let binary = try fakeNexusBinary(printing: Self.allCancelledJSON)
        let controller = TasksController(client: NexusClient(binary: binary))
        await controller.refresh()

        XCTAssertEqual(controller.progress.percent, 0)
    }

    @MainActor
    func testGroupedBucketsTasksInDisplayOrderIncludingEmptyBuckets() async throws {
        // tasks-list.json decodes to t1 in_progress, t2 done, t3 unknown
        // (the id-less row is dropped) — no blocked/todo/cancelled tasks.
        let binary = try fakeNexusBinary(printing: try fixtureText("tasks-list"))
        let controller = TasksController(client: NexusClient(binary: binary))
        await controller.refresh()

        let grouped = controller.grouped
        XCTAssertEqual(grouped.map(\.status), TaskStatus.displayOrder)

        let inProgress = try XCTUnwrap(grouped.first { $0.status == .inProgress })
        XCTAssertEqual(inProgress.tasks.map(\.id), ["t1"])
        let done = try XCTUnwrap(grouped.first { $0.status == .done })
        XCTAssertEqual(done.tasks.map(\.id), ["t2"])
        let unknown = try XCTUnwrap(grouped.first { $0.status == .unknown })
        XCTAssertEqual(unknown.tasks.map(\.id), ["t3"])
        let blocked = try XCTUnwrap(grouped.first { $0.status == .blocked })
        XCTAssertTrue(blocked.tasks.isEmpty, "an empty bucket must still be present")
    }

    // MARK: - NexusClient.runJSON + TasksController, against a fake `nexus`

    private func fakeNexusBinary(printing output: String, exitCode: Int32 = 0) throws -> NexusBinary {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-nexus-\(UUID().uuidString)")
        let contents = """
        #!/bin/sh
        cat <<'NEXUS_FIXTURE_EOF'
        \(output)
        NEXUS_FIXTURE_EOF
        exit \(exitCode)
        """
        try contents.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return NexusBinary(url: script)
    }

    @MainActor
    func testTasksControllerRefreshDecodesARealProcessesOutput() async throws {
        let binary = try fakeNexusBinary(printing: try fixtureText("tasks-list"))
        let controller = TasksController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertNil(controller.error)
        XCTAssertFalse(controller.isLoading)
        XCTAssertEqual(controller.tasks.count, 3, "the row without an id must be dropped")
    }

    @MainActor
    func testTasksControllerSurfacesRunJSONFailureAsItsError() async throws {
        let binary = try fakeNexusBinary(printing: "not json")
        let controller = TasksController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertTrue(controller.tasks.isEmpty)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testTasksControllerSetStatusFailsWithoutRunningAnythingForTodo() async throws {
        // If this accidentally ran a command, the fake binary below would
        // make it succeed and refresh would clear `error` — so a failing
        // assertion here would mean the guard in `setStatus` was bypassed.
        let binary = try fakeNexusBinary(printing: "[]")
        let controller = TasksController(client: NexusClient(binary: binary))

        let didRun = await controller.setStatus(.todo, for: "t1")

        XCTAssertFalse(didRun)
        XCTAssertNotNil(controller.error)
    }
}
