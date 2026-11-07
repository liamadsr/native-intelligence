//
//  ActionModels.swift
//  dial8
//
//  Core models for AI-powered actions and tasks
//

import Foundation
import SwiftUI

// MARK: - Action Status

/// Clean lifecycle states for actions
/// Note: Snoozing is handled separately via `snoozed_until` timestamp (orthogonal to status)
enum ActionStatus: String, Codable, CaseIterable {
    case suggested      // AI identified, unconfirmed
    case confirmed      // User validated as real action
    case inProgress = "in_progress"  // Actively working
    case completed      // Done
    case cancelled      // No longer relevant

    var displayName: String {
        switch self {
        case .suggested: return "Suggested"
        case .confirmed: return "Confirmed"
        case .inProgress: return "In Progress"
        case .completed: return "Completed"
        case .cancelled: return "Cancelled"
        }
    }

    var icon: String {
        switch self {
        case .suggested: return "sparkles"
        case .confirmed: return "circle"
        case .inProgress: return "arrow.triangle.2.circlepath"
        case .completed: return "checkmark.circle.fill"
        case .cancelled: return "xmark.circle"
        }
    }

    /// Whether the action is in an active (non-terminal) state
    var isActive: Bool {
        switch self {
        case .suggested, .confirmed, .inProgress:
            return true
        case .completed, .cancelled:
            return false
        }
    }

    /// Whether the action needs user attention
    var needsAttention: Bool {
        switch self {
        case .suggested:
            return true  // AI suggestion needs confirmation or dismissal
        case .confirmed, .inProgress, .completed, .cancelled:
            return false
        }
    }
}

// MARK: - Action Priority

/// Mirrors the Postgres enum `action_priority` (none | low | medium | high | urgent).
/// String-backed because that is what the column stores — an Int raw value was
/// the source of the old insert failures.
enum ActionPriority: String, Codable, CaseIterable, Comparable {
    case none
    case low
    case medium
    case high
    case urgent

    /// Explicit ordering (the raw value is a string, so `<` can't lean on it).
    var ordinal: Int {
        switch self {
        case .none: return 0
        case .low: return 1
        case .medium: return 2
        case .high: return 3
        case .urgent: return 4
        }
    }

    var displayName: String {
        switch self {
        case .none: return "None"
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .urgent: return "Urgent"
        }
    }

    var icon: String {
        switch self {
        case .none: return "minus"
        case .low: return "arrow.down"
        case .medium: return "equal"
        case .high: return "exclamationmark"
        case .urgent: return "exclamationmark.2"
        }
    }

    var color: String {
        switch self {
        case .none: return "#888888"
        case .low: return "#4CAF50"
        case .medium: return "#FF9800"
        case .high: return "#F44336"
        case .urgent: return "#B71C1C"
        }
    }

    static func < (lhs: ActionPriority, rhs: ActionPriority) -> Bool {
        lhs.ordinal < rhs.ordinal
    }

    static func fromString(_ string: String?) -> ActionPriority {
        guard let string = string?.lowercased() else { return .none }
        switch string {
        case "urgent": return .urgent
        case "high": return .high
        case "medium", "normal": return .medium
        case "low": return .low
        case "none": return .none
        default: return .none
        }
    }
}

// MARK: - Context Source

enum ActionContextSource: String, Codable {
    case voice
    case screenshot
    case manual
    case aiChat = "ai_chat"
    case meetingNote = "meeting_note"

    var displayName: String {
        switch self {
        case .voice: return "Voice"
        case .screenshot: return "Screenshot"
        case .manual: return "Manual"
        case .aiChat: return "AI Chat"
        case .meetingNote: return "Meeting Note"
        }
    }

    var icon: String {
        switch self {
        case .voice: return "mic.fill"
        case .screenshot: return "camera.fill"
        case .manual: return "square.and.pencil"
        case .aiChat: return "bubble.left.and.bubble.right"
        case .meetingNote: return "doc.text"
        }
    }
}

// MARK: - Action Source Type

/// Tracks the origin of an action for unified suggestion handling
enum ActionSourceType: String, Codable, CaseIterable {
    case user = "user"                          // Manually created by user
    case meetingExtraction = "meeting_extraction"  // Extracted from meeting notes by AI
    case chatSuggestion = "chat_suggestion"     // Identified by Claude in conversation
    case insightSuggestion = "insight_suggestion" // Created from accepted insight suggestion

    var displayName: String {
        switch self {
        case .user: return "User Created"
        case .meetingExtraction: return "From Meeting"
        case .chatSuggestion: return "AI Suggestion"
        case .insightSuggestion: return "From Insight"
        }
    }

    var icon: String {
        switch self {
        case .user: return "person.fill"
        case .meetingExtraction: return "doc.text"
        case .chatSuggestion: return "sparkles"
        case .insightSuggestion: return "lightbulb.fill"
        }
    }
}

// MARK: - Action Link Model

/// A link/URL associated with an action (name is optional)
struct ActionLink: Codable, Identifiable, Equatable {
    var id: UUID
    var name: String?
    var url: String

    init(id: UUID = UUID(), name: String? = nil, url: String) {
        self.id = id
        self.name = name
        self.url = url
    }

    /// Display name - returns the custom name or extracts domain from URL
    var displayName: String {
        if let name = name, !name.isEmpty {
            return name
        }
        // Extract domain from URL
        return extractDomain(from: url)
    }

    /// Extract domain name from URL for display
    private func extractDomain(from urlString: String) -> String {
        var urlStr = urlString
        if !urlStr.lowercased().hasPrefix("http://") && !urlStr.lowercased().hasPrefix("https://") {
            urlStr = "https://" + urlStr
        }
        guard let url = URL(string: urlStr), let host = url.host else {
            return urlString
        }
        // Remove "www." prefix if present
        if host.hasPrefix("www.") {
            return String(host.dropFirst(4))
        }
        return host
    }

    /// Convert to dictionary for JSON storage
    func toDictionary() -> [String: String?] {
        return ["id": id.uuidString, "name": name, "url": url]
    }

    /// Create from dictionary
    static func fromDictionary(_ dict: [String: String]) -> ActionLink? {
        guard let idString = dict["id"],
              let id = UUID(uuidString: idString),
              let url = dict["url"] else {
            return nil
        }
        let name = dict["name"]
        return ActionLink(id: id, name: name, url: url)
    }
}

// MARK: - Action Assignee

/// Represents a person assigned to an action (stored as JSONB array in database)
struct ActionAssignee: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var name: String
    var email: String?
    var contactId: UUID?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case email
        case contactId = "contact_id"
    }

    init(id: UUID = UUID(), name: String, email: String? = nil, contactId: UUID? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.contactId = contactId
    }

    /// Create from a MeetingParticipant
    init(from participant: MeetingParticipant) {
        self.id = UUID()
        self.name = participant.displayName
        self.email = participant.email
        self.contactId = participant.contactId
    }

    /// Display name (name or email-derived name)
    var displayName: String {
        if !name.isEmpty {
            return name
        }
        if let email = email, !email.isEmpty {
            return MeetingParticipant.extractNameFromEmail(email)
        }
        return "Unknown"
    }

    /// Whether this assignee is linked to a CRM contact
    var isLinkedToContact: Bool {
        contactId != nil
    }
}

// MARK: - Action Confirmation

/// The live values of the `actions.confirmation` text column. AI extraction
/// writes "suggested"; anything a human created (or accepted) is "confirmed".
enum ActionConfirmation {
    static let suggested = "suggested"
    static let confirmed = "confirmed"
}

// MARK: - Workflow State Reference

/// The slice of `workflow_state` that every action fetch embeds via
/// `workflow_state:workflow_state!status_id(id,name,category,color)`.
///
/// Why embed: `actions` has no `status` column — an action's lifecycle lives in
/// the team's board column it points at (`status_id`). Embedding the row means
/// `Action.status` is computable straight off the decoded value, with no
/// @MainActor hop into `WorkspaceService.workflowStatesByID` (which only holds
/// the DEFAULT team's states anyway, so a cross-team action would miss).
struct WorkflowStateRef: Codable, Equatable, Identifiable {
    let id: UUID
    let name: String
    let category: WorkflowStateCategory
    let color: String?

    init(id: UUID, name: String, category: WorkflowStateCategory, color: String? = nil) {
        self.id = id
        self.name = name
        self.category = category
        self.color = color
    }
}

// MARK: - Action Model

struct Action: Codable, Identifiable, Equatable {
    let id: UUID
    let userId: UUID
    var deviceId: String?

    // Workspace scoping (all NOT NULL on the server)
    var workspaceId: UUID?
    var teamId: UUID?
    var statusId: UUID?

    /// The embedded board column this action sits in. Present whenever the query
    /// selected the `workflow_state` embed; nil for narrow selects.
    var workflowState: WorkflowStateRef?

    /// `confirmation` column: "suggested" (AI proposed) | "confirmed" (real).
    var confirmation: String

    /// Server-generated handle like "GEN-42" (filled by a DB trigger from
    /// `team_id` — never sent on insert).
    var identifier: String?

    // Milestone / project / cycle association
    var milestoneId: UUID?
    var projectId: UUID?
    var cycleId: UUID?

    /// `member.id` of the assignee (distinct from the `assignees` JSONB blob,
    /// which carries free-form names/emails from AI extraction).
    var assigneeId: UUID?

    /// Parent action for sub-tasks (`parent_id`, distinct from the recurrence
    /// series' `parent_action_id`).
    var parentId: UUID?

    /// Story-point style estimate.
    var estimate: Int?

    // Core fields
    var title: String
    var description: String?
    var dueAt: Date?
    var allDay: Bool
    var timezone: String

    // Links/URLs (stored as JSONB array of {id, name, url} objects)
    var links: [ActionLink]

    // Recurrence
    var recurrenceRule: String?
    var parentActionId: UUID?

    // Status
    var completedAt: Date?

    // Deferral (orthogonal to status - action can be in_progress AND snoozed)
    var snoozedUntil: Date?

    // Ownership
    var ownerEntityId: UUID?        // Future FK to insights_entities for delegation
    var assignedToUser: Bool        // true = my action, false = tracking someone else's

    // Assignees (who should complete this action - stored as JSONB array)
    var assignees: [ActionAssignee]

    // AI validation (for dismissing suggestions)
    var isDismissed: Bool
    /// `dismissed_reason` — the legacy column, still present.
    var dismissedReason: String?
    /// `dismiss_reason` — the newer column the website writes.
    var dismissReason: String?
    var dismissedAt: Date?

    // Organization
    var priority: ActionPriority
    var color: String?
    var sortOrder: Int

    // Insights scoring (populated by extract-insights edge function or from suggestions)
    var urgencyScore: Int?
    var importanceScore: Int?

    // AI context
    var aiConfidence: Float
    var originalTranscript: String?
    var contextSource: String?
    var contextData: [String: AnyCodableValue]?

    // Source tracking (for unified suggestion handling)
    var sourceType: ActionSourceType
    /// `source_capture_id` — the capture (meeting) this action was extracted from.
    /// The column was renamed from `source_note_id` when notes became captures.
    var sourceCaptureId: UUID?
    var sourceSuggestionId: UUID?  // Reference to the insight suggestion this action was created from

    // Notifications
    var notificationIdentifier: String?
    var notificationScheduled: Bool

    // Agent integration
    var agentThreadId: UUID?
    var agentStatus: AgentStatus
    var lastAgentActivity: Date?

    // Timestamps
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case deviceId = "device_id"
        case workspaceId = "workspace_id"
        case teamId = "team_id"
        case statusId = "status_id"
        case workflowState = "workflow_state"
        case confirmation
        case identifier
        case milestoneId = "milestone_id"
        case projectId = "project_id"
        case cycleId = "cycle_id"
        case assigneeId = "assignee_id"
        case parentId = "parent_id"
        case estimate
        case title
        case description
        case dueAt = "due_at"
        case allDay = "all_day"
        case timezone
        case links
        case recurrenceRule = "recurrence_rule"
        case parentActionId = "parent_action_id"
        case completedAt = "completed_at"
        case snoozedUntil = "snoozed_until"
        case ownerEntityId = "owner_entity_id"
        case assignedToUser = "assigned_to_user"
        case assignees
        case isDismissed = "is_dismissed"
        case dismissedReason = "dismissed_reason"
        case dismissReason = "dismiss_reason"
        case dismissedAt = "dismissed_at"
        case priority
        case color
        case sortOrder = "sort_order"
        case urgencyScore = "urgency_score"
        case importanceScore = "importance_score"
        case aiConfidence = "ai_confidence"
        case originalTranscript = "original_transcript"
        case contextSource = "context_source"
        case contextData = "context_data"
        case sourceType = "source_type"
        case sourceCaptureId = "source_capture_id"
        case sourceSuggestionId = "source_suggestion_id"
        case notificationIdentifier = "notification_identifier"
        case notificationScheduled = "notification_scheduled"
        case agentThreadId = "agent_thread_id"
        case agentStatus = "agent_status"
        case lastAgentActivity = "last_agent_activity"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    // Default initializer for creating new actions
    init(
        id: UUID = UUID(),
        userId: UUID,
        deviceId: String? = nil,
        workspaceId: UUID? = nil,
        teamId: UUID? = nil,
        statusId: UUID? = nil,
        workflowState: WorkflowStateRef? = nil,
        confirmation: String = ActionConfirmation.confirmed,
        identifier: String? = nil,
        milestoneId: UUID? = nil,
        projectId: UUID? = nil,
        cycleId: UUID? = nil,
        assigneeId: UUID? = nil,
        parentId: UUID? = nil,
        estimate: Int? = nil,
        title: String,
        description: String? = nil,
        dueAt: Date? = nil,
        allDay: Bool = false,
        timezone: String = TimeZone.current.identifier,
        links: [ActionLink] = [],
        recurrenceRule: String? = nil,
        parentActionId: UUID? = nil,
        completedAt: Date? = nil,
        snoozedUntil: Date? = nil,
        ownerEntityId: UUID? = nil,
        assignedToUser: Bool = true,
        assignees: [ActionAssignee] = [],
        isDismissed: Bool = false,
        dismissedReason: String? = nil,
        dismissReason: String? = nil,
        dismissedAt: Date? = nil,
        priority: ActionPriority = .none,
        color: String? = nil,
        sortOrder: Int = 0,
        urgencyScore: Int? = nil,
        importanceScore: Int? = nil,
        aiConfidence: Float = 1.0,
        originalTranscript: String? = nil,
        contextSource: String? = nil,
        contextData: [String: AnyCodableValue]? = nil,
        sourceType: ActionSourceType = .user,
        sourceCaptureId: UUID? = nil,
        sourceSuggestionId: UUID? = nil,
        notificationIdentifier: String? = nil,
        notificationScheduled: Bool = false,
        agentThreadId: UUID? = nil,
        agentStatus: AgentStatus = .disabled,
        lastAgentActivity: Date? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.userId = userId
        self.deviceId = deviceId
        self.workspaceId = workspaceId
        self.teamId = teamId
        self.statusId = statusId
        self.workflowState = workflowState
        self.confirmation = confirmation
        self.identifier = identifier
        self.milestoneId = milestoneId
        self.projectId = projectId
        self.cycleId = cycleId
        self.assigneeId = assigneeId
        self.parentId = parentId
        self.estimate = estimate
        self.title = title
        self.description = description
        self.dueAt = dueAt
        self.allDay = allDay
        self.timezone = timezone
        self.links = links
        self.recurrenceRule = recurrenceRule
        self.parentActionId = parentActionId
        self.completedAt = completedAt
        self.snoozedUntil = snoozedUntil
        self.ownerEntityId = ownerEntityId
        self.assignedToUser = assignedToUser
        self.assignees = assignees
        self.isDismissed = isDismissed
        self.dismissedReason = dismissedReason
        self.dismissReason = dismissReason
        self.dismissedAt = dismissedAt
        self.priority = priority
        self.color = color
        self.sortOrder = sortOrder
        self.urgencyScore = urgencyScore
        self.importanceScore = importanceScore
        self.aiConfidence = aiConfidence
        self.originalTranscript = originalTranscript
        self.contextSource = contextSource
        self.contextData = contextData
        self.sourceType = sourceType
        self.sourceCaptureId = sourceCaptureId
        self.sourceSuggestionId = sourceSuggestionId
        self.notificationIdentifier = notificationIdentifier
        self.notificationScheduled = notificationScheduled
        self.agentThreadId = agentThreadId
        self.agentStatus = agentStatus
        self.lastAgentActivity = lastAgentActivity
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Tolerant decoder: every column beyond the primary key and title decodes
    /// with a default, so a narrow select (or a column the backend later drops)
    /// degrades instead of failing the whole fetch.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decode(UUID.self, forKey: .id)
        userId = try container.decode(UUID.self, forKey: .userId)
        deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId)
        workspaceId = try container.decodeIfPresent(UUID.self, forKey: .workspaceId)
        teamId = try container.decodeIfPresent(UUID.self, forKey: .teamId)
        statusId = try container.decodeIfPresent(UUID.self, forKey: .statusId)
        // PostgREST returns a to-one embed as an object, but older/other shapes
        // can send an array — tolerate both so one odd row never kills a fetch.
        // Tolerant, but never silent: a swallowed decode here means the action
        // renders with the wrong lifecycle, which is worth a log line.
        do {
            workflowState = try container.decodeIfPresent(WorkflowStateRef.self, forKey: .workflowState)
        } catch {
            do {
                workflowState = try container.decodeIfPresent([WorkflowStateRef].self, forKey: .workflowState)?.first
            } catch let arrayError {
                print("❌ Action decode: workflowState \(arrayError)")
                workflowState = nil
            }
        }
        confirmation = try container.decodeIfPresent(String.self, forKey: .confirmation) ?? ActionConfirmation.confirmed
        identifier = try container.decodeIfPresent(String.self, forKey: .identifier)
        milestoneId = try container.decodeIfPresent(UUID.self, forKey: .milestoneId)
        projectId = try container.decodeIfPresent(UUID.self, forKey: .projectId)
        cycleId = try container.decodeIfPresent(UUID.self, forKey: .cycleId)
        assigneeId = try container.decodeIfPresent(UUID.self, forKey: .assigneeId)
        parentId = try container.decodeIfPresent(UUID.self, forKey: .parentId)
        estimate = try container.decodeIfPresent(Int.self, forKey: .estimate)
        title = try container.decode(String.self, forKey: .title)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        dueAt = try container.decodeIfPresent(Date.self, forKey: .dueAt)
        allDay = try container.decodeIfPresent(Bool.self, forKey: .allDay) ?? false
        timezone = try container.decodeIfPresent(String.self, forKey: .timezone) ?? TimeZone.current.identifier
        do {
            links = try container.decodeIfPresent([ActionLink].self, forKey: .links) ?? []
        } catch {
            print("❌ Action decode: links \(error)")
            links = []
        }
        recurrenceRule = try container.decodeIfPresent(String.self, forKey: .recurrenceRule)
        parentActionId = try container.decodeIfPresent(UUID.self, forKey: .parentActionId)
        completedAt = try container.decodeIfPresent(Date.self, forKey: .completedAt)
        snoozedUntil = try container.decodeIfPresent(Date.self, forKey: .snoozedUntil)
        ownerEntityId = try container.decodeIfPresent(UUID.self, forKey: .ownerEntityId)
        assignedToUser = try container.decodeIfPresent(Bool.self, forKey: .assignedToUser) ?? true
        // `assignees` is a free-form JSONB blob written by AI extraction — a
        // shape we don't recognise must not fail the row.
        do {
            assignees = try container.decodeIfPresent([ActionAssignee].self, forKey: .assignees) ?? []
        } catch {
            print("❌ Action decode: assignees \(error)")
            assignees = []
        }
        isDismissed = try container.decodeIfPresent(Bool.self, forKey: .isDismissed) ?? false
        dismissedReason = try container.decodeIfPresent(String.self, forKey: .dismissedReason)
        dismissReason = try container.decodeIfPresent(String.self, forKey: .dismissReason)
        dismissedAt = try container.decodeIfPresent(Date.self, forKey: .dismissedAt)
        priority = try container.decodeIfPresent(ActionPriority.self, forKey: .priority) ?? .none
        color = try container.decodeIfPresent(String.self, forKey: .color)
        sortOrder = try container.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
        urgencyScore = try container.decodeIfPresent(Int.self, forKey: .urgencyScore)
        importanceScore = try container.decodeIfPresent(Int.self, forKey: .importanceScore)
        aiConfidence = try container.decodeIfPresent(Float.self, forKey: .aiConfidence) ?? 1.0
        originalTranscript = try container.decodeIfPresent(String.self, forKey: .originalTranscript)
        contextSource = try container.decodeIfPresent(String.self, forKey: .contextSource)
        contextData = try container.decodeIfPresent([String: AnyCodableValue].self, forKey: .contextData)
        do {
            sourceType = try container.decodeIfPresent(ActionSourceType.self, forKey: .sourceType) ?? .user
        } catch {
            print("❌ Action decode: sourceType \(error)")
            sourceType = .user
        }
        sourceCaptureId = try container.decodeIfPresent(UUID.self, forKey: .sourceCaptureId)
        sourceSuggestionId = try container.decodeIfPresent(UUID.self, forKey: .sourceSuggestionId)
        notificationIdentifier = try container.decodeIfPresent(String.self, forKey: .notificationIdentifier)
        notificationScheduled = try container.decodeIfPresent(Bool.self, forKey: .notificationScheduled) ?? false
        agentThreadId = try container.decodeIfPresent(UUID.self, forKey: .agentThreadId)
        do {
            agentStatus = try container.decodeIfPresent(AgentStatus.self, forKey: .agentStatus) ?? .disabled
        } catch {
            print("❌ Action decode: agentStatus \(error)")
            agentStatus = .disabled
        }
        lastAgentActivity = try container.decodeIfPresent(Date.self, forKey: .lastAgentActivity)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
    }

    /// Hand-rolled encoder so an `Action` can be handed straight to
    /// `.insert(action)`. It emits ONLY columns the server accepts on write:
    /// never `identifier` (a DB trigger fills it from `team_id`), never the
    /// `workflow_state` embed, and never a column that no longer exists.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)

        try c.encode(id, forKey: .id)
        try c.encode(userId, forKey: .userId)
        try c.encodeIfPresent(deviceId, forKey: .deviceId)
        try c.encodeIfPresent(workspaceId, forKey: .workspaceId)
        try c.encodeIfPresent(teamId, forKey: .teamId)
        try c.encodeIfPresent(statusId, forKey: .statusId)
        try c.encode(confirmation, forKey: .confirmation)
        try c.encodeIfPresent(milestoneId, forKey: .milestoneId)
        try c.encodeIfPresent(projectId, forKey: .projectId)
        try c.encodeIfPresent(cycleId, forKey: .cycleId)
        try c.encodeIfPresent(assigneeId, forKey: .assigneeId)
        try c.encodeIfPresent(parentId, forKey: .parentId)
        try c.encodeIfPresent(estimate, forKey: .estimate)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(dueAt, forKey: .dueAt)
        try c.encode(allDay, forKey: .allDay)
        try c.encode(timezone, forKey: .timezone)
        try c.encode(links, forKey: .links)
        try c.encodeIfPresent(recurrenceRule, forKey: .recurrenceRule)
        try c.encodeIfPresent(parentActionId, forKey: .parentActionId)
        try c.encodeIfPresent(completedAt, forKey: .completedAt)
        try c.encodeIfPresent(snoozedUntil, forKey: .snoozedUntil)
        try c.encodeIfPresent(ownerEntityId, forKey: .ownerEntityId)
        try c.encode(assignedToUser, forKey: .assignedToUser)
        try c.encode(assignees, forKey: .assignees)
        try c.encode(isDismissed, forKey: .isDismissed)
        try c.encodeIfPresent(dismissedReason, forKey: .dismissedReason)
        try c.encodeIfPresent(dismissReason, forKey: .dismissReason)
        try c.encodeIfPresent(dismissedAt, forKey: .dismissedAt)
        try c.encode(priority, forKey: .priority)
        try c.encodeIfPresent(color, forKey: .color)
        try c.encode(sortOrder, forKey: .sortOrder)
        try c.encodeIfPresent(urgencyScore, forKey: .urgencyScore)
        try c.encodeIfPresent(importanceScore, forKey: .importanceScore)
        try c.encode(aiConfidence, forKey: .aiConfidence)
        try c.encodeIfPresent(originalTranscript, forKey: .originalTranscript)
        try c.encodeIfPresent(contextSource, forKey: .contextSource)
        try c.encodeIfPresent(contextData, forKey: .contextData)
        try c.encode(sourceType, forKey: .sourceType)
        try c.encodeIfPresent(sourceCaptureId, forKey: .sourceCaptureId)
        try c.encodeIfPresent(sourceSuggestionId, forKey: .sourceSuggestionId)
        try c.encodeIfPresent(notificationIdentifier, forKey: .notificationIdentifier)
        try c.encode(notificationScheduled, forKey: .notificationScheduled)
        try c.encodeIfPresent(agentThreadId, forKey: .agentThreadId)
        try c.encodeIfPresent(lastAgentActivity, forKey: .lastAgentActivity)
        // agent_status / created_at / updated_at are server-managed on insert.
    }

    // MARK: - Computed Properties

    /// Backwards-compatible alias — the column was renamed `source_note_id` →
    /// `source_capture_id`. Kept so `AttachedContextProvider` keeps compiling.
    var sourceNoteId: UUID? { sourceCaptureId }

    /// The action's lifecycle state, derived rather than stored: `actions` has
    /// no `status` column. `confirmation` separates AI suggestions from real
    /// work; everything else comes from the board column's category.
    var status: ActionStatus {
        if confirmation == ActionConfirmation.suggested { return .suggested }
        switch workflowState?.category {
        case .completed: return .completed
        case .canceled, .lost: return .cancelled
        case .started: return .inProgress
        case .backlog, .unstarted, .won, .triage, .unknown, .none: return .confirmed
        }
    }

    /// The board column's display name (e.g. "Todo", "In Progress"), falling
    /// back to the derived status when no embed was selected.
    var statusDisplayName: String {
        if confirmation == ActionConfirmation.suggested { return ActionStatus.suggested.displayName }
        return workflowState?.name ?? status.displayName
    }

    var isOverdue: Bool {
        guard status.isActive, let dueAt = dueAt else { return false }
        return dueAt < Date()
    }

    /// Whether the action is currently snoozed (has a future snoozed_until date)
    var isSnoozed: Bool {
        guard let snoozedUntil = snoozedUntil else { return false }
        return snoozedUntil > Date()
    }

    /// Whether this is someone else's action that I'm tracking
    var isDelegated: Bool {
        !assignedToUser
    }

    var isDueToday: Bool {
        guard let dueAt = dueAt else { return false }
        return Calendar.current.isDateInToday(dueAt)
    }

    var isDueTomorrow: Bool {
        guard let dueAt = dueAt else { return false }
        return Calendar.current.isDateInTomorrow(dueAt)
    }

    var isDueThisWeek: Bool {
        guard let dueAt = dueAt else { return false }
        let calendar = Calendar.current
        let now = Date()
        guard let weekEnd = calendar.date(byAdding: .day, value: 7, to: now) else { return false }
        return dueAt >= now && dueAt <= weekEnd
    }

    var isDueThisMonth: Bool {
        guard let dueAt = dueAt else { return false }
        let calendar = Calendar.current
        let now = Date()
        guard let weekEnd = calendar.date(byAdding: .day, value: 7, to: now),
              let monthEnd = calendar.date(byAdding: .month, value: 1, to: now) else { return false }
        return dueAt > weekEnd && dueAt <= monthEnd
    }

    var formattedDueDate: String? {
        guard let dueAt = dueAt else { return nil }

        let formatter = DateFormatter()

        if isOverdue {
            formatter.dateStyle = .short
            formatter.timeStyle = allDay ? .none : .short
            return "Overdue: \(formatter.string(from: dueAt))"
        }

        if isDueToday {
            if allDay {
                return "Today"
            }
            formatter.timeStyle = .short
            return "Today at \(formatter.string(from: dueAt))"
        }

        if isDueTomorrow {
            if allDay {
                return "Tomorrow"
            }
            formatter.timeStyle = .short
            return "Tomorrow at \(formatter.string(from: dueAt))"
        }

        if isDueThisWeek {
            formatter.dateFormat = "EEEE"
            if allDay {
                return formatter.string(from: dueAt)
            }
            let day = formatter.string(from: dueAt)
            formatter.timeStyle = .short
            formatter.dateStyle = .none
            return "\(day) at \(formatter.string(from: dueAt))"
        }

        formatter.dateStyle = .medium
        formatter.timeStyle = allDay ? .none : .short
        return formatter.string(from: dueAt)
    }

    var source: ActionContextSource? {
        guard let contextSource = contextSource else { return nil }
        return ActionContextSource(rawValue: contextSource)
    }

    var isRecurring: Bool {
        recurrenceRule != nil
    }

    var hasContext: Bool {
        contextData != nil && !(contextData?.isEmpty ?? true)
    }

    var hasActiveAgent: Bool {
        agentStatus.isActive
    }

    var hasAgentThread: Bool {
        agentThreadId != nil
    }

    /// Whether this action was extracted from a meeting note
    var isFromMeeting: Bool {
        sourceType == .meetingExtraction
    }

    /// Whether this is an AI suggestion (from any source)
    var isAISuggestion: Bool {
        status == .suggested
    }

    /// Whether this is a meeting suggestion that needs review
    var isMeetingSuggestion: Bool {
        status == .suggested && sourceType == .meetingExtraction && !isDismissed
    }

    var needsAgentAttention: Bool {
        agentStatus == .awaitingApproval
    }

    /// Whether this action has any assignees
    var hasAssignees: Bool {
        !assignees.isEmpty
    }

    /// Display name for the first assignee (for backward compatibility in compact views)
    var primaryAssigneeDisplayName: String? {
        assignees.first?.displayName
    }

    /// Summary of assignees for display (e.g., "John" or "John +2")
    var assigneesSummary: String? {
        guard !assignees.isEmpty else { return nil }
        if assignees.count == 1 {
            return assignees[0].displayName
        }
        return "\(assignees[0].displayName) +\(assignees.count - 1)"
    }

    static func == (lhs: Action, rhs: Action) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - Create Action DTO

/// Intent for creating an action. Only fields that map to live columns —
/// `list_id`, `tags` and `status` are gone from the schema, so they are gone
/// from here too. `workspace_id` / `team_id` / `status_id` are supplied by
/// `ActionsService` from `WorkspaceService`, not by callers.
struct CreateActionDTO: Codable {
    let title: String
    let description: String?
    let milestoneId: UUID?
    let projectId: UUID?
    let dueAt: Date?
    let allDay: Bool?
    /// Raw `action_priority` value ("none" … "urgent").
    let priority: String?
    let links: [ActionLink]?
    let recurrenceRule: String?
    let contextSource: String?
    let contextData: [String: AnyCodableValue]?
    let originalTranscript: String?
    let aiConfidence: Float?
    let sortOrder: Int?
    /// "confirmed" (default) or "suggested".
    let confirmation: String?
    let sourceType: String?
    let sourceCaptureId: UUID?
    let sourceSuggestionId: UUID?

    // Assignees (JSONB array)
    let assignees: [ActionAssignee]?

    enum CodingKeys: String, CodingKey {
        case title
        case description
        case milestoneId = "milestone_id"
        case projectId = "project_id"
        case dueAt = "due_at"
        case allDay = "all_day"
        case priority
        case links
        case recurrenceRule = "recurrence_rule"
        case contextSource = "context_source"
        case contextData = "context_data"
        case originalTranscript = "original_transcript"
        case aiConfidence = "ai_confidence"
        case sortOrder = "sort_order"
        case confirmation
        case sourceType = "source_type"
        case sourceCaptureId = "source_capture_id"
        case sourceSuggestionId = "source_suggestion_id"
        case assignees
    }

    init(
        title: String,
        description: String? = nil,
        milestoneId: UUID? = nil,
        projectId: UUID? = nil,
        dueAt: Date? = nil,
        allDay: Bool? = nil,
        priority: ActionPriority? = nil,
        links: [ActionLink]? = nil,
        recurrenceRule: String? = nil,
        contextSource: ActionContextSource? = nil,
        contextData: [String: AnyCodableValue]? = nil,
        originalTranscript: String? = nil,
        aiConfidence: Float? = nil,
        sortOrder: Int? = nil,
        confirmation: String? = nil,
        sourceType: ActionSourceType? = nil,
        sourceCaptureId: UUID? = nil,
        sourceSuggestionId: UUID? = nil,
        assignees: [ActionAssignee]? = nil
    ) {
        self.title = title
        self.description = description
        self.milestoneId = milestoneId
        self.projectId = projectId
        self.dueAt = dueAt
        self.allDay = allDay
        self.priority = priority?.rawValue
        self.links = links
        self.recurrenceRule = recurrenceRule
        self.contextSource = contextSource?.rawValue
        self.contextData = contextData
        self.originalTranscript = originalTranscript
        self.aiConfidence = aiConfidence
        self.sortOrder = sortOrder
        self.confirmation = confirmation
        self.sourceType = sourceType?.rawValue
        self.sourceCaptureId = sourceCaptureId
        self.sourceSuggestionId = sourceSuggestionId
        self.assignees = assignees
    }

    /// Convenience alias — the column used to be `source_note_id`.
    var sourceNoteId: UUID? { sourceCaptureId }
}

// MARK: - Update Action DTO

/// Partial update. `statusId` carries a board-column move; there is no `status`
/// column to write, so lifecycle changes go through `ActionsService`'s
/// complete/uncomplete/confirm helpers or an explicit `statusId`.
struct UpdateActionDTO: Codable {
    var title: String?
    var description: String?
    var milestoneId: UUID?
    var projectId: UUID?
    var dueAt: Date?
    var allDay: Bool?
    /// Raw `action_priority` value.
    var priority: String?
    var links: [ActionLink]?
    var recurrenceRule: String?
    /// Move to a different workflow state (board column).
    var statusId: UUID?
    var confirmation: String?
    var color: String?
    var sortOrder: Int?

    // Assignees (JSONB array)
    var assignees: [ActionAssignee]?

    // Ownership
    var assignedToUser: Bool?

    // Flag to indicate due_at was explicitly set (even to nil) - not encoded
    var dueAtWasSet: Bool = false

    enum CodingKeys: String, CodingKey {
        case title
        case description
        case milestoneId = "milestone_id"
        case projectId = "project_id"
        case dueAt = "due_at"
        case allDay = "all_day"
        case priority
        case links
        case recurrenceRule = "recurrence_rule"
        case statusId = "status_id"
        case confirmation
        case color
        case sortOrder = "sort_order"
        case assignees
        case assignedToUser = "assigned_to_user"
        // Note: dueAtWasSet is intentionally not a column.
    }

    init(
        title: String? = nil,
        description: String? = nil,
        milestoneId: UUID? = nil,
        projectId: UUID? = nil,
        dueAt: Date? = nil,
        allDay: Bool? = nil,
        priority: ActionPriority? = nil,
        links: [ActionLink]? = nil,
        recurrenceRule: String? = nil,
        statusId: UUID? = nil,
        confirmation: String? = nil,
        color: String? = nil,
        sortOrder: Int? = nil,
        assignees: [ActionAssignee]? = nil,
        assignedToUser: Bool? = nil
    ) {
        self.title = title
        self.description = description
        self.milestoneId = milestoneId
        self.projectId = projectId
        self.dueAt = dueAt
        self.allDay = allDay
        self.priority = priority?.rawValue
        self.links = links
        self.recurrenceRule = recurrenceRule
        self.statusId = statusId
        self.confirmation = confirmation
        self.color = color
        self.sortOrder = sortOrder
        self.assignees = assignees
        self.assignedToUser = assignedToUser
    }
}

// MARK: - Action Filter

enum ActionFilter: String, CaseIterable {
    case all
    case today
    case tomorrow
    case thisWeek = "this_week"
    case overdue
    case completed
    case snoozed      // Actions with snoozed_until > now (deferred)
    case suggested    // AI suggestions awaiting confirmation

    var displayName: String {
        switch self {
        case .all: return "All"
        case .today: return "Today"
        case .tomorrow: return "Tomorrow"
        case .thisWeek: return "This Week"
        case .overdue: return "Overdue"
        case .completed: return "Completed"
        case .snoozed: return "Snoozed"
        case .suggested: return "Suggestions"
        }
    }

    var icon: String {
        switch self {
        case .all: return "tray.full"
        case .today: return "sun.max"
        case .tomorrow: return "sunrise"
        case .thisWeek: return "calendar"
        case .overdue: return "exclamationmark.triangle"
        case .completed: return "checkmark.circle"
        case .snoozed: return "moon.zzz"
        case .suggested: return "sparkles"
        }
    }
}

// MARK: - Action Sort Option

enum ActionSortOption: String, CaseIterable, Codable {
    case dueDate = "due_date"
    case priority
    case createdAt = "created_at"
    case title
    case urgencyScore = "urgency_score"
    case updatedAt = "updated_at"

    var displayName: String {
        switch self {
        case .dueDate: return "Due Date"
        case .priority: return "Priority"
        case .createdAt: return "Created"
        case .title: return "Title"
        case .urgencyScore: return "Urgency"
        case .updatedAt: return "Updated"
        }
    }

    var icon: String {
        switch self {
        case .dueDate: return "calendar"
        case .priority: return "exclamationmark"
        case .createdAt: return "clock"
        case .title: return "textformat.abc"
        case .urgencyScore: return "flame"
        case .updatedAt: return "arrow.clockwise"
        }
    }
}

// MARK: - To-Do Filter Settings

struct ToDoFilterSettings: Codable, Equatable {
    var selectedStatuses: Set<ActionStatus>
    var sortOption: ActionSortOption
    var sortAscending: Bool

    static let `default` = ToDoFilterSettings(
        selectedStatuses: [.confirmed, .inProgress],
        sortOption: .dueDate,
        sortAscending: true
    )

    var hasActiveFilters: Bool {
        selectedStatuses != Set([ActionStatus.confirmed, ActionStatus.inProgress]) ||
        sortOption != .dueDate ||
        !sortAscending
    }

    var activeFilterCount: Int {
        var count = 0
        if selectedStatuses != Set([ActionStatus.confirmed, ActionStatus.inProgress]) { count += 1 }
        if sortOption != .dueDate || !sortAscending { count += 1 }
        return count
    }
}

// MARK: - UserDefaults Extension for ToDoFilterSettings

extension UserDefaults {
    private static let toDoFilterSettingsKey = "toDoFilterSettings"

    var toDoFilterSettings: ToDoFilterSettings {
        get {
            guard let data = data(forKey: Self.toDoFilterSettingsKey),
                  let settings = try? JSONDecoder().decode(ToDoFilterSettings.self, from: data) else {
                return .default
            }
            return settings
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                set(data, forKey: Self.toDoFilterSettingsKey)
            }
        }
    }

    func resetToDoFilterSettings() {
        removeObject(forKey: Self.toDoFilterSettingsKey)
    }
}

// MARK: - Action Group

struct ActionGroup: Identifiable {
    let id: String
    let title: String
    let actions: [Action]
    let sortOrder: Int

    static func groupByDueDate(_ actions: [Action]) -> [ActionGroup] {
        // Pre-compute date boundaries once
        let now = Date()
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: now)
        let startOfTomorrow = calendar.date(byAdding: .day, value: 1, to: startOfToday)!
        let startOfDayAfterTomorrow = calendar.date(byAdding: .day, value: 2, to: startOfToday)!
        let endOfWeek = calendar.date(byAdding: .day, value: 7, to: now)!
        let endOfMonth = calendar.date(byAdding: .month, value: 1, to: now)!

        // Buckets for single-pass classification
        var overdue: [Action] = []
        var today: [Action] = []
        var tomorrow: [Action] = []
        var thisWeek: [Action] = []
        var thisMonth: [Action] = []
        var later: [Action] = []
        var noDueDate: [Action] = []
        var completed: [Action] = []
        var suggested: [Action] = []

        // Single pass over all actions
        for action in actions {
            // Completed actions
            if action.status == .completed {
                completed.append(action)
                continue
            }

            // Suggested actions (AI suggestions needing review)
            if action.status == .suggested && !action.isDismissed {
                suggested.append(action)
                continue
            }

            // Only classify active actions (confirmed, in_progress)
            guard action.status == .confirmed || action.status == .inProgress else {
                continue
            }

            guard let dueAt = action.dueAt else {
                noDueDate.append(action)
                continue
            }

            // Classify by due date using pre-computed boundaries
            if dueAt < now && action.status.isActive {
                // Overdue: due before now (and not today's date range)
                // But if it's today and just past the time, check if it's still "today"
                if dueAt >= startOfToday {
                    today.append(action)
                } else {
                    overdue.append(action)
                }
            } else if dueAt >= startOfToday && dueAt < startOfTomorrow {
                today.append(action)
            } else if dueAt >= startOfTomorrow && dueAt < startOfDayAfterTomorrow {
                tomorrow.append(action)
            } else if dueAt >= startOfDayAfterTomorrow && dueAt <= endOfWeek {
                thisWeek.append(action)
            } else if dueAt > endOfWeek && dueAt <= endOfMonth {
                thisMonth.append(action)
            } else {
                later.append(action)
            }
        }

        // Build groups array
        var groups: [ActionGroup] = []

        if !completed.isEmpty {
            // Sort by completion date (most recent first)
            completed.sort {
                ($0.completedAt ?? $0.updatedAt) > ($1.completedAt ?? $1.updatedAt)
            }
            groups.append(ActionGroup(id: "completed", title: "Completed", actions: completed, sortOrder: 7))
        }

        if !overdue.isEmpty {
            groups.append(ActionGroup(id: "overdue", title: "Overdue", actions: overdue, sortOrder: 0))
        }

        if !today.isEmpty {
            groups.append(ActionGroup(id: "today", title: "Today", actions: today, sortOrder: 1))
        }

        if !tomorrow.isEmpty {
            groups.append(ActionGroup(id: "tomorrow", title: "Tomorrow", actions: tomorrow, sortOrder: 2))
        }

        if !thisWeek.isEmpty {
            groups.append(ActionGroup(id: "this_week", title: "This Week", actions: thisWeek, sortOrder: 3))
        }

        if !thisMonth.isEmpty {
            groups.append(ActionGroup(id: "this_month", title: "This Month", actions: thisMonth, sortOrder: 4))
        }

        if !later.isEmpty {
            groups.append(ActionGroup(id: "later", title: "Later", actions: later, sortOrder: 5))
        }

        if !noDueDate.isEmpty {
            groups.append(ActionGroup(id: "no_date", title: "No Due Date", actions: noDueDate, sortOrder: 6))
        }

        if !suggested.isEmpty {
            groups.append(ActionGroup(id: "suggested", title: "AI Suggestions", actions: suggested, sortOrder: -1))
        }

        return groups.sorted { $0.sortOrder < $1.sortOrder }
    }

    // MARK: - Section Display Helpers

    var sectionIcon: String {
        switch id {
        case "overdue": return "exclamationmark.circle.fill"
        case "today": return "sun.max.fill"
        case "tomorrow": return "sunrise.fill"
        case "this_week": return "calendar"
        case "this_month": return "calendar.circle"
        case "later": return "clock"
        case "no_date": return "tray"
        case "completed": return "checkmark.circle.fill"
        case "suggested": return "sparkles"
        default: return "list.bullet"
        }
    }

    var sectionColor: Color {
        switch id {
        case "overdue": return .red
        case "today": return .orange
        case "tomorrow": return .yellow
        case "this_week": return .blue
        case "this_month": return .indigo
        case "later": return .secondary
        case "no_date": return Color.secondary
        case "completed": return .green
        case "suggested": return .purple
        default: return .secondary
        }
    }
}

// MARK: - AnyCodableValue

/// A type-erased Codable value for storing arbitrary JSON data
enum AnyCodableValue: Codable, Equatable, Hashable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([AnyCodableValue])
    case dictionary([String: AnyCodableValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
            return
        }

        if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
            return
        }

        if let int = try? container.decode(Int.self) {
            self = .int(int)
            return
        }

        if let double = try? container.decode(Double.self) {
            self = .double(double)
            return
        }

        if let string = try? container.decode(String.self) {
            self = .string(string)
            return
        }

        if let array = try? container.decode([AnyCodableValue].self) {
            self = .array(array)
            return
        }

        if let dictionary = try? container.decode([String: AnyCodableValue].self) {
            self = .dictionary(dictionary)
            return
        }

        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unable to decode value")
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch self {
        case .string(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .dictionary(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let value) = self {
            return value
        }
        return nil
    }

    var intValue: Int? {
        if case .int(let value) = self {
            return value
        }
        return nil
    }

    var doubleValue: Double? {
        if case .double(let value) = self {
            return value
        }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self {
            return value
        }
        return nil
    }
}
