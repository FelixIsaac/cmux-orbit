#if os(iOS)
import Foundation
import SwiftUI
import CmuxCore

#if canImport(ActivityKit)
import ActivityKit
#endif

#if canImport(WidgetKit)
import WidgetKit
#endif

#if canImport(ActivityKit)
public struct AgentActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var agentState: String
        public var turnSnippet: String
        public var pendingPromptTitle: String?
        public var durationSeconds: Int
        public var costString: String?

        public init(
            agentState: String,
            turnSnippet: String,
            pendingPromptTitle: String? = nil,
            durationSeconds: Int = 0,
            costString: String? = nil
        ) {
            self.agentState = agentState
            self.turnSnippet = turnSnippet
            self.pendingPromptTitle = pendingPromptTitle
            self.durationSeconds = durationSeconds
            self.costString = costString
        }
    }

    public var workspaceId: String
    public var workspaceTitle: String
    public var agentKind: String

    public init(workspaceId: String, workspaceTitle: String, agentKind: String) {
        self.workspaceId = workspaceId
        self.workspaceTitle = workspaceTitle
        self.agentKind = agentKind
    }
}

#if canImport(WidgetKit)
public struct AgentLiveActivityWidget: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            // Lock Screen Live Activity Banner
            LockScreenLiveActivityView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded Dynamic Island
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 4) {
                        Image(systemName: agentIcon(for: context.attributes.agentKind))
                            .foregroundColor(.accentColor)
                        Text(context.attributes.workspaceTitle)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.agentState.uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor(for: context.state.agentState).opacity(0.2))
                        .foregroundColor(statusColor(for: context.state.agentState))
                        .clipShape(Capsule())
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let prompt = context.state.pendingPromptTitle {
                            Text(prompt)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(.primary)
                                .lineLimit(2)
                        } else {
                            Text(context.state.turnSnippet)
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                                .lineLimit(2)
                        }

                        HStack {
                            if let cost = context.state.costString {
                                Text(cost)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            Text("\(context.state.durationSeconds)s")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.secondary)
                        }
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                Image(systemName: agentIcon(for: context.attributes.agentKind))
                    .foregroundColor(.accentColor)
            } compactTrailing: {
                Circle()
                    .fill(statusColor(for: context.state.agentState))
                    .frame(width: 8, height: 8)
            } minimal: {
                Circle()
                    .fill(statusColor(for: context.state.agentState))
                    .frame(width: 8, height: 8)
            }
        }
    }
}

private struct LockScreenLiveActivityView: View {
    let context: ActivityViewContext<AgentActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: agentIcon(for: context.attributes.agentKind))
                    .foregroundColor(.accentColor)
                    .font(.system(size: 14, weight: .semibold))

                Text(context.attributes.workspaceTitle)
                    .font(.system(size: 14, weight: .semibold))

                Spacer()

                Text(context.state.agentState.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.system(size: 11, weight: .medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(statusColor(for: context.state.agentState).opacity(0.18))
                    .foregroundColor(statusColor(for: context.state.agentState))
                    .clipShape(Capsule())
            }

            if let prompt = context.state.pendingPromptTitle {
                Text(prompt)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(2)
            } else {
                Text(context.state.turnSnippet)
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }

            HStack {
                if let cost = context.state.costString {
                    Label(cost, systemImage: "creditcard")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.secondary)
                }

                Spacer()

                Text("Elapsed: \(context.state.durationSeconds)s")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)
            }
        }
        .padding(14)
        .background(.ultraThinMaterial)
    }
}
#endif

private func agentIcon(for kind: String) -> String {
    switch kind {
    case "claude": return "sparkles"
    case "grok": return "bolt.fill"
    case "codex": return "cpu"
    case "pi": return "number"
    case "antigravity": return "atom"
    default: return "terminal.fill"
    }
}

private func statusColor(for state: String) -> Color {
    switch state {
    case "needs_input": return .orange
    case "running": return .blue
    case "unread": return .purple
    default: return .green
    }
}
#endif
#endif
