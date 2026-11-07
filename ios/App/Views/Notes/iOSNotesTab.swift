import SwiftUI

struct iOSNotesTab: View {
    @StateObject private var notesService = NotesService.shared
    @State private var searchText = ""
    @State private var showingRecordingSheet = false

    var body: some View {
        NavigationStack {
            Group {
                if notesService.isLoading && notesService.allNotesForSearch.isEmpty {
                    ProgressView("Loading notes...")
                } else if filteredNotes.isEmpty {
                    ContentUnavailableView(
                        "No Notes",
                        systemImage: "note.text",
                        description: Text("Your notes will appear here")
                    )
                } else {
                    List(filteredNotes) { note in
                        NavigationLink {
                            iOSNoteDetailView(note: note)
                        } label: {
                            iOSNoteRow(note: note)
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingRecordingSheet = true
                    } label: {
                        Label("Record", systemImage: "mic.fill")
                    }
                }
            }
            .sheet(isPresented: $showingRecordingSheet) {
                iOSVoiceNoteRecordingView()
            }
            .searchable(text: $searchText, prompt: "Search notes")
            .refreshable {
                await notesService.fetchAllNotesForSearch()
            }
            .task {
                if notesService.allNotesForSearch.isEmpty {
                    await notesService.fetchAllNotesForSearch()
                }
            }
        }
    }

    private var filteredNotes: [Note] {
        if searchText.isEmpty {
            return notesService.allNotesForSearch
        }
        return notesService.allNotesForSearch.filter { note in
            note.title.localizedCaseInsensitiveContains(searchText) ||
            (note.content ?? "").localizedCaseInsensitiveContains(searchText) ||
            (note.summary ?? "").localizedCaseInsensitiveContains(searchText)
        }
    }
}
