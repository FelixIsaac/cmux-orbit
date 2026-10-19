#if os(macOS)
import SwiftUI
import AppKit
import CmuxCore

@main
struct CmuxOrbitMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Bindable var watcher = OrbitStateWatcher.shared

    var body: some Scene {
        MenuBarExtra {
            MenuBarView()
        } label: {
            let attention = watcher.totalAttentionCount
            let isRunning = watcher.snapshot.runningCount > 0

            HStack(spacing: 3) {
                if attention > 0 {
                    Image(systemName: "bell.badge.fill")
                    Text("\(attention)")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                } else if isRunning {
                    Image(systemName: "bolt.fill")
                } else {
                    Image(systemName: "terminal.fill")
                }
            }
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Run as accessory application (lives in menu bar, floating HUD overlay)
        NSApp.setActivationPolicy(.accessory)

        // Setup notification engine
        NotificationEngine.shared.configure()
        Task {
            _ = await NotificationEngine.shared.requestAuthorization()
        }

        // Setup global hotkey for Quick HUD overlay (Cmd+Shift+O)
        GlobalHotkeyManager.shared.setup()

        // Start watcher polling
        OrbitStateWatcher.shared.startPolling(intervalSeconds: 1.0)
    }

    func applicationWillTerminate(_ notification: Notification) {
        OrbitStateWatcher.shared.stopPolling()
    }
}
#endif
