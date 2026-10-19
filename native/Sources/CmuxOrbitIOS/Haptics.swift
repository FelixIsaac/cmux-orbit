import Foundation

#if canImport(UIKit)
import UIKit
#endif

public enum HapticImpactStyle: Sendable {
    case light
    case medium
    case heavy
    case rigid
    case soft
}

public enum HapticNotificationType: Sendable {
    case success
    case warning
    case error
}

@MainActor
public enum Haptics {
    public static func selection() {
        #if os(iOS)
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
        #endif
    }

    public static func impact(_ style: HapticImpactStyle = .medium) {
        #if os(iOS)
        let uistyle: UIImpactFeedbackGenerator.FeedbackStyle
        switch style {
        case .light: uistyle = .light
        case .medium: uistyle = .medium
        case .heavy: uistyle = .heavy
        case .rigid: uistyle = .rigid
        case .soft: uistyle = .soft
        }
        let generator = UIImpactFeedbackGenerator(style: uistyle)
        generator.prepare()
        generator.impactOccurred()
        #endif
    }

    public static func notify(_ type: HapticNotificationType) {
        #if os(iOS)
        let uitype: UINotificationFeedbackGenerator.FeedbackType
        switch type {
        case .success: uitype = .success
        case .warning: uitype = .warning
        case .error: uitype = .error
        }
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(uitype)
        #endif
    }
}
