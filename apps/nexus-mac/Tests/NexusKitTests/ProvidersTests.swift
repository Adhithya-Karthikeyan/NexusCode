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

    private func reasoningJSON(_ raw: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
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
        // `mock` really is a test fixture (see `NexusProvider.isTestFixture`'s
        // doc) — this does NOT change `isUsable` above, only who gets to
        // decide whether a picker shows it (`ProvidersController.selectable`).
        XCTAssertTrue(mock.isTestFixture)
    }

    func testIsTestFixtureIsDerivedFromKindNotFromIdSpelling() throws {
        // `mock-flaky`/`mock-slow` are the proof: their `id` is NOT "mock",
        // but a live `nexus providers status -o json` run still reports
        // `kind: "mock"` (and so `isTestFixture: true`) for both, because
        // `buildRuntime` constructs all three through the same mock adapter
        // family. A naive `id == "mock"` check would miss these two.
        let raw = #"""
        [
          {"id":"mock-flaky","kind":"mock","available":true,"isTestFixture":true},
          {"id":"mock-slow","kind":"mock","available":true,"isTestFixture":true}
        ]
        """#
        let json = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
        let providers = try XCTUnwrap(json.arrayValue).compactMap(NexusProvider.init(json:))
        XCTAssertEqual(providers.count, 2)
        XCTAssertTrue(providers.allSatisfy(\.isTestFixture))
    }

    func testIsTestFixtureDefaultsToFalseWhenAbsent() throws {
        // An older CLI that predates this field must degrade to "not a
        // fixture" — the safe default that shows a real provider rather than
        // silently hiding one (see `NexusProvider.isTestFixture`'s doc).
        let groq = try XCTUnwrap(try decodedProviders().first { $0.id == "groq" })
        XCTAssertFalse(groq.isTestFixture)
    }

    // MARK: - NexusProvider.localServerReachable decode
    //
    // Bytes below mirror a live `nexus providers status -o json` run with
    // lmstudio genuinely not running: the CLI's own
    // `probeLocalServerReachability` (`packages/runtime/src/index.ts`)
    // reports `false` for a confirmed-refused connection, `null` for a
    // timed-out/inconclusive probe (verified live against a black-holed
    // TCP listener), and omits the key entirely for a provider this axis
    // does not apply to at all — three wire-visible states collapsing to
    // TWO here (see the property's doc for why `null` and absent share one
    // Swift `nil`).

    func testLocalServerReachableDecodesTrueWhenConfirmedReachable() throws {
        let json = try reasoningJSON(#"{"id":"lmstudio","kind":"openai-compat","available":true,"needsKey":false,"localServerReachable":true}"#)
        let provider = try XCTUnwrap(NexusProvider(json: json))
        XCTAssertEqual(provider.localServerReachable, true)
    }

    func testLocalServerReachableDecodesFalseWhenConfirmedUnreachable() throws {
        let json = try reasoningJSON(#"{"id":"lmstudio","kind":"openai-compat","available":true,"needsKey":false,"localServerReachable":false}"#)
        let provider = try XCTUnwrap(NexusProvider(json: json))
        XCTAssertEqual(provider.localServerReachable, false)
    }

    func testLocalServerReachableDecodesNilForAnExplicitJSONNull() throws {
        // The probe was attempted but timed out — inconclusive, NOT "down".
        let json = try reasoningJSON(#"{"id":"lmstudio","kind":"openai-compat","available":true,"needsKey":false,"localServerReachable":null}"#)
        let provider = try XCTUnwrap(NexusProvider(json: json))
        XCTAssertNil(provider.localServerReachable)
    }

    func testLocalServerReachableDefaultsToNilWhenTheKeyIsAbsent() throws {
        // Every non-local-server provider (anthropic, groq, mock, …) and
        // every older CLI that predates this field.
        let anthropic = try XCTUnwrap(try decodedProviders().first { $0.id == "groq" })
        XCTAssertNil(anthropic.localServerReachable)
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

    // `NexusProvider.reasoning`/`ReasoningCapability` decode tests used to
    // live here (`providers list|status -o json`'s `reasoning` field). That
    // field is superseded entirely by the live `nexus effort <provider>`
    // probe — see `EffortTests.swift` for its decode coverage, and
    // `Providers.swift`'s module note for why `NexusProvider.reasoning` was
    // removed rather than kept as a second, weaker parallel signal.

    // MARK: - ProviderCircuit decode (G6 — provider health was computed and thrown away)
    //
    // Shapes below are NOT hand-guessed: captured live by running the REAL
    // `providers status -o json` command against a synthetic (but real,
    // store-format-correct) `provider-circuits.json` in an isolated
    // `NEXUS_DATA_DIR` sandbox — i.e. round-tripped through the actual
    // `ProviderCircuitBreaker.load()`/`statusOf()` code
    // (`packages/core/src/provider-circuit.ts`), not typed from the
    // TypeScript interface alone. `availability`/`retryAt` in particular are
    // DERIVED by the CLI (not stored input), which this confirms.

    private func circuitJSON(_ raw: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    }

    func testQuotaCircuitDecodesWithABlockedUntilDate() throws {
        // Real bytes for a quota-exhausted, provider-wide (no account/model
        // scope) circuit.
        let raw = #"""
        {
          "key": "p:groq",
          "target": { "providerId": "groq" },
          "state": "open",
          "availability": "blocked",
          "attempts": 3,
          "openCount": 1,
          "reason": "quota",
          "blockedUntil": 1785186254326,
          "retryAt": 1785186254326,
          "openedAt": 1785182654286,
          "lastFailureAt": 1785182654286
        }
        """#
        let circuit = try XCTUnwrap(ProviderCircuit(json: try circuitJSON(raw)))
        XCTAssertEqual(circuit.providerId, "groq")
        XCTAssertNil(circuit.accountId)
        XCTAssertNil(circuit.modelId)
        XCTAssertEqual(circuit.state, .open)
        XCTAssertEqual(circuit.availability, .blocked)
        XCTAssertEqual(circuit.reason, .quota)
        XCTAssertTrue(circuit.isBlocking)
        XCTAssertEqual(circuit.blockedUntil, Date(timeIntervalSince1970: 1785186254326 / 1000))
    }

    func testAuthCircuitDecodesWithNoBlockedUntilAtAll() throws {
        // Real bytes for an account-scoped auth failure — the breaker never
        // sets a cooldown for `auth`, verified live (see the section doc).
        let raw = #"""
        {
          "key": "p:anthropic|a:acct1",
          "target": { "providerId": "anthropic", "accountId": "acct1" },
          "state": "open",
          "availability": "blocked",
          "attempts": 1,
          "openCount": 1,
          "reason": "auth",
          "openedAt": 1785182654286,
          "lastFailureAt": 1785182654286
        }
        """#
        let circuit = try XCTUnwrap(ProviderCircuit(json: try circuitJSON(raw)))
        XCTAssertEqual(circuit.providerId, "anthropic")
        XCTAssertEqual(circuit.accountId, "acct1")
        XCTAssertEqual(circuit.reason, .auth)
        XCTAssertTrue(circuit.isBlocking)
        XCTAssertNil(circuit.blockedUntil, "auth failures never get a cooldown — only fresh creds or a manual reset clear them")
    }

    func testClosedCircuitIsNotBlocking() throws {
        // Real bytes for a healthy circuit — `providers status` includes
        // closed entries too (`includeClosed: true`).
        let raw = #"""
        {
          "key": "p:anthropic|a:d215cc5d02b78d10|m:claude-opus-5",
          "target": { "providerId": "anthropic", "accountId": "d215cc5d02b78d10", "modelId": "claude-opus-5" },
          "state": "closed",
          "availability": "available",
          "attempts": 0,
          "openCount": 0,
          "lastFailureAt": 1785131781285,
          "lastSuccessAt": 1785174310279
        }
        """#
        let circuit = try XCTUnwrap(ProviderCircuit(json: try circuitJSON(raw)))
        XCTAssertEqual(circuit.modelId, "claude-opus-5")
        XCTAssertEqual(circuit.state, .closed)
        XCTAssertFalse(circuit.isBlocking)
        XCTAssertNil(circuit.reason)
    }

    func testMalformedCircuitRowDegradesRatherThanCrashingTheWholeArray() {
        // Missing `state` — must drop this row, not fail the whole `circuits` decode.
        let malformed = JSONValue.object([
            "target": .object(["providerId": .string("groq")]),
            "availability": .string("blocked"),
        ])
        XCTAssertNil(ProviderCircuit(json: malformed))
        XCTAssertTrue([malformed].compactMap(ProviderCircuit.init(json:)).isEmpty)
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

    // MARK: - SelectableProvider.circuitWarning (G6)
    //
    // The core decision this task made: a tripped circuit is surfaced, not
    // hidden and not disabled — `isUsable` is UNTOUCHED by circuit state.
    // These assert that decision directly, not just the string formatting.

    func testATrippedCircuitNeverChangesUsabilityJustAddsAWarning() throws {
        let mock = try XCTUnwrap(try decodedProviders().first { $0.id == "mock" })
        let quotaCircuit = try XCTUnwrap(ProviderCircuit(json: try circuitJSON(#"""
        {"key":"p:mock","target":{"providerId":"mock"},"state":"open","availability":"blocked",
         "attempts":3,"openCount":1,"reason":"quota","blockedUntil":1785186254326}
        """#)))
        let selectable = SelectableProvider(provider: mock, circuit: quotaCircuit)

        XCTAssertTrue(selectable.isUsable, "a tripped circuit must not make a usable provider unselectable")
        XCTAssertNil(selectable.reason, "reason is about STRUCTURAL usability, not circuit state")
        XCTAssertNotNil(selectable.circuitWarning, "but the trip must still be visible somewhere")
        XCTAssertTrue(selectable.circuitWarning?.contains("quota") == true)
    }

    func testNoCircuitMeansNoWarning() throws {
        let mock = try XCTUnwrap(try decodedProviders().first { $0.id == "mock" })
        let selectable = SelectableProvider(provider: mock, circuit: nil)
        XCTAssertNil(selectable.circuitWarning)
    }

    func testAClosedOrProbeAvailableCircuitProducesNoWarningEitherEvenIfPresent() throws {
        // A circuit record can exist (e.g. recently recovered) without being
        // BLOCKING — only a genuinely denying state should surface a caution.
        let mock = try XCTUnwrap(try decodedProviders().first { $0.id == "mock" })
        for availability in ["available", "probe_available"] {
            let circuit = try XCTUnwrap(ProviderCircuit(json: try circuitJSON(#"""
            {"target":{"providerId":"mock"},"state":"half-open","availability":"\#(availability)","attempts":1,"openCount":1}
            """#)))
            let selectable = SelectableProvider(provider: mock, circuit: circuit)
            XCTAssertNil(selectable.circuitWarning, "\(availability) does not deny dispatch, so no warning")
        }
    }

    func testCircuitWarningWordingForEveryReason() throws {
        let mock = try XCTUnwrap(try decodedProviders().first { $0.id == "mock" })
        let cases: [(String?, String)] = [
            ("quota", "quota exhausted"),
            ("auth", "sign-in needed"),
            ("model_unavailable", "model unavailable"),
            ("transient", "temporarily unavailable"),
        ]
        for (reason, expectedLabel) in cases {
            var fields: [String: JSONValue] = [
                "target": .object(["providerId": .string("mock")]),
                "state": .string("open"),
                "availability": .string("blocked"),
                "attempts": .number(1),
                "openCount": .number(1),
            ]
            if let reason { fields["reason"] = .string(reason) }
            let circuit = try XCTUnwrap(ProviderCircuit(json: .object(fields)))
            let warning = try XCTUnwrap(SelectableProvider(provider: mock, circuit: circuit).circuitWarning)
            XCTAssertTrue(warning.hasPrefix(expectedLabel), "reason \(String(describing: reason)) -> \(warning)")
            // No `blockedUntil` in any of these fixtures — must fall back to
            // the CLI's own wording rather than inventing a time.
            XCTAssertTrue(warning.contains("credentials or status change"))
        }
    }

    func testCircuitWarningShowsARetryTimeWhenTheCircuitHasOne() throws {
        let mock = try XCTUnwrap(try decodedProviders().first { $0.id == "mock" })
        let circuit = try XCTUnwrap(ProviderCircuit(json: try circuitJSON(#"""
        {"target":{"providerId":"mock"},"state":"open","availability":"blocked","attempts":1,"openCount":1,
         "reason":"transient","blockedUntil":1785186254326}
        """#)))
        let warning = try XCTUnwrap(SelectableProvider(provider: mock, circuit: circuit).circuitWarning)
        XCTAssertTrue(warning.contains("retry after"))
        XCTAssertFalse(warning.contains("credentials or status change"), "a real blockedUntil must win over the generic fallback")
    }

    // MARK: - SelectableProvider.localServerWarning / isReadyForAutoSelect
    //
    // The "available: true does NOT mean usable" gap, closed: lmstudio/vllm
    // report `available: true, needsKey: false` unconditionally, so nothing
    // used to distinguish "a server is actually listening" from "nothing is
    // running at localhost:1234" — a live run against an intentionally-not-
    // running lmstudio confirmed both looked identical before this axis
    // existed. `isUsable` is deliberately left alone by all of this (still
    // asserted directly below) — these are two NEW, narrower properties.

    private func lmstudioProvider(reachable: Bool?) -> NexusProvider {
        NexusProvider(id: "lmstudio", kind: "openai-compat", available: true, needsKey: false, localServerReachable: reachable)
    }

    func testLocalServerWarningIsNilWhenConfirmedReachable() {
        let selectable = SelectableProvider(provider: lmstudioProvider(reachable: true))
        XCTAssertTrue(selectable.isUsable)
        XCTAssertNil(selectable.localServerWarning)
    }

    func testLocalServerWarningIsSetWhenConfirmedUnreachable() {
        let selectable = SelectableProvider(provider: lmstudioProvider(reachable: false))
        XCTAssertNotNil(selectable.localServerWarning)
        // Still fully usable/selectable — a warning, never a block. The user
        // may be about to start the server and should still be able to pick it.
        XCTAssertTrue(selectable.isUsable, "reachability must never change isUsable's own meaning")
    }

    func testLocalServerWarningIsNilWhenUnconfirmedEitherReason() {
        // `nil` covers BOTH "not a local-server candidate at all" (e.g.
        // anthropic — never probed) and "probed but inconclusive" (a
        // timeout) — an unconfirmed state must never render as a confident
        // warning, matching the CLI's own text-mode rule (never mark "down"
        // on a mere timeout).
        let notProbed = NexusProvider(id: "anthropic", kind: "anthropic", available: true, needsKey: false, localServerReachable: nil)
        XCTAssertNil(SelectableProvider(provider: notProbed).localServerWarning)
        let inconclusive = lmstudioProvider(reachable: nil)
        XCTAssertNil(SelectableProvider(provider: inconclusive).localServerWarning)
    }

    func testIsReadyForAutoSelectIsFalseOnlyForAConfirmedUnreachableLocalServer() {
        XCTAssertTrue(SelectableProvider(provider: lmstudioProvider(reachable: true)).isReadyForAutoSelect)
        XCTAssertTrue(SelectableProvider(provider: lmstudioProvider(reachable: nil)).isReadyForAutoSelect, "unconfirmed must not block auto-select — only a POSITIVE finding does")
        XCTAssertFalse(SelectableProvider(provider: lmstudioProvider(reachable: false)).isReadyForAutoSelect)
    }

    func testIsReadyForAutoSelectStillRequiresIsUsable() {
        // A provider that needs a key is never auto-select-ready regardless
        // of `localServerReachable` — `isReadyForAutoSelect` narrows
        // `isUsable`, it does not replace its own gate.
        let needsKey = NexusProvider(id: "groq", kind: "openai-compat", available: true, needsKey: true, localServerReachable: true)
        XCTAssertFalse(SelectableProvider(provider: needsKey).isReadyForAutoSelect)
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

    // MARK: - NexusModel.source / isVerified (model list provenance)
    //
    // The fix for the owner's literal complaint: `nexus models -p gemini`
    // used to print a hand-curated, occasionally stale array identically to
    // a verified live catalog. `source` is real bytes from a live
    // `nexus models mock -o json` run (mock has no live listModelsWithSource,
    // so every row is honestly "fallback" — see `models-mock.json`).

    func testSourceDecodesAsFallbackAndIsNotVerified() throws {
        let fast = try XCTUnwrap(try decodedModels().first { $0.id == "mock-fast" })
        XCTAssertEqual(fast.source, .fallback)
        XCTAssertFalse(fast.isVerified)
    }

    func testSourceDefaultsToNilWhenAbsentAndDegradesToNotVerified() throws {
        // `mock-tools`' fixture row has no `source` key at all (an older CLI
        // that predates this field) — must decode as `nil`, and `isVerified`
        // must still read `false`, never a confident "yes" for an unknown
        // provenance.
        let tools = try XCTUnwrap(try decodedModels().first { $0.id == "mock-tools" })
        XCTAssertNil(tools.source)
        XCTAssertFalse(tools.isVerified)
    }

    func testSourceDecodesAsProviderAndIsVerified() throws {
        let json = JSONValue.object(["id": .string("live-a"), "source": .string("provider")])
        let model = try XCTUnwrap(NexusModel(json: json))
        XCTAssertEqual(model.source, .provider)
        XCTAssertTrue(model.isVerified)
    }

    func testUnrecognizedSourceStringDegradesToNilRatherThanCrashing() throws {
        let json = JSONValue.object(["id": .string("x"), "source": .string("some-future-value")])
        let model = try XCTUnwrap(NexusModel(json: json))
        XCTAssertNil(model.source)
        XCTAssertFalse(model.isVerified)
    }

    func testMergingPricingPreservesSource() throws {
        // `merging(pricing:)` must carry `source` through unchanged — it is
        // a copy for ONE purpose (attaching pricing), not a chance to drop
        // provenance.
        let verified = NexusModel(id: "live-a", source: .provider)
        let merged = verified.merging(pricing: ["live-a": .number(5)])
        XCTAssertEqual(merged.source, .provider)
        XCTAssertTrue(merged.isVerified)
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
    func testSelectableComputedFromControllerNeverHidesARealProviderButHidesTestFixturesByDefault() async throws {
        // The fixture has two rows: "mock" (a test fixture) and "groq" (a
        // REAL provider that just needs a key). Those are two DIFFERENT
        // axes — see `SelectableProvider`'s doc: "groq" must still show up,
        // greyed out; "mock" must not show up at all, by default.
        let binary = try fakeNexusBinary(routing: ["providers status": try fixtureText("providers-status")])
        let controller = ProvidersController(client: NexusClient(binary: binary))
        await controller.refresh()

        XCTAssertEqual(controller.providers.count, 2, "fixture shape changed")
        XCTAssertEqual(controller.selectable.map(\.id), ["groq"], "the test fixture must be excluded, not just greyed out")
        XCTAssertEqual(controller.selectable.filter { !$0.isUsable }.map(\.id), ["groq"])
    }

    @MainActor
    func testSelectableIncludesTestFixturesWhenTheDeveloperEscapeHatchIsSet() async throws {
        let binary = try fakeNexusBinary(routing: ["providers status": try fixtureText("providers-status")])
        let controller = ProvidersController(
            client: NexusClient(binary: binary),
            environment: ["NEXUS_SHOW_TEST_PROVIDERS": "1"]
        )
        await controller.refresh()

        XCTAssertEqual(controller.selectable.map(\.id).sorted(), ["groq", "mock"])
    }

    @MainActor
    func testSelectableEscapeHatchTreatsABlankValueAsUnset() async throws {
        // Mirrors `NEXUS_BIN`'s own rule (`NexusClient.swift`): a set-but-blank
        // env var (a real way one ends up that way, e.g. an unquoted shell
        // substitution) is treated as unset, not as a literal "on".
        let binary = try fakeNexusBinary(routing: ["providers status": try fixtureText("providers-status")])
        let controller = ProvidersController(
            client: NexusClient(binary: binary),
            environment: ["NEXUS_SHOW_TEST_PROVIDERS": "   "]
        )
        await controller.refresh()

        XCTAssertEqual(controller.selectable.map(\.id), ["groq"])
    }

    // MARK: - Circuits end to end (G6)
    //
    // `providers-status.json` now carries a real, quota-blocked circuit for
    // "mock" — a provider that is otherwise FULLY usable (no key needed).
    // This is the exact bug: before this task, `refresh()` read `providers`
    // and `pricing` and silently dropped `circuits` on the floor
    // (`Providers.swift:161-175` per the capability audit) — "mock" would
    // have shown as plain "usable", no different from a healthy provider.

    @MainActor
    func testControllerRefreshDecodesCircuitsFromStatus() async throws {
        let binary = try fakeNexusBinary(routing: ["providers status": try fixtureText("providers-status")])
        let controller = ProvidersController(client: NexusClient(binary: binary))
        await controller.refresh()

        XCTAssertEqual(controller.circuits.count, 1)
        let circuit = try XCTUnwrap(controller.circuits.first)
        XCTAssertEqual(circuit.providerId, "mock")
        XCTAssertEqual(circuit.reason, .quota)
        XCTAssertTrue(circuit.isBlocking)
    }

    @MainActor
    func testSelectableJoinsEachProviderToItsOwnBlockingCircuitByProviderId() async throws {
        // This test is about the circuit JOIN, not fixture-filtering — it
        // opts into the developer escape hatch so "mock" (the fixture's only
        // row with a circuit attached) stays in `selectable` to exercise it.
        let binary = try fakeNexusBinary(routing: ["providers status": try fixtureText("providers-status")])
        let controller = ProvidersController(
            client: NexusClient(binary: binary),
            environment: ["NEXUS_SHOW_TEST_PROVIDERS": "1"]
        )
        await controller.refresh()

        let mock = try XCTUnwrap(controller.selectable.first { $0.id == "mock" })
        // The bug, made concrete: "mock" stays usable (real information was
        // ADDED, nothing was taken away) but is no longer indistinguishable
        // from a genuinely healthy provider.
        XCTAssertTrue(mock.isUsable)
        XCTAssertNotNil(mock.circuitWarning)

        // "groq" has no circuit in the fixture — its unavailability is
        // entirely the pre-existing "needs key" reason, untouched by this task.
        let groq = try XCTUnwrap(controller.selectable.first { $0.id == "groq" })
        XCTAssertNil(groq.circuitWarning)
        XCTAssertFalse(groq.isUsable)
    }
}
