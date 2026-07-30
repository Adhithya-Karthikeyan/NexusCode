import SwiftUI
import NexusKit

/// A modal review of one pending tool-call approval: the tool, its permission
/// tier, its arguments, and — for a file write — the exact diff. A user cannot
/// consent to something they cannot see, so nothing here is summarized away.
///
/// This view is a pure seam: it takes a `PendingApproval` and two callbacks. The
/// caller (wiring `ApprovalsController` into the conversation surface) decides
/// how it's presented (`.sheet`, an inline banner, …) and what `onAllow`/
/// `onDeny` actually do (call `ApprovalsController.allow`/`deny` and send the
/// resulting `ApprovalDecision.controlLine` to the live `PersistentSession`).
public struct ApprovalSheet: View {
    @Environment(\.nexusTheme) private var theme
    let approval: PendingApproval
    let onAllow: () -> Void
    let onDeny: () -> Void

    public init(approval: PendingApproval, onAllow: @escaping () -> Void, onDeny: @escaping () -> Void) {
        self.approval = approval
        self.onAllow = onAllow
        self.onDeny = onDeny
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(theme.color(\.chromeDivider))
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    detailCard
                    if let diff = approval.diff {
                        labeledBlock("Diff") { CodeBlock(text: diff, isDiff: true) }
                    } else if let input = approval.input {
                        labeledBlock("Arguments") { CodeBlock(text: prettyPrinted(input)) }
                    }
                }
                .padding(Space.xl)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 480, idealWidth: 560, minHeight: 320, idealHeight: 440)
        .background(theme.color(\.surfaceRaised))
        // The action bar is an always-visible inset, not a VStack sibling — a
        // long argument dump or diff must never be able to push Allow/Deny out
        // of the window (see `apps/nexus-mac`'s layout rules).
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actionBar
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: Space.md) {
            ZStack {
                Circle().fill(permissionColor.opacity(0.14))
                Image(systemName: permissionIcon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(permissionColor)
            }
            .frame(width: 34, height: 34)

            VStack(alignment: .leading, spacing: 2) {
                Text(approval.toolName)
                    .textStyle(Type.title)
                    .foregroundStyle(theme.color(\.textPrimary))
                Text("wants to \(actionVerb)")
                    .textStyle(Type.caption)
                    .foregroundStyle(theme.color(\.textMuted))
            }
            Spacer(minLength: 0)
            CountPill(text: approval.permission.uppercased(), tone: permissionTone)
        }
        .padding(Space.xl)
    }

    // MARK: - Detail

    private var detailCard: some View {
        Card(fill: true) {
            VStack(alignment: .leading, spacing: Space.sm) {
                metaRow("Mode", approval.mode)
                metaRow("Reason", approval.reason.isEmpty ? "—" : approval.reason)
                metaRow("Lane", approval.lane)
            }
        }
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Text(label.uppercased())
                .textStyle(Type.micro)
                .tracking(0.5)
                .foregroundStyle(theme.color(\.textMuted))
                .frame(width: 60, alignment: .leading)
            Text(value)
                .textStyle(Type.body)
                .foregroundStyle(theme.color(\.textSecondary))
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func labeledBlock(_ label: String, @ViewBuilder _ block: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label.uppercased())
                .textStyle(Type.micro)
                .tracking(0.5)
                .foregroundStyle(theme.color(\.textMuted))
            block()
        }
    }

    // MARK: - Action bar

    private var actionBar: some View {
        VStack(spacing: 0) {
            Rectangle().fill(theme.color(\.chromeDivider)).frame(height: 1)
            HStack(spacing: Space.md) {
                Text("This blocks the conversation until you answer.")
                    .textStyle(Type.caption)
                    .foregroundStyle(theme.color(\.textMuted))
                    .lineLimit(2)
                Spacer(minLength: 0)
                Button("Deny", role: .destructive, action: onDeny)
                    .buttonStyle(SoftButton(tone: .danger))
                Button("Allow", action: onAllow)
                    .buttonStyle(SoftButton(tone: .accent))
                    .keyboardShortcut(.defaultAction)
            }
            .padding(Space.lg)
        }
        .background(theme.color(\.surfaceSunken))
    }

    // MARK: - Permission-tier presentation

    private var actionVerb: String {
        switch approval.permission {
        case "write": return "write a file"
        case "exec": return "run a command"
        case "network": return "make a network call"
        default: return "act"
        }
    }

    private var permissionIcon: String {
        switch approval.permission {
        case "write": return "pencil"
        case "exec": return "terminal"
        case "network": return "network"
        default: return "eye"
        }
    }

    private var permissionColor: Color {
        switch approval.permission {
        case "write": return theme.color(\.warningFg)
        case "exec": return theme.color(\.errorFg)
        case "network": return theme.color(\.accentDefault)
        default: return theme.color(\.successFg)
        }
    }

    private var permissionTone: CountPill.Tone {
        switch approval.permission {
        case "write": return .warning
        case "exec": return .danger
        case "network": return .accent
        default: return .neutral
        }
    }

    private func prettyPrinted(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else {
            return value.inlineDescription
        }
        return text
    }
}
