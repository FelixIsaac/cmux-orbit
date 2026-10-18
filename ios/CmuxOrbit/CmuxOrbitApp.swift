import SwiftUI
import UserNotifications

@main
struct CmuxOrbitApp: App {
    init() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    var body: some Scene {
        WindowGroup {
            OrbitContainerView()
                .preferredColorScheme(.dark)
        }
    }
}
