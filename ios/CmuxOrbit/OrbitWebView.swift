import SwiftUI
import WebKit
import UserNotifications

struct OrbitWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: UUID
    @Binding var isLoading: Bool
    @Binding var loadError: String?
    var onOpenHostSettings: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(context.coordinator, name: "orbitNative")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        let obsidian = UIColor(red: 9/255, green: 10/255, blue: 15/255, alpha: 1.0)
        webView.backgroundColor = obsidian
        webView.scrollView.backgroundColor = obsidian
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false

        context.coordinator.webView = webView
        context.coordinator.lastLoadedURL = url
        context.coordinator.lastReloadToken = reloadToken
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8.0))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastLoadedURL != url || context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastLoadedURL = url
            context.coordinator.lastReloadToken = reloadToken
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8.0))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: OrbitWebView
        weak var webView: WKWebView?
        var lastLoadedURL: URL?
        var lastReloadToken: UUID?

        private let lightHaptic = UIImpactFeedbackGenerator(style: .light)
        private let mediumHaptic = UIImpactFeedbackGenerator(style: .medium)
        private let notifyHaptic = UINotificationFeedbackGenerator()

        init(parent: OrbitWebView) {
            self.parent = parent
            super.init()
            lightHaptic.prepare()
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "orbitNative",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            if type == "haptic" {
                let style = (body["style"] as? String) ?? "light"
                DispatchQueue.main.async {
                    switch style {
                    case "medium":
                        self.mediumHaptic.impactOccurred()
                    case "success":
                        self.notifyHaptic.notificationOccurred(.success)
                    case "warning":
                        self.notifyHaptic.notificationOccurred(.warning)
                    default:
                        self.lightHaptic.impactOccurred()
                    }
                }
            } else if type == "host_settings" {
                DispatchQueue.main.async {
                    self.parent.onOpenHostSettings()
                }
            } else if type == "notify" {
                let title = (body["title"] as? String) ?? "cmux Orbit"
                let text = (body["body"] as? String) ?? "An agent surface needs your input."
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = text
                content.sound = .default
                let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
                UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = true
                self.parent.loadError = nil
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.loadError = nil
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.loadError = error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.loadError = error.localizedDescription
            }
        }
    }
}
