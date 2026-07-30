import Foundation
import Observation

/// A reasoning-effort level id, exactly as `nexus effort <provider> -o json`
/// reports it — mirrors the CLI's own `EffortLevel` (`packages/cli/src/
/// commands.ts`) verbatim: a plain `String`, never a closed enum. Each
/// provider owns its own scale — a live run shows claude-code reporting
/// seven (`low|medium|high|xhigh|max|ultracode|auto`), anthropic three
/// (`low|medium|high`), codex its own set — so a fixed Swift union here
/// would go stale the instant a vendor CLI added a level, exactly the defect
/// this whole feature replaces (see this file's module doc). The universal
/// `"off"` sentinel is the one value every provider understands without a
/// live probe (see `ConversationController.effort`'s doc for how it's sent).
public typealias EffortLevel = String

/// One entry of `nexus effort <provider> -o json`'s `levels` array.
public struct EffortLevelOption: Sendable, Hashable, Identifiable {
    public let id: EffortLevel
    /// Human detail straight off the wire — e.g. `"24k thinking tokens"` for
    /// a token-budget provider (anthropic/gemini/bedrock/vertex); `nil` for
    /// a `cli-native` provider's bare level name (claude-code/codex), which
    /// carries no numeric budget to report.
    public let description: String?

    public init(id: EffortLevel, description: String? = nil) {
        self.id = id
        self.description = description
    }

    /// `nil` only when the row has no `id` at all.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        self.description = json["description"]?.stringValue
    }
}

/// Where `nexus effort`'s levels actually came from — mirrors
/// `ModelListSource`'s "never render a guess identically to a verified fact"
/// discipline (`Providers.swift`).
public enum EffortListSource: String, Sendable, Hashable {
    case provider
    case fallback
    /// A value this build doesn't recognize yet — preserved rather than
    /// dropped, the same forward-compat style `ReasoningCapability.Kind`
    /// used to keep.
    case unknown

    public init(wire: String?) {
        self = wire.flatMap(EffortListSource.init(rawValue:)) ?? .unknown
    }
}

/// The full decode of one `nexus effort <provider> -o json` run — the live,
/// per-provider reasoning-effort scale.
///
/// This is a DELIBERATELY different, newer data source than `NexusProvider
/// .reasoning`/`ReasoningCapability`, which this replaces entirely (see
/// `cmdEffort`'s own doc comment in `packages/cli/src/commands.ts`):
/// `providers status` never probes live and only ever describes the
/// token-budget/effort-string families, never claude-code's or codex's own
/// native scale — a live run of `nexus effort claude-code -o json` returns
/// seven levels that `providers status`'s `reasoning` field has no way to
/// represent at all. `nexus effort <provider>` is the dedicated "ask on
/// purpose" surface for exactly this, so this is the ONLY decode a picker
/// should be built from.
public struct EffortCapability: Sendable, Hashable {
    public let provider: String
    /// `false` means this provider has no reasoning-effort concept at all —
    /// the caller's job is to hide the control entirely (per `cmdEffort`'s
    /// own "no dead controls" doc), never render a disabled one.
    public let supported: Bool
    public let levels: [EffortLevelOption]
    /// The level this provider is ALREADY using when `--effort` is omitted —
    /// `nil` when the CLI couldn't determine one. Never auto-applied to
    /// `ConversationController.effort` (see that property's doc) — shown
    /// only as a "current" marker in the picker.
    public let defaultLevel: EffortLevel?
    public let source: EffortListSource
    /// Whether NexusCode's "off" (no `--effort` at all) actually disables
    /// reasoning for THIS provider. `false` for claude-code/codex: they
    /// always reason — `--effort` only selects the level — so a picker must
    /// never render an "off" option for those; `true` for the token-budget
    /// family (anthropic/gemini/bedrock/vertex), where off genuinely means
    /// no extended thinking.
    public let offDisablesReasoning: Bool

    /// Plain memberwise construction — for previews and tests.
    public init(
        provider: String,
        supported: Bool,
        levels: [EffortLevelOption] = [],
        defaultLevel: EffortLevel? = nil,
        source: EffortListSource = .fallback,
        offDisablesReasoning: Bool = true
    ) {
        self.provider = provider
        self.supported = supported
        self.levels = levels
        self.defaultLevel = defaultLevel
        self.source = source
        self.offDisablesReasoning = offDisablesReasoning
    }

    /// `nil` only when the row has no `provider` at all — every other field
    /// degrades independently, the same defensive style as `NexusProvider`/
    /// `NexusRole`.
    public init?(json: JSONValue) {
        guard let provider = json["provider"]?.stringValue else { return nil }
        self.provider = provider
        self.supported = json["supported"]?.boolValue ?? false
        self.levels = (json["levels"]?.arrayValue ?? []).compactMap(EffortLevelOption.init(json:))
        self.defaultLevel = json["defaultLevel"]?.stringValue
        self.source = EffortListSource(wire: json["source"]?.stringValue)
        // Defaults `true` (the safe assumption for "no live signal either
        // way") — mirrors `cmdEffort`'s own default on the CLI side
        // (`commands.ts`), so an older CLI build that predates this field
        // degrades to "off really means off" rather than silently treating
        // an unopposed omission as if it disabled reasoning.
        self.offDisablesReasoning = json["offDisablesReasoning"]?.boolValue ?? true
    }
}

/// Loads ONE provider's live reasoning-effort scale from `nexus effort
/// <provider> -o json` — re-instantiated by the caller every time the active
/// provider changes (`ConversationView`'s `.task(id:)`), never reused across
/// providers, so a brief in-flight probe can never show a stale scale
/// borrowed from whatever provider was selected before it (`capability`
/// starts `nil` on every fresh instance). This is cheap (one short-lived
/// subprocess) unlike `ProvidersController.models(for:)`'s per-provider
/// cache, so there is no caching layer to get wrong here.
@MainActor
@Observable
public final class EffortController {
    public private(set) var capability: EffortCapability?
    public private(set) var isLoading = false
    public var error: String?

    private let client: NexusClient
    private let workingDirectory: URL?

    public init(client: NexusClient, workingDirectory: URL? = nil) {
        self.client = client
        self.workingDirectory = workingDirectory
    }

    /// Reloads from `nexus effort <provider> -o json`.
    public func refresh(provider: String) async {
        isLoading = true
        defer { isLoading = false }
        switch await client.runJSON(.effort(provider: provider, cwd: workingDirectory)) {
        case .success(let value):
            guard let capability = EffortCapability(json: value) else {
                error = "unexpected response shape from `nexus effort \(provider)`"
                return
            }
            self.capability = capability
            error = nil
        case .failure(let commandError):
            error = commandError.message
        }
    }
}

// MARK: - Command factory

extension NexusCommand {
    /// `nexus effort <provider> -o json` — the live, per-provider
    /// reasoning-effort scale. See `EffortCapability`'s doc for why this is
    /// the one place a client asks for the real thing rather than
    /// `providers status`, which deliberately never probes live.
    public static func effort(provider: String, cwd: URL? = nil) -> NexusCommand {
        .json(["effort", provider], cwd: cwd)
    }
}
