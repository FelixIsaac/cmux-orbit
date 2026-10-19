#if os(macOS)
import AppKit
import Foundation
import CmuxCore

@MainActor
public final class DockBadgeController {
    public static let shared = DockBadgeController()

    private init() {}

    public func updateBadge(count: Int) {
        if count > 0 {
            NSApp.dockTile.badgeLabel = "\(count)"
        } else {
            NSApp.dockTile.badgeLabel = nil
        }
        NSApp.dockTile.display()
    }
}
#endif
