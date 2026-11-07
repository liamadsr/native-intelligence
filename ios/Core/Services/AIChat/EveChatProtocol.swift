import Foundation

/// The public Eve NDJSON contract, independent of networking and UI.
struct EveInputRequest: Identifiable {
    struct Option: Identifiable {
        let id: String
        let label: String
        let isDestructive: Bool
    }
    let id: String
    let prompt: String
    let kind: String
    let allowsText: Bool
    let options: [Option]
    let questions: [[String: Any]]

    init?(_ json: [String: Any]) {
        guard let id = json["requestId"] as? String, let prompt = json["prompt"] as? String else { return nil }
        self.id = id
        self.prompt = prompt
        kind = json["kind"] as? String ?? "question"
        allowsText = json["allowFreeform"] as? Bool ?? false
        options = (json["options"] as? [[String: Any]] ?? []).compactMap {
            guard let id = $0["id"] as? String, let label = $0["label"] as? String else { return nil }
            return Option(id: id, label: label, isDestructive: $0["style"] as? String == "danger")
        }
        let action = json["action"] as? [String: Any]
        let input = action?["input"] as? [String: Any]
        questions = action?["toolName"] as? String == "ask_user" ? input?["questions"] as? [[String: Any]] ?? [] : []
    }
}

struct EveToolActivity: Identifiable {
    let id: String
    let name: String
    let input: [String: Any]
    var finished = false
    var failed = false
}

struct EveTurnProjection {
    var messageID = UUID().uuidString.lowercased()
    var turnID: String?
    var userText: String?
    var parts: [[String: Any]] = []
    var tools: [EveToolActivity] = []
    var requests: [EveInputRequest] = []
    var failure: String?
    var cancelled = false
    /// The accepted messages that own this turn (`meta.deliveryIds`). In v26 an
    /// answer resumes the same turn, whose events keep these ids rather than the
    /// answer's own delivery id.
    private(set) var deliveryIDs = Set<String>()
    private var blocks: [String: Int] = [:]
    /// Calls that run as tasks: their `action.result` is only a receipt.
    private var taskCallIDs = Set<String>()
    private var seenEvents = Set<String>()

    var text: String { parts.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n\n") }
    var reasoning: String { parts.filter { $0["type"] as? String == "reasoning" }.compactMap { $0["text"] as? String }.joined(separator: "\n\n") }

    /// Completed blocks replace deltas. Retries and a completed-only replay must
    /// converge on the authoritative text, without duplicating earlier steps.
    /// Stream versions this client reads. v25 made message and reasoning appends
    /// delta-only; v26 keeps that contract and adds `turn.waiting` and
    /// `task.started` / `task.settled`.
    static let supportedStreamVersions = 21...26

    /// eve's rule for where a client stops reading mid-turn (v26): a `turn.waiting`
    /// that waits on the person (`on: "input"`: a question or a sign-in), or any
    /// `turn.waiting` while a question is open. `on: "tasks"` with nothing open
    /// means the turn is still working.
    static func pausesForPerson(_ event: [String: Any], requestsOpen: Bool) -> Bool {
        guard event["type"] as? String == "turn.waiting" else { return false }
        return (event["data"] as? [String: Any])?["on"] as? String == "input" || requestsOpen
    }

    mutating func consume(_ event: [String: Any], version: Int = 26) {
        let meta = event["meta"] as? [String: Any] ?? [:]
        if let id = meta["id"] as? String, !seenEvents.insert(id).inserted { return }
        guard let type = event["type"] as? String, let data = event["data"] as? [String: Any] else { return }
        if !type.hasPrefix("session."), let ids = meta["deliveryIds"] as? [String] { deliveryIDs.formUnion(ids) }
        if let id = data["turnId"] as? String { turnID = id }
        switch type {
        case "message.received":
            if data["kind"] as? String != "execution.background_task" { userText = data["message"] as? String }
        case "message.appended", "message.completed", "reasoning.appended", "reasoning.completed":
            let isText = type.hasPrefix("message.")
            let partType = isText ? "text" : "reasoning"
            let completed = type.hasSuffix("completed")
            let field = isText ? "message" : "reasoning"
            let key = "\(partType):\(data["stepIndex"] ?? 0):\(data["sequence"] ?? 0)"
            let value = data[completed || version < 25 ? field : field + "Delta"] as? String ?? ""
            let index: Int
            if let existing = blocks[key] { index = existing }
            else { index = parts.count; blocks[key] = index; parts.append(["type": partType, "text": ""]) }
            parts[index]["text"] = completed || version < 25 ? value : (parts[index]["text"] as? String ?? "") + value
        case "actions.requested":
            for action in data["actions"] as? [[String: Any]] ?? [] {
                guard let id = action["callId"] as? String, !tools.contains(where: { $0.id == id }) else { continue }
                let name = action["toolName"] as? String ?? action["subagentName"] as? String ?? action["kind"] as? String ?? "tool"
                let input = action["input"] as? [String: Any] ?? [:]
                tools.append(EveToolActivity(id: id, name: name, input: input))
                parts.append(["type": "dynamic-tool", "toolCallId": id, "toolName": name, "state": "input-available", "input": input])
            }
        case "action.result":
            guard let result = data["result"] as? [String: Any], let id = result["callId"] as? String else { return }
            if taskCallIDs.contains(id) { return }
            let failed = result["isError"] as? Bool ?? false
            if let index = tools.firstIndex(where: { $0.id == id }) { tools[index].finished = true; tools[index].failed = failed }
            if let index = parts.firstIndex(where: { $0["toolCallId"] as? String == id }) {
                parts[index]["state"] = failed ? "output-error" : "output-available"
                if failed { parts[index]["errorText"] = String(describing: result["output"] ?? "Tool failed") }
                else { parts[index]["output"] = result["output"] ?? NSNull() }
            }
        case "task.started":
            // The call's `action.result` (before or after this) is a receipt; the
            // result comes with `task.settled`, so the call is still running.
            guard let id = data["callId"] as? String else { return }
            taskCallIDs.insert(id)
            if let index = tools.firstIndex(where: { $0.id == id }) { tools[index].finished = false; tools[index].failed = false }
            if let index = parts.firstIndex(where: { $0["toolCallId"] as? String == id }) {
                parts[index]["state"] = "input-available"
                parts[index].removeValue(forKey: "output")
                parts[index].removeValue(forKey: "errorText")
            }
        case "task.settled":
            // A tool that runs as a task answers its call with a receipt; the real
            // result arrives here, matched by callId.
            guard let id = data["callId"] as? String else { return }
            let status = data["status"] as? String ?? "completed"
            let failed = status != "completed"
            if let index = tools.firstIndex(where: { $0.id == id }) { tools[index].finished = true; tools[index].failed = failed }
            if let index = parts.firstIndex(where: { $0["toolCallId"] as? String == id }) {
                parts[index]["state"] = failed ? "output-error" : "output-available"
                if failed {
                    let error = data["error"] as? [String: Any]
                    parts[index]["errorText"] = error?["message"] as? String ?? (status == "cancelled" ? "Cancelled" : "Task failed")
                } else { parts[index]["output"] = data["output"] ?? NSNull() }
            }
        case "input.requested":
            for request in (data["requests"] as? [[String: Any]] ?? []).compactMap(EveInputRequest.init) {
                if !requests.contains(where: { $0.id == request.id }) { requests.append(request) }
            }
        case "input.resolved":
            let ids = (data["resolutions"] as? [[String: Any]] ?? []).compactMap { $0["requestId"] as? String }
            requests.removeAll { ids.contains($0.id) }
        case "turn.failed", "session.failed":
            failure = data["message"] as? String ?? "The agent could not finish this turn."
        case "turn.cancelled": cancelled = true
        default: break
        }
    }
}

struct EveHTTPError: LocalizedError {
    let status: Int
    let code: String?
    let message: String
    var errorDescription: String? { message }
    var isAuthenticationError: Bool {
        status == 401 || (status == 403 && ["session_expired", "chat_run_token_required", "session_forbidden"].contains(code ?? ""))
    }
    var isRetiredSession: Bool {
        ["session_not_found", "session_inactive", "session_completed", "session_failed", "session_not_active"].contains(code ?? "")
    }
}
