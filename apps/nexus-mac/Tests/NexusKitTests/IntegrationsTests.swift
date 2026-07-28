import XCTest
@testable import NexusKit

/// `McpServer`/`NexusTool` decode straight from the `JSONValue`
/// `NexusClient.runJSON` hands back, driven by fixtures shaped like real
/// `nexus mcp list|tools -o json` / `nexus tools list -o json` output
/// (captured from a live run of the CLI, then hand-augmented with the
/// degenerate rows below — the same style `SessionsTests`/`TasksTests` use).
final class IntegrationsTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    }

    private func fixtureText(_ name: String) throws -> String {
        try String(contentsOf: try fixtureURL(name), encoding: .utf8)
    }

    private func fixtureJSON(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: try fixtureURL(name)))
    }

    // MARK: - McpServer decode

    func testDecodesAToolsReportRowAsConnectedAndEnabled() throws {
        let servers = try XCTUnwrap(try fixtureJSON("mcp-tools")["servers"]?.arrayValue)
            .compactMap { McpServer(toolsReport: $0) }

        let kyp = try XCTUnwrap(servers.first { $0.name == "kyp-mem" })
        XCTAssertEqual(kyp.transport, "stdio")
        XCTAssertTrue(kyp.enabled, "every server `mcp tools` reports was enabled to even attempt a connection")
        XCTAssertTrue(kyp.connected)
        XCTAssertEqual(kyp.toolCount, 16)
        XCTAssertNil(kyp.error)
    }

    func testDecodesAFailedConnectionWithItsError() throws {
        let servers = try XCTUnwrap(try fixtureJSON("mcp-tools")["servers"]?.arrayValue)
            .compactMap { McpServer(toolsReport: $0) }

        let flaky = try XCTUnwrap(servers.first { $0.name == "flaky-server" })
        XCTAssertFalse(flaky.connected)
        XCTAssertEqual(flaky.toolCount, 0)
        XCTAssertEqual(flaky.error, "spawn ENOENT")
    }

    func testDecodesAListEntryAsNotConnectedWithNoLiveData() throws {
        let servers = try XCTUnwrap(try fixtureJSON("mcp-list").arrayValue)
            .compactMap { McpServer(listEntry: $0) }

        let kyp = try XCTUnwrap(servers.first { $0.name == "kyp-mem" })
        XCTAssertTrue(kyp.enabled)
        XCTAssertFalse(kyp.connected, "`mcp list` is declared config only, never live connection data")
        XCTAssertEqual(kyp.toolCount, 0)

        let disabled = try XCTUnwrap(servers.first { $0.name == "disabled-remote" })
        XCTAssertFalse(disabled.enabled)
        XCTAssertEqual(disabled.transport, "http")
        XCTAssertNil(disabled.error, "being disabled is a config choice, not a failure")
    }

    func testMcpServerRowsWithNoNameAreDropped() {
        XCTAssertNil(McpServer(toolsReport: .object(["transport": .string("stdio")])))
        XCTAssertNil(McpServer(listEntry: .object(["enabled": .bool(true)])))
    }

    // MARK: - ToolPermission

    func testToolPermissionWireValuesRoundTrip() {
        XCTAssertEqual(ToolPermission(wire: "read"), .read)
        XCTAssertEqual(ToolPermission(wire: "write"), .write)
        XCTAssertEqual(ToolPermission(wire: "exec"), .exec)
        XCTAssertEqual(ToolPermission(wire: "network"), .network)
        XCTAssertEqual(ToolPermission(wire: nil), .unknown)
        XCTAssertEqual(ToolPermission(wire: "admin"), .unknown)
    }

    // MARK: - NexusTool decode

    private func decodedTools() throws -> [NexusTool] {
        try XCTUnwrap(try fixtureJSON("tools-list")["tools"]?.arrayValue).compactMap(NexusTool.init(json:))
    }

    func testDecodesANormalToolRow() throws {
        let dbQuery = try XCTUnwrap(try decodedTools().first { $0.name == "db_query" })
        XCTAssertEqual(dbQuery.permission, .network)
        XCTAssertEqual(dbQuery.group, "db")
        XCTAssertFalse(dbQuery.enabled)
        XCTAssertEqual(dbQuery.integrationAvailable, true)
    }

    func testNullIntegrationAvailableDecodesToNilNotFalse() throws {
        // `web_search` has no optional dependency at all — the CLI reports
        // `integrationAvailable: null`, which must stay a real `nil`, not be
        // conflated with `false` ("checked and missing").
        let webSearch = try XCTUnwrap(try decodedTools().first { $0.name == "web_search" })
        XCTAssertNil(webSearch.integrationAvailable)
    }

    func testUnknownPermissionValueDecodesToTheUnknownCaseNotAThrow() throws {
        let future = try XCTUnwrap(try decodedTools().first { $0.name == "future_tool" })
        XCTAssertEqual(future.permission, .unknown)
        XCTAssertTrue(future.enabled)
    }

    func testToolRowsWithNoNameAreDroppedRatherThanCrashingTheWholeDecode() throws {
        let items = try XCTUnwrap(try fixtureJSON("tools-list")["tools"]?.arrayValue)
        XCTAssertEqual(items.count, 5, "fixture shape changed")
        XCTAssertEqual(try decodedTools().count, 4, "the row without a name must be dropped")
    }

    func testEmptyArrayProducesAnEmptyToolListNotAFailure() {
        XCTAssertTrue([JSONValue]().compactMap(NexusTool.init(json:)).isEmpty)
    }

    // MARK: - ToolGroupInfo decode

    func testDecodesAGroupWithItsIntegrations() throws {
        let groups = try XCTUnwrap(try fixtureJSON("tools-list")["groups"]?.arrayValue)
            .compactMap(ToolGroupInfo.init(json:))

        let browser = try XCTUnwrap(groups.first { $0.group == "browser" })
        XCTAssertEqual(browser.description, "headless browser automation (navigate/click/extract/screenshot)")
        XCTAssertFalse(browser.enabled)
        let playwright = try XCTUnwrap(browser.integrations.first)
        XCTAssertEqual(playwright.name, "playwright")
        XCTAssertFalse(playwright.available)
        XCTAssertEqual(playwright.hint, "npm i playwright")
    }

    func testGroupRowsWithNoGroupNameAreDropped() throws {
        let items = try XCTUnwrap(try fixtureJSON("tools-list")["groups"]?.arrayValue)
        XCTAssertEqual(items.count, 4, "fixture shape changed")
        let groups = items.compactMap(ToolGroupInfo.init(json:))
        XCTAssertEqual(groups.count, 3, "the group without a name must be dropped")
    }

    // MARK: - Command factories

    func testMcpListBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.mcpList().arguments, ["mcp", "list", "-o", "json"])
    }

    func testMcpToolsBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.mcpTools().arguments, ["mcp", "tools", "-o", "json"])
    }

    func testToolsListBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.toolsList().arguments, ["tools", "list", "-o", "json"])
    }

    // MARK: - IntegrationsController, against a fake `nexus` that routes on argv
    //
    // `refresh()` fires three independent commands (`mcp list`, `mcp tools`,
    // `tools list`) concurrently via `async let`, so — like
    // `ProvidersTests` — the fake binary must dispatch per-command rather
    // than always printing one canned fixture.

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

    private func allRoutesFakeBinary() throws -> NexusBinary {
        try fakeNexusBinary(routing: [
            "mcp list": try fixtureText("mcp-list"),
            "mcp tools": try fixtureText("mcp-tools"),
            "tools list": try fixtureText("tools-list"),
        ])
    }

    @MainActor
    func testControllerRefreshMergesLiveReportOverDeclaredConfig() async throws {
        let controller = IntegrationsController(client: NexusClient(binary: try allRoutesFakeBinary()))

        await controller.refresh()

        XCTAssertNil(controller.error)
        XCTAssertFalse(controller.isLoading)

        // kyp-mem is declared AND reported live — the live row (connected,
        // 16 tools) must win over the declared-only stand-in.
        let kyp = try XCTUnwrap(controller.mcpServers.first { $0.name == "kyp-mem" })
        XCTAssertTrue(kyp.connected)
        XCTAssertEqual(kyp.toolCount, 16)
    }

    @MainActor
    func testControllerRefreshKeepsADisabledDeclaredServerVisible() async throws {
        // `disabled-remote` is declared in `mcp list` but never attempted a
        // connection (it isn't in `mcp tools`'s report), so it must still
        // show up — greyed out — rather than silently vanish.
        let controller = IntegrationsController(client: NexusClient(binary: try allRoutesFakeBinary()))
        await controller.refresh()

        let disabled = try XCTUnwrap(controller.mcpServers.first { $0.name == "disabled-remote" })
        XCTAssertFalse(disabled.enabled)
        XCTAssertFalse(disabled.connected)
    }

    @MainActor
    func testControllerRefreshIncludesALiveServerNotInTheDeclaredList() async throws {
        // `flaky-server` only appears in `mcp tools`'s report, not in
        // `mcp list` — still must not be dropped.
        let controller = IntegrationsController(client: NexusClient(binary: try allRoutesFakeBinary()))
        await controller.refresh()

        let flaky = try XCTUnwrap(controller.mcpServers.first { $0.name == "flaky-server" })
        XCTAssertEqual(flaky.error, "spawn ENOENT")
    }

    @MainActor
    func testControllerRefreshPopulatesToolsAndGroups() async throws {
        let controller = IntegrationsController(client: NexusClient(binary: try allRoutesFakeBinary()))
        await controller.refresh()

        XCTAssertFalse(controller.tools.isEmpty)
        XCTAssertFalse(controller.groups.isEmpty)
        XCTAssertTrue(controller.tools.contains { $0.name == "db_query" })
    }

    @MainActor
    func testControllerSurfacesEachFailureWithoutLettingOneFailureHideTheOthers() async throws {
        let binary = try fakeNexusBinary(routing: [
            "mcp list": "not json",
            "mcp tools": try fixtureText("mcp-tools"),
            "tools list": try fixtureText("tools-list"),
        ])
        let controller = IntegrationsController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertNotNil(controller.error)
        // `mcp list` failing must not prevent `mcp tools`/`tools list` data
        // from still populating.
        XCTAssertFalse(controller.tools.isEmpty)
        XCTAssertTrue(controller.mcpServers.contains { $0.name == "kyp-mem" })
    }

    @MainActor
    func testControllerSurfacesUnexpectedToolsListShapeAsAnErrorNotACrash() async throws {
        let binary = try fakeNexusBinary(routing: [
            "mcp list": try fixtureText("mcp-list"),
            "mcp tools": try fixtureText("mcp-tools"),
            "tools list": #"{"unexpected":true}"#,
        ])
        let controller = IntegrationsController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertNotNil(controller.error)
        XCTAssertTrue(controller.tools.isEmpty)
        XCTAssertTrue(controller.groups.isEmpty)
    }

    // MARK: - refresh() must be bounded (see NexusClientTimeoutTests for the
    // `runJSON`-level proof that the child is really killed, not just
    // abandoned — these pin the same bug one layer up: that `refresh()`
    // itself resolves promptly, and says WHICH of its three concurrent
    // commands stalled, rather than a bare "timed out").

    /// Like `fakeNexusBinary`, but one route hangs (`sleep`) instead of
    /// answering, so `refresh()` is exercised against a REAL wedged process —
    /// a canned fixture cannot prove this the way `NexusClientTimeoutTests`'
    /// own doc explains for `runJSON` itself.
    private func fakeNexusBinary(hangingOn hangPrefix: String, routing: [String: String]) throws -> (NexusBinary, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-nexus-hang-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("fake-nexus")
        var body = "#!/bin/sh\ncase \"$*\" in\n"
        body += "  \"\(hangPrefix)\"*) sleep 120 ;;\n"
        for (prefix, output) in routing {
            body += "  \"\(prefix)\"*) cat <<'NEXUS_FIXTURE_EOF'\n\(output)\nNEXUS_FIXTURE_EOF\n  ;;\n"
        }
        body += "  *) echo \"no fixture route for: $*\" 1>&2; exit 1 ;;\nesac\n"
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (NexusBinary(url: script), dir)
    }

    @MainActor
    func testControllerRefreshNeverHangsWhenOneCommandIsWedged() async throws {
        let (binary, dir) = try fakeNexusBinary(
            hangingOn: "mcp tools",
            routing: [
                "mcp list": try fixtureText("mcp-list"),
                "tools list": try fixtureText("tools-list"),
            ]
        )
        defer { try? FileManager.default.removeItem(at: dir) }
        let controller = IntegrationsController(client: NexusClient(binary: binary))

        let started = Date()
        await controller.refresh(timeoutSeconds: 1)
        let elapsed = Date().timeIntervalSince(started)

        XCTAssertFalse(controller.isLoading, "must resolve, never leave the spinner up forever")
        XCTAssertLessThan(elapsed, 20, "must not wait out the wedged command's 120s sleep")

        // The two commands that DID answer must still populate real data —
        // one wedged command must never blank out the others (same rule
        // `testControllerSurfacesEachFailureWithoutLettingOneFailureHideTheOthers`
        // pins for an ordinary failure).
        XCTAssertFalse(controller.mcpServers.isEmpty)
        XCTAssertFalse(controller.tools.isEmpty)
    }

    @MainActor
    func testControllerRefreshNamesWhichCommandStalledAndThatItWasATimeout() async throws {
        let (binary, dir) = try fakeNexusBinary(
            hangingOn: "mcp tools",
            routing: [
                "mcp list": try fixtureText("mcp-list"),
                "tools list": try fixtureText("tools-list"),
            ]
        )
        defer { try? FileManager.default.removeItem(at: dir) }
        let controller = IntegrationsController(client: NexusClient(binary: binary))

        await controller.refresh(timeoutSeconds: 1)

        let error = try XCTUnwrap(controller.error)
        XCTAssertTrue(error.contains("nexus mcp tools"), "must name which command didn't answer; got: \(error)")
        XCTAssertTrue(
            error.contains("did not respond within 1s"),
            "must read as a timeout, distinct from an ordinary failure; got: \(error)"
        )
    }
}
