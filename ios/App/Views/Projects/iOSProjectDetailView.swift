import SwiftUI

struct iOSProjectDetailView: View {
    let project: KBProject
    @StateObject private var notesService = NotesService.shared
    @State private var projectNotes: [Note] = []
    @State private var isLoading = true

    var body: some View {
        List {
            // Project header
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Text(project.icon)
                            .font(.system(size: 32))

                        VStack(alignment: .leading) {
                            Text(project.name)
                                .font(.title2.bold())

                            if let description = project.description, !description.isEmpty {
                                Text(description)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            // Notes in this project
            Section("Notes") {
                if isLoading {
                    ProgressView()
                } else if projectNotes.isEmpty {
                    Text("No notes in this project")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(projectNotes) { note in
                        NavigationLink {
                            iOSNoteDetailView(note: note)
                        } label: {
                            iOSNoteRow(note: note)
                        }
                    }
                }
            }

            // Metadata
            Section("Details") {
                LabeledContent("Created", value: project.createdAt.formatted(date: .abbreviated, time: .omitted))
                LabeledContent("Updated", value: project.updatedAt.formatted(date: .abbreviated, time: .omitted))
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            isLoading = true
            projectNotes = notesService.notes.filter { $0.projectId == project.id }
            if projectNotes.isEmpty {
                // Fetch notes for this project if not already loaded
                if let notes = try? await notesService.fetchNotes(projectId: project.id) {
                    projectNotes = notes
                }
            }
            isLoading = false
        }
    }
}
