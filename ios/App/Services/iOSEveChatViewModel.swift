import Foundation
import Combine
import Supabase

struct iOSChatAgent: Identifiable, Equatable {
    enum Kind: String { case teammate, persona }
    let id: UUID
    let name: String
    let detail: String
    let character: String?
    let avatarURL: URL?
    let workspaceID: UUID
    let kind: Kind
}

struct iOSChatHistoryItem: Identifiable {
    let id: UUID
    let title: String?
    let preview: String?
    let legacy: Bool
}

/// Native presentation of the web's conversations and teammate threads.
@MainActor
final class iOSEveChatViewModel: ObservableObject {
    @Published private(set) var messages: [AgentMessage] = []
    @Published private(set) var currentSessionId: UUID?
    @Published private(set) var chatSessions: [iOSChatHistoryItem] = []
    @Published private(set) var agents: [iOSChatAgent] = []
    @Published private(set) var selectedAgent: iOSChatAgent?
    @Published private(set) var isLoadingAgents = false
    @Published private(set) var agentLoadError: String?
    @Published private(set) var isLoadingThread = false
    @Published private(set) var isProcessing = false
    @Published private(set) var lastError: String?
    @Published private(set) var streamingContent: String?
    @Published private(set) var streamingToolCalls: [StreamingToolCall] = []
    @Published private(set) var inputRequests: [EveInputRequest] = []
    @Published var userInput = ""

    #if DEBUG
    private var isPreview = false
    #endif
    private let note: Note?
    private var session: EveChatSession?
    private var generation = UUID()
    private var observation: Task<Void, Never>?
    private var lastFailedMessage: String?
    private var legacyPrimer: String?
    private var activeUser: UUID? { SupabaseManager.shared.currentUser?.id }
    private var activeWorkspace: UUID? { selectedAgent?.workspaceID ?? WorkspaceService.shared.workspaceId }
    private var toolIDs: [String: UUID] = [:]
    private var draftID = UUID()
    private var accepted = false
    @Published private(set) var needsReconnect = false

    init(note: Note? = nil) { self.note = note }

    func loadAgents() async {
        #if DEBUG
        if isPreview { return }
        #endif
        guard let workspace = WorkspaceService.shared.workspaceId, let owner = activeUser else { return }
        let stamp = generation
        isLoadingAgents = true
        agentLoadError = nil
        do {
            let result = try await EveChatAPI.shared.scoped(to: owner).json("/api/account/agent-work?light=1", method: "GET", workspaceID: workspace)
            let roster = result["roster"] as? [[String: Any]] ?? []
            var loaded = roster.compactMap { row -> iOSChatAgent? in
                guard let id = (row["id"] as? String).flatMap(UUID.init(uuidString:)),
                      let workspaceID = (row["workspace_id"] as? String).flatMap(UUID.init(uuidString:)), workspaceID == workspace,
                      let name = row["name"] as? String else { return nil }
                let fronts = row["fronts"] as? [String] ?? []
                let detail = row["speaks_for_agent"] as? String ?? row["role"] as? String ?? (fronts.isEmpty ? "Workspace agent" : fronts.joined(separator: ", "))
                return iOSChatAgent(id: id, name: name, detail: detail.capitalized, character: row["bot_character"] as? String,
                    avatarURL: (row["avatar_url"] as? String).flatMap(URL.init(string:)), workspaceID: workspaceID, kind: .teammate)
            }
            // Recipes are selectable personas too; the server revalidates each
            // agentId at mint, and resolves teammate personas itself.
            let data = try await SupabaseManager.shared.client.from("recipe")
                .select("id,name,description,workspace_id,is_system")
                .eq("category", value: "agent")
                .or("workspace_id.eq.\(workspace.uuidString.lowercased()),is_system.eq.true")
                .order("name").execute().data
            let recipes = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
            loaded += recipes.compactMap { row in
                guard let id = (row["id"] as? String).flatMap(UUID.init(uuidString:)), let name = row["name"] as? String else { return nil }
                return iOSChatAgent(id: id, name: name, detail: row["description"] as? String ?? "Agent", character: nil, avatarURL: nil, workspaceID: workspace, kind: .persona)
            }
            guard generation == stamp, activeUser == owner, WorkspaceService.shared.workspaceId == workspace else { return }
            agents = loaded
            if let selectedAgent, let refreshed = loaded.first(where: { $0.id == selectedAgent.id }) { self.selectedAgent = refreshed }
        } catch {
            guard generation == stamp else { return }
            agentLoadError = "Couldn’t load your agents. \(error.localizedDescription)"
        }
        if generation == stamp { isLoadingAgents = false }
    }

    func selectAgent(_ agent: iOSChatAgent?) async {
        guard !isProcessing, !isLoadingThread else { return }
        startNewConversation()
        selectedAgent = agent
        #if DEBUG
        if isPreview { return }
        #endif
        guard let agent, agent.kind == .teammate, let owner = activeUser else { return }
        let stamp = generation
        isLoadingThread = true
        do {
            let thread = try await EveChatAPI.shared.scoped(to: owner).json("/api/account/chat/eve-session", body: ["action": "thread", "teammateId": agent.id.uuidString.lowercased()], workspaceID: agent.workspaceID)
            guard generation == stamp, let id = (thread["conversationId"] as? String).flatMap(UUID.init(uuidString:)) else { return }
            try await loadConversation(id, workspace: agent.workspaceID, stamp: stamp)
        } catch { if generation == stamp { lastError = error.localizedDescription } }
        if generation == stamp { isLoadingThread = false }
    }

    func startNewConversation() {
        generation = UUID()
        observation?.cancel()
        observation = nil
        session = nil
        currentSessionId = nil
        selectedAgent = nil
        messages = []
        streamingContent = nil
        streamingToolCalls = []
        inputRequests = []
        isProcessing = false
        isLoadingThread = false
        isLoadingAgents = false
        lastError = nil
        lastFailedMessage = nil
        legacyPrimer = nil
        userInput = ""
        draftID = UUID()
        accepted = false
        needsReconnect = false
    }

    func resetForAccountChange() {
        startNewConversation()
        agents = []
        chatSessions = []
        agentLoadError = nil
    }

    func sendMessage() async throws {
        let text = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isProcessing, !isLoadingThread, !needsReconnect, inputRequests.isEmpty else { return }
        guard let workspace = activeWorkspace, let owner = activeUser else { throw AIBackendError.notAuthenticated }
        let stamp = generation
        if session == nil {
            session = EveChatSession(conversationID: legacyPrimer == nil ? currentSessionId : nil, workspaceID: workspace,
                teammateID: selectedAgent?.kind == .teammate ? selectedAgent?.id : nil,
                agentID: selectedAgent?.kind == .persona ? selectedAgent?.id : nil, ownerID: owner)
        }
        guard let session else { return }
        isProcessing = true
        accepted = false
        lastError = nil
        userInput = ""
        let messageID = draftID
        let message = AgentMessage(id: messageID, threadId: currentSessionId ?? UUID(), role: .user, content: text)
        if !messages.contains(where: { $0.id == messageID }) { messages.append(message) }
        let attached = ProjectsService.shared.aiContextSelection
        var contextLines: [String] = []
        if let note { contextLines.append("The user is viewing capture \(note.id.uuidString.lowercased()): \(note.title)") }
        if !attached.selectedNoteIds.isEmpty { contextLines.append("Attached capture IDs: " + attached.selectedNoteIds.map { $0.uuidString.lowercased() }.joined(separator: ", ")) }
        if !attached.selectedProjectIds.isEmpty { contextLines.append("Attached project IDs: " + attached.selectedProjectIds.map { $0.uuidString.lowercased() }.joined(separator: ", ")) }
        var context: [String: Any] = ["systemContext": ["conversationContext": contextLines.joined(separator: "\n")]]
        let model = ClaudeConfiguration.shared.selectedModel
        if model != .auto { context["model"] = model.rawValue }
        do {
            try await observe(session.send(parts: [["type": "text", "text": text]], messageID: messageID.uuidString.lowercased(), context: context, historyPrimer: legacyPrimer), stamp: stamp)
            if generation == stamp { draftID = UUID(); legacyPrimer = nil; lastFailedMessage = nil }
        } catch {
            guard generation == stamp else { return }
            isProcessing = false
            lastError = error.localizedDescription
            needsReconnect = accepted
            lastFailedMessage = accepted ? nil : text
            if !accepted && userInput.isEmpty { userInput = text }
            throw error
        }
    }

    private func observe(_ stream: AsyncThrowingStream<EveChatEvent, Error>, stamp: UUID) async throws {
        for try await event in stream {
            guard generation == stamp else { return }
            switch event {
            case .conversation(let id):
                currentSessionId = id
                if let selectedAgent, selectedAgent.kind == .persona, let owner = activeUser {
                    UserDefaults.standard.set(selectedAgent.id.uuidString, forKey: "dial8.chat.persona.\(owner).\(id)")
                }
            case .accepted: accepted = true
            case .warning(let warning): lastError = warning
            case .updated(let turn): apply(turn)
            case .finished(let turn):
                apply(turn)
                isProcessing = false
                needsReconnect = false
                accepted = false
                draftID = UUID()
                legacyPrimer = nil
                lastFailedMessage = nil
                if turn.requests.isEmpty {
                    if !turn.text.isEmpty {
                        let id = UUID(uuidString: turn.messageID) ?? UUID()
                        let reply = AgentMessage(id: id, threadId: currentSessionId ?? UUID(), role: .assistant, content: turn.text)
                        if let index = messages.firstIndex(where: { $0.id == id }) { messages[index] = reply }
                        else { messages.append(reply) }
                    }
                    streamingContent = nil
                }
            }
        }
    }

    private func apply(_ turn: EveTurnProjection) {
        streamingContent = turn.text
        inputRequests = turn.requests
        streamingToolCalls = turn.tools.map { tool in
            let id = toolIDs[tool.id] ?? UUID()
            toolIDs[tool.id] = id
            return StreamingToolCall(id: id, toolName: tool.name, input: tool.input, status: tool.failed ? .failed : tool.finished ? .completed : .executing, startedAt: Date())
        }
    }

    func respond(to request: EveInputRequest, optionID: String? = nil, text: String? = nil) async {
        guard let session, !isProcessing else { return }
        var response: [String: Any] = ["requestId": request.id]
        if let optionID { response["optionId"] = optionID }
        if let text { response["text"] = text }
        let stamp = generation
        isProcessing = true
        lastError = nil
        do { try await observe(session.respond([response]), stamp: stamp) }
        catch { if stamp == generation { isProcessing = false; needsReconnect = accepted; lastError = error.localizedDescription } }
    }

    func stop() { Task { do { try await session?.stop() } catch { lastError = error.localizedDescription } } }
    func clearError() { lastError = nil }
    func retryLastMessage() {
        guard !isProcessing else { return }
        if needsReconnect, let session {
            let stamp = generation
            isProcessing = true
            lastError = nil
            Task {
                do { try await observe(session.reconnect(), stamp: stamp) }
                catch { if stamp == generation { isProcessing = false; lastError = error.localizedDescription } }
            }
            return
        }
        if let lastFailedMessage { userInput = lastFailedMessage; Task { try? await sendMessage() } }
        else if let session {
            Task {
                do { try await session.retrySave(); lastError = nil }
                catch { lastError = error.localizedDescription }
            }
        }
    }

    func loadChatHistory() async {
        guard let workspace = WorkspaceService.shared.workspaceId, let owner = activeUser else { return }
        let stamp = generation
        do {
            let data = try await SupabaseManager.shared.client.from("chat_conversations")
                .select("id,title").eq("user_id", value: owner.uuidString.lowercased())
                .eq("workspace_id", value: workspace.uuidString.lowercased()).is("ai_team_member_id", value: nil)
                .order("updated_at", ascending: false).limit(100).execute().data
            let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
            var history = rows.compactMap { row -> iOSChatHistoryItem? in
                guard let id = (row["id"] as? String).flatMap(UUID.init(uuidString:)) else { return nil }
                return iOSChatHistoryItem(id: id, title: row["title"] as? String, preview: nil, legacy: false)
            }
            // Keep old native chats accessible. They are primed into a fresh Eve
            // session on first continuation; the original rows remain intact.
            // Some newer deployments no longer expose the legacy tables. Their
            // absence must not hide the web history that loaded successfully.
            let old: [AgentThread] = (try? await SupabaseManager.shared.client.from("agent_threads").select()
                .eq("user_id", value: owner.uuidString.lowercased())
                .eq("entity_type", value: "general").order("last_message_at", ascending: false).limit(100).execute().value) ?? []
            history += old.map { iOSChatHistoryItem(id: $0.id, title: $0.title, preview: $0.preview, legacy: true) }
            if generation == stamp { chatSessions = history }
        } catch { if generation == stamp { lastError = "Couldn’t load chat history. \(error.localizedDescription)" } }
    }

    func loadSession(_ id: UUID) async {
        guard !isProcessing, let workspace = WorkspaceService.shared.workspaceId else { return }
        startNewConversation()
        let stamp = generation
        isLoadingThread = true
        do { try await loadConversation(id, workspace: workspace, stamp: stamp) }
        catch { if generation == stamp { lastError = error.localizedDescription } }
        if generation == stamp { isLoadingThread = false }
    }

    private func loadConversation(_ id: UUID, workspace: UUID, stamp: UUID) async throws {
        guard let owner = activeUser else { throw AIBackendError.notAuthenticated }
        let data = try await SupabaseManager.shared.client.from("chat_conversations").select("id,ai_team_member_id,eve_session_id")
            .eq("id", value: id.uuidString.lowercased()).eq("user_id", value: owner.uuidString.lowercased())
            .eq("workspace_id", value: workspace.uuidString.lowercased()).execute().data
        let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
        guard generation == stamp else { return }
        if let row = rows.first {
            if let teammate = (row["ai_team_member_id"] as? String).flatMap(UUID.init(uuidString:)) {
                if agents.isEmpty { await loadAgents() }
                guard generation == stamp else { return }
                guard let agent = agents.first(where: { $0.id == teammate && $0.kind == .teammate }) else { throw AIBackendError.serverError("This agent is no longer available in this workspace.") }
                selectedAgent = agent
            }
            let messagesData = try await SupabaseManager.shared.client.from("chat_messages").select("id,role,ui_message,created_at")
                .eq("conversation_id", value: id.uuidString.lowercased()).eq("user_id", value: owner.uuidString.lowercased())
                .eq("workspace_id", value: workspace.uuidString.lowercased()).order("created_at", ascending: false).limit(200).execute().data
            let messageRows = try JSONSerialization.jsonObject(with: messagesData) as? [[String: Any]] ?? []
            guard generation == stamp else { return }
            messages = messageRows.reversed().compactMap { row in
                guard let role = (row["role"] as? String).flatMap(AgentMessageRole.init(rawValue:)), let ui = row["ui_message"] as? [String: Any] else { return nil }
                let text = (ui["parts"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n\n")
                return AgentMessage(id: (ui["id"] as? String).flatMap(UUID.init(uuidString:)) ?? (row["id"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID(), threadId: id, role: role, content: text)
            }
            currentSessionId = id
            if selectedAgent == nil, let personaID = UserDefaults.standard.string(forKey: "dial8.chat.persona.\(owner).\(id)").flatMap(UUID.init(uuidString:)) {
                if agents.isEmpty { await loadAgents() }
                guard generation == stamp else { return }
                selectedAgent = agents.first { $0.id == personaID && $0.kind == .persona }
            }
            session = EveChatSession(conversationID: id, workspaceID: workspace, teammateID: selectedAgent?.kind == .teammate ? selectedAgent?.id : nil,
                                     agentID: selectedAgent?.kind == .persona ? selectedAgent?.id : nil, ownerID: owner)
            if let eveID = row["eve_session_id"] as? String, let session {
                let restored = try await session.restore(sessionID: eveID)
                guard generation == stamp else { return }
                // A just-completed stream can beat the web persistence write.
                // Show its authoritative reply when the loaded transcript still
                // ends at that exact user message, without duplicating a saved one.
                if !restored.running, restored.turn.requests.isEmpty,
                   let last = messages.last, last.role == .user,
                   restored.turn.userText?.hasSuffix(last.content) == true, !restored.turn.text.isEmpty {
                    messages.append(AgentMessage(threadId: id, role: .assistant, content: restored.turn.text))
                }
                if restored.running || !restored.turn.requests.isEmpty {
                    apply(restored.turn)
                    if restored.running {
                        isProcessing = true
                        observation = Task {
                            do { try await observe(session.reconnect(), stamp: stamp) }
                            catch { if generation == stamp { isProcessing = false; needsReconnect = true; lastError = error.localizedDescription } }
                        }
                    }
                }
            }
        } else {
            let threads: [AgentThread] = try await SupabaseManager.shared.client.from("agent_threads").select()
                .eq("id", value: id.uuidString.lowercased()).eq("user_id", value: owner.uuidString.lowercased()).execute().value
            guard !threads.isEmpty else { throw AIBackendError.serverError("This conversation is no longer available.") }
            let old: [AgentMessage] = try await SupabaseManager.shared.client.from("agent_messages").select()
                .eq("thread_id", value: id.uuidString.lowercased()).order("timestamp").execute().value
            guard generation == stamp else { return }
            messages = old
            currentSessionId = id
            legacyPrimer = "Conversation so far (historical context):\n" + String(old.suffix(40).map { "\($0.role.rawValue): \($0.content)" }.joined(separator: "\n").suffix(24000))
        }
    }
}

#if DEBUG
extension iOSEveChatViewModel {
    /// Local visual fixture: no credentials, model calls, or server mutations.
    static func preview() -> iOSEveChatViewModel {
        let model = iOSEveChatViewModel()
        model.isPreview = true
        let workspace = UUID()
        model.agents = [
            ("Researcher", "Find answers and explore ideas", "research"),
            ("Writer", "Turn your ideas into clear writing", "writer"),
            ("Developer", "Build, debug, and ship", "dev"),
            ("Correspondent", "Stay on top of conversations", "mail"),
            ("Triage", "Make room for what matters", "triage"),
            ("Extraction", "Find the next steps in your captures", "extraction"),
            ("Reconciler", "Keep your workspace up to date", "reconciler")
        ].map { name, detail, character in
            iOSChatAgent(id: UUID(), name: name, detail: detail, character: character, avatarURL: nil, workspaceID: workspace, kind: .teammate)
        }
        model.selectedAgent = model.agents.first
        let id = UUID()
        model.messages = [
            AgentMessage(threadId: id, role: .user, content: "Help me get ready for the week."),
            AgentMessage(threadId: id, role: .assistant, content: "Let's start with what matters most. I can research a topic, help you prepare for a meeting, or look through your recent captures.\n\nWhat would you like to focus on?")
        ]
        return model
    }
}
#endif
