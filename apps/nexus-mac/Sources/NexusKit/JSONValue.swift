import Foundation

/// A decoded JSON value of unknown shape.
///
/// Two `UiEvent` payloads are deliberately untyped on the TypeScript side —
/// a tool call's `args` and a tool result's `result` are whatever the tool
/// decided to emit. Modelling them as `JSONValue` keeps them fully preserved
/// and inspectable (the UI renders them as a tree) instead of being flattened
/// to a string at the decode boundary, which would throw away the structure the
/// tool inspector wants to show.
public enum JSONValue: Sendable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// A compact single-line rendering, for collapsed rows and tooltips.
    public var inlineDescription: String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            return value == value.rounded() && abs(value) < 1e15
                ? String(Int(value))
                : String(value)
        case .string(let value): return value
        case .array(let items): return "[\(items.count)]"
        case .object(let fields):
            let keys = fields.keys.sorted().prefix(3).joined(separator: ", ")
            return fields.count > 3 ? "{\(keys), …}" : "{\(keys)}"
        }
    }

    /// The value at `key`, when this is an object.
    public subscript(key: String) -> JSONValue? {
        guard case .object(let fields) = self else { return nil }
        return fields[key]
    }

    public var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }
}
