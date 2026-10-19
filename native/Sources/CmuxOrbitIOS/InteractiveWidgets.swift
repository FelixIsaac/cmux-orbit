import Foundation
import SwiftUI
import CmuxCore

#if canImport(WidgetKit)
import WidgetKit

public struct OrbitWidgetEntry: TimelineEntry {
    public let date: Date
    public let attentionCount: Int
    public let runningCount: Int
    public let primaryWorkspaceTitle: String?
    public let primaryAgentKind: String?
    public let isConnected: Bool

    public init(
        date: Date = Date(),
        attentionCount: Int = 0,
        runningCount: Int = 0,
        primaryWorkspaceTitle: String? = nil,
        primaryAgentKind: String? = nil,
        isConnected: Bool = true
    ) {
        self.date = date
        self.attentionCount = attentionCount
        self.runningCount = runningCount
        self.primaryWorkspaceTitle = primaryWorkspaceTitle
        self.primaryAgentKind = primaryAgentKind
        self.isConnected = isConnected
    }
}

public struct OrbitWidgetTimelineProvider: TimelineProvider {
    public init() {}

    public func placeholder(in context: Context) -> OrbitWidgetEntry {
        OrbitWidgetEntry(attentionCount: 1, runningCount: 2, primaryWorkspaceTitle: "Mobile Pairing", primaryAgentKind: "claude")
    }

    public func getSnapshot(in context: Context, completion: @escaping (OrbitWidgetEntry) -> Void) {
        completion(placeholder(in: context))
    }

    public func getTimeline(in context: Context, completion: @escaping (Timeline<OrbitWidgetEntry>) -> Void) {
        let entry = OrbitWidgetEntry()
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 5, to: Date())!
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }
}

public struct OrbitStatusWidget: Widget {
    public let kind: String = "OrbitStatusWidget"

    public init() {}

    public var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OrbitWidgetTimelineProvider()) { entry in
            OrbitWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("cmux Agent Status")
        .description("Track active coding agents and pending approval requests.")
        #if os(iOS)
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryInline, .accessoryRectangular])
        #else
        .supportedFamilies([.systemSmall, .systemMedium])
        #endif
    }
}

private struct OrbitWidgetEntryView: View {
    let entry: OrbitWidgetEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        #if os(iOS)
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 1) {
                    Image(systemName: entry.attentionCount > 0 ? "bell.badge.fill" : "terminal.fill")
                        .font(.system(size: 14))
                    Text("\(entry.attentionCount)")
                        .font(.system(size: 13, weight: .bold, design: .monospaced))
                }
            }
        case .accessoryInline:
            HStack {
                Image(systemName: "circle.fill")
                    .foregroundColor(entry.attentionCount > 0 ? .orange : .green)
                Text(entry.attentionCount > 0 ? "\(entry.attentionCount) Waiting" : "\(entry.runningCount) Agents Active")
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Image(systemName: "terminal.fill")
                    Text("cmux Orbit")
                        .font(.headline)
                }
                Text(entry.attentionCount > 0 ? "\(entry.attentionCount) Need Approval" : "\(entry.runningCount) Running")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        #endif
        case .systemSmall:
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "terminal.fill")
                        .foregroundColor(.accentColor)
                    Spacer()
                    Circle()
                        .fill(entry.attentionCount > 0 ? Color.orange : Color.green)
                        .frame(width: 8, height: 8)
                }

                Spacer()

                Text("\(entry.attentionCount)")
                    .font(.system(size: 32, weight: .bold, design: .monospaced))
                    .foregroundColor(entry.attentionCount > 0 ? .orange : .primary)

                Text(entry.attentionCount > 0 ? "Needs Approval" : "All Agents Idle")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.secondary)
            }
            .padding()

        case .systemMedium:
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Image(systemName: "terminal.fill")
                            .foregroundColor(.accentColor)
                        Text("cmux Orbit")
                            .font(.system(size: 13, weight: .bold))
                    }

                    Spacer()

                    Text("\(entry.attentionCount)")
                        .font(.system(size: 34, weight: .bold, design: .monospaced))
                        .foregroundColor(entry.attentionCount > 0 ? .orange : .primary)

                    Text(entry.attentionCount > 0 ? "Waiting for Approval" : "No Pending Actions")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.secondary)
                }

                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text("STATUS")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.secondary)

                    HStack {
                        Circle().fill(Color.blue).frame(width: 6, height: 6)
                        Text("Running: \(entry.runningCount)")
                            .font(.system(size: 12))
                    }

                    HStack {
                        Circle().fill(Color.orange).frame(width: 6, height: 6)
                        Text("Attention: \(entry.attentionCount)")
                            .font(.system(size: 12))
                    }

                    HStack {
                        Circle().fill(entry.isConnected ? Color.green : Color.red).frame(width: 6, height: 6)
                        Text(entry.isConnected ? "cmux Connected" : "Disconnected")
                            .font(.system(size: 12))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()

        default:
            Text("cmux Orbit")
        }
    }
}
#endif
