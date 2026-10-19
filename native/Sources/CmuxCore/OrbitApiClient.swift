import Foundation

public actor OrbitApiClient {
    public static let shared = OrbitApiClient()

    public var baseURLString: String = "http://127.0.0.1:4400"

    public init(baseURLString: String = "http://127.0.0.1:4400") {
        self.baseURLString = baseURLString
    }

    public func setBaseURL(_ url: String) {
        self.baseURLString = url
    }

    public func fetchDashboard() async throws -> DashboardSnapshot {
        guard let url = URL(string: "\(baseURLString)/api/dashboard") else {
            throw URLError(.badURL)
        }

        var req = URLRequest(url: url)
        req.timeoutInterval = 6.0
        req.setValue("1", forHTTPHeaderField: "x-orbit-request")

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }

        struct DashboardResp: Codable {
            let ok: Bool
            let data: DashboardSnapshot?
            let error: String?
        }

        let decoded = try JSONDecoder().decode(DashboardResp.self, from: data)
        guard decoded.ok, let snapshot = decoded.data else {
            throw NSError(domain: "OrbitApi", code: 500, userInfo: [NSLocalizedDescriptionKey: decoded.error ?? "Failed to fetch dashboard"])
        }
        return snapshot
    }

    public func executeAction(action: String, workspaceId: String, surfaceId: String, text: String? = nil, key: String? = nil) async throws {
        guard let url = URL(string: "\(baseURLString)/api/action") else {
            throw URLError(.badURL)
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 8.0
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-orbit-request")

        var body: [String: Any] = [
            "action": action,
            "workspaceId": workspaceId,
            "surfaceId": surfaceId
        ]
        if let text = text { body["text"] = text; body["submit"] = true }
        if let key = key { body["key"] = key }

        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }

    public func sendPrompt(workspaceId: String, surfaceId: String, text: String) async throws {
        try await executeAction(action: "send_prompt", workspaceId: workspaceId, surfaceId: surfaceId, text: text)
    }

    public func approvePrompt(workspaceId: String, surfaceId: String, optionIndex: Int) async throws {
        try await executeAction(action: "answer_prompt", workspaceId: workspaceId, surfaceId: surfaceId, text: "\(optionIndex)")
    }

    public func sendKey(workspaceId: String, surfaceId: String, key: String) async throws {
        try await executeAction(action: "send_key", workspaceId: workspaceId, surfaceId: surfaceId, key: key)
    }
}
