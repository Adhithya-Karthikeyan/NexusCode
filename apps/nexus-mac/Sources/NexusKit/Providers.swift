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

    /// Plain memberwise construction — for previews and tests. Kept separate
    /// from `init?(json:)` below, which is the only one that talks to the
    /// CLI's wire format.
    public init(
        id: String,
        kind: String? = nil,
        available: Bool = true,
        needsKey: Bool = false,
        detail: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.available = available
        self.needsKey = needsKey
        self.detail = detail
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
    }

    /// Whether picking this provider would actually work right now —
    /// `available` alone isn't enough (see the type doc above).
    public var isUsable: Bool { available && !needsKey }
}

/// One row for a provider picker that must show EVERY provider — including
/// ones that can't be used yet — rather than silently filtering them out.
/// Mirrors the same "grey it out, don't hide it" rule the Tasks/Sessions tabs
/// use for other degraded states: a user switching providers needs to see
/// "groq exists, but needs GROQ_API_KEY" instead of groq just not being there.
public struct SelectableProvider: Sendable, Hashable, Identifiable {
    public let provider: NexusProvider
    public var id: String { provider.id }
    public var isUsable: Bool { provider.isUsable }
    /// The reason to render (greyed out) when `isUsable` is false; `nil` when
    /// the provider is fully usable.
    public var reason: String? { isUsable ? nil : provider.detail }

    public init(provider: NexusProvider) {
        self.provider = provider
    }
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

    /// Plain memberwise construction — for previews and tests.
    public init(id: String, hint: String? = nil, pricing: JSONValue? = nil) {
        self.id = id
        self.hint = hint
        self.pricing = pricing
    }

    /// `nil` only when the row has no `id`. `pricing` is never set from this
    /// initializer — `models <provider> -o json` doesn't carry it — and is
    /// only ever attached afterwards via `merging(pricing:)`.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        self.hint = json["hint"]?.stringValue
        self.pricing = nil
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
        NexusModel(id: id, hint: hint, pricing: table[id])
    }
}

/// Loads and holds the Providers tab's data, backed by `nexus providers …`
/// and `nexus models …`.
@MainActor
@Observable
public final class ProvidersController {
    public private(set) var providers: [NexusProvider] = []
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

    public init(client: NexusClient, workingDirectory: URL? = nil) {
        self.client = client
        self.workingDirectory = workingDirectory
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

    /// Every provider, annotated for a picker that greys out but never hides
    /// ones that aren't usable yet.
    public var selectable: [SelectableProvider] {
        providers.map(SelectableProvider.init)
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
