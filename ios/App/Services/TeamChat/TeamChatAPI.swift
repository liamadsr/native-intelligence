//
//  TeamChatAPI.swift
//  Native Intelligence
//
//  The web app's team chat routes (/api/account/team-chat/*), the same ones
//  the web page calls, so the rules live in one place: who may read and post,
//  mentions and the agent's turn, a send's replay by its client id, files
//  checked against storage, notifications. Auth is the Supabase access token
//  as a Bearer, and the workspace as x-workspace-id, like CaptureAPIService.
//  The base URL is the chat's (EveChatAPI.appBaseURL: localhost:3000 in a
//  Development build, NI_API_BASE_URL to reach another).
//

import Foundation

enum TeamChatAPIError: LocalizedError {
    case notSignedIn
    case noWorkspace
    case http(status: Int, message: String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in again to use team chat."
        case .noWorkspace: return "Still loading your workspace — try again in a moment."
        case let .http(_, message): return message
        case .badResponse: return "Team chat answered with something unexpected."
        }
    }

    /// A refusal the same send would get again (bad input, not allowed): not worth a retry.
    var isFinal: Bool {
        if case let .http(status, _) = self { return (400..<500).contains(status) && status != 408 && status != 429 }
        return false
    }
}

final class TeamChatAPI {
    static let shared = TeamChatAPI()

    private let session: URLSession
    private let baseURL: URL
    private let decoder = JSONDecoder()

    init(baseURL: URL = EveChatAPI.appBaseURL) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        session = URLSession(configuration: config)
        self.baseURL = baseURL
    }

    // MARK: Channels

    func channels() async throws -> TeamChatChannelsResponse {
        try await get("/api/account/team-chat/channels")
    }

    func createChannel(name: String, topic: String?) async throws -> String {
        struct Out: Decodable { let id: String }
        var body: [String: Any] = ["name": name]
        if let topic, !topic.isEmpty { body["topic"] = topic }
        let out: Out = try await send("POST", "/api/account/team-chat/channels", body)
        return out.id.lowercased()
    }

    func openDM(memberId: String) async throws -> String {
        struct Out: Decodable { let id: String }
        let out: Out = try await send("POST", "/api/account/team-chat/dm", ["memberId": memberId])
        return out.id.lowercased()
    }

    func setNotify(channelId: String, level: TeamChatNotifyLevel?) async throws -> TeamChatNotifyLevel {
        struct Out: Decodable { let notify: TeamChatNotifyLevel }
        let out: Out = try await send("POST", "/api/account/team-chat/channels/\(channelId)/notify", ["level": level?.rawValue ?? NSNull()])
        return out.notify
    }

    func markRead(channelId: String) async throws {
        let _: Ok = try await send("POST", "/api/account/team-chat/channels/\(channelId)/read", [:])
    }

    func markThreadRead(rootId: String) async throws {
        let _: Ok = try await send("POST", "/api/account/team-chat/threads/\(rootId)/read", [:])
    }

    // MARK: Messages

    /// The newest page; `before` an older one; `around` the page around one of the channel's own messages.
    func messages(channelId: String, before: String? = nil, around: String? = nil) async throws -> TeamChatMessagesResponse {
        var query: [URLQueryItem] = []
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        if let around { query.append(URLQueryItem(name: "around", value: around)) }
        return try await get("/api/account/team-chat/channels/\(channelId)/messages", query: query)
    }

    func thread(channelId: String, rootId: String) async throws -> TeamChatMessagesResponse {
        try await get("/api/account/team-chat/channels/\(channelId)/messages", query: [URLQueryItem(name: "thread", value: rootId)])
    }

    /// One message and its thread's root: where a push or a link opens.
    func message(id: String) async throws -> TeamChatOneMessageResponse {
        try await get("/api/account/team-chat/messages/\(id)")
    }

    /// Post as the person. A retry with the same client id answers with the row the first try made.
    func post(_ send: TeamChatPendingSend) async throws -> TeamChatMessage {
        var body: [String: Any] = [
            "body": send.body,
            "mentions": send.mentions,
            "clientId": send.clientId,
        ]
        if send.mentionsAgent { body["mentionsAgent"] = true }
        if let thread = send.threadRootId { body["thread"] = thread }
        if !send.attachments.isEmpty {
            body["attachments"] = send.attachments.map { a -> [String: Any] in
                var out: [String: Any] = ["path": a.path, "name": a.name, "size": a.size, "type": a.type]
                if let w = a.width, let h = a.height { out["width"] = w; out["height"] = h }
                return out
            }
        }
        let out: TeamChatPostResponse = try await self.send("POST", "/api/account/team-chat/channels/\(send.channelId)/messages", body)
        return out.message
    }

    func edit(messageId: String, body: String, mentions: [String]) async throws -> TeamChatMessage {
        struct Out: Decodable { let message: TeamChatMessage }
        let out: Out = try await send("PATCH", "/api/account/team-chat/messages/\(messageId)", ["body": body, "mentions": mentions])
        return out.message
    }

    func delete(messageId: String) async throws {
        let _: Ok = try await send("DELETE", "/api/account/team-chat/messages/\(messageId)", nil)
    }

    func react(messageId: String, emoji: String, on: Bool) async throws -> Bool {
        struct Out: Decodable { let on: Bool }
        let out: Out = try await send("POST", "/api/account/team-chat/messages/\(messageId)/reactions", ["emoji": emoji, "on": on])
        return out.on
    }

    // MARK: Plumbing

    private struct Ok: Decodable {}

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send("GET", path, nil, query: query)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]?, query: [URLQueryItem] = []) async throws -> T {
        var attempt = 0
        while true {
            var request = try await makeRequest(method, path, body, query: query)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw TeamChatAPIError.badResponse }
            if http.statusCode == 401, attempt == 0 {
                // A token that ran out while the app slept: refresh once and ask again.
                attempt += 1
                _ = try? await SupabaseManager.shared.client.auth.refreshSession()
                continue
            }
            guard (200...299).contains(http.statusCode) else {
                throw TeamChatAPIError.http(status: http.statusCode, message: Self.message(from: data) ?? "Team chat couldn’t do that (\(http.statusCode)).")
            }
            if T.self == Ok.self { return Ok() as! T }
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                print("❌ TeamChatAPI: \(method) \(path) decode failed: \(error)")
                throw TeamChatAPIError.badResponse
            }
        }
    }

    private func makeRequest(_ method: String, _ path: String, _ body: [String: Any]?, query: [URLQueryItem]) async throws -> URLRequest {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw TeamChatAPIError.badResponse
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw TeamChatAPIError.badResponse }
        guard let token = await AIProxyConfig.getAccessToken() else { throw TeamChatAPIError.notSignedIn }
        guard let workspaceId = await MainActor.run(body: { WorkspaceService.shared.workspaceId }) else { throw TeamChatAPIError.noWorkspace }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(workspaceId.uuidString.lowercased(), forHTTPHeaderField: "x-workspace-id")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private static func message(from data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
    }
}
