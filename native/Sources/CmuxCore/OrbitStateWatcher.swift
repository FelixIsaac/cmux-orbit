import Foundation
import Observation

@Observable
public final class OrbitStateWatcher: @unchecked Sendable {
    public static let shared = OrbitStateWatcher()

    public var snapshot: DashboardSnapshot = DashboardSnapshot()
    public var isConnected: Bool = false
    public var lastError: String? = nil
    public var isPolling: Bool = false
    public var selectedWorkspaceId: String? = nil
    public var selectedSurfaceId: String? = nil

    private var pollTask: Task<Void, Never>?
    private var previouslyPendingSurfaceIds: Set<String> = []

    public init() {}

    public var needsInputSurfaces: [(workspace: WorkspaceItem, surface: SurfaceItem)] {
        var results: [(workspace: WorkspaceItem, surface: SurfaceItem)] = []
        for ws in snapshot.workspaces {
            for surf in ws.surfaces {
                if surf.state == .needsInput || surf.hasHumanObligation {
                    results.append((workspace: ws, surface: surf))
                }
            }
        }
        return results
    }

    public var runningSurfaces: [(workspace: WorkspaceItem, surface: SurfaceItem)] {
        var results: [(workspace: WorkspaceItem, surface: SurfaceItem)] = []
        for ws in snapshot.workspaces {
            for surf in ws.surfaces {
                if surf.state == .running {
                    results.append((workspace: ws, surface: surf))
                }
            }
        }
        return results
    }

    public var totalAttentionCount: Int {
        return needsInputSurfaces.count
    }

    public func startPolling(intervalSeconds: TimeInterval = 1.0) {
        guard pollTask == nil else { return }
        isPolling = true

        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds * 1_000_000_000))
            }
        }
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
    }

    public func refresh() async {
        do {
            let newSnapshot = try await OrbitApiClient.shared.fetchDashboard()
            await MainActor.run {
                self.snapshot = newSnapshot
                self.isConnected = newSnapshot.cmuxConnected
                self.lastError = nil

                // Auto-select first workspace if none selected
                if self.selectedWorkspaceId == nil, let first = newSnapshot.workspaces.first {
                    self.selectedWorkspaceId = first.id
                    self.selectedSurfaceId = first.surfaces.first?.id
                }

                self.checkForNewAttentionPrompts(newSnapshot)
            }
        } catch {
            await MainActor.run {
                self.isConnected = false
                self.lastError = error.localizedDescription
            }
        }
    }

    private func checkForNewAttentionPrompts(_ snapshot: DashboardSnapshot) {
        var currentPendingIds = Set<String>()
        for ws in snapshot.workspaces {
            for surf in ws.surfaces {
                if surf.state == .needsInput || surf.hasHumanObligation {
                    currentPendingIds.insert(surf.id)
                    if !previouslyPendingSurfaceIds.contains(surf.id) {
                        // New prompt requiring user input!
                        Task {
                            await NotificationEngine.shared.postAttentionNotification(
                                surface: surf,
                                workspaceTitle: ws.title
                            )
                        }
                    }
                }
            }
        }
        previouslyPendingSurfaceIds = currentPendingIds
    }

    public func approvePrompt(workspaceId: String, surfaceId: String, optionIndex: Int = 1) async {
        try? await OrbitApiClient.shared.approvePrompt(workspaceId: workspaceId, surfaceId: surfaceId, optionIndex: optionIndex)
        await refresh()
    }

    public func denyPrompt(workspaceId: String, surfaceId: String) async {
        try? await OrbitApiClient.shared.sendKey(workspaceId: workspaceId, surfaceId: surfaceId, key: "Escape")
        await refresh()
    }

    public func sendPrompt(workspaceId: String, surfaceId: String, text: String) async {
        try? await OrbitApiClient.shared.sendPrompt(workspaceId: workspaceId, surfaceId: surfaceId, text: text)
        await refresh()
    }
}
