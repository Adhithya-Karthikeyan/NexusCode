import SwiftUI

/// Bridges the generated hex tokens to SwiftUI colours.
///
/// Tokens are stored as hex strings rather than `Color` because the generator
/// emits plain data from the TypeScript theme package, and because a string is
/// comparable and hashable — which keeps `NexusTheme` a value type SwiftUI can
/// diff cheaply.
public extension Color {
    /// Parse `#rgb`, `#rrggbb`, or `#rrggbbaa`. Returns nil for anything else,
    /// so a malformed token degrades to a caller-chosen fallback rather than
    /// silently rendering black.
    init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("#") else { return nil }
        text.removeFirst()

        if text.count == 3 {
            // #rgb -> #rrggbb
            text = text.map { "\($0)\($0)" }.joined()
        }
        guard text.count == 6 || text.count == 8,
              let value = UInt64(text, radix: 16)
        else { return nil }

        let hasAlpha = text.count == 8
        let red = Double((value >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
        let green = Double((value >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
        let blue = Double((value >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
        let alpha = hasAlpha ? Double(value & 0xFF) / 255 : 1

        self.init(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
}

public extension NexusTheme {
    /// A token as a SwiftUI colour. Falls back to a visible magenta rather than
    /// a plausible-looking grey, so a bad token is caught in review, not shipped.
    func color(_ token: KeyPath<ThemeTokens, String>) -> Color {
        Color(hex: tokens[keyPath: token]) ?? Color(.sRGB, red: 1, green: 0, blue: 1, opacity: 1)
    }

    /// The theme paired with this one for OS light/dark following, if declared.
    var pairedTheme: NexusTheme? {
        pairId.flatMap { NexusTheme.named($0) }
    }

    /// Resolve the theme to use for a colour scheme, honouring `pairId`:
    /// picking "Nexus Noir" in light mode yields its light sibling rather than an
    /// unreadable dark palette.
    func resolved(for scheme: ColorScheme) -> NexusTheme {
        let wantsDark = scheme == .dark
        if isDark == wantsDark { return self }
        return pairedTheme ?? self
    }
}

/// Provides the active theme to the view tree.
public struct ThemeKey: EnvironmentKey {
    public static let defaultValue: NexusTheme =
        NexusTheme.named(NexusTheme.defaultThemeId) ?? NexusTheme.all[0]
}

public extension EnvironmentValues {
    var nexusTheme: NexusTheme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}
