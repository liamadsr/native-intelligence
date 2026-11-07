//
//  AgentThreadModels.swift
//  dial8
//
//  Core models for AI agents that work on action items
//

import Foundation

// MARK: - Agent Status

enum AgentStatus: String, Codable, CaseIterable {
    case disabled
    case pending
    case analyzing
    case working
    case awaitingApproval = "awaiting_approval"
    case approved
    case paused
    case completed
    case error

    var displayName: String {
        switch self {
        case .disabled: return "Disabled"
        case .pending: return "Pending"
        case .analyzing: return "Analyzing"
        case .working: return "Working"
        case .awaitingApproval: return "Awaiting Approval"
        case .approved: return "Approved"
        case .paused: return "Paused"
        case .completed: return "Completed"
        case .error: return "Error"
        }
    }

    var icon: String {
        switch self {
        case .disabled: return "circle.slash"
        case .pending: return "clock"
        case .analyzing: return "magnifyingglass"
        case .working: return "gearshape.2.fill"
        case .awaitingApproval: return "bell.badge.fill"
        case .approved: return "checkmark.seal.fill"
        case .paused: return "pause.circle.fill"
        case .completed: return "checkmark.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    var color: String {
        switch self {
        case .disabled: return "#888888"
        case .pending: return "#9E9E9E"
        case .analyzing: return "#2196F3"
        case .working: return "#4CAF50"
        case .awaitingApproval: return "#FF9800"
        case .approved: return "#4CAF50"
        case .paused: return "#9E9E9E"
        case .completed: return "#4CAF50"
        case .error: return "#F44336"
        }
    }

    var isActive: Bool {
        switch self {
        case .analyzing, .working, .approved:
            return true
        default:
            return false
        }
    }
}

// MARK: - Entity Type

enum AgentEntityType: String, Codable, CaseIterable {
    case action
    /// Legacy: the Goals feature was cut, but old agent_threads rows still carry
    /// entity_type = 'goal'. Kept so those threads keep decoding.
    case goal
    /// Legacy: same as `.goal` — retained for decoding old rows only.
    case milestone
    case workflow  // Future
    case note
    case general   // General chat (no entity bound)

    var displayName: String {
        switch self {
        case .action: return "Action"
        case .goal: return "Goal"
        case .milestone: return "Milestone"
        case .workflow: return "Workflow"
        case .note: return "Note"
        case .general: return "General"
        }
    }
}

// MARK: - Attached Context Summary

/// Summary of context attached to a message (for UI display)
/// This is NOT persisted to the database - it's just for showing what context was attached
struct AttachedContextSummary: Equatable {
    let projectNames: [String]
    let noteNames: [String]
    let actionNames: [String]

    var isEmpty: Bool {
        projectNames.isEmpty && noteNames.isEmpty && actionNames.isEmpty
    }

    var totalCount: Int {
        projectNames.count + noteNames.count + actionNames.count
    }

    /// Short description for collapsed indicator (e.g., "2 notes attached")
    var shortDescription: String {
        var parts: [String] = []
        if !projectNames.isEmpty {
            parts.append("\(projectNames.count) project\(projectNames.count == 1 ? "" : "s")")
        }
        if !noteNames.isEmpty {
            parts.append("\(noteNames.count) note\(noteNames.count == 1 ? "" : "s")")
        }
        if !actionNames.isEmpty {
            parts.append("\(actionNames.count) action\(actionNames.count == 1 ? "" : "s")")
        }
        return parts.joined(separator: ", ") + " attached"
    }

    /// Create from AttachmentChanges
    static func from(_ changes: AttachmentChanges) -> AttachedContextSummary? {
        guard !changes.isEmpty else { return nil }

        let projectsService = ProjectsService.shared
        let notesService = NotesService.shared
        let actionsService = ActionsService.shared

        let projectNames = changes.projectIds.compactMap { id in
            projectsService.projects.first(where: { $0.id == id })?.name
        }
        let noteNames = changes.noteIds.compactMap { notesService.getNote(by: $0)?.title }
        let actionNames = changes.actionIds.compactMap { actionsService.getAction(by: $0)?.title }

        return AttachedContextSummary(
            projectNames: projectNames,
            noteNames: noteNames,
            actionNames: actionNames
        )
    }
}

// MARK: - Trigger Type

enum AgentTriggerType: String, Codable, CaseIterable {
    case manual
    case automatic
    case scheduled  // Future

    var displayName: String {
        switch self {
        case .manual: return "Manual"
        case .automatic: return "Automatic"
        case .scheduled: return "Scheduled"
        }
    }
}

// MARK: - Agent Thread Status

enum AgentThreadStatus: String, Codable, CaseIterable {
    case active
    case paused
    case completed
    case error

    var displayName: String {
        switch self {
        case .active: return "Active"
        case .paused: return "Paused"
        case .completed: return "Completed"
        case .error: return "Error"
        }
    }
}

// MARK: - Message Role

enum AgentMessageRole: String, Codable, CaseIterable {
    case user
    case assistant
    case system
    case tool

    var displayName: String {
        switch self {
        case .user: return "User"
        case .assistant: return "Assistant"
        case .system: return "System"
        case .tool: return "Tool"
        }
    }
}

// MARK: - Approval Status

enum ApprovalStatus: String, Codable, CaseIterable {
    case pending
    case approved
    case rejected
    case modified

    var displayName: String {
        switch self {
        case .pending: return "Pending"
        case .approved: return "Approved"
        case .rejected: return "Rejected"
        case .modified: return "Modified"
        }
    }

    var icon: String {
        switch self {
        case .pending: return "clock"
        case .approved: return "checkmark.circle.fill"
        case .rejected: return "xmark.circle.fill"
        case .modified: return "pencil.circle.fill"
        }
    }
}

// MARK: - Tool Call Status

enum ToolCallStatus: String, Codable, CaseIterable {
    case pending
    case awaitingApproval = "awaiting_approval"
    case approved
    case rejected
    case executing
    case completed
    case failed

    var displayName: String {
        switch self {
        case .pending: return "Pending"
        case .awaitingApproval: return "Awaiting Approval"
        case .approved: return "Approved"
        case .rejected: return "Rejected"
        case .executing: return "Executing"
        case .completed: return "Completed"
        case .failed: return "Failed"
        }
    }
}

// MARK: - Proposal Type

enum ProposalType: String, Codable, CaseIterable {
    case draft
    case plan
    case execution
    case question
    case completion

    var displayName: String {
        switch self {
        case .draft: return "Draft"
        case .plan: return "Plan"
        case .execution: return "Execution"
        case .question: return "Question"
        case .completion: return "Completion"
        }
    }

    var icon: String {
        switch self {
        case .draft: return "doc.text"
        case .plan: return "list.bullet.clipboard"
        case .execution: return "play.circle"
        case .question: return "questionmark.circle"
        case .completion: return "checkmark.circle"
        }
    }
}

// MARK: - Feedback Type (for learning)

enum FeedbackType: String, Codable, CaseIterable {
    case tooLong = "too_long"
    case tooShort = "too_short"
    case wrongTone = "wrong_tone"
    case missingInfo = "missing_info"
    case incorrectInfo = "incorrect_info"
    case other

    var displayName: String {
        switch self {
        case .tooLong: return "Too Long"
        case .tooShort: return "Too Short"
        case .wrongTone: return "Wrong Tone"
        case .missingInfo: return "Missing Information"
        case .incorrectInfo: return "Incorrect Information"
        case .other: return "Other"
        }
    }

    /// Alias for displayName (used in UI components)
    var displayText: String { displayName }
}

// MARK: - Sensitive Action

enum SensitiveAction: String, Codable, CaseIterable {
    case sendEmail = "send_email"
    case deleteFile = "delete_file"
    case externalAPICall = "external_api"
    case calendarInvite = "calendar_invite"
    case contactModification = "contact_modify"

    var displayName: String {
        switch self {
        case .sendEmail: return "Send Email"
        case .deleteFile: return "Delete File"
        case .externalAPICall: return "External API Call"
        case .calendarInvite: return "Calendar Invite"
        case .contactModification: return "Contact Modification"
        }
    }

    var icon: String {
        switch self {
        case .sendEmail: return "envelope.fill"
        case .deleteFile: return "trash.fill"
        case .externalAPICall: return "network"
        case .calendarInvite: return "calendar.badge.plus"
        case .contactModification: return "person.crop.circle.badge.exclamationmark"
        }
    }

    /// Tools that map to this sensitive action
    var toolNames: [String] {
        switch self {
        case .sendEmail: return ["send_email", "mcp__dial8__send_email"]
        case .deleteFile: return ["delete_file", "mcp__dial8__delete_file"]
        case .externalAPICall: return ["external_api_call"]
        case .calendarInvite: return ["create_calendar_event", "mcp__dial8__create_calendar_event"]
        case .contactModification: return ["update_contact", "delete_contact", "mcp__dial8__update_contact", "mcp__dial8__delete_contact"]
        }
    }

    /// Check if a tool name requires this sensitive action approval
    static func forToolName(_ toolName: String) -> SensitiveAction? {
        for action in SensitiveAction.allCases {
            if action.toolNames.contains(toolName) {
                return action
            }
        }
        return nil
    }
}

// MARK: - Agent Thread

struct AgentThread: Codable, Identifiable, Equatable {
    let id: UUID
    let userId: UUID
    var entityType: AgentEntityType
    var entityId: UUID?  // Optional for general chats (no entity bound)
    var workflowId: UUID?  // Future: link to workflow template
    var triggerType: AgentTriggerType
    var status: AgentThreadStatus
    var systemPrompt: String?
    var toolsUsed: [String]
    var contextData: [String: AnyCodableValue]?

    // General chat metadata
    var title: String?  // Display title (auto-generated from first message)
    var preview: String?  // Short preview for list display

    // Cost tracking (for future limits)
    var tokensUsed: Int

    // Learning metrics
    var proposalsApproved: Int
    var proposalsRejected: Int

    // Timestamps
    let createdAt: Date
    var updatedAt: Date
    var lastMessageAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case entityType = "entity_type"
        case entityId = "entity_id"
        case workflowId = "workflow_id"
        case triggerType = "trigger_type"
        case status
        case systemPrompt = "system_prompt"
        case toolsUsed = "tools_used"
        case contextData = "context_data"
        case title
        case preview
        case tokensUsed = "tokens_used"
        case proposalsApproved = "proposals_approved"
        case proposalsRejected = "proposals_rejected"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastMessageAt = "last_message_at"
    }

    init(
        id: UUID = UUID(),
        userId: UUID,
        entityType: AgentEntityType,
        entityId: UUID? = nil,
        workflowId: UUID? = nil,
        triggerType: AgentTriggerType = .automatic,
        status: AgentThreadStatus = .active,
        systemPrompt: String? = nil,
        toolsUsed: [String] = [],
        contextData: [String: AnyCodableValue]? = nil,
        title: String? = nil,
        preview: String? = nil,
        tokensUsed: Int = 0,
        proposalsApproved: Int = 0,
        proposalsRejected: Int = 0,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        lastMessageAt: Date? = nil
    ) {
        self.id = id
        self.userId = userId
        self.entityType = entityType
        self.entityId = entityId
        self.workflowId = workflowId
        self.triggerType = triggerType
        self.status = status
        self.systemPrompt = systemPrompt
        self.toolsUsed = toolsUsed
        self.contextData = contextData
        self.title = title
        self.preview = preview
        self.tokensUsed = tokensUsed
        self.proposalsApproved = proposalsApproved
        self.proposalsRejected = proposalsRejected
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
    }

    // MARK: - Computed Properties

    var approvalRate: Double {
        let total = proposalsApproved + proposalsRejected
        guard total > 0 else { return 0 }
        return Double(proposalsApproved) / Double(total)
    }

    static func == (lhs: AgentThread, rhs: AgentThread) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Agent Message

struct AgentMessage: Codable, Identifiable, Equatable {
    let id: UUID
    let threadId: UUID
    var role: AgentMessageRole
    var content: String
    var timestamp: Date
    var toolCalls: [AgentToolCall]?
    var isProposal: Bool
    var approvalStatus: ApprovalStatus?

    // Cost tracking
    var inputTokens: Int
    var outputTokens: Int

    // Transient (not persisted) - UI display only for mid-conversation attachments
    var attachedContext: AttachedContextSummary?

    enum CodingKeys: String, CodingKey {
        case id
        case threadId = "thread_id"
        case role
        case content
        case timestamp
        case toolCalls = "tool_calls"
        case isProposal = "is_proposal"
        case approvalStatus = "approval_status"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        // Note: attachedContext is intentionally excluded - it's transient and not persisted
    }

    init(
        id: UUID = UUID(),
        threadId: UUID,
        role: AgentMessageRole,
        content: String,
        timestamp: Date = Date(),
        toolCalls: [AgentToolCall]? = nil,
        isProposal: Bool = false,
        approvalStatus: ApprovalStatus? = nil,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        attachedContext: AttachedContextSummary? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.toolCalls = toolCalls
        self.isProposal = isProposal
        self.approvalStatus = approvalStatus
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.attachedContext = attachedContext
    }

    // Custom decoder to handle missing attachedContext (since it's not persisted)
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        threadId = try container.decode(UUID.self, forKey: .threadId)
        role = try container.decode(AgentMessageRole.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        timestamp = try container.decode(Date.self, forKey: .timestamp)
        toolCalls = try container.decodeIfPresent([AgentToolCall].self, forKey: .toolCalls)
        isProposal = try container.decode(Bool.self, forKey: .isProposal)
        approvalStatus = try container.decodeIfPresent(ApprovalStatus.self, forKey: .approvalStatus)
        inputTokens = try container.decode(Int.self, forKey: .inputTokens)
        outputTokens = try container.decode(Int.self, forKey: .outputTokens)
        // attachedContext is always nil when decoding from persistence
        attachedContext = nil
    }

    var totalTokens: Int {
        inputTokens + outputTokens
    }

    static func == (lhs: AgentMessage, rhs: AgentMessage) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Agent Tool Call

struct AgentToolCall: Codable, Identifiable, Equatable {
    let id: UUID
    var toolName: String
    var input: [String: AnyCodableValue]
    var output: String?
    var status: ToolCallStatus
    var requiresApproval: Bool
    var sensitiveAction: SensitiveAction?
    var timestamp: Date

    enum CodingKeys: String, CodingKey {
        case id
        case toolName = "tool_name"
        case input
        case output
        case status
        case requiresApproval = "requires_approval"
        case sensitiveAction = "sensitive_action"
        case timestamp
    }

    init(
        id: UUID = UUID(),
        toolName: String,
        input: [String: AnyCodableValue] = [:],
        output: String? = nil,
        status: ToolCallStatus = .pending,
        requiresApproval: Bool = false,
        sensitiveAction: SensitiveAction? = nil,
        timestamp: Date = Date()
    ) {
        self.id = id
        self.toolName = toolName
        self.input = input
        self.output = output
        self.status = status
        self.requiresApproval = requiresApproval
        self.sensitiveAction = sensitiveAction
        self.timestamp = timestamp
    }

    static func == (lhs: AgentToolCall, rhs: AgentToolCall) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Agent Proposal

struct AgentProposal: Codable, Identifiable, Equatable {
    let id: UUID
    let threadId: UUID
    var type: ProposalType
    var summary: String
    var details: String
    var toolCalls: [AgentToolCall]
    var status: ApprovalStatus
    let createdAt: Date
    var respondedAt: Date?

    // Learning: capture user feedback
    var userFeedback: String?
    var feedbackType: FeedbackType?

    enum CodingKeys: String, CodingKey {
        case id
        case threadId = "thread_id"
        case type
        case summary
        case details
        case toolCalls = "tool_calls"
        case status
        case createdAt = "created_at"
        case respondedAt = "responded_at"
        case userFeedback = "user_feedback"
        case feedbackType = "feedback_type"
    }

    init(
        id: UUID = UUID(),
        threadId: UUID,
        type: ProposalType,
        summary: String,
        details: String,
        toolCalls: [AgentToolCall] = [],
        status: ApprovalStatus = .pending,
        createdAt: Date = Date(),
        respondedAt: Date? = nil,
        userFeedback: String? = nil,
        feedbackType: FeedbackType? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.type = type
        self.summary = summary
        self.details = details
        self.toolCalls = toolCalls
        self.status = status
        self.createdAt = createdAt
        self.respondedAt = respondedAt
        self.userFeedback = userFeedback
        self.feedbackType = feedbackType
    }

    var hasSensitiveActions: Bool {
        toolCalls.contains { $0.requiresApproval }
    }

    static func == (lhs: AgentProposal, rhs: AgentProposal) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Streaming Tool Call (for real-time UI display)

/// Represents a tool call that is currently being executed or was recently executed
/// Used for real-time display in the chat UI before the final message is assembled
struct StreamingToolCall: Identifiable, Equatable {
    let id: UUID
    let toolName: String
    let input: [String: Any]
    var status: ToolCallStatus
    let startedAt: Date
    var completedAt: Date?

    /// Human-readable display name for the tool
    var displayName: String {
        // Convert tool names like "search_knowledge" to "Search Knowledge"
        toolName
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    /// Icon for the tool type
    var icon: String {
        switch toolName.lowercased() {
        case let name where name.contains("search"):
            return "magnifyingglass"
        case let name where name.contains("knowledge"):
            return "book.closed"
        case let name where name.contains("email"):
            return "envelope"
        case let name where name.contains("calendar"):
            return "calendar"
        case let name where name.contains("contact"):
            return "person.crop.circle"
        case let name where name.contains("note"):
            return "note.text"
        case let name where name.contains("reminder"):
            return "bell"
        case let name where name.contains("screenshot"):
            return "camera"
        case let name where name.contains("mcp"):
            return "network"
        default:
            return "wrench.and.screwdriver"
        }
    }

    /// Duration since the tool started executing
    var elapsedTime: TimeInterval? {
        if let completed = completedAt {
            return completed.timeIntervalSince(startedAt)
        }
        return Date().timeIntervalSince(startedAt)
    }

    /// Formatted elapsed time string
    var elapsedTimeString: String {
        guard let elapsed = elapsedTime else { return "" }
        if elapsed < 1 {
            return "<1s"
        } else if elapsed < 60 {
            return String(format: "%.0fs", elapsed)
        } else {
            return String(format: "%.1fm", elapsed / 60)
        }
    }

    /// Brief description of the input for display
    var inputSummary: String? {
        // Extract the most relevant input parameter to show
        if let query = input["query"] as? String {
            return "\"\(query.prefix(50))\(query.count > 50 ? "..." : "")\""
        }
        if let name = input["name"] as? String {
            return "\"\(name.prefix(50))\(name.count > 50 ? "..." : "")\""
        }
        if let text = input["text"] as? String {
            return "\"\(text.prefix(50))\(text.count > 50 ? "..." : "")\""
        }
        if let message = input["message"] as? String {
            return "\"\(message.prefix(50))\(message.count > 50 ? "..." : "")\""
        }
        return nil
    }

    static func == (lhs: StreamingToolCall, rhs: StreamingToolCall) -> Bool {
        lhs.id == rhs.id && lhs.status == rhs.status
    }
}
