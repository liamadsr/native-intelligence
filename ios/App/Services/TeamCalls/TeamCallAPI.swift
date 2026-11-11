//
//  TeamCallAPI.swift
//  Native Intelligence
//
//  The web app's team call routes (/api/account/team-calls/*), the same ones
//  the web page calls: whether calling is on, start or join a call, ring
//  people, answer a ring, a fresh join, hang up. A join (the LiveKit address
//  and a ten-minute token) only ever comes from here, as the person: never
//  from a push. Auth is the Supabase access token as a Bearer; the routes
//  read the person's own workspace for each call, so a call from another
//  workspace (a ring while the phone shows a different one) works too.
//

import Foundation

enum TeamCallAPIError: LocalizedError, Equatable {
    case notSignedIn
    case unavailable
    case ended
    case unreachable
    case http(status: Int, message: String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in again to call."
        case .unavailable: return "Calls aren’t available."
        case .ended: return "This call has ended."
        case .unreachable: return "The call server couldn’t be reached. Try again."
        case let .http(_, message): return message
        case .badResponse: return "The call answered with something unexpected."
        }
    }
}

/// A call the person may join, with its join.
struct TeamCallJoined: Decodable {
    let call: TeamCallPlace
    let join: TeamCallJoin
}

/// An answer to a ring: how it was settled, and the join when accepted.
struct TeamCallAnswer: Decodable {
    let state: TeamCallRingState
    let join: TeamCallJoin?
    let call: TeamCallPlace?
    /// Settled before this answer (accepted on another device): no join here.
    let elsewhere: Bool?
}

final class TeamCallAPI {
    static let shared = TeamCallAPI()

    private let session: URLSession
    private let baseURL: URL
    private let decoder = JSONDecoder()

    init(baseURL: URL = EveChatAPI.appBaseURL) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config)
        self.baseURL = baseURL
    }

    /// Whether calling is on here (the LiveKit settings set on the server), and the person's rings still open.
    func availability() async throws -> (available: Bool, rings: [TeamCallRing]) {
        struct Out: Decodable {
            let available: Bool
            let rings: [TeamCallRing]?
        }
        let out: Out = try await send("GET", "/api/account/team-calls", nil)
        return (out.available, out.rings ?? [])
    }

    /// Start a call in a conversation, or join the one live there.
    func start(channelId: String) async throws -> TeamCallJoined {
        try await send("POST", "/api/account/team-calls", ["channelId": channelId])
    }

    /// A fresh join for a live call (a call's Join, a rejoin after the connection was lost for good).
    /// `noticeSeen`: the person was told the call takes notes or is recorded and went on (the server
    /// lets them talk only then; without it they join listening).
    func join(callId: String, noticeSeen: Bool = false) async throws -> TeamCallJoined {
        try await send("POST", "/api/account/team-calls/\(callId)/token", noticeSeen ? ["noticeSeen": true] : [:])
    }

    /// The call's row as the person may read it (RLS), for its notes and recording; nil when unread.
    func callRow(_ callId: String) async -> TeamCall? {
        try? await SupabaseManager.shared.client.from("team_call").select("*").eq("id", value: callId).single().execute().value
    }

    /// Answer the person's own ring, only if it still rings (a ring another device accepted answers
    /// `elsewhere`, never a join under the same identity). `voipToken`: this phone's (no cancel for it).
    func answer(ringId: String, accept: Bool, voipToken: String?) async throws -> TeamCallAnswer {
        var body: [String: Any] = ["accept": accept, "onlyIfRinging": true]
        if let voipToken { body["voipToken"] = voipToken }
        return try await send("POST", "/api/account/team-calls/rings/\(ringId)", body)
    }

    /// Ring people into the call.
    func ring(callId: String, memberIds: [String]) async throws -> Int {
        struct Out: Decodable {
            struct Made: Decodable { let memberId: String; let state: String }
            let rings: [Made]
        }
        let out: Out = try await send("POST", "/api/account/team-calls/\(callId)/ring", ["memberIds": memberIds])
        return out.rings.count
    }

    /// Hung up (a DM's call ends at once).
    func leave(callId: String) async {
        struct Out: Decodable { let ended: Bool? }
        let _: Out? = try? await send("POST", "/api/account/team-calls/\(callId)/leave", [:])
    }

    // MARK: Plumbing

    private func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]?) async throws -> T {
        var attempt = 0
        while true {
            guard let token = await AIProxyConfig.getAccessToken() else { throw TeamCallAPIError.notSignedIn }
            var request = URLRequest(url: baseURL.appendingPathComponent(path))
            request.httpMethod = method
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let workspaceId = await MainActor.run(body: { WorkspaceService.shared.workspaceId }) {
                request.setValue(workspaceId.uuidString.lowercased(), forHTTPHeaderField: "x-workspace-id")
            }
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response): (Data, URLResponse)
            do {
                (data, response) = try await session.data(for: request)
            } catch {
                throw TeamCallAPIError.unreachable
            }
            guard let http = response as? HTTPURLResponse else { throw TeamCallAPIError.badResponse }
            if http.statusCode == 401, attempt == 0 {
                // A token that ran out while the app slept (a push woke it): refresh once and ask again.
                attempt += 1
                _ = try? await SupabaseManager.shared.client.auth.refreshSession()
                continue
            }
            guard (200...299).contains(http.statusCode) else {
                let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                switch json?["code"] as? String {
                case "CALLS_NOT_AVAILABLE": throw TeamCallAPIError.unavailable
                case "CALL_ENDED": throw TeamCallAPIError.ended
                case "CALLS_UNREACHABLE": throw TeamCallAPIError.unreachable
                default:
                    throw TeamCallAPIError.http(status: http.statusCode, message: json?["error"] as? String ?? "The call couldn’t do that (\(http.statusCode)).")
                }
            }
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                print("❌ TeamCallAPI: \(method) \(path) decode failed: \(error)")
                throw TeamCallAPIError.badResponse
            }
        }
    }
}
