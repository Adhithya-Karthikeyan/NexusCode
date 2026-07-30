import Foundation
import Observation

/// One row of `nexus providers list` / `providers status -o json`'s
/// `providers` array.
///
/// `available` and `needsKey` are NOT the same axis — per the CLI's own
/// provider-loading code (`packages/runtime/src/index.ts`), `available: false`
/// means the provider's package failed to load at all (a genuine, rare
/// failure), while `available: true, needsKey: true` is the ordinary
/// "installed fine, just no credential set yet" case: a live run of
/// `providers list -o json` shows every OpenAI-compatible provider (groq,
/// together, mistral, …) reporting `available: true` with zero API keys
/// configured. `detail` carries the human-readable reason either way, which is
/// why the UI should show it rather than just hiding the row — see
/// `SelectableProvider` below.
public struct NexusProvider: Sendable, Hashable, Identifiable {
    public let id: String
    public let kind: String?
    public let available: Bool
    public let needsKey: Bool
    public let detail: String?
    /// True when this row is a TEST FIXTURE (the CLI's built-in `mock`
    /// adapter family — `mock`, `mock-flaky`, `mock-slow`, and any
    /// provider a user configures with `kind: "mock"`) rather than a real,
    /// dispatchable provider. Straight off the wire's own `isTestFixture`
    /// field (`cmdProviders`'s `isTestFixtureProvider`, `commands.ts`),
    /// itself derived from `kind` — the closed `ProviderKind` enum's
    /// adapter-implementation tag (`packages/config/src/schema.ts`) — NOT
    /// from `id` spelling: a live run confirms `mock-flaky`/`mock-slow`
    /// report `isTestFixture: true` despite neither `id` being "mock".
    /// Defaults to `false` on an older CLI that predates this field, so a
    /// stale binary degrades to "show everything" rather than hiding real
    /// providers.
    public let isTestFixture: Bool
    /// Whether a LOCAL SERVER this provider depends on is actually running
    /// right now — straight off the wire's `localServerReachable`
    /// (`probeLocalServerReachability`, `packages/runtime/src/index.ts`).
    /// This is the "`available: true` does NOT mean usable" gap: lmstudio/
    /// vllm register `available: true, needsKey: false` unconditionally
    /// (no credential to check), so — before this field existed — nothing
    /// distinguished "installed and a server is listening" from "nothing is
    /// listening at localhost:1234" (a live run with nothing running there
    /// confirms this: `available`/`needsKey` alone are identical either way).
    ///
    /// THREE-valued, same discipline as `reasoning` above — deliberately
    /// NOT collapsed to a plain `Bool`:
    ///  - `nil` — either this provider has nothing to probe (most providers:
    ///    a cloud API, `mock`, a subprocess CLI — this axis simply does not
    ///    apply) OR the CLI tried and the probe was inconclusive (timed out).
    ///    A live run confirms the CLI itself keeps a THIRD, wire-level state
    ///    for the timeout case (JSON `null`, distinct from the key being
    ///    absent) but this decode intentionally collapses both into `nil`:
    ///    every consumer of this property treats them identically — "no
    ///    confirmed evidence either way, don't warn, don't block auto-select"
    ///    — see `SelectableProvider.localServerWarning`/`isReadyForAutoSelect`.
    ///    A caller that ever needs the finer distinction should decode
    ///    `json["localServerReachable"]` directly rather than add it here.
    ///  - `.some(false)` — CONFIRMED unreachable: the CLI's own probe
    ///    completed within its bound and got a real connection failure.
    ///    Never render this as merely "unknown"; it is the one state worth
    ///    acting on.
    ///  - `.some(true)` — confirmed reachable.
    public let localServerReachable: Bool?

    /// Plain memberwise construction — for previews and tests. Kept separate
    /// from `init?(json:)` below, which is the only one that talks to the
    /// CLI's wire format.
    public init(
        id: String,
        kind: String? = nil,
        available: Bool = true,
        needsKey: Bool = false,
        detail: String? = nil,
        isTestFixture: Bool = false,
        localServerReachable: Bool? = nil
    ) {
        self.id = id
        self.kind = kind
        self.available = available
        self.needsKey = needsKey
        self.detail = detail
        self.isTestFixture = isTestFixture
        self.localServerReachable = localServerReachable
    }

    /// `nil` only when the row has no `id` at all — every other field
    /// tolerates absence, the same defensive style as `NexusSession`/`NexusTask`.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        self.kind = json["kind"]?.stringValue
        self.available = json["available"]?.boolValue ?? false
        self.needsKey = json["needsKey"]?.boolValue ?? false
        self.detail = json["detail"]?.stringValue
        self.isTestFixture = json["isTestFixture"]?.boolValue ?? false
        // `?.boolValue` already collapses "key absent" and "JSON null" into
        // the same Swift `nil` for free (see this property's doc) — no
        // special-case decode needed for the two-vs-three-state distinction.
        self.localServerReachable = json["localServerReachable"]?.boolValue
    }

    /// Whether picking this provider would actually work right now —
    /// `available` alone isn't enough (see the type doc above).
    public var isUsable: Bool { available && !needsKey }
}

// Reasoning-effort capability used to live here as `ReasoningCapability`,
// decoded from `providers list|status -o json`'s `reasoning` field. Removed:
// that field never probes live and only ever describes the token-budget/
// effort-string families, never claude-code's or codex's own native scale —
// a live run of `nexus effort claude-code -o json` returns SEVEN levels
// `reasoning` has no way to represent at all. `EffortCapability`
// (`Effort.swift`), decoded from the dedicated `nexus effort <provider>`
// live probe, is the real replacement — see its module doc for the full
// reasoning, and `cmdEffort`'s own doc comment in `packages/cli/src/
// commands.ts` for why that command exists as a separate surface from this
// one.

/// One entry from `providers status -o json`'s `circuits` array — the
/// provider circuit breaker's persisted, CROSS-PROCESS state for one
/// (provider, account, model) scope. Mirrors `ProviderCircuitStatus`
/// (`packages/core/src/provider-circuit.ts`) exactly, decoded through
/// `JSONValue` (not `Decodable`) the same defensive style as
/// `NexusSession`/`NexusProvider` — a field this build doesn't know about
/// degrades that field, never the whole row.
///
/// This is a DIFFERENT signal from `ViewState.providerHealth` — see that
/// property's doc comment (`ViewState.swift`) for which one wins if a future
/// UI ever needs to show both together.
public struct ProviderCircuit: Sendable, Hashable {
    public enum State: String, Sendable, Hashable {
        case closed, open
        case halfOpen = "half-open"
    }

    /// Whether a request would actually be allowed through right now. The
    /// CLI's own `providers status` (text mode) switches on exactly this:
    /// `.blocked`/`.probing` deny dispatch; `.available`/`.probeAvailable`
    /// both let one through (the latter consuming the single live half-open
    /// probe every cooperating `nexus` process shares).
    public enum Availability: String, Sendable, Hashable {
        case available
        case blocked
        case probeAvailable = "probe_available"
        case probing
    }

    public enum Reason: String, Sendable, Hashable {
        case quota, auth
        case modelUnavailable = "model_unavailable"
        case transient
    }

    public let providerId: String
    public let accountId: String?
    public let modelId: String?
    public let state: State
    public let availability: Availability
    public let reason: Reason?
    /// When the block clears. Absent for `auth` failures specifically — the
    /// breaker deliberately never sets a cooldown for those (verified against
    /// a real synthesized `auth`-reason circuit run through the actual store
    /// loader: no `blockedUntil`/`retryAt` at all): only fresh credentials or
    /// a manual `nexus providers reset` clears one.
    public let blockedUntil: Date?
    public let lastFailureAt: Date?
    public let lastSuccessAt: Date?

    /// Whether this circuit currently denies a real dispatch — mirrors the
    /// CLI's own `blocked || probing` check (`commands.ts`'s `cmdProviders`).
    public var isBlocking: Bool { availability == .blocked || availability == .probing }

    /// `nil` when the row is missing `target.providerId`, `state`, or
    /// `availability` — the three fields every other field's meaning depends
    /// on. Every other field degrades independently.
    public init?(json: JSONValue) {
        guard let providerId = json["target"]?["providerId"]?.stringValue,
              let stateRaw = json["state"]?.stringValue, let state = State(rawValue: stateRaw),
              let availabilityRaw = json["availability"]?.stringValue,
              let availability = Availability(rawValue: availabilityRaw)
        else { return nil }
        self.providerId = providerId
        self.accountId = json["target"]?["accountId"]?.stringValue
        self.modelId = json["target"]?["modelId"]?.stringValue
        self.state = state
        self.availability = availability
        self.reason = json["reason"]?.stringValue.flatMap(Reason.init(rawValue:))
        self.blockedUntil = json["blockedUntil"]?.doubleValue.map { Date(timeIntervalSince1970: $0 / 1000) }
        self.lastFailureAt = json["lastFailureAt"]?.doubleValue.map { Date(timeIntervalSince1970: $0 / 1000) }
        self.lastSuccessAt = json["lastSuccessAt"]?.doubleValue.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}

/// One row for a provider picker that must show EVERY REAL provider —
/// including ones that can't be used yet — rather than silently filtering
/// them out. Mirrors the same "grey it out, don't hide it" rule the
/// Tasks/Sessions tabs use for other degraded states: a user switching
/// providers needs to see "groq exists, but needs GROQ_API_KEY" instead of
/// groq just not being there.
///
/// A TEST FIXTURE (`provider.isTestFixture`) is a deliberately DIFFERENT
/// axis from this rule, not an exception to it: it isn't a degraded real
/// provider a user might still want to pick (like groq needing a key), it
/// is a CLI-internal offline harness (`mock`/`mock-flaky`/`mock-slow`) that
/// was never meant to be end-user-selectable in the first place — its
/// presence here was a leak, not a feature. `ProvidersController.selectable`
/// omits it entirely (rather than greying it out) for exactly that reason;
/// see that property's doc for the developer escape hatch.
public struct SelectableProvider: Sendable, Hashable, Identifiable {
    public let provider: NexusProvider
    /// The strongest currently-blocking circuit for this provider (any
    /// account/model scope), if any. `nil` means nothing is tripped — NOT
    /// the same as `isUsable == false`; see `circuitWarning` below.
    public let circuit: ProviderCircuit?
    public var id: String { provider.id }
    public var isUsable: Bool { provider.isUsable }
    /// The reason to render (greyed out) when `isUsable` is false; `nil` when
    /// the provider is fully usable.
    public var reason: String? { isUsable ? nil : provider.detail }

    /// A caution for a TRIPPED circuit — deliberately a SEPARATE axis from
    /// `reason` above, not folded into it. `reason`/`isUsable` are about
    /// STRUCTURAL usability (no credential configured); a circuit trip is an
    /// OPERATIONAL, transient state — quota exhaustion, a rate limit, a run
    /// of failures — that the CLI's own breaker already tracks and will clear
    /// on its own (or admit a probe) without the user doing anything. Hiding
    /// or disabling the option for that would be its own dishonesty: circuit
    /// state can be stale by the time the user acts on it, and the user may
    /// know something this app doesn't (a quota reset, a fixed key). So the
    /// provider stays fully selectable (`isUsable` is UNCHANGED by this) and
    /// the caution surfaces alongside it — the exact "visible, not blocking"
    /// contract `PickerOption.warning` already has for a different case (an
    /// agent role that can write). The real gate is the CLI's circuit breaker
    /// at dispatch time; this app is advisory, not the enforcement point.
    public var circuitWarning: String? {
        guard let circuit, circuit.isBlocking else { return nil }
        let label: String
        switch circuit.reason {
        case .quota: label = "quota exhausted"
        case .auth: label = "sign-in needed"
        case .modelUnavailable: label = "model unavailable"
        case .transient, .none: label = "temporarily unavailable"
        }
        guard let until = circuit.blockedUntil else {
            // `auth` (and any other reason-less block) has no cooldown —
            // matches the CLI's own text-mode wording ("… until credentials
            // or status change") rather than inventing a time that isn't there.
            return "\(label) — retry after credentials or status change"
        }
        return "\(label) — retry after \(until.formatted(date: .abbreviated, time: .shortened))"
    }

    /// A caution for a CONFIRMED-unreachable local-server dependency
    /// (lmstudio/vllm with nothing listening) — a THIRD axis, separate from
    /// both `reason` (structural usability — needs a key) and
    /// `circuitWarning` (an operational trip the CLI's own breaker tracks).
    /// This one the app itself just found out by asking, this run, right
    /// now — see `NexusProvider.localServerReachable`'s doc for the
    /// three-valued decode this reads.
    ///
    /// Same "visible, not blocking" shape as `circuitWarning`: `isUsable` is
    /// UNCHANGED (a user who knows they are about to start the server should
    /// still be able to pick it), only `isReadyForAutoSelect` below acts on
    /// this. `nil` for `localServerReachable == nil` (not a local-server
    /// candidate at all, OR the probe was inconclusive) — an unconfirmed
    /// state must never render as a confident warning, exactly as it must
    /// never render as a confident "down" mark in the CLI's own text output
    /// (`commands.ts`'s `cmdProviders`).
    public var localServerWarning: String? {
        provider.localServerReachable == false ? "local server not reachable — start it, then retry" : nil
    }

    /// Whether this provider should be eligible for an AUTOMATIC preselect
    /// (`ChatTab`'s `task` in `RootView.swift`) — deliberately a DIFFERENT,
    /// narrower question than `isUsable`. `isUsable` keeps meaning exactly
    /// what it means today (own it), so this is a NEW seam rather than a
    /// redefinition: a confirmed-unreachable local server is structurally
    /// "usable" (no key needed, package loaded fine) but landing a user on
    /// it with no server running is the same experience as the mock-fixture
    /// leak this whole picker cleanup started with, just wearing a real
    /// provider's name — see `localServerWarning`'s doc. `nil`
    /// (unconfirmed/not-applicable) does NOT block this, matching the same
    /// "don't punish what we don't know" rule as everywhere else on this
    /// axis: only a POSITIVE finding of unreachability disqualifies.
    public var isReadyForAutoSelect: Bool {
        isUsable && provider.localServerReachable != false
    }

    public init(provider: NexusProvider, circuit: ProviderCircuit? = nil) {
        self.provider = provider
        self.circuit = circuit
    }
}

/// Where a `NexusModel` row actually came from — mirrors the CLI's
/// `ModelListSource` (`packages/shared/src/model-cache.ts`) exactly, straight
/// off `nexus models <provider> -o json`'s `source` field.
///
/// A CLOSED two-value type, not a `Bool` — matching this repo's convention
/// for anything a client must react to differently rather than render
/// identically (`AgentVerdict`'s three-valued outcome,
/// `NexusProvider.localServerReachable`'s reachability triple): `.fallback`
/// is not a degraded or partial `.provider` result, it is a DIFFERENT KIND
/// of answer — the CLI's own built-in guess, not a confirmed fact. This is
/// the fix for the exact bug the owner reported: `nexus models -p gemini`
/// printed a hand-curated, occasionally stale array (`DEFAULT_GEMINI_MODELS`)
/// rendered IDENTICALLY to a verified live catalog, for every provider whose
/// live probe could never run because there was no key to try it with.
public enum ModelListSource: String, Sendable, Hashable {
    case provider
    case fallback
}

/// One entry of `nexus models <provider> -o json`'s `models` array.
public struct NexusModel: Sendable, Hashable, Identifiable {
    public let id: String
    /// Free-text sizing hint straight from the CLI, e.g. `"32k ctx"` /
    /// `"128k ctx"` — a live run shows `models <provider> -o json` has no
    /// separate numeric field, just this string. See `contextWindow` for a
    /// best-effort parse of it.
    public let hint: String?
    /// Filled in by `ProvidersController.models(for:)` from `providers
    /// status`'s pricing table — `models <provider> -o json` itself never
    /// reports pricing. `nil` when there is no configured price (every model
    /// in a live run of this build) or the provider/model isn't in the table
    /// at all.
    public let pricing: JSONValue?
    /// `nil` only for an older CLI that predates this field — see
    /// `isVerified` for how that degrades. Every current CLI build always
    /// sends an explicit `source` on every row (never omits it).
    public let source: ModelListSource?

    /// Whether this row is a CONFIRMED live result — `false` for both
    /// `.fallback` and `nil` (an older CLI / a malformed value): an unknown
    /// provenance must never read as verified, the same "unknown is not a
    /// confirmed positive" rule `NexusProvider.localServerReachable` and
    /// `EffortCapability.source`/`EffortListSource` (`Effort.swift`) already
    /// apply. This is the ONE property a picker should read to decide
    /// display treatment — see this type's doc for why it must never render
    /// a `.fallback`/unknown row identically to a verified one.
    public var isVerified: Bool { source == .provider }

    /// Plain memberwise construction — for previews and tests.
    public init(id: String, hint: String? = nil, pricing: JSONValue? = nil, source: ModelListSource? = nil) {
        self.id = id
        self.hint = hint
        self.pricing = pricing
        self.source = source
    }

    /// `nil` only when the row has no `id`. `pricing` is never set from this
    /// initializer — `models <provider> -o json` doesn't carry it — and is
    /// only ever attached afterwards via `merging(pricing:)`.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        self.hint = json["hint"]?.stringValue
        self.pricing = nil
        self.source = json["source"]?.stringValue.flatMap(ModelListSource.init(rawValue:))
    }

    /// Best-effort parse of `hint`'s `"NNk ctx"` shorthand into a token count.
    /// `nil` when `hint` is absent or doesn't match that exact shape — never a
    /// crash; the UI can fall back to showing the raw `hint` string.
    public var contextWindow: Int? {
        guard let hint, hint.hasSuffix("k ctx") else { return nil }
        let digits = hint.dropLast("k ctx".count)
        return Int(digits).map { $0 * 1_000 }
    }

    /// A copy with `pricing` looked up from a provider's modelId→pricing
    /// table (built by `ProvidersController` from `providers status`).
    func merging(pricing table: [String: JSONValue]) -> NexusModel {
        NexusModel(id: id, hint: hint, pricing: table[id], source: source)
    }
}

/// Loads and holds the Providers tab's data, backed by `nexus providers …`
/// and `nexus models …`.
@MainActor
@Observable
public final class ProvidersController {
    public private(set) var providers: [NexusProvider] = []
    /// The circuit breaker's full state, straight from `providers status`'s
    /// `circuits` array — every scope, closed or not (the CLI is asked for
    /// `includeClosed: true`). `selectable` below is what actually joins
    /// these to their provider by id; this is kept for a future, richer view
    /// (per-account/per-model detail) that isn't in scope yet.
    public private(set) var circuits: [ProviderCircuit] = []
    public private(set) var isLoading = false
    public var error: String?

    private let client: NexusClient
    private let workingDirectory: URL?
    private var modelsCache: [String: [NexusModel]] = [:]
    /// providerId → modelId → pricing, built once per `refresh()` from
    /// `providers status`'s `pricing` array and reused by every
    /// `models(for:)` call, so fetching one provider's models never needs a
    /// second round trip just to attach pricing.
    private var pricingIndex: [String: [String: JSONValue]] = [:]
    /// The developer escape hatch for `selectable`'s test-fixture filter —
    /// see that property's doc for why one exists at all. `NEXUS_BIN`
    /// (`NexusClient.swift`) is this app's one other env-var override, and
    /// this follows its exact rule: blank/whitespace-only counts as unset.
    /// Captured once at `init` (not re-read per `selectable` access) and
    /// threaded through an injectable `environment` parameter — the same
    /// pattern `NexusBinary.discover` uses — so a test can set it without
    /// mutating real process-wide state.
    private let showTestFixtures: Bool

    public init(
        client: NexusClient,
        workingDirectory: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.client = client
        self.workingDirectory = workingDirectory
        self.showTestFixtures = !(environment["NEXUS_SHOW_TEST_PROVIDERS"]?
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    /// Reloads from `nexus providers status -o json` — a superset of
    /// `providers list` (same `providers` array, plus the pricing table used
    /// to enrich `models(for:)`), so one call covers both.
    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        switch await client.runJSON(.providersStatus(cwd: workingDirectory)) {
        case .success(let value):
            guard let items = value["providers"]?.arrayValue else {
                error = "unexpected response shape from `nexus providers status`"
                return
            }
            providers = items.compactMap(NexusProvider.init(json:))
            circuits = (value["circuits"]?.arrayValue ?? []).compactMap(ProviderCircuit.init(json:))
            pricingIndex = Self.pricingIndex(from: value["pricing"]?.arrayValue ?? [])
            // Pricing may have changed since the last refresh; drop the cache
            // so the next `models(for:)` call re-merges against the new table
            // rather than keep serving stale pricing forever.
            modelsCache.removeAll()
            error = nil
        case .failure(let commandError):
            error = commandError.message
        }
    }

    /// Loads (and caches) one provider's models from `nexus models <id> -o
    /// json`, enriched with any pricing `refresh()` already fetched for it.
    public func models(for providerId: String) async -> [NexusModel] {
        if let cached = modelsCache[providerId] { return cached }
        switch await client.runJSON(.models(provider: providerId, cwd: workingDirectory)) {
        case .success(let value):
            guard let items = value["models"]?.arrayValue else {
                error = "unexpected response shape from `nexus models \(providerId)`"
                return []
            }
            let table = pricingIndex[providerId] ?? [:]
            let models = items.compactMap(NexusModel.init(json:)).map { $0.merging(pricing: table) }
            modelsCache[providerId] = models
            return models
        case .failure(let commandError):
            error = commandError.message
            return []
        }
    }

    /// Every REAL provider, annotated for a picker that greys out but never
    /// hides ones that aren't usable yet — and now also carries a tripped
    /// circuit's warning, when it has one, without touching usability (see
    /// `SelectableProvider.circuitWarning`'s doc for why the two stay
    /// separate).
    ///
    /// Test fixtures (`provider.isTestFixture` — the CLI's built-in
    /// `mock`/`mock-flaky`/`mock-slow` family, see `NexusProvider
    /// .isTestFixture`'s doc) are excluded here rather than greyed out: they
    /// are an offline test harness, not a real provider a user is choosing
    /// between, and their presence in a user-facing picker (or as an
    /// accidental auto-selection — every consumer of `selectable`, including
    /// `ChatTab`'s `first(where: \.isReadyForAutoSelect)` preselect in
    /// `RootView.swift`, reads from this ONE list) is the exact leak this
    /// property exists to close. `NexusProvider.isUsable`/`isTestFixture`
    /// themselves are left alone — `mock` really is usable, so
    /// decoding/CLI-facing code (e.g. `nexus ask -p mock`) is untouched;
    /// only THIS app-facing aggregation point filters.
    ///
    /// A developer working on this app who genuinely needs `mock` in the
    /// picker can set `NEXUS_SHOW_TEST_PROVIDERS` (any non-blank value) —
    /// see `showTestFixtures`'s doc. Deliberately just an env var, not a
    /// Settings toggle: this is a workbench need for someone already running
    /// the app from source, not a product feature end users should discover.
    public var selectable: [SelectableProvider] {
        providers
            .filter { showTestFixtures || !$0.isTestFixture }
            .map { SelectableProvider(provider: $0, circuit: blockingCircuit(for: $0.id)) }
    }

    /// The strongest currently-blocking circuit for `providerId` (any
    /// account/model scope), or `nil` when nothing is tripped. Mirrors the
    /// CLI's own `providers status` (text-mode) selection exactly
    /// (`commands.ts`'s `cmdProviders`: `scopedCircuits`/`blocked`) — a
    /// non-closed circuit for this provider whose availability actually
    /// denies dispatch, i.e. NOT `probe_available` (that one still lets a
    /// request through).
    private func blockingCircuit(for providerId: String) -> ProviderCircuit? {
        circuits.first { $0.providerId == providerId && $0.state != .closed && $0.isBlocking }
    }

    /// Flattens `providers status`'s `pricing[].models[]` into a
    /// providerId→modelId→pricing lookup, dropping entries whose `pricing` is
    /// JSON `null` (every model in a live run of this build) so `nil` from the
    /// lookup means "genuinely no price" rather than "found a null".
    private static func pricingIndex(from entries: [JSONValue]) -> [String: [String: JSONValue]] {
        var index: [String: [String: JSONValue]] = [:]
        for entry in entries {
            guard let providerId = entry["providerId"]?.stringValue else { continue }
            var models: [String: JSONValue] = [:]
            for modelEntry in entry["models"]?.arrayValue ?? [] {
                guard let modelId = modelEntry["modelId"]?.stringValue,
                      let pricing = modelEntry["pricing"], pricing != .null
                else { continue }
                models[modelId] = pricing
            }
            if !models.isEmpty { index[providerId] = models }
        }
        return index
    }
}

// MARK: - Command factories

extension NexusCommand {
    public static func providersList(cwd: URL? = nil) -> NexusCommand {
        .json(["providers", "list"], cwd: cwd)
    }

    public static func providersStatus(cwd: URL? = nil) -> NexusCommand {
        .json(["providers", "status"], cwd: cwd)
    }

    public static func models(provider: String, cwd: URL? = nil) -> NexusCommand {
        .json(["models", provider], cwd: cwd)
    }
}
