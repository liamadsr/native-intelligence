//
//  SearchService.swift
//  dial8
//
//  Unified search service that aggregates results from projects, notes, actions, and contacts
//

import Foundation
import Combine

// MARK: - Search Mode

enum SearchMode: String, CaseIterable {
    case regular    // Standard text search
    case semantic   // AI-powered semantic/RAG search

    var displayName: String {
        switch self {
        case .regular: return "Search"
        case .semantic: return "AI Search"
        }
    }

    var icon: String {
        switch self {
        case .regular: return "magnifyingglass"
        case .semantic: return "sparkles"
        }
    }

    var placeholder: String {
        switch self {
        case .regular: return "Search projects, meetings, actions, or contacts..."
        case .semantic: return "Ask a question to search your knowledge base..."
        }
    }

    var color: String {
        switch self {
        case .regular: return "#6366F1"    // Indigo
        case .semantic: return "#10B981"   // Emerald/Green for AI
        }
    }

    /// Toggle to the other mode
    var toggled: SearchMode {
        switch self {
        case .regular: return .semantic
        case .semantic: return .regular
        }
    }
}

// MARK: - Search Filter

enum SearchFilter: String, CaseIterable, Hashable {
    case meetings   // NoteType.meeting
    case actions    // Action items
    case projects   // Projects
    case contacts   // CRM Contacts

    var displayName: String {
        switch self {
        case .meetings: return "Meetings"
        case .actions: return "Actions"
        case .projects: return "Projects"
        case .contacts: return "Contacts"
        }
    }

    var icon: String {
        switch self {
        case .meetings: return "video.fill"
        case .actions: return "checklist"
        case .projects: return "folder"
        case .contacts: return "person.2"
        }
    }

    var color: String {
        switch self {
        case .meetings: return "#3B82F6"   // Blue
        case .actions: return "#6366F1"    // Indigo
        case .projects: return "#8B5CF6"   // Purple
        case .contacts: return "#10B981"   // Green
        }
    }
}

// MARK: - Search Result Types

enum SearchResultType: String, CaseIterable {
    case knowledge  // Semantic search results
    case project
    case note
    case action
    case contact

    var icon: String {
        switch self {
        case .knowledge: return "sparkles"
        case .project: return "folder"
        case .note: return "doc.text"
        case .action: return "checklist"
        case .contact: return "person.crop.circle"
        }
    }

    var displayName: String {
        switch self {
        case .knowledge: return "Knowledge"
        case .project: return "Projects"
        case .note: return "Notes"
        case .action: return "Actions"
        case .contact: return "Contacts"
        }
    }
}

struct SearchResult: Identifiable, Equatable {
    let id: UUID
    let type: SearchResultType
    let title: String
    let subtitle: String?
    let icon: String
    let color: String?
    let date: Date?

    // For navigation
    let projectId: UUID?
    let noteId: UUID?
    let actionId: UUID?
    let contactId: UUID?

    // For semantic search results
    let similarity: Float?
    let chunkText: String?

    static func == (lhs: SearchResult, rhs: SearchResult) -> Bool {
        lhs.id == rhs.id
    }

    init(
        id: UUID,
        type: SearchResultType,
        title: String,
        subtitle: String?,
        icon: String,
        color: String?,
        date: Date?,
        projectId: UUID?,
        noteId: UUID?,
        actionId: UUID?,
        contactId: UUID? = nil,
        similarity: Float? = nil,
        chunkText: String? = nil
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.color = color
        self.date = date
        self.projectId = projectId
        self.noteId = noteId
        self.actionId = actionId
        self.contactId = contactId
        self.similarity = similarity
        self.chunkText = chunkText
    }
}

// MARK: - Search Service

class SearchService: ObservableObject {
    static let shared = SearchService()

    @Published var searchText: String = ""
    @Published var searchMode: SearchMode = .regular
    @Published var results: [SearchResultType: [SearchResult]] = [:]
    @Published var isSearching: Bool = false
    @Published var recentSearches: [String] = []
    @Published var activeFilters: Set<SearchFilter> = []

    private var cancellables = Set<AnyCancellable>()
    private let projectsService = ProjectsService.shared
    private let notesService = NotesService.shared
    private let contactsService = ContactsService.shared
    private let embeddingService = EmbeddingService.shared

    /// Whether any filters are currently active
    var hasActiveFilters: Bool {
        !activeFilters.isEmpty
    }

    /// Whether to show filtered content (filters active, regardless of search text)
    var shouldShowFilteredContent: Bool {
        hasActiveFilters
    }

    /// Whether we're in semantic search mode
    var isSemanticMode: Bool {
        searchMode == .semantic
    }

    var allResults: [SearchResult] {
        results.values.flatMap { $0 }
    }

    var hasResults: Bool {
        !allResults.isEmpty
    }

    /// Whether semantic/knowledge search is available (requires OpenAI API key)
    var isSemanticSearchAvailable: Bool {
        embeddingService.hasAPIKey()
    }

    private init() {
        setupSearchDebounce()
        setupFilterDebounce()
        setupModeDebounce()
        loadRecentSearches()
        setupWorkspaceObserver()
    }

    /// Results reference rows from the workspace we just left, so they are wiped
    /// along with the query and filters. `recentSearches` is deliberately kept —
    /// it stores strings the user typed, not workspace data.
    ///
    /// Re-priming goes through `ensureDataLoaded()`, which reads the underlying
    /// services; those clear on the same notification, so this runs after a beat
    /// rather than racing their refetch.
    private func setupWorkspaceObserver() {
        NotificationCenter.default.publisher(for: .workspaceDidChange)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.clearSearch()
                    self.isSearching = false
                    print("🔍 SearchService: cleared results for workspace switch")
                    await self.ensureDataLoaded()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Data Loading

    /// Ensures all services have their data loaded before searching
    @MainActor
    func ensureDataLoaded() async {
        var didLoad = false

        if projectsService.projects.isEmpty {
            _ = try? await projectsService.fetchProjects()
            didLoad = true
        }

        if !notesService.hasPerformedFullNotesSearch {
            await notesService.fetchAllNotesForSearch()
            didLoad = true
        }

        let actionsService = ActionsService.shared
        if actionsService.actions.isEmpty {
            _ = try? await actionsService.fetchActions()
            didLoad = true
        }

        if contactsService.contacts.isEmpty {
            _ = try? await contactsService.fetchContacts()
            didLoad = true
        }

        // Re-run search if new data was loaded and a search/filter is active
        if didLoad && (hasActiveFilters || !searchText.isEmpty) {
            await performFilteredSearch()
        }
    }

    private func setupSearchDebounce() {
        $searchText
            .debounce(for: .milliseconds(200), scheduler: DispatchQueue.main)
            .removeDuplicates()
            .sink { [weak self] query in
                Task {
                    await self?.performFilteredSearch()
                }
            }
            .store(in: &cancellables)
    }

    private func setupFilterDebounce() {
        $activeFilters
            .debounce(for: .milliseconds(100), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                Task {
                    await self?.performFilteredSearch()
                }
            }
            .store(in: &cancellables)
    }

    private func setupModeDebounce() {
        $searchMode
            .dropFirst()
            .sink { [weak self] _ in
                Task {
                    await self?.performFilteredSearch()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Filter Management

    func toggleFilter(_ filter: SearchFilter) {
        if activeFilters.contains(filter) {
            activeFilters.remove(filter)
        } else {
            activeFilters.insert(filter)
        }
    }

    func isFilterActive(_ filter: SearchFilter) -> Bool {
        activeFilters.contains(filter)
    }

    // MARK: - Search

    @MainActor
    func performFilteredSearch() async {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let searchQuery = query.lowercased()
        let hasQuery = !query.isEmpty

        if isSemanticMode && !hasQuery {
            results = [:]
            isSearching = false
            return
        }

        if !isSemanticMode && !hasActiveFilters && !hasQuery {
            results = [:]
            isSearching = false
            return
        }

        isSearching = true

        var newResults: [SearchResultType: [SearchResult]] = [:]
        let limit = 20

        // SEMANTIC MODE
        if isSemanticMode && hasQuery {
            if isSemanticSearchAvailable {
                let knowledgeResults = await searchKnowledge(query: query, limit: limit)
                if !knowledgeResults.isEmpty {
                    newResults[.knowledge] = knowledgeResults
                }
            }
            results = newResults
            isSearching = false
            return
        }

        // REGULAR MODE
        let shouldSearchProjects = activeFilters.isEmpty || activeFilters.contains(.projects)
        let shouldSearchMeetings = activeFilters.isEmpty || activeFilters.contains(.meetings)
        let shouldSearchActions = activeFilters.isEmpty || activeFilters.contains(.actions)
        let shouldSearchContacts = activeFilters.isEmpty || activeFilters.contains(.contacts)

        if shouldSearchProjects {
            let projectResults = hasQuery
                ? searchProjects(query: searchQuery)
                : fetchAllProjects(limit: limit)
            if !projectResults.isEmpty {
                newResults[.project] = projectResults
            }
        }

        if shouldSearchMeetings {
            let meetingResults = hasQuery
                ? searchMeetings(query: searchQuery)
                : fetchAllMeetings(limit: limit)
            if !meetingResults.isEmpty {
                newResults[.note] = meetingResults
            }
        }

        if shouldSearchActions {
            let actionResults = hasQuery
                ? searchActions(query: searchQuery)
                : fetchAllActions(limit: limit)
            if !actionResults.isEmpty {
                newResults[.action] = actionResults
            }
        }

        if shouldSearchContacts {
            let contactResults = hasQuery
                ? searchContacts(query: searchQuery)
                : fetchAllContacts(limit: limit)
            if !contactResults.isEmpty {
                newResults[.contact] = contactResults
            }
        }

        results = newResults
        isSearching = false
    }

    // MARK: - Fetch All (Browse Mode)

    private func fetchAllProjects(limit: Int) -> [SearchResult] {
        projectsService.projects
            .sorted { ($0.updatedAt) > ($1.updatedAt) }
            .prefix(limit)
            .map { project in
                SearchResult(
                    id: project.id,
                    type: .project,
                    title: project.name,
                    subtitle: project.description,
                    icon: project.icon,
                    color: project.color,
                    date: project.updatedAt,
                    projectId: project.id,
                    noteId: nil,
                    actionId: nil
                )
            }
    }

    private func fetchAllMeetings(limit: Int) -> [SearchResult] {
        notesService.allNotesForSearch
            .filter { $0.type == .meeting }
            .sorted { ($0.createdAt) > ($1.createdAt) }
            .prefix(limit)
            .map { note in
                SearchResult(
                    id: note.id,
                    type: .note,
                    title: note.title,
                    subtitle: note.contentPreview,
                    icon: note.type.icon,
                    color: note.type.color,
                    date: note.createdAt,
                    projectId: note.projectId,
                    noteId: note.id,
                    actionId: nil
                )
            }
    }

    private func fetchAllActions(limit: Int) -> [SearchResult] {
        let actionsService = ActionsService.shared
        return actionsService.actions
            .sorted { ($0.createdAt) > ($1.createdAt) }
            .prefix(limit)
            .map { action in
                let isCompleted = action.status == .completed
                return SearchResult(
                    id: action.id,
                    type: .action,
                    title: action.title,
                    subtitle: action.description ?? formatActionDate(action.dueAt),
                    icon: isCompleted ? "checkmark.circle.fill" : "checklist",
                    color: isCompleted ? "#10B981" : "#6366F1",
                    date: action.createdAt,
                    projectId: nil,
                    noteId: nil,
                    actionId: action.id
                )
            }
    }

    private func fetchAllContacts(limit: Int) -> [SearchResult] {
        contactsService.contacts
            .sorted { ($0.createdAt) > ($1.createdAt) }
            .prefix(limit)
            .map { contact in
                let subtitle = [contact.jobTitle, contact.company]
                    .compactMap { $0 }
                    .filter { !$0.isEmpty }
                    .joined(separator: " at ")
                return SearchResult(
                    id: contact.id,
                    type: .contact,
                    title: contact.displayName,
                    subtitle: subtitle.isEmpty ? contact.emails.first?.email : subtitle,
                    icon: "person.crop.circle",
                    color: "#10B981",
                    date: contact.createdAt,
                    projectId: nil,
                    noteId: nil,
                    actionId: nil,
                    contactId: contact.id
                )
            }
    }

    // MARK: - Search (Query Mode)

    private func searchProjects(query: String) -> [SearchResult] {
        projectsService.projects
            .filter { project in
                project.name.lowercased().contains(query) ||
                (project.description?.lowercased().contains(query) ?? false)
            }
            .sorted { ($0.updatedAt) > ($1.updatedAt) }
            .map { project in
                SearchResult(
                    id: project.id,
                    type: .project,
                    title: project.name,
                    subtitle: project.description,
                    icon: project.icon,
                    color: project.color,
                    date: project.updatedAt,
                    projectId: project.id,
                    noteId: nil,
                    actionId: nil
                )
            }
    }

    private func searchMeetings(query: String) -> [SearchResult] {
        notesService.allNotesForSearch
            .filter { note in
                note.type == .meeting && (
                    note.title.lowercased().contains(query) ||
                    (note.content?.lowercased().contains(query) ?? false) ||
                    (note.transcript?.lowercased().contains(query) ?? false) ||
                    note.tags.contains { $0.lowercased().contains(query) }
                )
            }
            .sorted { ($0.createdAt) > ($1.createdAt) }
            .map { note in
                SearchResult(
                    id: note.id,
                    type: .note,
                    title: note.title,
                    subtitle: note.contentPreview,
                    icon: note.type.icon,
                    color: note.type.color,
                    date: note.createdAt,
                    projectId: note.projectId,
                    noteId: note.id,
                    actionId: nil
                )
            }
    }

    private func searchActions(query: String) -> [SearchResult] {
        let actionsService = ActionsService.shared

        return actionsService.actions
            .filter { action in
                action.title.lowercased().contains(query) ||
                (action.description?.lowercased().contains(query) ?? false) ||
                (action.originalTranscript?.lowercased().contains(query) ?? false)
            }
            .sorted { ($0.createdAt) > ($1.createdAt) }
            .map { action in
                let isCompleted = action.status == .completed
                return SearchResult(
                    id: action.id,
                    type: .action,
                    title: action.title,
                    subtitle: action.description ?? formatActionDate(action.dueAt),
                    icon: isCompleted ? "checkmark.circle.fill" : "checklist",
                    color: isCompleted ? "#10B981" : "#6366F1",
                    date: action.createdAt,
                    projectId: nil,
                    noteId: nil,
                    actionId: action.id
                )
            }
    }

    private func searchContacts(query: String) -> [SearchResult] {
        contactsService.contacts
            .filter { contact in
                (contact.firstName?.lowercased().contains(query) ?? false) ||
                (contact.lastName?.lowercased().contains(query) ?? false) ||
                (contact.nickname?.lowercased().contains(query) ?? false) ||
                (contact.company?.lowercased().contains(query) ?? false) ||
                (contact.jobTitle?.lowercased().contains(query) ?? false) ||
                contact.emails.contains { $0.email.lowercased().contains(query) } ||
                contact.displayName.lowercased().contains(query)
            }
            .sorted { ($0.createdAt) > ($1.createdAt) }
            .map { contact in
                let subtitle = [contact.jobTitle, contact.company]
                    .compactMap { $0 }
                    .filter { !$0.isEmpty }
                    .joined(separator: " at ")
                return SearchResult(
                    id: contact.id,
                    type: .contact,
                    title: contact.displayName,
                    subtitle: subtitle.isEmpty ? contact.emails.first?.email : subtitle,
                    icon: "person.crop.circle",
                    color: "#10B981",
                    date: contact.createdAt,
                    projectId: nil,
                    noteId: nil,
                    actionId: nil,
                    contactId: contact.id
                )
            }
    }

    private func formatActionDate(_ date: Date?) -> String? {
        guard let date = date else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    // MARK: - Semantic/Knowledge Search

    private func searchKnowledge(query: String, limit: Int) async -> [SearchResult] {
        guard isSemanticSearchAvailable else { return [] }

        do {
            let queryEmbedding = try await embeddingService.generateEmbedding(text: query)

            let searchResults = try await notesService.searchByEmbedding(
                embedding: queryEmbedding,
                projectIds: nil,
                noteIds: nil,
                limit: limit,
                threshold: 0.25
            )

            return searchResults.map { result in
                let project = result.projectId.flatMap { projectsService.getProject(by: $0) }
                let matchPercentage = Int(result.similarity * 100)

                let previewText = result.chunkText.prefix(120)
                let subtitle = "\(result.noteType.displayName) in \(project?.name ?? "Unknown") • \(matchPercentage)% match"

                return SearchResult(
                    id: result.chunkId,
                    type: .knowledge,
                    title: result.noteTitle,
                    subtitle: subtitle,
                    icon: result.noteType.icon,
                    color: SearchMode.semantic.color,
                    date: nil,
                    projectId: result.projectId,
                    noteId: result.noteId,
                    actionId: nil,
                    similarity: result.similarity,
                    chunkText: String(previewText)
                )
            }
        } catch {
            print("SearchService: Semantic search failed: \(error.localizedDescription)")
            return []
        }
    }

    // MARK: - Recent Searches

    func clearRecentSearches() {
        recentSearches = []
        saveRecentSearches()
    }

    private func loadRecentSearches() {
        recentSearches = UserDefaults.standard.stringArray(forKey: "recentSearches") ?? []
    }

    private func saveRecentSearches() {
        UserDefaults.standard.set(recentSearches, forKey: "recentSearches")
    }

    // MARK: - Clear

    func clearSearch() {
        searchText = ""
        activeFilters.removeAll()
        results = [:]
    }
}
