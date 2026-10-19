import Foundation
import Network

public actor CmuxUnixSocket {
    public static let shared = CmuxUnixSocket()

    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "com.felix.cmux.socket", qos: .userInitiated)
    private var inFlightCalls: [String: CheckedContinuation<Data, Error>] = [:]
    private var isConnected: Bool = false
    private var readBuffer = Data()

    public init() {}

    public func resolveSocketPath() -> String {
        #if os(macOS)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let primary = (home as NSString).appendingPathComponent(".local/state/cmux/cmux.sock")
        if FileManager.default.fileExists(atPath: primary) {
            return primary
        }
        let fallback = (home as NSString).appendingPathComponent(".cmux/cmux.sock")
        return fallback
        #else
        return ""
        #endif
    }

    public func connect() async throws {
        #if os(macOS)
        if isConnected && connection?.state == .ready { return }

        let path = resolveSocketPath()
        guard FileManager.default.fileExists(atPath: path) else {
            throw NSError(domain: "CmuxSocket", code: 404, userInfo: [NSLocalizedDescriptionKey: "cmux.sock not found at \(path)"])
        }

        let endpoint = NWEndpoint.unix(path: path)
        let conn = NWConnection(to: endpoint, using: .tcp)
        self.connection = conn

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var resumed = false
            conn.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    Task { await self.setConnected(true) }
                    if !resumed {
                        resumed = true
                        continuation.resume()
                    }
                    Task { await self.startReading() }
                case .failed(let err):
                    Task { await self.setConnected(false) }
                    if !resumed {
                        resumed = true
                        continuation.resume(throwing: err)
                    }
                case .cancelled:
                    Task { await self.setConnected(false) }
                default:
                    break
                }
            }
            conn.start(queue: self.queue)
        }
        #else
        throw NSError(
            domain: "CmuxSocket",
            code: 405,
            userInfo: [NSLocalizedDescriptionKey: "Unix domain sockets are macOS-only. Use OrbitApiClient over network/Tailscale for iOS."]
        )
        #endif
    }

    private func setConnected(_ value: Bool) {
        self.isConnected = value
    }

    public func call<T: Decodable>(method: String, params: [String: Any] = [:]) async throws -> T {
        try await connect()

        let reqId = UUID().uuidString
        var payload: [String: Any] = [
            "id": reqId,
            "method": method,
            "params": params
        ]

        let rawData = try JSONSerialization.data(withJSONObject: payload, options: [])
        guard let lineData = String(data: rawData, encoding: .utf8)?.appending("\n").data(using: .utf8) else {
            throw NSError(domain: "CmuxSocket", code: 400, userInfo: [NSLocalizedDescriptionKey: "Failed to format request data"])
        }

        let respData = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            self.inFlightCalls[reqId] = continuation

            self.connection?.send(content: lineData, completion: .contentProcessed({ [weak self] err in
                if let err = err {
                    Task { [weak self] in
                        guard let self = self else { return }
                        await self.failCall(id: reqId, error: err)
                    }
                }
            }))
        }

        let decoder = JSONDecoder()
        return try decoder.decode(T.self, from: respData)
    }

    private func failCall(id: String, error: Error) {
        if let cont = inFlightCalls.removeValue(forKey: id) {
            cont.resume(throwing: error)
        }
    }

    private func startReading() {
        guard let conn = connection else { return }
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                Task {
                    await self.processIncomingData(data)
                }
            }
            if !isComplete && error == nil {
                Task {
                    await self.startReading()
                }
            }
        }
    }

    private func processIncomingData(_ chunk: Data) {
        readBuffer.append(chunk)

        while let nlIndex = readBuffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = readBuffer.subdata(in: 0..<nlIndex)
            readBuffer.removeSubrange(0...nlIndex)

            if lineData.isEmpty { continue }

            if let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
               let id = json["id"] as? String {
                if let cont = inFlightCalls.removeValue(forKey: id) {
                    if let result = json["result"] {
                        if let resData = try? JSONSerialization.data(withJSONObject: result) {
                            cont.resume(returning: resData)
                            continue
                        }
                    } else if let errorDict = json["error"] as? [String: Any],
                              let msg = errorDict["message"] as? String {
                        cont.resume(throwing: NSError(domain: "CmuxSocket", code: 500, userInfo: [NSLocalizedDescriptionKey: msg]))
                        continue
                    }
                    cont.resume(returning: lineData)
                }
            }
        }
    }

    public func sendPrompt(workspaceId: String, surfaceId: String, text: String) async throws {
        _ = try await call(method: "surface.send_prompt", params: [
            "surface_id": surfaceId,
            "text": text,
            "submit": true
        ]) as [String: AnyCodable]
    }

    public func sendKey(surfaceId: String, key: String) async throws {
        _ = try await call(method: "surface.send_key", params: [
            "surface_id": surfaceId,
            "key": key
        ]) as [String: AnyCodable]
    }
}

public struct AnyCodable: Codable, Sendable {
    public init(from decoder: Decoder) throws {}
    public func encode(to encoder: Encoder) throws {}
}
