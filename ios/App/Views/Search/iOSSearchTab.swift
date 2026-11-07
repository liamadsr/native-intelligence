import SwiftUI

// MARK: - Filter Chip

struct iOSFilterChip: View {
    let filter: SearchFilter
    let isActive: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 5) {
                Image(systemName: filter.icon)
                    .font(.caption2.weight(.medium))
                Text(filter.displayName)
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(isActive ? Color(.systemBackground) : .secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                Capsule()
                    .fill(isActive ? Color.primary : Color(.systemGray5))
            )
        }
    }
}

// MARK: - Search Result Row

struct iOSSearchResultRow: View {
    let result: SearchResult

    private var resultColor: Color {
        Color(hex: result.color ?? "#6366F1")
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(resultColor.opacity(0.12))
                    .frame(width: 36, height: 36)
                Image(systemName: result.icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(resultColor)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(result.title)
                        .font(.body)
                        .lineLimit(1)

                    if let similarity = result.similarity {
                        Text("\(Int(similarity * 100))%")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(resultColor)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(resultColor.opacity(0.15)))
                    }
                }

                if let subtitle = result.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if result.type == .knowledge, let chunkText = result.chunkText, !chunkText.isEmpty {
                    Text(chunkText + "...")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                        .italic()
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Search Result Destination

struct iOSSearchResultDestination: View {
    let result: SearchResult

    var body: some View {
        switch result.type {
        case .knowledge, .note:
            if let noteId = result.noteId {
                iOSNoteDetailDestination(noteId: noteId)
            } else {
                Text("Note not found")
            }
        case .project:
            if let projectId = result.projectId {
                iOSProjectDetailDestination(projectId: projectId)
            } else {
                Text("Project not found")
            }
        case .action:
            if let actionId = result.actionId {
                iOSActionDetailDestination(actionId: actionId)
            } else {
                Text("Action not found")
            }
        case .contact:
            if let contactId = result.contactId {
                iOSContactDetailDestination(contactId: contactId)
            } else {
                Text("Contact not found")
            }
        }
    }
}

// MARK: - Detail Destinations (resolve IDs to model objects)

private struct iOSNoteDetailDestination: View {
    let noteId: UUID
    @StateObject private var notesService = NotesService.shared

    var body: some View {
        if let note = notesService.allNotesForSearch.first(where: { $0.id == noteId }) {
            iOSNoteDetailView(note: note)
        } else {
            ProgressView()
                .task { await notesService.fetchAllNotesForSearch() }
        }
    }
}

private struct iOSProjectDetailDestination: View {
    let projectId: UUID
    @StateObject private var projectsService = ProjectsService.shared

    var body: some View {
        if let project = projectsService.projects.first(where: { $0.id == projectId }) {
            iOSProjectDetailView(project: project)
        } else {
            ProgressView()
                .task { _ = try? await projectsService.fetchProjects() }
        }
    }
}

private struct iOSActionDetailDestination: View {
    let actionId: UUID
    @StateObject private var actionsService = ActionsService.shared

    var body: some View {
        if let action = actionsService.actions.first(where: { $0.id == actionId }) {
            iOSActionDetailView(action: action)
        } else {
            ProgressView()
                .task { _ = try? await actionsService.fetchActions() }
        }
    }
}

private struct iOSContactDetailDestination: View {
    let contactId: UUID
    @StateObject private var contactsService = ContactsService.shared

    var body: some View {
        if let contact = contactsService.contacts.first(where: { $0.id == contactId }) {
            iOSContactDetailView(contact: contact)
        } else {
            ProgressView()
                .task { _ = try? await contactsService.fetchContacts() }
        }
    }
}
