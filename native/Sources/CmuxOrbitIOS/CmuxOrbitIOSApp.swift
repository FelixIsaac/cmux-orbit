#if os(iOS)
import SwiftUI
import CmuxCore

@main
public struct CmuxOrbitIOSApp: App {
    @UIApplicationDelegateAdaptor(IOSAppDelegate.self) var appDelegate
    @Bindable var watcher = OrbitStateWatcher.shared

    public init() {}

    public var body: some Scene {
        WindowGroup {
            IOSCompanionView()
        }
    }
}

final class IOSAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil
    ) -> Bool {
        NotificationEngine.shared.configure()
        Task {
            _ = await NotificationEngine.shared.requestAuthorization()
        }
        OrbitStateWatcher.shared.startPolling(intervalSeconds: 1.5)
        return true
    }
}
#endif
