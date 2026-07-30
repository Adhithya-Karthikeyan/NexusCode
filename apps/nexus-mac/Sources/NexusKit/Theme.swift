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

public extension Color {
    /// WCAG 2.1 contrast ratio between two hex colours, computed directly
    /// from the hex strings rather than a resolved `Color`. That matters:
    /// `Color`'s component accessors need a window server / colour space to
    /// resolve against, which headless `swift test` doesn't have, so this
    /// gives the same answer in a running app and in a unit test — the two
    /// places this codebase has been burned by contrast that "looked fine."
    static func contrastRatio(_ hexA: String, _ hexB: String) -> Double {
        func luminance(_ hex: String) -> Double {
            var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.hasPrefix("#") { text.removeFirst() }
            guard text.count == 6, let value = UInt64(text, radix: 16) else { return 0 }
            let r = Double((value >> 16) & 0xFF) / 255
            let g = Double((value >> 8) & 0xFF) / 255
            let b = Double(value & 0xFF) / 255
            func linearize(_ c: Double) -> Double {
                c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
        }
        let lumA = luminance(hexA)
        let lumB = luminance(hexB)
        let lighter = max(lumA, lumB)
        let darker = min(lumA, lumB)
        return (lighter + 0.05) / (darker + 0.05)
    }

    /// Picks whichever of two candidate text colours reads better against a
    /// background, by measured contrast rather than by assuming the
    /// background is dark or light.
    ///
    /// Exists because a few tokens (`accentMuted` chief among them) were
    /// designed as a tinted wash, not as one half of a text/background pair —
    /// there is no single "the text colour for this" token, and guessing one
    /// (this codebase guessed `accentFg`, which was designed for text on the
    /// full-strength `accentDefault` fill, not the muted one) is exactly how
    /// `CountPill`'s `.accent` badge ended up at a 1.5–3.7:1 ratio across
    /// every theme, old and new. This computes the answer instead.
    static func readableText(on backgroundHex: String, preferring primaryHex: String, otherwise inverseHex: String) -> Color {
        let primaryRatio = contrastRatio(primaryHex, backgroundHex)
        let inverseRatio = contrastRatio(inverseHex, backgroundHex)
        let winner = primaryRatio >= inverseRatio ? primaryHex : inverseHex
        return Color(hex: winner) ?? Color(.sRGB, red: 1, green: 0, blue: 1, opacity: 1)
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
///
/// Typed `AppTheme`, not `NexusTheme`: the app renders through the richer
/// model (elevation, material, gradient, state layers) unconditionally, for
/// BOTH catalogues. A hand-designed theme (`AppTheme.all`) is used as-is; one
/// of the 16 terminal-generated palettes (`NexusTheme.all`) is used through
/// `NexusTheme.appTheme`, the generic bridge in `AppTheme.swift` — so every
/// view in the app can read `theme.color(...)`, `theme.elevation`, etc.
/// without caring which catalogue the active theme came from. The default is
/// a catalogue theme (`AppTheme.defaultThemeId`, currently Storm), not
/// a generated one — a default nobody changes is what most users will
/// actually see.
public struct ThemeKey: EnvironmentKey {
    public static let defaultValue: AppTheme =
        AppTheme.named(AppTheme.defaultThemeId) ?? AppTheme.all[0]
}

public extension EnvironmentValues {
    var nexusTheme: AppTheme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}
