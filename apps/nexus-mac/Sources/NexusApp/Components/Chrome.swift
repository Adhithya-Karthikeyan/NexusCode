import SwiftUI
import NexusKit

/// Shared themed primitives.
///
/// Every colour comes from a semantic token — no view names a raw colour, the
/// same rule the terminal theme layer enforces. That is what lets all 16 themes
/// work without any view knowing they exist.

/// A small status pill (running / failed / idle).
struct StatusDot: View {
    @Environment(\.nexusTheme) private var theme
    let isRunning: Bool
    let isFailed: Bool
    var animate = true

    @State private var pulse = false

    private var color: Color {
        if isFailed { return theme.color(\.errorFg) }
        return isRunning ? theme.color(\.accentDefault) : theme.color(\.textMuted)
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .overlay {
                if isRunning && animate {
                    Circle()
                        .stroke(color.opacity(0.55), lineWidth: 2)
                        .scaleEffect(pulse ? 2.2 : 1)
                        .opacity(pulse ? 0 : 1)
                }
            }
            .onAppear {
                guard isRunning && animate else { return }
                withAnimation(.easeOut(duration: 1.1).repeatForever(autoreverses: false)) {
                    pulse = true
                }
            }
            .accessibilityLabel(isFailed ? "failed" : (isRunning ? "running" : "idle"))
    }
}

/// A labelled key/value readout for the status bar.
struct Metric: View {
    @Environment(\.nexusTheme) private var theme
    let label: String
    let value: String
    var emphasis: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(theme.color(\.textMuted))
            Text(value)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(emphasis ? theme.color(\.accentDefault) : theme.color(\.textSecondary))
        }
        .fixedSize()
    }
}

/// A card surface used by the agent rows and the empty states.
struct Panel<Content: View>: View {
    @Environment(\.nexusTheme) private var theme
    var padding: CGFloat = 14
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .background(theme.color(\.surfaceRaised))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(theme.color(\.chromeBorderSubtle), lineWidth: 1)
            }
    }
}

/// A centred "nothing here yet" state — never a blank void.
struct EmptyState: View {
    @Environment(\.nexusTheme) private var theme
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(theme.color(\.accentMuted))
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.color(\.textPrimary))
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(theme.color(\.textMuted))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
    }
}

/// Monospaced code/diff block that scrolls horizontally instead of wrapping.
struct CodeBlock: View {
    @Environment(\.nexusTheme) private var theme
    let text: String
    var isDiff = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                    Text(String(line))
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(color(for: String(line)))
                        .textSelection(.enabled)
                }
            }
            .padding(10)
        }
        .background(theme.color(\.surfaceInset))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func color(for line: String) -> Color {
        guard isDiff else { return theme.color(\.textSecondary) }
        if line.hasPrefix("+") { return theme.color(\.diffAddedFg) }
        if line.hasPrefix("-") { return theme.color(\.diffRemovedFg) }
        if line.hasPrefix("@@") { return theme.color(\.diffGutter) }
        return theme.color(\.diffContext)
    }
}
