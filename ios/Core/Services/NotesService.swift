//
//  NotesService.swift
//  Native Intelligence
//
//  Service for managing notes with Supabase backend and vector search
//

import Foundation
import Combine

// MARK: - Notes Error

enum NotesError: LocalizedError {
    case authRequired
    case noteNotFound
    case projectNotFound
    case invalidData
    case embeddingFailed
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .authRequired:
            return "Authentication required to manage notes"
        case .noteNotFound:
            return "Note not found"
        case .projectNotFound:
            return "Project not found"
        case .invalidData:
            return "Invalid note data"
        case .embeddingFailed:
            return "Failed to generate embeddings"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

// MARK: - Notes Service

class NotesService: ObservableObject {
    static let shared = NotesService()

    // MARK: - Published Properties

    @Published private(set) var notes: [Note] = []
    @Published private(set) var isLoading = false
    @Published private(set) var error: Error?

    // Current project context
    @Published var currentProjectId: UUID?

    // MARK: - Cached Computed Properties

    private var _cachedActiveNotes: [Note]?
    private var _cachedPinnedNotes: [Note]?
    private var _cachedMeetingNotes: [Note]?
    private var _cachedJournalEntries: [Note]?
    private var _cachedIdeas: [Note]?
    private var _cachedWebpages: [Note]?
    private var _cachedNoteCountByProject: [UUID: Int]?

    var activeNotes: [Note] {
        if let cached = _cachedActiveNotes { return cached }
        let result = notes.filter { $0.status == .active }
        _cachedActiveNotes = result
        return result
    }

    var pinnedNotes: [Note] {
        if let cached = _cachedPinnedNotes { return cached }
        let result = notes.filter { $0.isPinned && $0.status == .active }
        _cachedPinnedNotes = result
        return result
    }

    var noteCount: Int {
        activeNotes.count
    }

    var meetingNotes: [Note] {
        if let cached = _cachedMeetingNotes { return cached }
        let result = notes.filter { $0.type == .meeting && $0.status == .active }
        _cachedMeetingNotes = result
        return result
    }

    var journalEntries: [Note] {
        if let cached = _cachedJournalEntries { return cached }
        let result = notes.filter { $0.type == .journal && $0.status == .active }
        _cachedJournalEntries = result
        return result
    }

    var ideas: [Note] {
        if let cached = _cachedIdeas { return cached }
        let result = notes.filter { $0.type == .idea && $0.status == .active }
        _cachedIdeas = result
        return result
    }

    var webpages: [Note] {
        if let cached = _cachedWebpages { return cached }
        let result = notes.filter { $0.type == .webpage && $0.status == .active }
        _cachedWebpages = result
        return result
    }

    /// Pre-computed note count per project — O(1) lookup instead of O(n) filter
    var noteCountByProject: [UUID: Int] {
        if let cached = _cachedNoteCountByProject { return cached }
        var counts: [UUID: Int] = [:]
        for note in allNotesForSearch {
            if let projectId = note.projectId {
                counts[projectId, default: 0] += 1
            }
        }
        _cachedNoteCountByProject = counts
        return counts
    }

    private func invalidateNotesCaches() {
        _cachedActiveNotes = nil
        _cachedPinnedNotes = nil
        _cachedMeetingNotes = nil
        _cachedJournalEntries = nil
        _cachedIdeas = nil
        _cachedWebpages = nil
        _cachedNoteCountByProject = nil
    }

    // MARK: - Private Properties

    private let supabase = SupabaseManager.shared
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Initialization

    private init() {
        setupCacheInvalidation()
        setupAuthObserver()
        setupWorkspaceObserver()
    }

    /// Switching workspaces invalidates every cached note: `captures` is
    /// workspace-scoped, so the rows on screen belong to the workspace we just
    /// left. Clear FIRST (synchronously, on the main actor) so no frame ever
    /// renders the old workspace's captures under the new one's name, then
    /// refetch what Home reads.
    private func setupWorkspaceObserver() {
        NotificationCenter.default.publisher(for: .workspaceDidChange)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.notes = []
                    self.allNotesForSearch = []
                    self.hasPerformedFullNotesSearch = false
                    self.currentProjectId = nil
                    self.error = nil
                    self.isLoading = false
                    self.invalidateNotesCaches()
                    print("📝 NotesService: cleared caches for workspace switch")
                    await self.fetchAllNotesForSearch()
                }
            }
            .store(in: &cancellables)
    }

    private func setupCacheInvalidation() {
        $notes
            .sink { [weak self] _ in self?.invalidateNotesCaches() }
            .store(in: &cancellables)
        $allNotesForSearch
            .sink { [weak self] _ in self?._cachedNoteCountByProject = nil }
            .store(in: &cancellables)
    }

    private func setupAuthObserver() {
        NotificationCenter.default.publisher(for: .authenticationComplete)
            .sink { [weak self] _ in
                // Don't auto-fetch - wait for project selection
                self?.notes = []
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .userSignedOut)
            .sink { [weak self] _ in
                Task { @MainActor in
                    // EVERY per-user cache has to be cleared here. `allNotesForSearch`
                    // is the array Home renders, so leaving it populated let a second
                    // account see the FIRST account's captures until a full fetch
                    // landed — and `hasPerformedFullNotesSearch` gates that fetch, so
                    // it must be reset too or the stale rows simply stay.
                    self?.notes = []
                    self?.allNotesForSearch = []
                    self?.hasPerformedFullNotesSearch = false
                    self?.currentProjectId = nil
                    self?.error = nil
                    self?.isLoading = false
                    self?.invalidateNotesCaches()
                    print("📝 NotesService: Cleared per-user caches on sign-out")
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Search Support

    /// Cached notes for search (separate from project-specific notes view)
    @Published private(set) var allNotesForSearch: [Note] = []

    /// Tracks whether a full fetch of all notes for search has been performed
    private(set) var hasPerformedFullNotesSearch: Bool = false

    /// Fetch all notes for search functionality
    @MainActor
    func fetchAllNotesForSearch() async {
        guard let userId = supabase.currentUser?.id else { return }

        do {
            // `captures` is WORKSPACE-scoped and a user can belong to several, so
            // a user_id-only filter hands back every workspace's captures at once
            // — which made a workspace switch look like a no-op on Home. Scope to
            // the active workspace whenever one is resolved.
            let requestedWorkspaceId = WorkspaceService.shared.workspaceId

            var query = supabase.client
                .from("captures")
                .select()
                .eq("user_id", value: userId.uuidString)
                .eq("status", value: NoteStatus.active.rawValue)

            if let requestedWorkspaceId {
                query = query.eq("workspace_id", value: requestedWorkspaceId.uuidString)
            }

            let result: [Note] = try await query
                .order("created_at", ascending: false)
                .execute()
                .value

            // The assignment below is a wholesale replace, so a fetch that was in
            // flight when the workspace changed would repaint the OLD workspace's
            // captures over the observer's clear. Drop anything that no longer
            // matches the workspace it was requested for.
            guard requestedWorkspaceId == WorkspaceService.shared.workspaceId else {
                print("📝 NotesService: discarded \(result.count) captures from a stale workspace fetch")
                return
            }

            allNotesForSearch = result
            hasPerformedFullNotesSearch = true
        } catch {
            print("Failed to fetch notes for search: \(error)")
        }
    }

    // MARK: - CRUD Operations

    /// Fetch notes for a specific project
    @discardableResult
    func fetchNotes(projectId: UUID, type: NoteType? = nil, status: NoteStatus = .active) async throws -> [Note] {
        guard let userId = supabase.currentUser?.id else {
            throw NotesError.authRequired
        }

        await MainActor.run {
            isLoading = true
            error = nil
            currentProjectId = projectId
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        do {
            // The backend `captures` table has no `type` column, so we can't
            // filter by type server-side. Fetch all captures for the project and
            // apply any requested type filter in-memory (type is derived on decode).
            var result: [Note] = try await supabase.client
                .from("captures")
                .select()
                .eq("user_id", value: userId.uuidString)
                .eq("project_id", value: projectId.uuidString)
                .eq("status", value: status.rawValue)
                .order("is_pinned", ascending: false)
                .order("created_at", ascending: false)
                .execute()
                .value

            if let noteType = type {
                result = result.filter { $0.type == noteType }
            }

            await MainActor.run {
                self.notes = result
            }

            print("📝 NotesService: Fetched \(result.count) notes for project \(projectId)")
            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ NotesService: Failed to fetch notes: \(error)")
            throw error
        }
    }

    /// Create a new note
    @discardableResult
    func createNote(_ dto: CreateNoteDTO) async throws -> Note {
        guard let userId = supabase.currentUser?.id else {
            print("❌ NotesService: createNote failed - no authenticated user")
            throw NotesError.authRequired
        }

        print("📝 NotesService: Creating note for user: \(userId.uuidString.prefix(8))...")

        await MainActor.run {
            isLoading = true
            error = nil
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        do {
            // If no project specified, use the hidden default project
            let actualProjectId: UUID
            if let specified = dto.projectId {
                actualProjectId = specified
            } else {
                let defaultProject = try await ProjectsService.shared.getOrCreateDefaultProject()
                actualProjectId = defaultProject.id
            }

            // captures.workspace_id is NOT NULL — resolve the active workspace.
            let workspaceId = try await WorkspaceService.shared.requireWorkspaceId()

            // Build the captures row. NOTE: the backend table is `captures` (not
            // `notes`), and it has NO `type` column — note vs meeting vs webpage
            // is an iOS-only concept, so `dto.type` is intentionally dropped here.
            struct CaptureInsert: Encodable {
                let user_id: String
                let workspace_id: String
                let project_id: String
                let title: String
                let content: String?
                let transcript: String?
                let audio_url: String?
                let duration_seconds: Int?
                let source_url: String?
                let calendar_event_id: String?
                let meeting_url: String?
                let location: String?
                let organizer_email: String?
                let participants: [MeetingParticipant]?
                let tags: [String]?
                let recorded_at: String?
            }

            let insert = CaptureInsert(
                user_id: userId.uuidString,
                workspace_id: workspaceId.uuidString,
                project_id: actualProjectId.uuidString,
                title: dto.title,
                content: dto.content,
                transcript: dto.transcript,
                audio_url: dto.audioUrl,
                duration_seconds: dto.durationSeconds,
                source_url: dto.sourceUrl,
                calendar_event_id: dto.calendarEventId,
                meeting_url: dto.meetingUrl,
                location: dto.location,
                organizer_email: dto.organizerEmail,
                participants: dto.participants,
                tags: dto.tags,
                recorded_at: dto.recordedAt.map { ISO8601DateFormatter().string(from: $0) }
            )

            let result: Note = try await supabase.client
                .from("captures")
                .insert(insert)
                .select()
                .single()
                .execute()
                .value

            await MainActor.run {
                // Add to current notes list if viewing the same project, or if viewing all notes (no project selected)
                if self.currentProjectId == nil || self.currentProjectId == dto.projectId {
                    self.notes.insert(result, at: 0)
                    self.sortNotes()
                }
                // Also add to allNotesForSearch
                self.allNotesForSearch.insert(result, at: 0)
            }

            print("📝 NotesService: Created note: \(result.title)")

            // Create chunks for the note content (for vector search)
            Task {
                await self.createChunksForNote(result)
            }

            NotificationCenter.default.post(name: .noteCreated, object: result)
            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ NotesService: Failed to create note: \(error)")
            throw error
        }
    }

    /// Update an existing note
    /// - Parameters:
    ///   - id: The note ID to update
    ///   - dto: The update data
    ///   - silent: If true, skips local cache updates and notifications (for frequent updates like transcript streaming)
    @discardableResult
    func updateNote(id: UUID, dto: UpdateNoteDTO, silent: Bool = false) async throws -> Note {
        guard let userId = supabase.currentUser?.id else {
            print("❌ NotesService: updateNote failed - no authenticated user")
            throw NotesError.authRequired
        }

        // NOTE: We intentionally DON'T set isLoading for updates.
        // isLoading is for fetch operations where the user is waiting for data to appear.
        // For updates, the data already exists - we're just modifying it in place.
        // Setting isLoading would cause unnecessary UI refreshes.

        do {
            let result: Note = try await supabase.client
                .from("captures")
                .update(dto)
                .eq("id", value: id.uuidString)
                .eq("user_id", value: userId.uuidString)
                .select()
                .single()
                .execute()
                .value

            // Check if something that affects sort order changed (isPinned affects sort order)
            let sortOrderChanged = dto.isPinned != nil

            // For silent updates (like transcript streaming during recording),
            // we DON'T update the local arrays to avoid triggering SwiftUI re-renders.
            // The data is saved to the database and the detail view gets updates via notification.
            // The list will show accurate data when we do a non-silent update at recording end.
            if !silent {
                await MainActor.run {
                    // Update in notes array (project-specific view)
                    if let index = self.notes.firstIndex(where: { $0.id == id }) {
                        self.notes[index] = result
                    }
                    // Also update in allNotesForSearch array
                    if let searchIndex = self.allNotesForSearch.firstIndex(where: { $0.id == id }) {
                        self.allNotesForSearch[searchIndex] = result
                    }
                    // Only sort if something that affects sort order changed
                    if sortOrderChanged {
                        self.sortNotes()
                    }
                }
            }

            print("📝 NotesService: Updated note: \(result.title) (silent=\(silent))")

            // Re-create chunks if content changed (but NOT for frequent transcript updates during recording)
            // For transcript updates during recording, we'll create chunks at the end
            // Also trigger indexing when AI processing completes (aiProcessed=true) since the note now has final content
            let contentChanged = dto.content != nil || dto.transcript != nil
            let aiProcessingComplete = dto.aiProcessed == true

            if !silent && (contentChanged || aiProcessingComplete) {
                Task {
                    await self.deleteChunksForNote(id)
                    await self.createChunksForNote(result)
                }
            }

            // Post notification on main thread to avoid "Publishing changes from background threads" warning
            // For silent updates, we DON'T post notifications to avoid triggering view updates
            // The detail view (if open) will show the live recording data from VoiceNoteRecordingService
            if !silent {
                await MainActor.run {
                    NotificationCenter.default.post(name: .noteUpdated, object: result)
                }
            }
            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            // Provide more detailed error logging for PGRST116 errors
            let errorString = String(describing: error)
            if errorString.contains("PGRST116") {
                print("❌ NotesService: Failed to update note (id: \(id.uuidString.prefix(8))..., user: \(userId.uuidString.prefix(8))...)")
                print("   Error: Note not found or user_id mismatch. The note may have been deleted or created by a different user session.")
            } else {
                print("❌ NotesService: Failed to update note: \(error)")
            }
            throw error
        }
    }

    /// Delete a note
    func deleteNote(id: UUID) async throws {
        guard let userId = supabase.currentUser?.id else {
            print("❌ NotesService: deleteNote failed - no authenticated user")
            throw NotesError.authRequired
        }

        // Optimistic removal — remove from local arrays immediately for instant UI feedback
        let removedNote = await MainActor.run { () -> Note? in
            let note = self.notes.first { $0.id == id } ?? self.allNotesForSearch.first { $0.id == id }
            self.notes.removeAll { $0.id == id }
            self.allNotesForSearch.removeAll { $0.id == id }
            return note
        }

        do {
            // Delete ONLY suggested actions linked to this note before deleting the note
            // Confirmed/completed actions are preserved - the user explicitly accepted them
            do {
                try await ActionsService.shared.deleteSuggestedActionsForNote(id)
            } catch {
                // Log but don't fail the note deletion if action cleanup fails
                print("⚠️ NotesService: Failed to delete suggested actions for note, continuing: \(error)")
            }

            // Chunks are deleted automatically via CASCADE
            try await supabase.client
                .from("captures")
                .delete()
                .eq("id", value: id.uuidString)
                .eq("user_id", value: userId.uuidString)
                .execute()

            print("📝 NotesService: Deleted note: \(id)")
            NotificationCenter.default.post(name: .noteDeleted, object: id)

        } catch {
            // Restore the note on failure so it reappears in the UI
            if let note = removedNote {
                await MainActor.run {
                    self.notes.append(note)
                    self.allNotesForSearch.append(note)
                }
            }
            await MainActor.run {
                self.error = error
            }
            print("❌ NotesService: Failed to delete note: \(error)")
            throw error
        }
    }

    // MARK: - Search Operations

    /// Search notes by vector embedding within specific projects and/or notes
    func searchByEmbedding(embedding: [Float], projectIds: [UUID]? = nil, noteIds: [UUID]? = nil, limit: Int = 10, threshold: Float = 0.0) async throws -> [NoteSearchResult] {
        guard let userId = supabase.currentUser?.id else {
            throw NotesError.authRequired
        }

        // Convert embedding array to string format for Postgres
        let embeddingString = "[" + embedding.map { String($0) }.joined(separator: ",") + "]"

        struct EmbeddingSearchParams: Encodable {
            let p_user_id: String
            let p_project_ids: [String]  // Always include (empty array if no filter)
            let p_note_ids: [String]     // Always include (empty array if no filter)
            let p_embedding: String
            let p_limit: Int
            let p_threshold: Float
        }

        // Always include project_ids and note_ids (as empty arrays if nil) so PostgREST can match the function signature
        // IMPORTANT: Use lowercased() because PostgreSQL stores UUIDs in lowercase
        let params = EmbeddingSearchParams(
            p_user_id: userId.uuidString.lowercased(),
            p_project_ids: projectIds?.map { $0.uuidString.lowercased() } ?? [],
            p_note_ids: noteIds?.map { $0.uuidString.lowercased() } ?? [],
            p_embedding: embeddingString,
            p_limit: limit,
            p_threshold: threshold
        )

        // Call rag_search function
        do {
            let response = try await supabase.client
                .rpc("rag_search", params: params)
                .execute()

            let results: [NoteSearchResult] = try JSONDecoder().decode([NoteSearchResult].self, from: response.data)
            print("📝 NotesService: Embedding search found \(results.count) results")
            return results
        } catch {
            print("❌ NotesService: Embedding search error: \(error)")
            throw error
        }
    }

    // MARK: - Chunk Operations

    /// Create chunks for a note's content (for vector search)
    /// Indexes: title, content (AI-generated notes), userNotes (manual notes), and aiSummary
    /// Does NOT index: transcript (raw whisper output)
    private func createChunksForNote(_ note: Note) async {
        guard let userId = supabase.currentUser?.id else { return }
        guard let projectId = note.projectId else { return }  // Notes should always have a project now

        // Build text content from relevant fields (excluding transcript)
        var textParts: [String] = []

        // Always include title for searchability
        if !note.title.isEmpty {
            textParts.append("Title: \(note.title)")
        }

        // Include AI-generated summary if available
        if let aiSummary = note.aiSummary, !aiSummary.isEmpty {
            textParts.append("Summary: \(aiSummary)")
        }

        // Include main content (AI-generated structured notes)
        if let content = note.content, !content.isEmpty {
            textParts.append(content)
        }

        // Include user's manual notes
        if let userNotes = note.userNotes, !userNotes.isEmpty {
            textParts.append("User Notes: \(userNotes)")
        }

        let textContent = textParts.joined(separator: "\n\n")
        guard !textContent.isEmpty else { return }

        // Split into chunks (simple sentence-based chunking)
        let chunks = splitIntoChunks(textContent, maxChunkSize: 500)

        // Generate embeddings if OpenAI API key is configured
        let embeddingService = EmbeddingService.shared
        var embeddings: [[Float]]? = nil

        if embeddingService.hasAPIKey() {
            do {
                embeddings = try await embeddingService.generateEmbeddings(texts: chunks)
                print("📊 NotesService: Generated \(embeddings?.count ?? 0) embeddings for note: \(note.title)")
            } catch {
                print("⚠️ NotesService: Failed to generate embeddings: \(error.localizedDescription)")
                // Continue without embeddings - chunks will still be searchable by text
            }
        }

        // capture_chunks.workspace_id is NOT NULL. Chunking is a best-effort
        // background enrichment, so bail quietly if there's no active workspace.
        guard let workspaceId = await WorkspaceService.shared.workspaceId else {
            print("⚠️ NotesService: No active workspace — skipping chunk creation for \(note.id)")
            return
        }

        for (index, chunkText) in chunks.enumerated() {
            // Check if we have an embedding for this chunk
            let embedding = embeddings.flatMap { $0.count > index ? $0[index] : nil }

            // Matches the `capture_chunks` schema: capture_id (not note_id),
            // NOT NULL workspace_id + source.
            struct ChunkInsert: Encodable {
                let capture_id: String
                let project_id: String
                let workspace_id: String
                let user_id: String
                let chunk_index: Int
                let chunk_text: String
                let source: String
                let embedding: String?
            }

            // Convert embedding to Postgres vector format if available
            let embeddingString: String? = embedding.map { emb in
                "[" + emb.map { String($0) }.joined(separator: ",") + "]"
            }

            let insert = ChunkInsert(
                capture_id: note.id.uuidString,
                project_id: projectId.uuidString,
                workspace_id: workspaceId.uuidString,
                user_id: userId.uuidString,
                chunk_index: index,
                chunk_text: chunkText,
                source: "content",
                embedding: embeddingString
            )

            do {
                try await supabase.client
                    .from("capture_chunks")
                    .insert(insert)
                    .execute()
            } catch {
                print("❌ NotesService: Failed to create chunk \(index) for note \(note.id): \(error)")
            }
        }

        print("📝 NotesService: Created \(chunks.count) chunks for note: \(note.title)")
    }

    /// Delete all chunks for a note
    private func deleteChunksForNote(_ noteId: UUID) async {
        guard let userId = supabase.currentUser?.id else { return }

        do {
            try await supabase.client
                .from("capture_chunks")
                .delete()
                .eq("capture_id", value: noteId.uuidString)
                .eq("user_id", value: userId.uuidString)
                .execute()

            print("📝 NotesService: Deleted chunks for note: \(noteId)")
        } catch {
            print("❌ NotesService: Failed to delete chunks: \(error)")
        }
    }

    /// Split text into chunks for embedding
    private func splitIntoChunks(_ text: String, maxChunkSize: Int) -> [String] {
        var chunks: [String] = []
        var currentChunk = ""

        // Split by sentences (rough approximation)
        let sentences = text.components(separatedBy: CharacterSet(charactersIn: ".!?"))

        for sentence in sentences {
            let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            if currentChunk.isEmpty {
                currentChunk = trimmed
            } else if currentChunk.count + trimmed.count + 2 <= maxChunkSize {
                currentChunk += ". " + trimmed
            } else {
                chunks.append(currentChunk + ".")
                currentChunk = trimmed
            }
        }

        if !currentChunk.isEmpty {
            chunks.append(currentChunk + ".")
        }

        return chunks
    }

    // MARK: - Helpers

    private func sortNotes() {
        notes.sort { lhs, rhs in
            // Pinned first
            if lhs.isPinned != rhs.isPinned {
                return lhs.isPinned
            }
            // Then by date (newest first)
            let lhsDate = lhs.recordedAt ?? lhs.createdAt
            let rhsDate = rhs.recordedAt ?? rhs.createdAt
            return lhsDate > rhsDate
        }
    }

    /// Get note by ID (searches both project notes and all notes)
    func getNote(by id: UUID) -> Note? {
        // First check project-specific notes
        if let note = notes.first(where: { $0.id == id }) {
            return note
        }
        // Then check all notes (used when viewing "All Notes")
        return allNotesForSearch.first { $0.id == id }
    }

    /// Get note by ID from database
    /// Also caches the result in allNotesForSearch for future lookups.
    ///
    /// A note we have never seen is inserted at index 0, NOT appended: Home
    /// renders `allNotesForSearch` in newest-first order without re-sorting, and
    /// the only rows that arrive here unseen are freshly finalized captures. An
    /// append buried a just-saved capture at the bottom of the list, which read
    /// as "my recording vanished until I pull-to-refresh".
    @discardableResult
    func fetchNote(by id: UUID) async throws -> Note {
        guard let userId = supabase.currentUser?.id else {
            throw NotesError.authRequired
        }

        let result: Note = try await supabase.client
            .from("captures")
            .select()
            .eq("id", value: id.uuidString)
            .eq("user_id", value: userId.uuidString)
            .single()
            .execute()
            .value

        await MainActor.run {
            self.cacheNote(result)
        }

        return result
    }

    /// Insert-at-0 for an unknown id, replace-in-place for a known one — in both
    /// `allNotesForSearch` and the project-scoped `notes` array.
    @MainActor
    func cacheNote(_ note: Note) {
        if let index = allNotesForSearch.firstIndex(where: { $0.id == note.id }) {
            allNotesForSearch[index] = note
        } else {
            allNotesForSearch.insert(note, at: 0)
        }

        if let index = notes.firstIndex(where: { $0.id == note.id }) {
            notes[index] = note
        } else if currentProjectId == nil || currentProjectId == note.projectId {
            notes.insert(note, at: 0)
        }
    }

    /// Pull a capture from the server, put it at the top of the Home list, and
    /// tell every open view about it. This is the "a recording was just saved"
    /// entry point — the row is created server-side by the capture API, so
    /// nothing local knows about it until we fetch it.
    @discardableResult
    func refreshNoteAndNotify(id: UUID) async -> Note? {
        do {
            let note = try await fetchNote(by: id)
            await MainActor.run {
                NotificationCenter.default.post(name: .noteUpdated, object: note)
            }
            print("📝 NotesService: Cached capture \(id.uuidString.prefix(8))… → \"\(note.title)\"")
            return note
        } catch {
            print("⚠️ NotesService: Failed to refresh capture \(id.uuidString.prefix(8))…: \(error.localizedDescription)")
            return nil
        }
    }

    /// Lightweight refresh of the Home list. Used on recording-sheet dismiss,
    /// where a full re-fetch is cheap relative to how rarely it happens but a
    /// stale list is very visible.
    @MainActor
    func refreshNotesLightweight() async {
        await fetchAllNotesForSearch()
    }

    // MARK: - Processing State

    /// How long after a capture ends we still assume the server-side batch run
    /// (summary + title + extracted actions) may be in flight.
    static let processingWindow: TimeInterval = 15 * 60

    /// True while a freshly finished capture is still waiting on the server's
    /// batch extraction: no summary of any kind yet, and recent enough that one
    /// is plausibly still coming. Drives the "Processing…" label in the Home row.
    ///
    /// The capture MUST have ended. A row with `ended_at` NULL is not a capture
    /// the server is working on — it is one whose recording never finished (the
    /// app was killed mid-recording), and calling it "Processing…" for 15 minutes
    /// and then silently nothing is a lie. `isInterrupted` names that state
    /// instead, and CaptureRecoveryService fixes it.
    ///
    /// `recordedAt`/`createdAt` stand in for the processing-window reference —
    /// for a phone capture they sit within seconds of `ended_at`.
    ///
    /// ⚠️ The reference is the LATER of the two, not `recordedAt ?? createdAt`.
    /// A Watch capture sets `recordedAt` to the moment the WATCH started
    /// recording, which for a 30-minute meeting is already 30 minutes in the past
    /// when the row is created — so keying off `recordedAt` alone put every long
    /// recording outside the window the instant it appeared, and it rendered as a
    /// finished, title-less note instead of "Processing…" while the transcript
    /// and batch extraction were still in flight. `createdAt` is when the row
    /// came into existence, which is what "is the server still working on this"
    /// actually depends on; taking the max keeps phone captures (where the two
    /// are seconds apart) behaving exactly as before.
    func isProcessing(_ note: Note) -> Bool {
        let hasSummary = !(note.aiSummary?.isEmpty ?? true) || !(note.summary?.isEmpty ?? true)
        guard !hasSummary else { return false }
        // A capture the recorder started must also have FINISHED before anything
        // server-side can be "in progress" on it. Without this, an abandoned
        // capture claimed to be processing for 15 minutes and then went quiet.
        // Rows that never came from the recorder (no started_at — calendar
        // placeholders, iOS-local notes) keep the old, purely time-based
        // behaviour.
        if note.startedAt != nil && note.endedAt == nil { return false }
        let reference = max(note.recordedAt ?? note.createdAt, note.createdAt)
        return Date().timeIntervalSince(reference) < Self.processingWindow
    }

    /// True for a capture whose recording was started and never finished — see
    /// `Note.isInterrupted`. Exposed here so views ask NotesService for both
    /// states side by side rather than reaching into the model for one of them.
    func isInterrupted(_ note: Note) -> Bool {
        note.isInterrupted
    }
}

// MARK: - Notification Names

extension Notification.Name {
    static let noteCreated = Notification.Name("noteCreated")
    static let noteUpdated = Notification.Name("noteUpdated")
    static let noteDeleted = Notification.Name("noteDeleted")
    static let noteMoved = Notification.Name("noteMoved")
}
