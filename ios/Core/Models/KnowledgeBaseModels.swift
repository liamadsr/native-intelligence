//
//  KnowledgeBaseModels.swift
//  dial8
//
//  Core models for projects, notes, and knowledge base system
//

import Foundation
import SwiftUI

// MARK: - Note Type

enum NoteType: String, Codable, CaseIterable {
    case meeting
    case journal
    case idea
    case webpage

    var displayName: String {
        switch self {
        case .meeting: return "Meeting"
        case .journal: return "Journal"
        case .idea: return "Idea"
        case .webpage: return "Webpage"
        }
    }

    var icon: String {
        switch self {
        case .meeting: return "video.fill"
        case .journal: return "book.fill"
        case .idea: return "lightbulb.fill"
        case .webpage: return "globe"
        }
    }

    var color: String {
        switch self {
        case .meeting: return "#3B82F6" // Blue
        case .journal: return "#8B5CF6" // Purple
        case .idea: return "#F59E0B" // Amber
        case .webpage: return "#10B981" // Green
        }
    }
}

// MARK: - Note Status

enum NoteStatus: String, Codable, CaseIterable {
    case draft
    case active
    case archived

    var displayName: String {
        switch self {
        case .draft: return "Draft"
        case .active: return "Active"
        case .archived: return "Archived"
        }
    }

    var icon: String {
        switch self {
        case .draft: return "doc.badge.clock"
        case .active: return "doc.fill"
        case .archived: return "archivebox.fill"
        }
    }
}

// MARK: - KBProject Model (Knowledge Base Project)

struct KBProject: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    let userId: UUID

    // Project details
    var name: String
    var description: String?
    var icon: String
    var color: String

    // Organization
    var parentProjectId: UUID?
    var sortOrder: Int

    // Settings
    var isArchived: Bool
    var isPinned: Bool

    // Workspace scoping (NOT NULL in the live schema)
    var workspaceId: UUID?

    // Timestamps
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case name
        case description
        case icon
        case color
        case parentProjectId = "parent_project_id"
        case sortOrder = "sort_order"
        case isArchived = "is_archived"
        case isPinned = "is_pinned"
        case workspaceId = "workspace_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(
        id: UUID = UUID(),
        userId: UUID,
        name: String,
        description: String? = nil,
        icon: String = "folder",
        color: String = "#6366F1",
        parentProjectId: UUID? = nil,
        sortOrder: Int = 0,
        isArchived: Bool = false,
        isPinned: Bool = false,
        workspaceId: UUID? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.userId = userId
        self.name = name
        self.description = description
        self.icon = icon
        self.color = color
        self.parentProjectId = parentProjectId
        self.sortOrder = sortOrder
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.workspaceId = workspaceId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    // Decode defensively: several columns are nullable in the live schema
    // and `workspace_id` may be absent from older selects.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        userId = try c.decode(UUID.self, forKey: .userId)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? "folder"
        color = try c.decodeIfPresent(String.self, forKey: .color) ?? "#6366F1"
        parentProjectId = try c.decodeIfPresent(UUID.self, forKey: .parentProjectId)
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
        isArchived = try c.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        workspaceId = try c.decodeIfPresent(UUID.self, forKey: .workspaceId)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
    }

    static func == (lhs: KBProject, rhs: KBProject) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

// MARK: - Meeting Participant Model

/// Represents a participant in a meeting, enriched with CRM contact data if available
/// Participants can be identified by email, contactId, or both. At least one identifier should be present.
struct MeetingParticipant: Codable, Identifiable, Equatable, Hashable {
    /// Unique identifier - uses contactId if available, otherwise email, otherwise generates from name
    var id: String {
        if let contactId = contactId {
            return contactId.uuidString
        }
        if let email = email, !email.isEmpty {
            return email
        }
        // Fallback: use name hash for contacts without email or contactId
        return name ?? "unknown"
    }

    var email: String?  // Optional - contacts may not have email
    var name: String?
    var contactId: UUID?  // Link to CRM contact
    var isOrganizer: Bool

    // Enriched fields from CRM Contact (optional)
    var company: String?
    var jobTitle: String?

    init(email: String? = nil, name: String? = nil, contactId: UUID? = nil, isOrganizer: Bool = false, company: String? = nil, jobTitle: String? = nil) {
        self.email = email
        self.name = name
        self.contactId = contactId
        self.isOrganizer = isOrganizer
        self.company = company
        self.jobTitle = jobTitle
    }

    enum CodingKeys: String, CodingKey {
        case email
        case name
        case contactId = "contactId"
        case isOrganizer = "isOrganizer"
        case company
        case jobTitle = "jobTitle"
    }

    /// Display name - uses name if available, otherwise extracts from email
    var displayName: String {
        if let name = name, !name.isEmpty {
            return name
        }
        if let email = email {
            return Self.extractNameFromEmail(email)
        }
        return "Unknown"
    }

    /// Enriched display name including job title and company from CRM
    /// Example: "John Wheeler, CEO at Acme Corp"
    var enrichedDisplayName: String {
        var parts = [displayName]
        if let title = jobTitle, !title.isEmpty {
            parts.append(title)
        }
        if let co = company, !co.isEmpty {
            parts.append("at \(co)")
        }
        return parts.joined(separator: ", ")
    }

    /// Extract a display name from an email address
    /// "alex.rivera@example.com" -> "Alex Rivera"
    static func extractNameFromEmail(_ email: String) -> String {
        guard let localPart = email.split(separator: "@").first else {
            return email
        }
        return String(localPart)
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}

// MARK: - Note Model

struct Note: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    let userId: UUID
    /// The workspace the row actually lives in. Decode-only and optional: not
    /// every source of a Note carries it (locally constructed notes don't), and
    /// older cached payloads predate it.
    ///
    /// Load-bearing for `CaptureRecoveryService`: `fetchNote` reads by id +
    /// user_id with NO workspace filter, so it happily returns a capture from
    /// any workspace the user belongs to, while every recovery write is stamped
    /// with the ACTIVE workspace and would be rejected server-side. This is the
    /// field that lets recovery refuse a cross-workspace write.
    var workspaceId: UUID?
    var projectId: UUID?  // Optional - notes can exist without a project

    // Core content
    var type: NoteType
    var title: String
    var content: String?
    var summary: String?

    // For voice-based notes
    var transcript: String?       // Original whisper output, never modified after recording
    var userNotes: String?        // Manual notes added by user for context/enrichment
    var audioUrl: String?
    var durationSeconds: Int?

    // For webpages
    var sourceUrl: String?

    // Calendar event data (for meeting notes linked to calendar events)
    var calendarEventId: String?  // EventKit calendar event ID
    var meetingUrl: String?       // Meeting URL (Zoom, Teams, Meet, etc.)
    var location: String?         // Meeting location
    var organizerEmail: String?   // Email of the meeting organizer
    var participants: [MeetingParticipant]  // Enriched participant list

    // Metadata
    var tags: [String]
    var metadata: [String: AnyCodableValue]?

    // AI context
    var aiProcessed: Bool
    var aiSummary: String?

    // Status
    var status: NoteStatus
    var isPinned: Bool

    // Timestamps
    var recordedAt: Date?
    /// When recording actually began. A capture row created by the recorder has
    /// it; a calendar-placeholder row (a scheduled meeting nobody recorded) does
    /// not — which is what separates "interrupted recording" from "future
    /// meeting" when `endedAt` is nil for both.
    var startedAt: Date?
    /// When the capture was finalized (PATCH ended_at). **nil means the recording
    /// never finished** — an abandoned capture, not one that is still processing.
    /// Every "is the server still working on this?" check keys off this.
    var endedAt: Date?
    /// When the batch extraction wrote the summary. Diagnostic: a row with
    /// `endedAt` set but this nil is one whose batch run never landed.
    var batchProcessedAt: Date?
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case workspaceId = "workspace_id"
        case projectId = "project_id"
        case type
        case title
        case content
        case summary
        case transcript
        case userNotes = "user_notes"
        case audioUrl = "audio_url"
        case durationSeconds = "duration_seconds"
        case sourceUrl = "source_url"
        case calendarEventId = "calendar_event_id"
        case meetingUrl = "meeting_url"
        case location
        case organizerEmail = "organizer_email"
        case participants
        case tags
        case metadata
        case aiProcessed = "ai_processed"
        case aiSummary = "ai_summary"
        case status
        case isPinned = "is_pinned"
        case recordedAt = "recorded_at"
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case batchProcessedAt = "batch_processed_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(
        id: UUID = UUID(),
        userId: UUID,
        workspaceId: UUID? = nil,
        projectId: UUID? = nil,
        type: NoteType,
        title: String,
        content: String? = nil,
        summary: String? = nil,
        transcript: String? = nil,
        userNotes: String? = nil,
        audioUrl: String? = nil,
        durationSeconds: Int? = nil,
        sourceUrl: String? = nil,
        calendarEventId: String? = nil,
        meetingUrl: String? = nil,
        location: String? = nil,
        organizerEmail: String? = nil,
        participants: [MeetingParticipant] = [],
        tags: [String] = [],
        metadata: [String: AnyCodableValue]? = nil,
        aiProcessed: Bool = false,
        aiSummary: String? = nil,
        status: NoteStatus = .active,
        isPinned: Bool = false,
        recordedAt: Date? = nil,
        startedAt: Date? = nil,
        endedAt: Date? = nil,
        batchProcessedAt: Date? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.userId = userId
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.type = type
        self.title = title
        self.content = content
        self.summary = summary
        self.transcript = transcript
        self.userNotes = userNotes
        self.audioUrl = audioUrl
        self.durationSeconds = durationSeconds
        self.sourceUrl = sourceUrl
        self.calendarEventId = calendarEventId
        self.meetingUrl = meetingUrl
        self.location = location
        self.organizerEmail = organizerEmail
        self.participants = participants
        self.tags = tags
        self.metadata = metadata
        self.aiProcessed = aiProcessed
        self.aiSummary = aiSummary
        self.status = status
        self.isPinned = isPinned
        self.recordedAt = recordedAt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.batchProcessedAt = batchProcessedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    // MARK: - Custom Decoder

    /// Custom decoder to handle edge cases where array fields might be returned as numbers (0) from the database
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        // Required fields
        id = try container.decode(UUID.self, forKey: .id)
        userId = try container.decode(UUID.self, forKey: .userId)
        workspaceId = try container.decodeIfPresent(UUID.self, forKey: .workspaceId)
        // The backend `captures` table has no `type` column (note vs meeting vs
        // webpage is an iOS-only concept). Default to .meeting when absent so
        // captures rows decode. `sourceUrl` present → treat it as a webpage.
        if let decodedType = try container.decodeIfPresent(NoteType.self, forKey: .type) {
            type = decodedType
        } else if (try? container.decodeIfPresent(String.self, forKey: .sourceUrl)) ?? nil != nil {
            type = .webpage
        } else {
            type = .meeting
        }
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)

        // Optional simple fields
        projectId = try container.decodeIfPresent(UUID.self, forKey: .projectId)
        content = try container.decodeIfPresent(String.self, forKey: .content)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        transcript = try container.decodeIfPresent(String.self, forKey: .transcript)
        userNotes = try container.decodeIfPresent(String.self, forKey: .userNotes)
        audioUrl = try container.decodeIfPresent(String.self, forKey: .audioUrl)
        durationSeconds = try container.decodeIfPresent(Int.self, forKey: .durationSeconds)
        sourceUrl = try container.decodeIfPresent(String.self, forKey: .sourceUrl)
        calendarEventId = try container.decodeIfPresent(String.self, forKey: .calendarEventId)
        meetingUrl = try container.decodeIfPresent(String.self, forKey: .meetingUrl)
        location = try container.decodeIfPresent(String.self, forKey: .location)
        organizerEmail = try container.decodeIfPresent(String.self, forKey: .organizerEmail)
        aiProcessed = try container.decodeIfPresent(Bool.self, forKey: .aiProcessed) ?? false
        aiSummary = try container.decodeIfPresent(String.self, forKey: .aiSummary)
        status = try container.decodeIfPresent(NoteStatus.self, forKey: .status) ?? .active
        isPinned = try container.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        recordedAt = try container.decodeIfPresent(Date.self, forKey: .recordedAt)
        // Tolerant of absence AND of null: a locally-constructed Note (iOS-only
        // note types) never carries these, and an in-flight capture has them null.
        startedAt = try? container.decodeIfPresent(Date.self, forKey: .startedAt)
        endedAt = try? container.decodeIfPresent(Date.self, forKey: .endedAt)
        batchProcessedAt = try? container.decodeIfPresent(Date.self, forKey: .batchProcessedAt)
        metadata = try container.decodeIfPresent([String: AnyCodableValue].self, forKey: .metadata)

        // Handle participants - might be 0 (number) instead of [] (array) in some edge cases
        if let participantsArray = try? container.decode([MeetingParticipant].self, forKey: .participants) {
            participants = participantsArray
        } else {
            // If decoding as array fails (e.g., it's a number), use empty array
            participants = []
        }

        // Handle tags - same issue as participants
        if let tagsArray = try? container.decode([String].self, forKey: .tags) {
            tags = tagsArray
        } else {
            tags = []
        }
    }

    // MARK: - Computed Properties

    var formattedDuration: String? {
        guard let seconds = durationSeconds else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let secs = seconds % 60

        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        } else {
            return String(format: "%d:%02d", minutes, secs)
        }
    }

    var displayContent: String {
        // Return content, transcript, or summary - whichever is available
        if let content = content, !content.isEmpty {
            return content
        }
        if let transcript = transcript, !transcript.isEmpty {
            return transcript
        }
        if let summary = summary, !summary.isEmpty {
            return summary
        }
        return ""
    }

    var contentPreview: String {
        let text = displayContent
        if text.count > 200 {
            return String(text.prefix(200)) + "..."
        }
        return text
    }

    var isVoiceBased: Bool {
        type == .meeting || type == .journal
    }

    /// A recording that was started and never finished: the app was killed (or
    /// crashed) between `POST /api/account/captures` and the finalizing PATCH, so
    /// the row has `started_at` but no `ended_at` and nothing downstream will
    /// ever touch it.
    ///
    /// `startedAt` is the load-bearing half. A calendar-placeholder row — a
    /// scheduled meeting nobody recorded — also has `ended_at` NULL, and calling
    /// every one of those "interrupted" would be worse than the bug this fixes.
    ///
    /// The grace period exists because a LIVE recording's row looks exactly like
    /// an abandoned one while it is being recorded. Two minutes is comfortably
    /// longer than the gap between the create POST and the finalizing PATCH on
    /// any normal stop, and far shorter than a recording anyone would abandon.
    static let interruptedGracePeriod: TimeInterval = 120

    var isInterrupted: Bool {
        guard let startedAt, endedAt == nil else { return false }
        return Date().timeIntervalSince(startedAt) > Self.interruptedGracePeriod
    }

    var formattedDate: String {
        let formatter = DateFormatter()
        let calendar = Calendar.current

        let dateToFormat = recordedAt ?? createdAt

        if calendar.isDateInToday(dateToFormat) {
            formatter.timeStyle = .short
            formatter.dateStyle = .none
            return "Today at \(formatter.string(from: dateToFormat))"
        }

        if calendar.isDateInYesterday(dateToFormat) {
            formatter.timeStyle = .short
            formatter.dateStyle = .none
            return "Yesterday at \(formatter.string(from: dateToFormat))"
        }

        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: dateToFormat)
    }

    static func == (lhs: Note, rhs: Note) -> Bool {
        // Compare all fields that affect display, not just ID
        // This ensures SwiftUI re-renders when note content changes
        lhs.id == rhs.id &&
        lhs.title == rhs.title &&
        lhs.content == rhs.content &&
        lhs.summary == rhs.summary &&
        lhs.transcript == rhs.transcript &&
        lhs.userNotes == rhs.userNotes &&
        lhs.aiSummary == rhs.aiSummary &&
        lhs.aiProcessed == rhs.aiProcessed &&
        lhs.type == rhs.type &&
        lhs.projectId == rhs.projectId &&
        lhs.status == rhs.status &&
        lhs.isPinned == rhs.isPinned &&
        lhs.durationSeconds == rhs.durationSeconds &&
        lhs.tags == rhs.tags &&
        lhs.updatedAt == rhs.updatedAt &&
        lhs.calendarEventId == rhs.calendarEventId &&
        lhs.participants == rhs.participants
    }

    func hash(into hasher: inout Hasher) {
        // Hash all fields used in Equatable to maintain consistency
        // (equal objects must have equal hashes)
        hasher.combine(id)
        hasher.combine(title)
        hasher.combine(content)
        hasher.combine(summary)
        hasher.combine(transcript)
        hasher.combine(userNotes)
        hasher.combine(aiSummary)
        hasher.combine(aiProcessed)
        hasher.combine(type)
        hasher.combine(projectId)
        hasher.combine(status)
        hasher.combine(isPinned)
        hasher.combine(durationSeconds)
        hasher.combine(tags)
        hasher.combine(updatedAt)
        hasher.combine(calendarEventId)
        hasher.combine(participants)
    }

    /// Check if this note has calendar event data attached
    var hasCalendarEventData: Bool {
        calendarEventId != nil
    }

    /// Get the meeting organizer participant
    var organizer: MeetingParticipant? {
        participants.first { $0.isOrganizer }
    }

    /// Get non-organizer participants
    var attendees: [MeetingParticipant] {
        participants.filter { !$0.isOrganizer }
    }

    /// Formatted participant names for AI prompt injection
    var formattedParticipantNames: String {
        participants.map { participant in
            var line = "- \(participant.displayName)"
            if let email = participant.email, !email.isEmpty {
                line += " (\(email))"
            }
            if participant.isOrganizer {
                line += " - Organizer"
            }
            return line
        }.joined(separator: "\n")
    }

    /// Check if this note has action items in metadata
    var hasActionItems: Bool {
        guard let metadata = metadata,
              case .array(let items) = metadata["actionItems"] else {
            return false
        }
        return !items.isEmpty
    }

    /// Get action items from metadata (if any)
    var actionItems: [[String: Any]]? {
        guard let metadata = metadata,
              case .array(let items) = metadata["actionItems"] else {
            return nil
        }
        return items.compactMap { item -> [String: Any]? in
            if case .dictionary(let dict) = item {
                var result: [String: Any] = [:]
                for (key, value) in dict {
                    switch value {
                    case .string(let str): result[key] = str
                    case .int(let num): result[key] = num
                    case .double(let num): result[key] = num
                    case .bool(let bool): result[key] = bool
                    default: break
                    }
                }
                return result
            }
            return nil
        }
    }
}

// MARK: - Search Result Models

struct NoteSearchResult: Codable, Identifiable {
    let chunkId: UUID
    let noteId: UUID
    let projectId: UUID?  // Optional - some notes may not have a project
    let chunkText: String
    let chunkIndex: Int
    let noteTitle: String
    let noteType: NoteType
    let similarity: Float

    var id: UUID { chunkId }

    enum CodingKeys: String, CodingKey {
        case chunkId = "chunk_id"
        case noteId = "note_id"
        case projectId = "project_id"
        case chunkText = "chunk_text"
        case chunkIndex = "chunk_index"
        case noteTitle = "note_title"
        case noteType = "note_type"
        case similarity
    }
}

// MARK: - Create DTOs

struct CreateProjectDTO: Codable {
    let name: String
    let description: String?
    let icon: String?
    let color: String?
    let parentProjectId: UUID?

    enum CodingKeys: String, CodingKey {
        case name
        case description
        case icon
        case color
        case parentProjectId = "parent_project_id"
    }

    init(
        name: String,
        description: String? = nil,
        icon: String? = nil,
        color: String? = nil,
        parentProjectId: UUID? = nil
    ) {
        self.name = name
        self.description = description
        self.icon = icon
        self.color = color
        self.parentProjectId = parentProjectId
    }
}

struct CreateNoteDTO: Codable {
    let projectId: UUID?  // Optional - notes can be created without a project
    let type: String
    let title: String
    let content: String?
    let transcript: String?
    let audioUrl: String?
    let durationSeconds: Int?
    let sourceUrl: String?
    let calendarEventId: String?
    let meetingUrl: String?
    let location: String?
    let organizerEmail: String?
    let participants: [MeetingParticipant]?
    let tags: [String]?
    let recordedAt: Date?

    enum CodingKeys: String, CodingKey {
        case projectId = "project_id"
        case type
        case title
        case content
        case transcript
        case audioUrl = "audio_url"
        case durationSeconds = "duration_seconds"
        case sourceUrl = "source_url"
        case calendarEventId = "calendar_event_id"
        case meetingUrl = "meeting_url"
        case location
        case organizerEmail = "organizer_email"
        case participants
        case tags
        case recordedAt = "recorded_at"
    }

    init(
        projectId: UUID? = nil,
        type: NoteType,
        title: String,
        content: String? = nil,
        transcript: String? = nil,
        audioUrl: String? = nil,
        durationSeconds: Int? = nil,
        sourceUrl: String? = nil,
        calendarEventId: String? = nil,
        meetingUrl: String? = nil,
        location: String? = nil,
        organizerEmail: String? = nil,
        participants: [MeetingParticipant]? = nil,
        tags: [String]? = nil,
        recordedAt: Date? = nil
    ) {
        self.projectId = projectId
        self.type = type.rawValue
        self.title = title
        self.content = content
        self.transcript = transcript
        self.audioUrl = audioUrl
        self.durationSeconds = durationSeconds
        self.sourceUrl = sourceUrl
        self.calendarEventId = calendarEventId
        self.meetingUrl = meetingUrl
        self.location = location
        self.organizerEmail = organizerEmail
        self.participants = participants
        self.tags = tags
        self.recordedAt = recordedAt
    }
}

// MARK: - Update DTOs

struct UpdateNoteDTO: Codable {
    var projectId: UUID?  // Can be set to move note to a project
    var type: String?     // Can update note type
    var title: String?
    var content: String?
    var transcript: String?
    var userNotes: String?
    var summary: String?
    var aiSummary: String?
    var aiProcessed: Bool?
    var calendarEventId: String?
    var meetingUrl: String?
    var location: String?
    var organizerEmail: String?
    var participants: [MeetingParticipant]?
    var tags: [String]?
    var metadata: [String: AnyCodableValue]?  // For storing action items, insights, etc.
    var status: String?
    var isPinned: Bool?
    var durationSeconds: Int?

    enum CodingKeys: String, CodingKey {
        case projectId = "project_id"
        case type
        case title
        case content
        case transcript
        case userNotes = "user_notes"
        case summary
        case aiSummary = "ai_summary"
        case aiProcessed = "ai_processed"
        case calendarEventId = "calendar_event_id"
        case meetingUrl = "meeting_url"
        case location
        case organizerEmail = "organizer_email"
        case participants
        case tags
        case metadata
        case status
        case isPinned = "is_pinned"
        case durationSeconds = "duration_seconds"
    }
}

// MARK: - AI Context Selection

/// Represents the projects, notes, actions, and workflows currently selected for AI context
struct AIContextSelection: Equatable {
    var selectedProjectIds: Set<UUID>
    var selectedNoteIds: Set<UUID>
    var selectedActionIds: Set<UUID>
    var selectedWorkflowIds: Set<UUID>

    init(
        selectedProjectIds: Set<UUID> = [],
        selectedNoteIds: Set<UUID> = [],
        selectedActionIds: Set<UUID> = [],
        selectedWorkflowIds: Set<UUID> = []
    ) {
        self.selectedProjectIds = selectedProjectIds
        self.selectedNoteIds = selectedNoteIds
        self.selectedActionIds = selectedActionIds
        self.selectedWorkflowIds = selectedWorkflowIds
    }

    var isEmpty: Bool {
        selectedProjectIds.isEmpty && selectedNoteIds.isEmpty && selectedActionIds.isEmpty && selectedWorkflowIds.isEmpty
    }

    var projectCount: Int {
        selectedProjectIds.count
    }

    var noteCount: Int {
        selectedNoteIds.count
    }

    var actionCount: Int {
        selectedActionIds.count
    }

    var workflowCount: Int {
        selectedWorkflowIds.count
    }

    /// Total count of selected items (projects + notes + actions + workflows)
    var count: Int {
        selectedProjectIds.count + selectedNoteIds.count + selectedActionIds.count + selectedWorkflowIds.count
    }

    // MARK: - Project Methods

    mutating func toggleProject(_ projectId: UUID) {
        if selectedProjectIds.contains(projectId) {
            selectedProjectIds.remove(projectId)
        } else {
            selectedProjectIds.insert(projectId)
        }
    }

    mutating func addProject(_ projectId: UUID) {
        selectedProjectIds.insert(projectId)
    }

    mutating func removeProject(_ projectId: UUID) {
        selectedProjectIds.remove(projectId)
    }

    func containsProject(_ projectId: UUID) -> Bool {
        selectedProjectIds.contains(projectId)
    }

    // MARK: - Note Methods

    mutating func toggleNote(_ noteId: UUID) {
        if selectedNoteIds.contains(noteId) {
            selectedNoteIds.remove(noteId)
        } else {
            selectedNoteIds.insert(noteId)
        }
    }

    mutating func addNote(_ noteId: UUID) {
        selectedNoteIds.insert(noteId)
    }

    mutating func removeNote(_ noteId: UUID) {
        selectedNoteIds.remove(noteId)
    }

    func containsNote(_ noteId: UUID) -> Bool {
        selectedNoteIds.contains(noteId)
    }

    // MARK: - Action Methods

    mutating func toggleAction(_ actionId: UUID) {
        if selectedActionIds.contains(actionId) {
            selectedActionIds.remove(actionId)
        } else {
            selectedActionIds.insert(actionId)
        }
    }

    mutating func addAction(_ actionId: UUID) {
        selectedActionIds.insert(actionId)
    }

    mutating func removeAction(_ actionId: UUID) {
        selectedActionIds.remove(actionId)
    }

    func containsAction(_ actionId: UUID) -> Bool {
        selectedActionIds.contains(actionId)
    }

    // MARK: - Workflow Methods

    mutating func toggleWorkflow(_ workflowId: UUID) {
        if selectedWorkflowIds.contains(workflowId) {
            selectedWorkflowIds.remove(workflowId)
        } else {
            selectedWorkflowIds.insert(workflowId)
        }
    }

    mutating func addWorkflow(_ workflowId: UUID) {
        selectedWorkflowIds.insert(workflowId)
    }

    mutating func removeWorkflow(_ workflowId: UUID) {
        selectedWorkflowIds.remove(workflowId)
    }

    func containsWorkflow(_ workflowId: UUID) -> Bool {
        selectedWorkflowIds.contains(workflowId)
    }

    // MARK: - Clear Methods

    mutating func clear() {
        selectedProjectIds.removeAll()
        selectedNoteIds.removeAll()
        selectedActionIds.removeAll()
        selectedWorkflowIds.removeAll()
    }

    mutating func clearProjects() {
        selectedProjectIds.removeAll()
    }

    mutating func clearNotes() {
        selectedNoteIds.removeAll()
    }

    mutating func clearActions() {
        selectedActionIds.removeAll()
    }

    mutating func clearWorkflows() {
        selectedWorkflowIds.removeAll()
    }

    // MARK: - Array Accessors

    var projectIdsArray: [UUID] {
        Array(selectedProjectIds)
    }

    var noteIdsArray: [UUID] {
        Array(selectedNoteIds)
    }

    var actionIdsArray: [UUID] {
        Array(selectedActionIds)
    }

    var workflowIdsArray: [UUID] {
        Array(selectedWorkflowIds)
    }
}

// MARK: - Note Grouping

struct NoteGroup: Identifiable {
    let id: String
    let title: String
    let notes: [Note]
    let sortOrder: Int

    /// Groups notes by creation/recording date into time-based sections.
    /// Uses relative day boundaries so the hierarchy is consistent whether
    /// you're in the Unassigned folder or a dedicated project with old recordings.
    static func groupByDate(_ notes: [Note]) -> [NoteGroup] {
        // Pre-compute date boundaries once
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: Date())
        let startOfYesterday = calendar.date(byAdding: .day, value: -1, to: startOfToday)!
        let startOf7DaysAgo = calendar.date(byAdding: .day, value: -7, to: startOfToday)!
        let startOf14DaysAgo = calendar.date(byAdding: .day, value: -14, to: startOfToday)!
        let startOf30DaysAgo = calendar.date(byAdding: .day, value: -30, to: startOfToday)!

        // Buckets for single-pass classification
        var today: [Note] = []
        var yesterday: [Note] = []
        var thisWeek: [Note] = []
        var lastTwoWeeks: [Note] = []
        var thisMonth: [Note] = []
        var older: [Note] = []

        for note in notes {
            let date = note.recordedAt ?? note.createdAt

            if date >= startOfToday {
                today.append(note)
            } else if date >= startOfYesterday {
                yesterday.append(note)
            } else if date >= startOf7DaysAgo {
                thisWeek.append(note)
            } else if date >= startOf14DaysAgo {
                lastTwoWeeks.append(note)
            } else if date >= startOf30DaysAgo {
                thisMonth.append(note)
            } else {
                older.append(note)
            }
        }

        var groups: [NoteGroup] = []

        if !today.isEmpty {
            groups.append(NoteGroup(id: "today", title: "Today", notes: today, sortOrder: 0))
        }
        if !yesterday.isEmpty {
            groups.append(NoteGroup(id: "yesterday", title: "Yesterday", notes: yesterday, sortOrder: 1))
        }
        if !thisWeek.isEmpty {
            groups.append(NoteGroup(id: "this_week", title: "This Week", notes: thisWeek, sortOrder: 2))
        }
        if !lastTwoWeeks.isEmpty {
            groups.append(NoteGroup(id: "last_two_weeks", title: "Last 2 Weeks", notes: lastTwoWeeks, sortOrder: 3))
        }
        if !thisMonth.isEmpty {
            groups.append(NoteGroup(id: "this_month", title: "This Month", notes: thisMonth, sortOrder: 4))
        }
        if !older.isEmpty {
            groups.append(NoteGroup(id: "older", title: "Older", notes: older, sortOrder: 5))
        }

        return groups.sorted { $0.sortOrder < $1.sortOrder }
    }

    static func groupByType(_ notes: [Note]) -> [NoteGroup] {
        var groups: [NoteGroup] = []

        for noteType in NoteType.allCases {
            let filtered = notes.filter { $0.type == noteType }
            if !filtered.isEmpty {
                groups.append(NoteGroup(
                    id: noteType.rawValue,
                    title: noteType.displayName + "s",
                    notes: filtered,
                    sortOrder: NoteType.allCases.firstIndex(of: noteType) ?? 0
                ))
            }
        }

        return groups.sorted { $0.sortOrder < $1.sortOrder }
    }

    // MARK: - Section Display Helpers

    var sectionIcon: String {
        switch id {
        case "today": return "sun.max.fill"
        case "yesterday": return "sunset.fill"
        case "this_week": return "calendar"
        case "last_two_weeks": return "calendar.badge.clock"
        case "this_month": return "calendar.circle"
        case "older": return "clock"
        default: return "list.bullet"
        }
    }

    var sectionColor: Color {
        switch id {
        case "today": return .orange
        case "yesterday": return .yellow
        case "this_week": return .blue
        case "last_two_weeks": return .indigo
        case "this_month": return .indigo
        case "older": return .secondary
        default: return .secondary
        }
    }
}
