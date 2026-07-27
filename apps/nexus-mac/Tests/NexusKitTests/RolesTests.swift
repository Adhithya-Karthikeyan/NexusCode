import XCTest
@testable import NexusKit

/// `NexusRole` decodes straight from the `JSONValue` `NexusClient.runJSON`
/// hands back, driven by a fixture shaped like a real `nexus roles -o json`
/// run — all nine shipped presets, taken verbatim from `packages/agent/src/
/// roles.ts`'s `ROLE_PRESETS` (the `description` field there is `summary`,
/// not the model-facing `description` — see `cmdRoles`'s `definitionFrom`) —
/// plus one degenerate row with no `id`, the same style `ProvidersTests` uses.
final class RolesTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    }

    private func fixtureText(_ name: String) throws -> String {
        try String(contentsOf: try fixtureURL(name), encoding: .utf8)
    }

    private func fixtureJSON(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: try fixtureURL(name)))
    }

    private func decodedRoles() throws -> [NexusRole] {
        try XCTUnwrap(try fixtureJSON("roles")["roles"]?.arrayValue).compactMap(NexusRole.init(json:))
    }

    // MARK: - NexusRole decode

    func testDecodesAReadOnlyRole() throws {
        let reviewer = try XCTUnwrap(try decodedRoles().first { $0.id == "reviewer" })
        XCTAssertEqual(reviewer.description, "Reviews a change for correctness, clarity, and risk without modifying anything.")
        XCTAssertEqual(reviewer.tools, ["fs_read", "fs_search"])
        XCTAssertEqual(reviewer.maxSteps, 6)
        XCTAssertEqual(reviewer.permissionMode, "read-only")
        XCTAssertFalse(reviewer.canWrite)
    }

    func testDecodesAWorkspaceWriteRole() throws {
        let coder = try XCTUnwrap(try decodedRoles().first { $0.id == "coder" })
        XCTAssertEqual(coder.permissionMode, "workspace-write")
        XCTAssertTrue(coder.canWrite, "workspace-write must read as a role that can write")
    }

    func testWildcardToolsDecodeAsALiteralSingleEntryArray() throws {
        // `["*"]` means "every registered tool" — the coordinator preset's
        // shape — decoded as-is, not expanded here (expansion is the CLI's
        // concern if it ever needs to happen at all).
        let coordinator = try XCTUnwrap(try decodedRoles().first { $0.id == "coordinator" })
        XCTAssertEqual(coordinator.tools, ["*"])
    }

    func testEveryFourWorkspaceWriteRolesAreTheOnesTheAuditNamed() throws {
        // Locks in the exact set the capability audit flagged as needing a
        // visible warning: coordinator, coder, tester, doc-writer. The other
        // five (planner, reviewer, researcher, architect, security-reviewer)
        // must NOT warn.
        let roles = try decodedRoles()
        let writable = Set(roles.filter(\.canWrite).map(\.id))
        XCTAssertEqual(writable, ["coordinator", "coder", "tester", "doc-writer"])
    }

    func testRowsWithNoIdAreDroppedRatherThanCrashingTheWholeDecode() throws {
        let items = try XCTUnwrap(try fixtureJSON("roles")["roles"]?.arrayValue)
        XCTAssertEqual(items.count, 10, "fixture shape changed")

        let roles = try decodedRoles()
        XCTAssertEqual(roles.count, 9, "the row without an id must be dropped, not fail the array")
    }

    func testEmptyArrayProducesAnEmptyListNotAFailure() {
        XCTAssertTrue([JSONValue]().compactMap(NexusRole.init(json:)).isEmpty)
    }

    // MARK: - canWrite defensiveness

    func testAbsentPermissionModeReadsAsCanWriteRatherThanAssumedSafe() {
        // The CLI's OWN fallback for an absent value is "read-only" — but this
        // client cannot tell "the CLI applied its safe default" apart from "an
        // unexpected build omitted the field entirely", so it errs toward the
        // visible warning rather than silently trusting an unreadable field.
        let role = NexusRole(id: "mystery", permissionMode: nil)
        XCTAssertTrue(role.canWrite, "an unreadable permission class must warn, never silently read as safe")
    }

    func testUnrecognizedPermissionModeAlsoReadsAsCanWrite() {
        // A future CLI value this build doesn't know about (`"ask"`, `"plan"`,
        // `"full-access"`) must not be mistaken for the one specific safe
        // string this client checks against.
        let role = NexusRole(id: "mystery", permissionMode: "full-access")
        XCTAssertTrue(role.canWrite)
    }

    func testExactlyReadOnlyStringDoesNotWarn() {
        let role = NexusRole(id: "safe", permissionMode: "read-only")
        XCTAssertFalse(role.canWrite)
    }

    // MARK: - Command factory

    func testRolesBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.roles().arguments, ["roles", "-o", "json"])
    }

    // MARK: - RolesController, against a fake `nexus` that routes on argv

    private func fakeNexusBinary(routing: [String: String]) throws -> NexusBinary {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-nexus-\(UUID().uuidString)")
        var body = "#!/bin/sh\ncase \"$*\" in\n"
        for (prefix, output) in routing {
            body += "  \"\(prefix)\"*) cat <<'NEXUS_FIXTURE_EOF'\n\(output)\nNEXUS_FIXTURE_EOF\n  ;;\n"
        }
        body += "  *) echo \"no fixture route for: $*\" 1>&2; exit 1 ;;\nesac\n"
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return NexusBinary(url: script)
    }

    @MainActor
    func testControllerRefreshPopulatesRolesFromTheCommand() async throws {
        let binary = try fakeNexusBinary(routing: ["roles": try fixtureText("roles")])
        let controller = RolesController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertNil(controller.error)
        XCTAssertFalse(controller.isLoading)
        XCTAssertEqual(controller.roles.count, 9)
        XCTAssertTrue(controller.roles.contains { $0.id == "coder" && $0.canWrite })
        XCTAssertTrue(controller.roles.contains { $0.id == "reviewer" && !$0.canWrite })
    }

    @MainActor
    func testControllerSurfacesRunJSONFailureAsItsError() async throws {
        let binary = try fakeNexusBinary(routing: ["roles": "not json"])
        let controller = RolesController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertTrue(controller.roles.isEmpty)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testControllerSurfacesUnexpectedShapeAsAnErrorNotACrash() async throws {
        let binary = try fakeNexusBinary(routing: ["roles": #"{"notRoles":[]}"#])
        let controller = RolesController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertTrue(controller.roles.isEmpty)
        XCTAssertNotNil(controller.error)
    }
}
