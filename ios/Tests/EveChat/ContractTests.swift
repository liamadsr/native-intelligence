import Foundation

@main struct EveContractTests {
    static let workspace = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) {
        if !value() { fatalError(message) }
    }
    static func api(_ scenario: String) -> EveChatAPI {
        EveChatAPI(baseURL: URL(string: "http://127.0.0.1:" + ProcessInfo.processInfo.environment["EVE_TEST_PORT"]!)!, accessToken: { scenario }, refreshToken: {})
    }
    static func collect(_ stream: AsyncThrowingStream<EveChatEvent, Error>) async throws -> EveTurnProjection {
        var final = EveTurnProjection()
        for try await event in stream { if case .finished(let turn) = event { final = turn } }
        return final
    }
    static func main() async throws {
        // A final authoritative block repairs partial/retried deltas, and each
        // step is independent. Replayed meta IDs never duplicate tool/text data.
        var p = EveTurnProjection()
        func event(_ type: String, _ value: [String:Any], _ id: String) -> [String:Any] {
            ["type":type,"data":value,"meta":["id":id]]
        }
        p.consume(event("message.appended", ["messageDelta":"wrong", "stepIndex":0], "a"))
        p.consume(event("message.completed", ["message":"Correct", "stepIndex":0], "b"))
        p.consume(event("message.completed", ["message":"Next step", "stepIndex":1], "c"))
        p.consume(event("message.completed", ["message":"Next step", "stepIndex":1], "c"))
        expect(p.text == "Correct\n\nNext step", "Finalized blocks must repair deltas without replay duplicates")
        var old = EveTurnProjection()
        old.consume(event("message.appended", ["message":"A"], "a"), version:24)
        old.consume(event("message.appended", ["message":"AB"], "b"), version:24)
        expect(old.text == "AB", "Older cumulative streams must not double append")

        // v26 task tools: the receipt in action.result doesn't finish the call, in either order.
        for receiptFirst in [true, false] {
            var t = EveTurnProjection()
            t.consume(event("actions.requested", ["actions":[["callId":"tool-9","toolName":"research","input":[:]]]], "t1"))
            let receipt = event("action.result", ["result":["callId":"tool-9","output":["taskId":"task-1"]]], "t2")
            let started = event("task.started", ["callId":"tool-9","taskId":"task-1"], "t3")
            for e in receiptFirst ? [receipt, started] : [started, receipt] { t.consume(e) }
            expect(t.parts.first?["state"] as? String == "input-available" && t.tools.first?.finished == false, "v26: a task call runs until task.settled")
            t.consume(event("task.settled", ["callId":"tool-9","taskId":"task-1","status":"completed","output":"Found 3 notes"], "t4"))
            expect(t.parts.first?["output"] as? String == "Found 3 notes" && t.tools.first?.finished == true, "v26: task.settled finishes the call")
        }

        for scenario in ["normal", "reconnect", "retired"] {
            print("Testing \(scenario)")
            let api = api(scenario)
            let session = EveChatSession(workspaceID:workspace, api:api)
            let result = try await collect(session.send(parts:[["type":"text","text":"Hi"]], context:["model":"kimi-k3"]))
            expect(result.text == "Hello world", "Skip earlier delivery and stream the correct reply: \(scenario)")
            let state = try await api.json("/requests", method:"GET", workspaceID:workspace)
            let requests = state["requests"] as! [[String:Any]]
            let paths = requests.map { $0["path"] as! String }
            let register = requests.firstIndex { ($0["body"] as? [String:Any])?["action"] as? String == "register" }!
            let send = paths.firstIndex(of:"/eve/chat-agent/v1/session/fixture-session")!
            expect(register < send, "Register must happen before send or stream")
            expect((state["sends"] as! Int) == (scenario == "retired" ? 2 : 1), "Reconnection must never resend a user message")
            expect(requests.allSatisfy { $0["workspace"] as? String == workspace.uuidString.lowercased() }, "Every request must be workspace scoped")
            if scenario == "reconnect" { expect(paths.contains { $0.contains("startIndex=4") }, "Reconnect must resume the next unread event") }
            let persisted = requests.last { ($0["path"] as? String)?.hasSuffix("eve-persist") == true }!["body"] as! [String:Any]
            expect(persisted["userMessage"] != nil, "Persist the user before assistant, exactly as web does")
            let userSave = requests.firstIndex { ($0["body"] as? [String:Any])?["role"] as? String == "user" }!
            let firstStream = paths.firstIndex { $0.contains("/stream?") }!
            expect(userSave < firstStream, "Save accepted user input before an approval or background detachment")
            if scenario == "normal" {
                let next = try await collect(session.send(parts:[["type":"text","text":"Follow up"]]))
                expect(next.text == "Hello world", "Follow-up must render only its own turn")
                let updated = try await api.json("/requests", method:"GET", workspaceID:workspace)
                let all = updated["requests"] as! [[String:Any]]
                expect(all.filter { $0["path"] as? String == "/eve/chat-agent/v1/session" }.count == 1, "Follow-up must reuse the durable session")
            }
        }
        let uncertainAPI = api("uncertain")
        let uncertainSession = EveChatSession(workspaceID:workspace, api:uncertainAPI)
        var uncertainAccepted = false
        do {
            for try await event in uncertainSession.send(parts:[["type":"text","text":"Hi"]]) {
                if case .accepted = event { uncertainAccepted = true }
            }
            fatalError("An uncertain acknowledgement must require reconciliation")
        } catch { expect(uncertainAccepted, "Uncertain delivery must never offer a blind resend") }
        let recovered = try await collect(uncertainSession.reconnect())
        expect(recovered.text == "Hello world", "Reconcile uncertain delivery from durable events")
        let uncertainState = try await uncertainAPI.json("/requests", method:"GET", workspaceID:workspace)
        expect(uncertainState["sends"] as? Int == 1, "Lost POST acknowledgement must not duplicate model work")

        let approvalAPI = api("approval")
        let approvalSession = EveChatSession(workspaceID:workspace, api:approvalAPI)
        let parked = try await collect(approvalSession.send(parts:[["type":"text","text":"Ask me"]]))
        expect(parked.requests.first?.id == "request-7", "Surface exact request IDs")
        // The fixture's continuation starts at the following event index; a
        // fresh bounded replay verifies pending input can be recovered on open.
        let restored = EveChatSession(conversationID:UUID(uuidString:"00000000-0000-0000-0000-000000000002"), workspaceID:workspace, api:approvalAPI)
        let snapshot = try await restored.restore(sessionID:"fixture-session")
        expect(snapshot.turn.requests.count == 1 && !snapshot.running, "Restore parked approvals without minting or running a model")
        let resumed = try await collect(restored.respond([["requestId":"request-7","optionId":"approve-custom","text":"Research"]]))
        expect(resumed.requests.isEmpty && resumed.text.contains("Answer received"), "Answer must resume the parked turn")
        let approvalState = try await approvalAPI.json("/requests", method:"GET", workspaceID:workspace)
        let approvalRequests = approvalState["requests"] as! [[String:Any]]
        let answer = approvalRequests.compactMap { $0["body"] as? [String:Any] }.last { $0["inputResponses"] != nil }!
        expect((answer["clientContext"] as? String)?.contains("Research") == true, "Approval answers must ride clientContext (Eve discards approval response text)")
        expect((answer["inputResponses"] as? [[String:Any]])?.first?["optionId"] as? String == "approve-custom", "Use the exact server-provided option ID")
        // Stream v26: a question pauses the turn with turn.waiting instead of ending it.
        let v26API = api("approval-v26")
        let v26Session = EveChatSession(workspaceID:workspace, api:v26API)
        let v26Parked = try await collect(v26Session.send(parts:[["type":"text","text":"Ask me"]]))
        expect(v26Parked.requests.first?.id == "request-8", "v26: stop at turn.waiting while a question is pending")
        let v26Restored = EveChatSession(conversationID:UUID(uuidString:"00000000-0000-0000-0000-000000000003"), workspaceID:workspace, api:v26API)
        let v26Snapshot = try await v26Restored.restore(sessionID:"fixture-session")
        expect(v26Snapshot.turn.requests.count == 1 && !v26Snapshot.running, "v26: a turn parked on a question restores as settled")
        let v26Resumed = try await collect(v26Restored.respond([["requestId":"request-8","optionId":"approve-custom","text":"Research"]]))
        expect(v26Resumed.requests.isEmpty && v26Resumed.text.contains("Answer received"), "v26: the answer resumes the same turn")

        // v26: a turn that resumed after an answer and is still streaming restores as running
        // (it resumes with step.started, not turn.started).
        let partialAPI = api("resume-partial")
        let partialSession = EveChatSession(workspaceID:workspace, api:partialAPI)
        _ = try await collect(partialSession.send(parts:[["type":"text","text":"Ask me"]]))
        _ = try await partialAPI.json("/eve/chat-agent/v1/session/fixture-session", body:["inputResponses":[["requestId":"request-8","optionId":"approve-custom"]]], workspaceID:workspace)
        let midResume = try await EveChatSession(conversationID:UUID(uuidString:"00000000-0000-0000-0000-000000000004"), workspaceID:workspace, api:partialAPI).restore(sessionID:"fixture-session")
        expect(midResume.running && midResume.turn.requests.isEmpty, "v26: a resumed turn that is still streaming must restore as running")

        // v26: a sign-in pauses the turn with no question; the read stops there.
        let signinAPI = api("signin")
        let signin = try await collect(EveChatSession(workspaceID:workspace, api:signinAPI).send(parts:[["type":"text","text":"Use GitHub"]]))
        expect(signin.requests.isEmpty, "v26: a sign-in pause ends the read without a question")
        let signinSnapshot = try await EveChatSession(conversationID:UUID(uuidString:"00000000-0000-0000-0000-000000000005"), workspaceID:workspace, api:signinAPI).restore(sessionID:"fixture-session")
        expect(!signinSnapshot.running, "v26: a sign-in pause restores as settled")

        // Stream v26: turn.waiting while the turn waits on its own task must not stop the read.
        let tasksSession = EveChatSession(workspaceID:workspace, api:api("tasks"))
        let tasksTurn = try await collect(tasksSession.send(parts:[["type":"text","text":"Research"]]))
        expect(tasksTurn.text == "Hello world", "v26: keep reading past turn.waiting with no question")
        let taskPart = tasksTurn.parts.first { $0["toolCallId"] as? String == "tool-9" }
        expect(taskPart?["state"] as? String == "output-available" && taskPart?["output"] as? String == "Found 3 notes", "v26: task.settled carries the task tool's result")

        let scopedAPI = api("different-account")
        let scopedSession = EveChatSession(workspaceID:workspace, ownerID:workspace, api:scopedAPI)
        do {
            _ = try await collect(scopedSession.send(parts:[["type":"text","text":"Private old chat"]]))
            fatalError("Account change must fail closed")
        } catch {
            let state = try await scopedAPI.json("/requests", method:"GET", workspaceID:workspace)
            expect((state["requests"] as? [[String:Any]])?.isEmpty == true, "No old chat request may be sent using a different account")
        }
        for scenario in ["limited", "bad-version", "future-version"] {
            let service = api(scenario)
            let session = EveChatSession(workspaceID:workspace, api:service)
            do {
                _ = try await collect(session.send(parts:[["type":"text","text":"Hi"]]))
                fatalError("\(scenario) must fail")
            } catch {
                let state = try await service.json("/requests", method:"GET", workspaceID:workspace)
                if scenario == "limited" { expect(state["sends"] as? Int == 0, "Usage denial must not submit a turn") }
            }
        }
        print("PASS: projection repair, replay dedup, v24 compatibility, mint/register/send ordering, workspace scoping, delivery filtering, reconnect cursor, retired-session recovery, persistence, approval restoration, v26 question/sign-in pause, resume and task results, usage gate, stream-version rejection")
    }
}
