import Foundation
import UserNotifications

public final class NotificationEngine: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    public static let shared = NotificationEngine()

    public static let categoryApproval = "CMUX_ACTION_APPROVAL"
    public static let actionApprove = "ACTION_APPROVE"
    public static let actionAlways = "ACTION_ALWAYS"
    public static let actionDeny = "ACTION_DENY"
    public static let actionReply = "ACTION_REPLY"

    public var onActionReceived: (@Sendable (String, String, String?, String?) async -> Void)?

    private override init() {
        super.init()
    }

    public func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let approveAction = UNNotificationAction(
            identifier: Self.actionApprove,
            title: "Approve (1)",
            options: [.foreground]
        )

        let alwaysAction = UNNotificationAction(
            identifier: Self.actionAlways,
            title: "Always Allow (2)",
            options: [.foreground]
        )

        let denyAction = UNNotificationAction(
            identifier: Self.actionDeny,
            title: "Deny (Esc)",
            options: [.destructive]
        )

        let replyAction = UNTextInputNotificationAction(
            identifier: Self.actionReply,
            title: "Reply...",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Type prompt or command..."
        )

        let approvalCategory = UNNotificationCategory(
            identifier: Self.categoryApproval,
            actions: [approveAction, alwaysAction, denyAction, replyAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        center.setNotificationCategories([approvalCategory])
    }

    public func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            return false
        }
    }

    public func postAttentionNotification(
        surface: SurfaceItem,
        workspaceTitle: String
    ) async {
        let content = UNMutableNotificationContent()
        content.title = "\(surface.agentKind.displayName) Needs Approval"
        content.subtitle = workspaceTitle
        content.body = surface.detectedPrompt?.title ?? "Interactive tool call awaiting your input."
        content.sound = .default
        content.categoryIdentifier = Self.categoryApproval
        content.userInfo = [
            "workspaceId": surface.workspaceId ?? "",
            "surfaceId": surface.id,
            "agentKind": surface.agentKind.rawValue
        ]

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let request = UNNotificationRequest(
            identifier: "cmux_attention_\(surface.id)",
            content: content,
            trigger: trigger
        )

        try? await UNUserNotificationCenter.current().add(request)
    }

    // MARK: - UNUserNotificationCenterDelegate

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound, .badge]
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard let workspaceId = userInfo["workspaceId"] as? String,
              let surfaceId = userInfo["surfaceId"] as? String else {
            return
        }

        let actionId = response.actionIdentifier
        var textReply: String? = nil

        if let textResp = response as? UNTextInputNotificationResponse {
            textReply = textResp.userText
        }

        if let handler = onActionReceived {
            await handler(actionId, surfaceId, workspaceId, textReply)
            return
        }

        // Default handling via OrbitApiClient
        let client = OrbitApiClient.shared
        switch actionId {
        case Self.actionApprove:
            try? await client.approvePrompt(workspaceId: workspaceId, surfaceId: surfaceId, optionIndex: 1)
        case Self.actionAlways:
            try? await client.approvePrompt(workspaceId: workspaceId, surfaceId: surfaceId, optionIndex: 2)
        case Self.actionDeny:
            try? await client.sendKey(workspaceId: workspaceId, surfaceId: surfaceId, key: "Escape")
        case Self.actionReply:
            if let text = textReply, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try? await client.sendPrompt(workspaceId: workspaceId, surfaceId: surfaceId, text: text)
            }
        default:
            break
        }
    }
}
