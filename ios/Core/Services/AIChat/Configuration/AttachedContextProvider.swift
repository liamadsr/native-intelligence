//
//  AttachedContextProvider.swift
//  Native Intelligence
//
//  Generates context blocks from AI context bar attachments
//  - Initial attachments go in system prompt with full meaningful context
//  - Mid-conversation attachments are prepended to user messages
//

import Foundation

/// Provides context generation for AI context bar attachments
@MainActor
class AttachedContextProvider {
    static let shared = AttachedContextProvider()

    private let projectsService = ProjectsService.shared
    private let notesService = NotesService.shared
    private let actionsService = ActionsService.shared
    private init() {}

    // MARK: - Date Formatter

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private static let dateTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

// MARK: - Attachment Changes Tracking

/// Represents changes in attachments since last check
struct AttachmentChanges: Equatable {
    var projectIds: Set<UUID> = []
    var noteIds: Set<UUID> = []
    var actionIds: Set<UUID> = []
    var workflowIds: Set<UUID> = []

    var isEmpty: Bool {
        projectIds.isEmpty && noteIds.isEmpty && actionIds.isEmpty && workflowIds.isEmpty
    }

    /// Calculate what was added between two selections
    static func added(from previous: AIContextSelection, to current: AIContextSelection) -> AttachmentChanges {
        AttachmentChanges(
            projectIds: current.selectedProjectIds.subtracting(previous.selectedProjectIds),
            noteIds: current.selectedNoteIds.subtracting(previous.selectedNoteIds),
            actionIds: current.selectedActionIds.subtracting(previous.selectedActionIds),
            workflowIds: current.selectedWorkflowIds.subtracting(previous.selectedWorkflowIds)
        )
    }

    /// Calculate what was removed between two selections
    static func removed(from previous: AIContextSelection, to current: AIContextSelection) -> AttachmentChanges {
        AttachmentChanges(
            projectIds: previous.selectedProjectIds.subtracting(current.selectedProjectIds),
            noteIds: previous.selectedNoteIds.subtracting(current.selectedNoteIds),
            actionIds: previous.selectedActionIds.subtracting(current.selectedActionIds),
            workflowIds: previous.selectedWorkflowIds.subtracting(current.selectedWorkflowIds)
        )
    }
}
