//
//  AIBackendService.swift
//  dial8
//
//  HTTP client for Eve chat and Next.js indexing/search routes.
//  All AI calls go through the website backend,
//  which runs Eve agents, tool execution, and usage logging server-side.
//
//  Adapts the shared Eve session transport to legacy native chat consumers.
//

import Foundation

// MARK: - Streaming Types

struct AgentResponse {
    let text: String
    let toolUses: [ToolUse]
}

struct ToolUse {
    let name: String
    let input: [String: Any]
}

enum AgentStreamEvent {
    case textChunk(String)
    case thinkingChunk(String)
    case toolStarting(ToolUse)
    case toolUse(ToolUse)
    case completed(AgentResponse)
    case error(Error)
}

// MARK: - AIBackendService

class AIBackendService {
    static let shared = AIBackendService()

    /// Base URL for the AI backend (Next.js API routes)
    private var baseURL: String {
        #if DEBUG
        return "http://localhost:3000"
        #else
        return "https://dial8.ai"
        #endif
    }

    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 90 // slightly above Vercel's 60s limit
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }

    // MARK: - Chat (Eve)

    /// Adapter for existing native callers. Eve owns the conversation after the
    /// first send; only the newest user message is submitted on later turns.
    func sendMessageStreaming(
        messages: [[String: Any]],
        model: String? = nil,
        systemContext: [String: Any]? = nil,
        conversationKey: UUID? = nil
    ) -> AsyncThrowingStream<AgentStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let last = messages.last(where: { $0["role"] as? String == "user" }),
                          let parts = last["parts"] as? [[String: Any]] else { throw AIBackendError.invalidResponse }
                    let (workspace, owner) = await MainActor.run { (WorkspaceService.shared.workspaceId, SupabaseManager.shared.currentUser?.id) }
                    guard let workspace, let owner else { throw AIBackendError.notAuthenticated }
                    let key = "\(owner):\(workspace):\(conversationKey?.uuidString ?? messages.first?["id"] as? String ?? UUID().uuidString)"
                    let session = await NativeEveSessions.shared.session(key: key, workspace: workspace, owner: owner)
                    var context: [String: Any] = [:]
                    if let model, model != "auto" { context["model"] = model }
                    if let systemContext { context["systemContext"] = systemContext }
                    let history = messages.dropLast().suffix(40).map { message in
                        let text = (message["parts"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
                        return "\(message["role"] as? String ?? "user"): \(text)"
                    }.joined(separator: "\n")
                    var previousText = ""
                    var previousReasoning = ""
                    var started = Set<String>()
                    var finished = Set<String>()
                    for try await event in session.send(parts: parts, messageID: last["id"] as? String ?? UUID().uuidString,
                                                        context: context, historyPrimer: history.isEmpty ? nil : String(history.suffix(24000))) {
                        switch event {
                        case .updated(let turn):
                            if turn.text.hasPrefix(previousText) {
                                let delta = String(turn.text.dropFirst(previousText.count))
                                if !delta.isEmpty { continuation.yield(.textChunk(delta)) }
                            }
                            previousText = turn.text
                            if turn.reasoning.hasPrefix(previousReasoning) {
                                let delta = String(turn.reasoning.dropFirst(previousReasoning.count))
                                if !delta.isEmpty { continuation.yield(.thinkingChunk(delta)) }
                            }
                            previousReasoning = turn.reasoning
                            for tool in turn.tools {
                                let use = ToolUse(name: tool.name, input: tool.input)
                                if started.insert(tool.id).inserted { continuation.yield(.toolStarting(use)) }
                                if tool.finished && finished.insert(tool.id).inserted { continuation.yield(.toolUse(use)) }
                            }
                        case .finished(let turn):
                            if !turn.requests.isEmpty {
                                throw AIBackendError.serverError("This agent needs your input. Open the conversation in Dial8 chat to answer it.")
                            }
                            if let failure = turn.failure { throw AIBackendError.serverError(failure) }
                            continuation.yield(.completed(AgentResponse(text: turn.text, toolUses: turn.tools.map { ToolUse(name: $0.name, input: $0.input) })))
                        case .warning(let warning): continuation.yield(.error(AIBackendError.serverError(warning)))
                        case .conversation, .accepted: break
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Summarize

    /// Summarize a transcript through Eve, collecting the completed response.
    /// Returns structured JSON: title, summary, key_points, action_items, open_questions.
    func summarize(
        transcript: String,
        noteType: String = "meeting"
    ) async throws -> [String: Any] {
        let prompt = "Summarize this \(noteType) transcript. Return only a JSON object with title, summary, key_points, action_items, and open_questions.\n\n" + transcript
        let message: [String: Any] = ["id": UUID().uuidString, "role": "user", "parts": [["type": "text", "text": prompt]]]
        var text = ""
        for try await event in sendMessageStreaming(messages: [message]) {
            if case .completed(let response) = event { text = response.text }
            if case .error(let error) = event { throw error }
        }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "```json", with: "").replacingOccurrences(of: "```", with: "")
        guard let data = clean.data(using: .utf8), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AIBackendError.invalidResponse
        }
        return json
    }

    // MARK: - Private Helpers

    private func makeRequest(path: String, body: [String: Any]) async throws -> URLRequest {
        guard let url = URL(string: baseURL + path) else {
            throw AIBackendError.invalidURL(path)
        }

        guard let token = await AIProxyConfig.getAccessToken() else {
            throw AIBackendError.notAuthenticated
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Signal the window's active workspace. The route resolves workspace via
        // x-workspace-id header → cookie → first membership; without this header a
        // multi-workspace user would be silently scoped to their FIRST membership
        // rather than the one they're viewing. Matches the web client's
        // workspace-fetch.ts, which injects this on every /api request.
        if let workspaceId = await MainActor.run(body: { WorkspaceService.shared.workspaceId }) {
            // Lowercase to match the canonical (Postgres-normalized) UUID form the
            // web client sends; Swift's uuidString is uppercase.
            request.setValue(workspaceId.uuidString.lowercased(), forHTTPHeaderField: "x-workspace-id")
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        return request
    }
}

/// Cache is scoped by account + workspace + native conversation identity.
private actor NativeEveSessions {
    static let shared = NativeEveSessions()
    private var sessions: [String: EveChatSession] = [:]
    func session(key: String, workspace: UUID, owner: UUID) -> EveChatSession {
        if let session = sessions[key] { return session }
        let session = EveChatSession(workspaceID: workspace, ownerID: owner)
        sessions[key] = session
        return session
    }
}

// MARK: - Errors

enum AIBackendError: LocalizedError {
    case invalidURL(String)
    case notAuthenticated
    case usageLimitExceeded
    case httpError(statusCode: Int, message: String)
    case invalidResponse
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let path):
            return "Invalid API URL: \(path)"
        case .notAuthenticated:
            return "Sign in required to use AI features."
        case .usageLimitExceeded:
            return "AI usage limit reached. Please upgrade your plan or wait until your limit resets."
        case .httpError(let code, let message):
            return "Server error (\(code)): \(message)"
        case .invalidResponse:
            return "Invalid response from AI backend."
        case .serverError(let message):
            return "AI error: \(message)"
        }
    }
}
