#if os(macOS)
import SwiftUI
import AppKit
import CmuxCore

public struct MenuBarView: View {
    @Bindable var watcher = OrbitStateWatcher.shared

    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: 8) {
                Image(systemName: "circle.circle.fill")
                    .foregroundColor(watcher.isConnected ? .green : .red)
                    .font(.system(size: 10))

                VStack(alignment: .leading, spacing: 1) {
                    Text("cmux Orbit")
                        .font(.system(size: 13, weight: .semibold))
                    Text(watcher.isConnected ? "Connected to cmux" : "Connecting...")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }

                Spacer()

                Button(action: {
                    Task { await watcher.refresh() }
                }) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help("Refresh state")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.primary.opacity(0.04))

            Divider()

            // Quick Actions Bar
            HStack(spacing: 8) {
                Button(action: {
                    QuickHUDPanel.shared.toggle()
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "command")
                        Text("Summon HUD")
                        Text("⌘⇧O")
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                    .font(.system(size: 11, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Color.accentColor.opacity(0.12))
                    .foregroundColor(.accentColor)
                    .cornerRadius(6)
                }
                .buttonStyle(.plain)

                Button(action: {
                    if let url = URL(string: "http://127.0.0.1:4400") {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "globe")
                        Text("Web UI")
                    }
                    .font(.system(size: 11, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.12))
                    .foregroundColor(.primary)
                    .cornerRadius(6)
                }
                .buttonStyle(.plain)
            }
            .padding(10)

            Divider()

            // Content List
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    // Attention needed
                    let pending = watcher.needsInputSurfaces
                    if !pending.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("ATTENTION NEEDED (\(pending.count))")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.orange)

                            ForEach(pending, id: \.surface.id) { item in
                                MenuBarAttentionRow(item: item)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 8)

                        Divider()
                            .padding(.vertical, 4)
                    }

                    // Workspaces overview
                    VStack(alignment: .leading, spacing: 6) {
                        Text("WORKSPACES (\(watcher.snapshot.workspaces.count))")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.secondary)

                        ForEach(watcher.snapshot.workspaces) { ws in
                            MenuBarWorkspaceRow(workspace: ws)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                }
            }
            .frame(maxHeight: 320)

            Divider()

            // Footer
            HStack {
                Text("\(watcher.snapshot.runningCount) running • \(watcher.snapshot.totalSurfaces) surfaces")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)

                Spacer()

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                .font(.system(size: 11))
                .foregroundColor(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.primary.opacity(0.02))
        }
        .frame(width: 340)
    }
}

private struct MenuBarAttentionRow: View {
    let item: (workspace: WorkspaceItem, surface: SurfaceItem)
    @Bindable var watcher = OrbitStateWatcher.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: item.surface.agentKind.systemIcon)
                    .font(.system(size: 11))
                    .foregroundColor(.accentColor)
                Text(item.workspace.title)
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(item.surface.agentKind.displayName)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }

            Text(item.surface.detectedPrompt?.title ?? "Waiting for confirmation")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .lineLimit(2)

            HStack(spacing: 6) {
                Button(action: {
                    Task {
                        await watcher.approvePrompt(workspaceId: item.workspace.id, surfaceId: item.surface.id, optionIndex: 1)
                    }
                }) {
                    Text("Approve")
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.green.opacity(0.85))
                        .foregroundColor(.white)
                        .cornerRadius(4)
                }
                .buttonStyle(.plain)

                Button(action: {
                    Task {
                        await watcher.denyPrompt(workspaceId: item.workspace.id, surfaceId: item.surface.id)
                    }
                }) {
                    Text("Deny")
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.red.opacity(0.18))
                        .foregroundColor(.red)
                        .cornerRadius(4)
                }
                .buttonStyle(.plain)

                Spacer()
            }
        }
        .padding(8)
        .background(Color.orange.opacity(0.08))
        .cornerRadius(6)
    }
}

private struct MenuBarWorkspaceRow: View {
    let workspace: WorkspaceItem

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor(for: workspace.state))
                .frame(width: 6, height: 6)

            Text(workspace.title)
                .font(.system(size: 12))
                .lineLimit(1)

            Spacer()

            if workspace.unreadCount > 0 {
                Text("\(workspace.unreadCount)")
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Color.accentColor)
                    .foregroundColor(.white)
                    .clipShape(Capsule())
            }

            if let agentKind = workspace.surfaces.first?.agentKind {
                Image(systemName: agentKind.systemIcon)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func statusColor(for state: AgentLifecycleState) -> Color {
        switch state {
        case .needsInput: return .orange
        case .running: return .blue
        case .unread: return .purple
        case .idle: return .green
        }
    }
}
#endif
