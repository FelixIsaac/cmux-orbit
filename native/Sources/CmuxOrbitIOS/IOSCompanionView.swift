import SwiftUI
import CmuxCore

public struct IOSCompanionView: View {
    @Bindable var watcher = OrbitStateWatcher.shared
    @State private var quickPromptText: String = ""
    @State private var selectedWorkspaceId: String? = nil
    @State private var selectedSurfaceId: String? = nil

    public init() {}

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Main Content
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // Pending Attention Hero Deck
                        let attention = watcher.needsInputSurfaces
                        if !attention.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Label("NEEDS YOUR APPROVAL", systemImage: "bell.badge.fill")
                                        .font(.system(size: 11, weight: .bold))
                                        .foregroundColor(.orange)
                                    Spacer()
                                    Text("\(attention.count)")
                                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.orange.opacity(0.2))
                                        .foregroundColor(.orange)
                                        .clipShape(Capsule())
                                }

                                ForEach(attention, id: \.surface.id) { item in
                                    IOSAttentionCard(
                                        item: item,
                                        onApprove: {
                                            Haptics.notify(.success)
                                            Task {
                                                await watcher.approvePrompt(workspaceId: item.workspace.id, surfaceId: item.surface.id, optionIndex: 1)
                                            }
                                        },
                                        onAlways: {
                                            Haptics.notify(.success)
                                            Task {
                                                await watcher.approvePrompt(workspaceId: item.workspace.id, surfaceId: item.surface.id, optionIndex: 2)
                                            }
                                        },
                                        onDeny: {
                                            Haptics.notify(.warning)
                                            Task {
                                                await watcher.denyPrompt(workspaceId: item.workspace.id, surfaceId: item.surface.id)
                                            }
                                        }
                                    )
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.top, 12)
                        }

                        // Workspaces List
                        VStack(alignment: .leading, spacing: 10) {
                            Text("WORKSPACES (\(watcher.snapshot.workspaces.count))")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.secondary)
                                .padding(.horizontal, 16)

                            LazyVStack(spacing: 8) {
                                ForEach(watcher.snapshot.workspaces) { ws in
                                    IOSWorkspaceCard(
                                        workspace: ws,
                                        isSelected: (selectedWorkspaceId ?? watcher.snapshot.workspaces.first?.id) == ws.id,
                                        onSelect: {
                                            Haptics.selection()
                                            selectedWorkspaceId = ws.id
                                            selectedSurfaceId = ws.surfaces.first?.id
                                        }
                                    )
                                }
                            }
                            .padding(.horizontal, 16)
                        }
                    }
                    .padding(.bottom, 80)
                }
                .refreshable {
                    Haptics.impact(.light)
                    await watcher.refresh()
                }

                // Bottom Floating Composer
                VStack(spacing: 0) {
                    Divider()
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles")
                            .foregroundColor(.accentColor)
                            .font(.system(size: 16))

                        TextField("Prompt to active agent...", text: $quickPromptText)
                            .font(.system(size: 15))
                            .textFieldStyle(.plain)

                        Button(action: sendPrompt) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 28))
                                .foregroundColor(quickPromptText.isEmpty ? .secondary.opacity(0.3) : .accentColor)
                        }
                        .disabled(quickPromptText.isEmpty)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial)
                }
            }
            .navigationTitle("cmux Orbit")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(watcher.isConnected ? Color.green : Color.red)
                            .frame(width: 8, height: 8)
                        Text(watcher.isConnected ? "Live" : "Offline")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                }
                #endif
            }
        }
    }

    private func sendPrompt() {
        guard !quickPromptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let wsId = selectedWorkspaceId ?? watcher.snapshot.workspaces.first?.id,
              let surfId = selectedSurfaceId ?? watcher.snapshot.workspaces.first?.surfaces.first?.id else {
            return
        }

        let prompt = quickPromptText
        quickPromptText = ""
        Haptics.impact(.medium)

        Task {
            await watcher.sendPrompt(workspaceId: wsId, surfaceId: surfId, text: prompt)
        }
    }
}

private struct IOSAttentionCard: View {
    let item: (workspace: WorkspaceItem, surface: SurfaceItem)
    let onApprove: () -> Void
    let onAlways: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: item.surface.agentKind.systemIcon)
                    .foregroundColor(.accentColor)
                    .font(.system(size: 14, weight: .bold))

                Text(item.workspace.title)
                    .font(.system(size: 14, weight: .semibold))

                Text("•")
                    .foregroundColor(.secondary)

                Text(item.surface.agentKind.displayName)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.secondary)

                Spacer()

                Circle()
                    .fill(Color.orange)
                    .frame(width: 8, height: 8)
            }

            Text(item.surface.detectedPrompt?.title ?? "Permission approval requested by agent")
                .font(.system(size: 13))
                .foregroundColor(.primary)
                .lineLimit(3)

            HStack(spacing: 8) {
                Button(action: onApprove) {
                    HStack(spacing: 4) {
                        Text("1")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .padding(.horizontal, 4)
                            .background(Color.white.opacity(0.2))
                            .cornerRadius(3)
                        Text("Approve")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(Color.green.opacity(0.85))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }

                Button(action: onAlways) {
                    HStack(spacing: 4) {
                        Text("2")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .padding(.horizontal, 4)
                            .background(Color.white.opacity(0.2))
                            .cornerRadius(3)
                        Text("Always")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(Color.blue.opacity(0.85))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }

                Button(action: onDeny) {
                    Text("Deny")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(Color.red.opacity(0.18))
                        .foregroundColor(.red)
                        .cornerRadius(8)
                }
            }
        }
        .padding(14)
        .background(Color.orange.opacity(0.08))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.orange.opacity(0.25), lineWidth: 1)
        )
    }
}

private struct IOSWorkspaceCard: View {
    let workspace: WorkspaceItem
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                Circle()
                    .fill(statusColor(for: workspace.state))
                    .frame(width: 10, height: 10)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(workspace.title)
                            .font(.system(size: 15, weight: isSelected ? .bold : .medium))
                            .foregroundColor(.primary)

                        if let agent = workspace.surfaces.first?.agentKind {
                            Text(agent.displayName)
                                .font(.system(size: 10, weight: .medium))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.secondary.opacity(0.15))
                                .cornerRadius(4)
                        }
                    }

                    if let cwd = workspace.cwd {
                        Text(cwd)
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                if workspace.unreadCount > 0 {
                    Text("\(workspace.unreadCount)")
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary.opacity(0.6))
            }
            .padding(14)
            .background(isSelected ? Color.accentColor.opacity(0.1) : Color.primary.opacity(0.03))
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? Color.accentColor.opacity(0.3) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
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
