#if os(macOS)
import SwiftUI
import CmuxCore

public struct QuickHUDView: View {
    @Bindable var watcher = OrbitStateWatcher.shared
    var onDismiss: () -> Void

    @State private var searchText: String = ""
    @State private var quickPromptText: String = ""
    @State private var selectedWorkspaceId: String? = nil
    @State private var selectedSurfaceId: String? = nil
    @State private var isSendingPrompt: Bool = false

    public init(onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
    }

    public var filteredWorkspaces: [WorkspaceItem] {
        if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return watcher.snapshot.workspaces
        }
        let query = searchText.lowercased()
        return watcher.snapshot.workspaces.filter { ws in
            ws.title.lowercased().contains(query) ||
            (ws.cwd?.lowercased().contains(query) ?? false) ||
            ws.surfaces.contains { surf in
                surf.title.lowercased().contains(query) ||
                surf.agentKind.displayName.lowercased().contains(query)
            }
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Search & Command Bar
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.secondary)

                TextField("Search workspaces, agents, or type a command...", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15, weight: .regular))
                    .onSubmit {
                        if !searchText.isEmpty {
                            handleSearchSubmit()
                        }
                    }

                if !searchText.isEmpty {
                    Button(action: { searchText = "" }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                HStack(spacing: 4) {
                    Text("esc")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.2))
                        .cornerRadius(4)
                    Text("to close")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Color.primary.opacity(0.04))

            Divider()

            // Main Content Area
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Attention Section
                    let attentionItems = watcher.needsInputSurfaces
                    if !attentionItems.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Label("Needs Your Input", systemImage: "bell.badge.fill")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(.orange)
                                Spacer()
                                Text("\(attentionItems.count) pending")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundColor(.secondary)
                            }

                            ForEach(attentionItems, id: \.surface.id) { item in
                                AttentionPromptCard(
                                    workspace: item.workspace,
                                    surface: item.surface,
                                    onApprove: {
                                        Task {
                                            await watcher.approvePrompt(workspaceId: item.workspace.id, surfaceId: item.surface.id, optionIndex: 1)
                                        }
                                    },
                                    onAlways: {
                                        Task {
                                            await watcher.approvePrompt(workspaceId: item.workspace.id, surfaceId: item.surface.id, optionIndex: 2)
                                        }
                                    },
                                    onDeny: {
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

                    // Workspaces Section
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Workspaces")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(.secondary)
                            Spacer()
                            Text("\(filteredWorkspaces.count) active")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, attentionItems.isEmpty ? 12 : 4)

                        LazyVStack(spacing: 4) {
                            ForEach(filteredWorkspaces) { ws in
                                WorkspaceRow(
                                    workspace: ws,
                                    isSelected: selectedWorkspaceId == ws.id,
                                    onSelect: {
                                        selectedWorkspaceId = ws.id
                                        selectedSurfaceId = ws.surfaces.first?.id
                                    }
                                )
                            }
                        }
                        .padding(.horizontal, 8)
                    }
                }
                .padding(.bottom, 12)
            }
            .frame(maxHeight: 280)

            Divider()

            // Quick Prompt Bar
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .foregroundColor(.accentColor)
                    .font(.system(size: 14))

                TextField("Prompt to selected agent...", text: $quickPromptText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .onSubmit {
                        submitQuickPrompt()
                    }

                Button(action: submitQuickPrompt) {
                    HStack(spacing: 4) {
                        Text("Send")
                            .font(.system(size: 12, weight: .medium))
                        Image(systemName: "arrow.up.circle.fill")
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(quickPromptText.isEmpty ? Color.secondary.opacity(0.2) : Color.accentColor)
                    .foregroundColor(.white)
                    .cornerRadius(6)
                }
                .buttonStyle(.plain)
                .disabled(quickPromptText.isEmpty || isSendingPrompt)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color.primary.opacity(0.02))
        }
        .frame(width: 680, height: 440)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.white.opacity(0.12), lineWidth: 1)
        )
        .onAppear {
            if selectedWorkspaceId == nil, let first = watcher.snapshot.workspaces.first {
                selectedWorkspaceId = first.id
                selectedSurfaceId = first.surfaces.first?.id
            }
        }
    }

    private func handleSearchSubmit() {
        if let firstMatch = filteredWorkspaces.first {
            selectedWorkspaceId = firstMatch.id
            selectedSurfaceId = firstMatch.surfaces.first?.id
        }
    }

    private func submitQuickPrompt() {
        guard !quickPromptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let wsId = selectedWorkspaceId ?? watcher.snapshot.workspaces.first?.id,
              let surfId = selectedSurfaceId ?? watcher.snapshot.workspaces.first?.surfaces.first?.id else {
            return
        }

        let promptToSend = quickPromptText
        quickPromptText = ""
        isSendingPrompt = true

        Task {
            await watcher.sendPrompt(workspaceId: wsId, surfaceId: surfId, text: promptToSend)
            isSendingPrompt = false
            onDismiss()
        }
    }
}

private struct AttentionPromptCard: View {
    let workspace: WorkspaceItem
    let surface: SurfaceItem
    let onApprove: () -> Void
    let onAlways: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: surface.agentKind.systemIcon)
                    .foregroundColor(.accentColor)
                    .font(.system(size: 13, weight: .semibold))

                Text(workspace.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.primary)

                Text("•")
                    .foregroundColor(.secondary)

                Text(surface.agentKind.displayName)
                    .font(.system(size: 11, weight: .medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.15))
                    .cornerRadius(4)

                Spacer()

                Circle()
                    .fill(Color.orange)
                    .frame(width: 8, height: 8)
            }

            Text(surface.detectedPrompt?.title ?? "Action required: Permission requested by agent.")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .lineLimit(2)

            HStack(spacing: 8) {
                Button(action: onApprove) {
                    HStack(spacing: 4) {
                        Text("1")
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .padding(.horizontal, 4)
                            .background(Color.white.opacity(0.2))
                            .cornerRadius(3)
                        Text("Approve")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.green.opacity(0.85))
                    .foregroundColor(.white)
                    .cornerRadius(6)
                }
                .buttonStyle(.plain)

                Button(action: onAlways) {
                    HStack(spacing: 4) {
                        Text("2")
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .padding(.horizontal, 4)
                            .background(Color.white.opacity(0.2))
                            .cornerRadius(3)
                        Text("Always Allow")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.blue.opacity(0.85))
                    .foregroundColor(.white)
                    .cornerRadius(6)
                }
                .buttonStyle(.plain)

                Button(action: onDeny) {
                    Text("Deny (Esc)")
                        .font(.system(size: 11, weight: .medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.red.opacity(0.2))
                        .foregroundColor(.red)
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)

                Spacer()
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.08))
        .cornerRadius(10)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.orange.opacity(0.3), lineWidth: 1)
        )
    }
}

private struct WorkspaceRow: View {
    let workspace: WorkspaceItem
    let isSelected: Bool
    let onSelect: () -> Void

    var primarySurface: SurfaceItem? {
        workspace.surfaces.first
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Circle()
                    .fill(statusColor(for: workspace.state))
                    .frame(width: 8, height: 8)

                if let agentKind = primarySurface?.agentKind {
                    Image(systemName: agentKind.systemIcon)
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .frame(width: 16)
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(workspace.title)
                            .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                            .foregroundColor(.primary)

                        if workspace.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 9))
                                .foregroundColor(.secondary)
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

                if workspace.surfaces.count > 1 {
                    Text("\(workspace.surfaces.count) surfaces")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }

                if workspace.unreadCount > 0 {
                    Text("\(workspace.unreadCount)")
                        .font(.system(size: 10, weight: .bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
            .cornerRadius(8)
            .contentShape(Rectangle())
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
#endif
