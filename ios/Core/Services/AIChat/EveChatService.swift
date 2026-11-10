import Foundation

/// All native agent traffic uses the same authenticated Eve mount as the web.
/// No provider key or internal signing secret is present in the client.
final class EveChatAPI {
    static let shared = EveChatAPI()
    static var appBaseURL: URL {
        #if DEBUG
        // TODO(rename-compat): DIAL8_API_BASE_URL is the name an Xcode scheme set up before the rename uses.
        let environment = ProcessInfo.processInfo.environment
        if let override = environment["NI_API_BASE_URL"] ?? environment["DIAL8_API_BASE_URL"], let url = URL(string: override) { return url }
        return URL(string: "http://localhost:3000")!
        #else
        return URL(string: "https://nativeintelligence.dev")!
        #endif
    }

    let session: URLSession
    let baseURL: URL
    private let accessToken: () async throws -> String
    private let refreshToken: () async throws -> Void

    init(baseURL: URL = EveChatAPI.appBaseURL, session: URLSession? = nil,
         accessToken: @escaping () async throws -> String = {
             guard let token = await AIProxyConfig.getAccessToken() else { throw AIBackendError.notAuthenticated }
             return token
         }, refreshToken: @escaping () async throws -> Void = {
             _ = try await SupabaseManager.shared.client.auth.refreshSession()
         }) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 3600
        self.session = session ?? URLSession(configuration: config)
        self.accessToken = accessToken
        self.refreshToken = refreshToken
    }

    /// Bind every request to the account that opened the conversation. A sign
    /// out/in during a suspended send must never carry old chat text as a new user.
    func scoped(to owner: UUID) -> EveChatAPI {
        EveChatAPI(baseURL: baseURL, session: session, accessToken: {
            let auth = try await SupabaseManager.shared.client.auth.session
            guard auth.user.id == owner else { throw AIBackendError.notAuthenticated }
            return auth.accessToken
        }, refreshToken: {
            let current = try await SupabaseManager.shared.client.auth.session
            guard current.user.id == owner else { throw AIBackendError.notAuthenticated }
            _ = try await SupabaseManager.shared.client.auth.refreshSession()
        })
    }

    func refreshCredentials() async throws { try await refreshToken() }

    func request(_ path: String, method: String = "POST", body: [String: Any]? = nil,
                 workspaceID: UUID, headers: [String: String] = [:]) async throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw AIBackendError.invalidURL(path) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        request.setValue(workspaceID.uuidString.lowercased(), forHTTPHeaderField: "x-workspace-id")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    func json(_ path: String, method: String = "POST", body: [String: Any]? = nil,
              workspaceID: UUID, headers: [String: String] = [:]) async throws -> [String: Any] {
        let request = try await request(path, method: method, body: body, workspaceID: workspaceID, headers: headers)
        let (data, response) = try await session.data(for: request)
        try Self.validate(response, data: data)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AIBackendError.invalidResponse }
        return object
    }

    static func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let http = response as? HTTPURLResponse else { throw AIBackendError.invalidResponse }
        guard (200...299).contains(http.statusCode) else {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw EveHTTPError(status: http.statusCode, code: body?["code"] as? String,
                message: body?["error"] as? String ?? (http.statusCode == 401 ? "Please sign in again." : "The agent request failed (\(http.statusCode))."))
        }
    }
}

enum EveChatEvent {
    case conversation(UUID)
    case accepted
    case updated(EveTurnProjection)
    case finished(EveTurnProjection)
    case warning(String)
}

/// One instance per conversation. It holds only routing/stream state; Eve owns
/// model history, tools, approvals and billing. A dropped GET resumes its cursor;
/// it never re-POSTs an accepted user message.
actor EveChatSession {
    private let api: EveChatAPI
    private(set) var conversationID: UUID?
    private let workspaceID: UUID
    private let teammateID: UUID?
    private let agentID: UUID?
    private var sessionID: String?
    private var cursor = 0
    private var projection = EveTurnProjection()
    private var runToken = ""
    private var turnContext: [String: Any] = [:]
    private var openingMessage: [String: Any]?
    private var busy = false
    private var stopRequested = false
    private var cancelSent = false
    private var pendingDeliveryID: String?
    private var awaitingBoundary = false
    private var uncertainSubmission: (previousTurn: String?, text: String?, requestIDs: [String])?

    init(conversationID: UUID? = nil, workspaceID: UUID, teammateID: UUID? = nil, agentID: UUID? = nil, ownerID: UUID? = nil, api: EveChatAPI = .shared) {
        self.conversationID = conversationID
        self.workspaceID = workspaceID
        self.teammateID = teammateID
        self.agentID = agentID
        self.api = ownerID.map { api.scoped(to: $0) } ?? api
    }

    nonisolated func send(parts: [[String: Any]], messageID: String = UUID().uuidString.lowercased(), context: [String: Any] = [:], historyPrimer: String? = nil) -> AsyncThrowingStream<EveChatEvent, Error> {
        stream { continuation in try await self.run(parts: parts, messageID: messageID, context: context, historyPrimer: historyPrimer, responses: nil, continuation: continuation) }
    }

    nonisolated func respond(_ responses: [[String: Any]]) -> AsyncThrowingStream<EveChatEvent, Error> {
        stream { continuation in try await self.run(parts: [], messageID: "", context: nil, historyPrimer: nil, responses: responses, continuation: continuation) }
    }

    private nonisolated func stream(_ operation: @escaping (AsyncThrowingStream<EveChatEvent, Error>.Continuation) async throws -> Void) -> AsyncThrowingStream<EveChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do { try await operation(continuation); continuation.finish() }
                catch { continuation.finish(throwing: error) }
            }
            // Detaching the UI cancels the GET only. Stop explicitly cancels the
            // observed turn, so a late cancellation cannot stop a subsequent one.
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Reattach without resending a user message after a lost connection.
    nonisolated func reconnect() -> AsyncThrowingStream<EveChatEvent, Error> {
        stream { continuation in try await self.resume(continuation) }
    }

    private func resume(_ continuation: AsyncThrowingStream<EveChatEvent, Error>.Continuation) async throws {
        guard !busy, sessionID != nil else { return }
        busy = true
        defer { busy = false }
        continuation.yield(.accepted)
        var settled = false
        if let uncertain = uncertainSubmission, let sessionID {
            let messageID = projection.messageID
            let snapshot = try await restore(sessionID: sessionID)
            projection.messageID = messageID
            let confirmed: Bool
            if let text = uncertain.text {
                confirmed = projection.turnID != nil && projection.turnID != uncertain.previousTurn
                    && projection.userText?.hasSuffix(text) == true
            } else {
                confirmed = uncertain.requestIDs.allSatisfy { id in !projection.requests.contains { $0.id == id } }
            }
            guard confirmed else {
                awaitingBoundary = true
                throw AIBackendError.serverError("Delivery is still unconfirmed. Reconnect again before sending another message.")
            }
            uncertainSubmission = nil
            settled = !snapshot.running
            continuation.yield(.updated(projection))
        }
        if !settled { try await consume(deliveryID: pendingDeliveryID, turnDeliveries: projection.deliveryIDs, continuation: continuation) }
        awaitingBoundary = false
        pendingDeliveryID = nil
        if projection.requests.isEmpty {
            do {
                // Reattaching is a read and must still show the reply if the
                // account has since reached its usage limit. Mint only for save.
                if runToken.isEmpty { _ = try await mint() }
                try await persist()
            }
            catch { continuation.yield(.warning("Your reply arrived, but chat history could not be saved. Keep this chat open and try again later.")) }
        }
        continuation.yield(.finished(projection))
        if let failure = projection.failure { throw AIBackendError.serverError(failure) }
    }

    /// Bounded replay up to the server's durable tail. This restores questions
    /// and approvals after relaunch without running a model or using a run token.
    func restore(sessionID id: String) async throws -> (turn: EveTurnProjection, running: Bool) {
        sessionID = id
        cursor = 0
        projection = EveTurnProjection()
        let request = try await api.request(sessionPath + "/stream?includeTailIndex=1", method: "GET", workspaceID: workspaceID)
        let (bytes, response) = try await api.session.bytes(for: request)
        try EveChatAPI.validate(response)
        guard let http = response as? HTTPURLResponse,
              let tail = http.value(forHTTPHeaderField: "x-eve-stream-tail-index").flatMap(Int.init),
              let version = http.value(forHTTPHeaderField: "x-eve-stream-version").flatMap(Int.init), EveTurnProjection.supportedStreamVersions.contains(version) else { throw AIBackendError.invalidResponse }
        var settled = true
        var paused = false
        if tail >= 0 {
            for try await line in bytes.lines {
                try Task.checkCancellation()
                guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                guard let data = line.data(using: .utf8), let event = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = event["type"] as? String else { throw AIBackendError.invalidResponse }
                cursor += 1
                if type == "turn.started" { projection = EveTurnProjection(); settled = false; paused = false }
                projection.consume(event, version: version)
                if ["session.waiting", "session.completed", "session.failed"].contains(type) {
                    settled = true; paused = false
                } else if EveTurnProjection.pausesForPerson(event, requestsOpen: !projection.requests.isEmpty) {
                    // v26: a question or sign-in pauses the turn instead of ending it.
                    settled = true; paused = true
                } else if paused && (type == "step.started" || (type == "input.resolved" && projection.requests.isEmpty)) {
                    // Answered: the same turn resumes (no new `turn.started` in v26).
                    settled = false; paused = false
                }
                if cursor > tail { break }
            }
            guard cursor > tail else { throw AIBackendError.serverError("Could not restore the complete agent state. Try opening the chat again.") }
        }
        awaitingBoundary = !settled
        return (projection, !settled)
    }

    private func mint() async throws -> [String: Any] {
        var body: [String: Any] = ["action": "mint", "wantHistory": true]
        if let conversationID { body["conversationId"] = conversationID.uuidString.lowercased() }
        if let teammateID { body["teammateId"] = teammateID.uuidString.lowercased() }
        if let agentID { body["agentId"] = agentID.uuidString.lowercased() }
        let result = try await api.json("/api/account/chat/eve-session", body: body, workspaceID: workspaceID)
        guard let token = result["token"] as? String, let id = (result["conversationId"] as? String).flatMap(UUID.init(uuidString:)) else { throw AIBackendError.invalidResponse }
        if let resolved = result["workspaceId"] as? String, resolved.lowercased() != workspaceID.uuidString.lowercased() { throw AIBackendError.serverError("The agent moved to another workspace. Select it again.") }
        conversationID = id
        runToken = token
        if sessionID == nil { sessionID = result["eveSessionId"] as? String }
        return result
    }

    private func headers() throws -> [String: String] {
        let data = try JSONSerialization.data(withJSONObject: turnContext)
        let context = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return ["x-chat-run-token": runToken, "x-chat-run-ctx": context]
    }

    private var sessionPath: String {
        "/eve/chat-agent/v1/session/" + (sessionID ?? "").addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")))!
    }

    private func createAndRegister() async throws {
        // Prewarm without a message, then register before ANY stream/send. A
        // failed registration cannot strand model work on an inaccessible run.
        let created = try await api.json("/eve/chat-agent/v1/session", workspaceID: workspaceID, headers: headers())
        guard let id = created["sessionId"] as? String, let conversationID else { throw AIBackendError.invalidResponse }
        _ = try await api.json("/api/account/chat/eve-session", body: ["action": "register", "conversationId": conversationID.uuidString.lowercased(), "sessionId": id], workspaceID: workspaceID)
        sessionID = id
        cursor = 0
    }

    private func dispatch(_ body: [String: Any]) async throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(20)
        var delay: UInt64 = 250_000_000
        while true {
            do { return try await api.json(sessionPath, body: body, workspaceID: workspaceID, headers: headers()) }
            catch let error as EveHTTPError where error.code == "session_not_ready" && Date() < deadline {
                try await Task.sleep(nanoseconds: delay)
                delay = min(delay * 2, 2_000_000_000)
            }
        }
    }

    private func run(parts: [[String: Any]], messageID: String, context: [String: Any]?, historyPrimer: String?, responses: [[String: Any]]?, continuation: AsyncThrowingStream<EveChatEvent, Error>.Continuation) async throws {
        guard !busy else { throw AIBackendError.serverError("Wait for the current reply to finish.") }
        guard !awaitingBoundary else { throw AIBackendError.serverError("Reconnect to the current reply before sending another message.") }
        busy = true
        defer { busy = false }
        stopRequested = false
        cancelSent = false
        let previousTurnID = projection.turnID
        if let context { turnContext = context }
        if responses == nil {
            projection = EveTurnProjection()
            openingMessage = ["messageId": messageID, "parts": parts]
        }
        var mintResult: [String: Any]
        do { mintResult = try await mint() }
        catch let error as EveHTTPError where error.isAuthenticationError {
            try await api.refreshCredentials()
            mintResult = try await mint()
        }
        if let conversationID { continuation.yield(.conversation(conversationID)) }
        let primer = historyPrimer ?? mintResult["historyPrimer"] as? String
        var created = sessionID == nil
        if created { try await createAndRegister() }
        func body(newSession: Bool) -> [String: Any] {
            if let responses {
                var payload: [String: Any] = ["inputResponses": responses]
                let answers = responses.compactMap { response -> String? in
                    guard let text = response["text"] as? String, !text.isEmpty else { return nil }
                    let prompt = projection.requests.first { $0.id == response["requestId"] as? String }?.prompt ?? "Agent question"
                    return "\(prompt)\nUser answer: \(text)"
                }.joined(separator: "\n\n")
                if !answers.isEmpty { payload["clientContext"] = answers }
                return payload
            }
            var message = parts.map { part -> [String: Any] in
                if part["type"] as? String == "file" {
                    return ["type": "file", "data": part["url"] ?? "", "mediaType": part["mediaType"] ?? "application/octet-stream"]
                }
                return part
            }
            if newSession, let primer, !primer.isEmpty { message.insert(["type": "text", "text": primer], at: 0) }
            return ["message": message, "turnPolicy": "queue"]
        }
        try Task.checkCancellation()
        if stopRequested {
            projection.cancelled = true
            continuation.yield(.finished(projection))
            return
        }
        func submit() async throws -> [String: Any] {
            do { return try await dispatch(body(newSession: created)) }
            catch let error as EveHTTPError where error.isAuthenticationError {
                try await api.refreshCredentials()
                _ = try await mint()
                return try await dispatch(body(newSession: created))
            } catch let error as EveHTTPError where error.isRetiredSession && responses == nil {
                sessionID = nil
                try await createAndRegister()
                created = true
                return try await dispatch(body(newSession: true))
            }
        }
        let accepted: [String: Any]
        do { accepted = try await submit() }
        catch {
            // A failed acknowledgement can still mean the server accepted the
            // turn. Reconcile against durable events; never retry that POST.
            if error is URLError || (error as? EveHTTPError).map({ $0.status >= 500 }) == true {
                uncertainSubmission = (previousTurnID,
                    responses == nil ? parts.compactMap { $0["text"] as? String }.joined(separator: "\n") : nil,
                    responses?.compactMap { $0["requestId"] as? String } ?? [])
                awaitingBoundary = true
                pendingDeliveryID = nil
                continuation.yield(.accepted)
                throw AIBackendError.serverError("The connection dropped before delivery was confirmed. Reconnect to check the agent’s reply without sending twice.")
            }
            throw error
        }
        guard accepted["sessionId"] as? String == sessionID else { throw AIBackendError.invalidResponse }
        let deliveryID = accepted["deliveryId"] as? String
        if responses == nil && deliveryID == nil { throw AIBackendError.serverError("The chat server must be updated to support this app.") }
        awaitingBoundary = true
        pendingDeliveryID = deliveryID
        continuation.yield(.accepted)
        if let openingMessage, responses == nil {
            do {
                _ = try await api.json("/api/account/chat/eve-persist", body: ["messageId": openingMessage["messageId"]!, "parts": openingMessage["parts"]!, "role": "user"], workspaceID: workspaceID, headers: headers())
            } catch { continuation.yield(.warning("Your message was accepted, but saving it is delayed. Keep this chat open while the agent replies.")) }
        }
        if let responses { projection.requests.removeAll { request in responses.contains { $0["requestId"] as? String == request.id } } }
        // An answer resumes the parked turn (v26), so its events may carry the
        // turn's original delivery ids instead of the answer's.
        try await consume(deliveryID: deliveryID, turnDeliveries: responses == nil ? [] : projection.deliveryIDs, continuation: continuation)
        awaitingBoundary = false
        pendingDeliveryID = nil
        if projection.requests.isEmpty {
            do { try await persist() }
            catch { continuation.yield(.warning("Your reply arrived, but chat history could not be saved. Keep this chat open and try again later.")) }
        }
        continuation.yield(.finished(projection))
        if let failure = projection.failure { throw AIBackendError.serverError(failure) }
    }

    private func consume(deliveryID: String?, turnDeliveries: Set<String> = [], continuation: AsyncThrowingStream<EveChatEvent, Error>.Continuation) async throws {
        var claimed = deliveryID == nil || projection.turnID != nil
        var reconnects = 0
        while true {
            try Task.checkCancellation()
            do {
                let request = try await api.request(sessionPath + "/stream?startIndex=\(cursor)", method: "GET", workspaceID: workspaceID, headers: headers())
                let (bytes, response) = try await api.session.bytes(for: request)
                try EveChatAPI.validate(response)
                guard let http = response as? HTTPURLResponse,
                      let version = http.value(forHTTPHeaderField: "x-eve-stream-version").flatMap(Int.init), EveTurnProjection.supportedStreamVersions.contains(version) else {
                    throw AIBackendError.serverError("Unsupported Eve stream version. Update the app and server together.")
                }
                for try await line in bytes.lines {
                    try Task.checkCancellation()
                    guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    guard let data = line.data(using: .utf8), let event = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = event["type"] as? String else { throw AIBackendError.invalidResponse }
                    cursor += 1
                    let meta = event["meta"] as? [String: Any] ?? [:]
                    let deliveries = meta["deliveryIds"] as? [String]
                    if let deliveryID {
                        let ours = deliveries.map { $0.contains(deliveryID) || !turnDeliveries.isDisjoint(with: $0) } ?? false
                        let matches = deliveries?.contains(deliveryID) == true
                        if ["session.failed", "session.completed"].contains(type) && !claimed && !matches { throw AIBackendError.serverError("The agent session ended before it could answer. Open the chat again.") }
                        if !claimed && !matches { continue }
                        if deliveries != nil, !ours, !type.hasPrefix("session.") { continue }
                        claimed = true
                    }
                    projection.consume(event, version: version)
                    continuation.yield(.updated(projection))
                    if stopRequested { try await cancelObservedTurn() }
                    if ["session.waiting", "session.completed", "session.failed"].contains(type) { return }
                    // v26: stop where the turn waits on the person, not where it waits on its tasks.
                    if EveTurnProjection.pausesForPerson(event, requestsOpen: !projection.requests.isEmpty) { return }
                }
            } catch let error as EveHTTPError where error.isAuthenticationError && reconnects < 3 {
                try await api.refreshCredentials()
            } catch let error as EveHTTPError where [404, 409, 425, 500, 502, 503, 504].contains(error.status) && reconnects < 3 {
                // The durable stream may not be available immediately after send.
            } catch let error as URLError where reconnects < 3 && error.code != .cancelled {
                // Only retry the read, from the next unread event.
            }
            reconnects += 1
            guard reconnects <= 3 else { throw AIBackendError.serverError("Connection interrupted. The agent may still be working; reopen this conversation to reconnect.") }
            try await Task.sleep(nanoseconds: UInt64(reconnects) * 500_000_000)
        }
    }

    func stop() async throws {
        stopRequested = true
        try await cancelObservedTurn()
    }

    private func cancelObservedTurn() async throws {
        guard !cancelSent, let turnID = projection.turnID, sessionID != nil else { return }
        _ = try await api.json(sessionPath + "/cancel", body: ["turnId": turnID], workspaceID: workspaceID)
        cancelSent = true
    }

    func retrySave() async throws {
        _ = try await mint()
        try await persist()
    }

    private func persist() async throws {
        guard !projection.parts.isEmpty || openingMessage != nil else { return }
        var body: [String: Any] = ["messageId": projection.messageID, "parts": projection.parts]
        if let openingMessage { body["userMessage"] = openingMessage }
        _ = try await api.json("/api/account/chat/eve-persist", body: body, workspaceID: workspaceID, headers: headers())
        openingMessage = nil
    }
}
