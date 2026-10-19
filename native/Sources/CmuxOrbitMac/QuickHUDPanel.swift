#if os(macOS)
import AppKit
import SwiftUI
import CmuxCore

@MainActor
public final class QuickHUDPanel: NSPanel {
    public static let shared = QuickHUDPanel()

    private init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 440),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        self.level = .floating
        self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        self.titleVisibility = .hidden
        self.titlebarAppearsTransparent = true
        self.isMovableByWindowBackground = true
        self.isOpaque = false
        self.backgroundColor = .clear
        self.hasShadow = true

        let hostingView = NSHostingView(rootView: QuickHUDView(onDismiss: { [weak self] in
            self?.hideHUD()
        }))
        self.contentView = hostingView
    }

    public override var canBecomeKey: Bool {
        return true
    }

    public override var canBecomeMain: Bool {
        return true
    }

    public func toggle() {
        if isVisible {
            hideHUD()
        } else {
            showHUD()
        }
    }

    public func showHUD() {
        center()
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func hideHUD() {
        orderOut(nil)
    }
}

@MainActor
public final class GlobalHotkeyManager {
    public static let shared = GlobalHotkeyManager()

    private var localMonitor: Any?
    private var globalMonitor: Any?

    private init() {}

    public func setup() {
        // Monitor local keydown for Cmd+Shift+O
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.modifierFlags.contains([.command, .shift]) && event.charactersIgnoringModifiers?.lowercased() == "o" {
                QuickHUDPanel.shared.toggle()
                return nil
            }
            return event
        }

        // Monitor global keydown when app is in background
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            if event.modifierFlags.contains([.command, .shift]) && event.charactersIgnoringModifiers?.lowercased() == "o" {
                Task { @MainActor in
                    QuickHUDPanel.shared.toggle()
                }
            }
        }
    }
}
#endif
