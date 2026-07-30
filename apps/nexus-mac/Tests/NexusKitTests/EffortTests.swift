import XCTest
@testable import NexusKit

/// `EffortCapability`/`EffortLevelOption` decode straight from the `JSONValue`
/// `NexusClient.runJSON` hands back, driven by bytes shaped like real `nexus
/// effort <provider> -o json` output — captured from a live run against
/// claude-code (seven native levels, no numeric budget, `offDisablesReasoning:
/// false`) and anthropic (three token-budget levels, `offDisablesReasoning:
/// true`), per `cmdEffort`'s own doc comment (`packages/cli/src/commands.ts`).
final class EffortTests: XCTestCase {
    private func json(_ raw: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    }

    // MARK: - EffortLevelOption decode

    func testLevelOptionDecodesIdAndDescription() throws {
        let level = try XCTUnwrap(EffortLevelOption(json: try json(#"{"id":"low","description":"4k thinking tokens"}"#)))
        XCTAssertEqual(level.id, "low")
        XCTAssertEqual(level.description, "4k thinking tokens")
    }

    func testLevelOptionDecodesWithNoDescription() throws {
        // claude-code's/codex's native levels carry no numeric budget at all —
        // `cmdEffort` only ever emits `description` when it has one.
        let level = try XCTUnwrap(EffortLevelOption(json: try json(#"{"id":"xhigh"}"#)))
        XCTAssertEqual(level.id, "xhigh")
        XCTAssertNil(level.description)
    }

    func testLevelOptionWithNoIdDecodesAsNil() throws {
        XCTAssertNil(EffortLevelOption(json: try json(#"{"description":"mystery"}"#)))
    }

    // MARK: - EffortCapability decode — claude-code (cli-native, real seven-level scale)

    func testClaudeCodeDecodesAllSevenNativeLevelsWithNoOff() throws {
        // Real shape: `nexus effort claude-code -o json` reports seven
        // provider-native levels and `offDisablesReasoning: false` — claude-code
        // always reasons, `--effort` only selects among these.
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"""
        {"provider":"claude-code","supported":true,
         "levels":[{"id":"low"},{"id":"medium"},{"id":"high"},{"id":"xhigh"},{"id":"max"},{"id":"ultracode"},{"id":"auto"}],
         "source":"provider","offDisablesReasoning":false}
        """#)))
        XCTAssertEqual(capability.provider, "claude-code")
        XCTAssertTrue(capability.supported)
        XCTAssertEqual(capability.levels.map(\.id), ["low", "medium", "high", "xhigh", "max", "ultracode", "auto"])
        XCTAssertTrue(capability.levels.allSatisfy { $0.description == nil })
        XCTAssertEqual(capability.source, .provider)
        XCTAssertFalse(capability.offDisablesReasoning, "claude-code has no off — it always reasons")
        XCTAssertNil(capability.defaultLevel)
    }

    func testDefaultLevelIsCapturedWhenThePickerHasSomethingToMark() throws {
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"""
        {"provider":"claude-code","supported":true,
         "levels":[{"id":"low"},{"id":"medium"}],
         "defaultLevel":"medium","source":"provider","offDisablesReasoning":false}
        """#)))
        XCTAssertEqual(capability.defaultLevel, "medium")
    }

    // MARK: - EffortCapability decode — anthropic (token-budget, real off-capable scale)

    func testAnthropicDecodesThreeTokenBudgetLevelsWithOff() throws {
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"""
        {"provider":"anthropic","supported":true,
         "levels":[{"id":"low","description":"4k thinking tokens"},{"id":"medium","description":"10k thinking tokens"},{"id":"high","description":"24k thinking tokens"}],
         "source":"provider","offDisablesReasoning":true}
        """#)))
        XCTAssertEqual(capability.provider, "anthropic")
        XCTAssertEqual(capability.levels.map(\.id), ["low", "medium", "high"])
        XCTAssertEqual(capability.levels.map(\.description), ["4k thinking tokens", "10k thinking tokens", "24k thinking tokens"])
        XCTAssertTrue(capability.offDisablesReasoning, "anthropic's off genuinely disables extended thinking")
    }

    // MARK: - EffortCapability decode — unsupported / degenerate shapes

    func testUnsupportedProviderDecodesWithNoLevels() throws {
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"""
        {"provider":"some-provider","supported":false,"levels":[],"source":"fallback","offDisablesReasoning":true}
        """#)))
        XCTAssertFalse(capability.supported)
        XCTAssertTrue(capability.levels.isEmpty)
    }

    func testMissingProviderDecodesAsNilRatherThanCrashing() throws {
        XCTAssertNil(EffortCapability(json: try json(#"{"supported":true,"levels":[]}"#)))
    }

    func testMissingSupportedDefaultsToFalseRatherThanAssumingSafe() throws {
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"{"provider":"mystery"}"#)))
        XCTAssertFalse(capability.supported)
        XCTAssertTrue(capability.levels.isEmpty)
    }

    func testMissingOffDisablesReasoningDefaultsToTrueForAnOlderCLI() throws {
        // Mirrors `cmdEffort`'s own default on the CLI side — an older build
        // that predates this field must degrade to "off really means off"
        // rather than silently treating an unopposed omission as reasoning
        // still being on.
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"{"provider":"mystery","supported":true,"levels":[{"id":"low"}]}"#)))
        XCTAssertTrue(capability.offDisablesReasoning)
    }

    func testUnrecognizedSourceDecodesAsUnknownRatherThanCrashing() throws {
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"{"provider":"p","supported":true,"source":"some-future-value"}"#)))
        XCTAssertEqual(capability.source, .unknown)
    }

    func testMissingSourceDecodesAsUnknown() throws {
        let capability = try XCTUnwrap(EffortCapability(json: try json(#"{"provider":"p","supported":true}"#)))
        XCTAssertEqual(capability.source, .unknown)
    }

    // MARK: - Command factory

    func testEffortBuildsAJsonCommandWithTheProviderId() {
        XCTAssertEqual(NexusCommand.effort(provider: "claude-code").arguments, ["effort", "claude-code", "-o", "json"])
    }

    // MARK: - EffortController, against a fake `nexus` that routes on argv

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
    func testControllerRefreshPopulatesCapabilityForTheGivenProvider() async throws {
        let binary = try fakeNexusBinary(routing: [
            "effort claude-code": #"{"provider":"claude-code","supported":true,"levels":[{"id":"low"},{"id":"xhigh"}],"source":"provider","offDisablesReasoning":false}"#,
            "effort anthropic": #"{"provider":"anthropic","supported":true,"levels":[{"id":"low","description":"4k thinking tokens"}],"source":"provider","offDisablesReasoning":true}"#,
        ])
        let controller = EffortController(client: NexusClient(binary: binary))

        await controller.refresh(provider: "claude-code")
        XCTAssertNil(controller.error)
        XCTAssertFalse(controller.isLoading)
        XCTAssertEqual(controller.capability?.provider, "claude-code")
        XCTAssertEqual(controller.capability?.levels.map(\.id), ["low", "xhigh"])

        // A second `refresh(provider:)` for a DIFFERENT provider must replace
        // the capability entirely, not merge with or leave behind the first.
        await controller.refresh(provider: "anthropic")
        XCTAssertEqual(controller.capability?.provider, "anthropic")
        XCTAssertEqual(controller.capability?.levels.map(\.id), ["low"])
    }

    @MainActor
    func testControllerSurfacesRunJSONFailureAsItsError() async throws {
        let binary = try fakeNexusBinary(routing: ["effort broken": "not json"])
        let controller = EffortController(client: NexusClient(binary: binary))

        await controller.refresh(provider: "broken")

        XCTAssertNil(controller.capability)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testControllerSurfacesUnexpectedShapeAsAnErrorNotACrash() async throws {
        let binary = try fakeNexusBinary(routing: ["effort weird": #"{"notProvider":true}"#])
        let controller = EffortController(client: NexusClient(binary: binary))

        await controller.refresh(provider: "weird")

        XCTAssertNil(controller.capability)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testControllerSurfacesAConfirmedUnsupportedProviderRatherThanAnError() async throws {
        // "Not supported" is a real, valid answer — not a failure — so it
        // must decode into `capability` with `error == nil`, exactly what
        // lets a caller distinguish "hide the control" from "something broke".
        let binary = try fakeNexusBinary(routing: [
            "effort mock": #"{"provider":"mock","supported":false,"levels":[],"source":"fallback","offDisablesReasoning":true}"#,
        ])
        let controller = EffortController(client: NexusClient(binary: binary))

        await controller.refresh(provider: "mock")

        XCTAssertNil(controller.error)
        XCTAssertEqual(controller.capability?.supported, false)
    }
}
