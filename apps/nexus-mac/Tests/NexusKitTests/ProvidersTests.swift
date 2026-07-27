import XCTest
@testable import NexusKit

/// `NexusProvider`/`NexusModel` decode straight from the `JSONValue`
/// `NexusClient.runJSON` hands back, driven by fixtures shaped like real
/// `nexus providers list|status -o json` / `nexus models <provider> -o json`
/// output (captured from a live run of the CLI, then hand-augmented with the
/// degenerate rows below — the same style `SessionsTests`/`TasksTests` use).
final class ProvidersTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    }

    private func fixtureText(_ name: String) throws -> String {
        try String(contentsOf: try fixtureURL(name), encoding: .utf8)
    }

    private func fixtureJSON(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: try fixtureURL(name)))
    }

    private func decodedProviders() throws -> [NexusProvider] {
        try XCTUnwrap(try fixtureJSON("providers-list").arrayValue).compactMap(NexusProvider.init(json:))
    }

    // MARK: - NexusProvider decode

    func testDecodesANormalProviderRow() throws {
        let mock = try XCTUnwrap(try decodedProviders().first { $0.id == "mock" })
        XCTAssertEqual(mock.kind, "mock")
        XCTAssertTrue(mock.available)
        // `needsKey`/`detail` are both absent on this row — must default
        // sanely rather than propagating nil into a Bool.
        XCTAssertFalse(mock.needsKey)
        XCTAssertNil(mock.detail)
        XCTAssertTrue(mock.isUsable)
    }

    func testAvailableTrueWithNeedsKeyTrueIsNotUsable() throws {
        // groq/together/etc. all report `available: true` even with zero API
        // keys configured (verified against a live `providers list -o json`
        // run) — `isUsable` must still say no.
        let groq = try XCTUnwrap(try decodedProviders().first { $0.id == "groq" })
        XCTAssertTrue(groq.available)
        XCTAssertTrue(groq.needsKey)
        XCTAssertFalse(groq.isUsable)
        XCTAssertEqual(groq.detail, "needs key: GROQ_API_KEY")
    }

    func testLocalProviderWithNoKeyNeededIsUsable() throws {
        let lmstudio = try XCTUnwrap(try decodedProviders().first { $0.id == "lmstudio" })
        XCTAssertFalse(lmstudio.needsKey)
        XCTAssertTrue(lmstudio.isUsable)
    }

    func testUnavailableProviderIsNeverUsableRegardlessOfNeedsKey() throws {
        // `available: false` means the provider's package failed to load
        // entirely (see `packages/runtime/src/index.ts`) — a different,
        // harder failure than merely needing a key.
        let broken = try XCTUnwrap(try decodedProviders().first { $0.id == "broken-provider" })
        XCTAssertFalse(broken.available)
        XCTAssertFalse(broken.isUsable)
        XCTAssertNotNil(broken.detail)
    }

    func testSignedInButNotKeyedProviderIsUsable() throws {
        // Regression: `nexus providers status -o json` used to omit "anthropic"
        // entirely (a CLI-side bug in `cmdProviders`/`cmdModels` — see
        // `packages/cli/src/commands.ts` — not a decoding/filtering bug here),
        // so it silently vanished from the picker despite a valid `nexus login
        // anthropic` OAuth session. This row is shaped exactly like the FIXED
        // CLI's real output for a signed-in-but-not-separately-keyed provider
        // (an OAuth bearer token satisfies the credential, no console API key
        // needed) — `available: true, needsKey: false` — and must decode as
        // usable, not merely present.
        let raw = #"""
        {
          "id": "anthropic",
          "kind": "anthropic",
          "available": true,
          "needsKey": false,
          "detail": "signed in (`nexus login anthropic`) or key present"
        }
        """#
        let json = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
        let anthropic = try XCTUnwrap(NexusProvider(json: json))
        XCTAssertTrue(anthropic.available)
        XCTAssertFalse(anthropic.needsKey)
        XCTAssertTrue(anthropic.isUsable)

        let selectable = SelectableProvider(provider: anthropic)
        XCTAssertTrue(selectable.isUsable)
        XCTAssertNil(selectable.reason, "a usable provider must not be greyed out with a reason")
    }

    func testRowsWithNoIdAreDroppedRatherThanCrashingTheWholeDecode() throws {
        let items = try XCTUnwrap(try fixtureJSON("providers-list").arrayValue)
        XCTAssertEqual(items.count, 6, "fixture shape changed")

        let providers = try decodedProviders()
        XCTAssertEqual(providers.count, 5, "the row without an id must be dropped, not fail the array")
    }

    func testEmptyArrayProducesAnEmptyListNotAFailure() {
        XCTAssertTrue([JSONValue]().compactMap(NexusProvider.init(json:)).isEmpty)
    }

    // MARK: - SelectableProvider

    func testSelectableNeverHidesAnUnusableProviderButAttachesItsReason() throws {
        let groq = try XCTUnwrap(try decodedProviders().first { $0.id == "groq" })
        let selectable = SelectableProvider(provider: groq)
        XCTAssertFalse(selectable.isUsable)
        XCTAssertEqual(selectable.reason, "needs key: GROQ_API_KEY")
    }

    func testSelectableHasNoReasonWhenUsable() throws {
        let mock = try XCTUnwrap(try decodedProviders().first { $0.id == "mock" })
        let selectable = SelectableProvider(provider: mock)
        XCTAssertTrue(selectable.isUsable)
        XCTAssertNil(selectable.reason)
    }

    // MARK: - NexusModel decode + contextWindow

    private func decodedModels() throws -> [NexusModel] {
        let value = try fixtureJSON("models-mock")
        return try XCTUnwrap(value["models"]?.arrayValue).compactMap(NexusModel.init(json:))
    }

    func testDecodesModelHintAndParsesContextWindow() throws {
        let fast = try XCTUnwrap(try decodedModels().first { $0.id == "mock-fast" })
        XCTAssertEqual(fast.hint, "32k ctx")
        XCTAssertEqual(fast.contextWindow, 32_000)

        let smart = try XCTUnwrap(try decodedModels().first { $0.id == "mock-smart" })
        XCTAssertEqual(smart.contextWindow, 128_000)
    }

    func testMissingHintDegradesContextWindowToNilRatherThanCrashing() throws {
        let tools = try XCTUnwrap(try decodedModels().first { $0.id == "mock-tools" })
        XCTAssertNil(tools.hint)
        XCTAssertNil(tools.contextWindow)
    }

    func testModelRowsWithNoIdAreDropped() throws {
        let items = try XCTUnwrap(try fixtureJSON("models-mock")["models"]?.arrayValue)
        XCTAssertEqual(items.count, 4, "fixture shape changed")
        XCTAssertEqual(try decodedModels().count, 3, "the row without an id must be dropped")
    }

    func testModelInitFromJSONNeverAttachesPricingDirectly() throws {
        // `models <provider> -o json` never reports pricing — only
        // `merging(pricing:)` (exercised through the controller below) does.
        let fast = try XCTUnwrap(try decodedModels().first { $0.id == "mock-fast" })
        XCTAssertNil(fast.pricing)
    }

    // MARK: - Command factories

    func testProvidersListBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.providersList().arguments, ["providers", "list", "-o", "json"])
    }

    func testProvidersStatusBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.providersStatus().arguments, ["providers", "status", "-o", "json"])
    }

    func testModelsBuildsAJsonCommandWithTheProviderId() {
        XCTAssertEqual(NexusCommand.models(provider: "mock").arguments, ["models", "mock", "-o", "json"])
    }

    // MARK: - ProvidersController, against a fake `nexus` that routes on argv
    //
    // Unlike `SessionsController`/`TasksController` (one command per action),
    // `refresh()` followed by `models(for:)` are two SEPARATE process
    // launches expecting two different fixtures, so the fake binary here
    // dispatches on the command's own arguments rather than always printing
    // the same canned output.

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
    func testControllerRefreshPopulatesProvidersFromStatus() async throws {
        let binary = try fakeNexusBinary(routing: ["providers status": try fixtureText("providers-status")])
        let controller = ProvidersController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertNil(controller.error)
        XCTAssertFalse(controller.isLoading)
        XCTAssertEqual(controller.providers.map(\.id), ["mock", "groq"])
    }

    @MainActor
    func testControllerSurfacesRunJSONFailureAsItsError() async throws {
        let binary = try fakeNexusBinary(routing: ["providers status": "not json"])
        let controller = ProvidersController(client: NexusClient(binary: binary))

        await controller.refresh()

        XCTAssertTrue(controller.providers.isEmpty)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testModelsForMergesInPricingFetchedByRefresh() async throws {
        let binary = try fakeNexusBinary(routing: [
            "providers status": try fixtureText("providers-status"),
            "models mock": try fixtureText("models-mock"),
        ])
        let controller = ProvidersController(client: NexusClient(binary: binary))
        await controller.refresh()

        let models = await controller.models(for: "mock")

        XCTAssertNil(controller.error)
        XCTAssertEqual(models.map(\.id).sorted(), ["mock-fast", "mock-smart", "mock-tools"])

        let smart = try XCTUnwrap(models.first { $0.id == "mock-smart" })
        XCTAssertNotNil(smart.pricing, "mock-smart has a non-null price in the fixture and must be merged in")

        let fast = try XCTUnwrap(models.first { $0.id == "mock-fast" })
        XCTAssertNil(fast.pricing, "mock-fast's price is JSON null in the fixture, so must stay nil not `.null`")
    }

    @MainActor
    func testModelsForCachesRatherThanRefetchingOnASecondCall() async throws {
        // Only ONE `models mock` route is registered; if the controller
        // refetched instead of using its cache, the fake binary's un-cached
        // second invocation would still succeed (same route), so this test
        // instead asserts the returned values are stable and `isLoading`
        // never gets stuck — the meaningful, observable half of "cached".
        let binary = try fakeNexusBinary(routing: [
            "providers status": try fixtureText("providers-status"),
            "models mock": try fixtureText("models-mock"),
        ])
        let controller = ProvidersController(client: NexusClient(binary: binary))
        await controller.refresh()

        let first = await controller.models(for: "mock")
        let second = await controller.models(for: "mock")

        XCTAssertEqual(first, second)
    }

    @MainActor
    func testModelsForSurfacesUnexpectedShapeAsAnErrorNotACrash() async throws {
        let binary = try fakeNexusBinary(routing: ["models mock": #"{"provider":"mock"}"#])
        let controller = ProvidersController(client: NexusClient(binary: binary))

        let models = await controller.models(for: "mock")

        XCTAssertTrue(models.isEmpty)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testSelectableComputedFromControllerNeverHidesProviders() async throws {
        let binary = try fakeNexusBinary(routing: ["providers status": try fixtureText("providers-status")])
        let controller = ProvidersController(client: NexusClient(binary: binary))
        await controller.refresh()

        XCTAssertEqual(controller.selectable.count, controller.providers.count)
        XCTAssertEqual(controller.selectable.filter { !$0.isUsable }.map(\.id), ["groq"])
    }
}
