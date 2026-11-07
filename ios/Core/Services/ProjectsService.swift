//
//  ProjectsService.swift
//  dial8
//
//  Service for managing projects with Supabase backend
//

import Foundation
import Combine

// MARK: - Projects Error

enum ProjectsError: LocalizedError {
    case authRequired
    case projectNotFound
    case invalidData
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .authRequired:
            return "Authentication required to manage projects"
        case .projectNotFound:
            return "Project not found"
        case .invalidData:
            return "Invalid project data"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

// MARK: - Projects Service

class ProjectsService: ObservableObject {
    static let shared = ProjectsService()

    // MARK: - Published Properties

    @Published private(set) var projects: [KBProject] = []
    @Published private(set) var isLoading = false
    @Published private(set) var error: Error?

    // For AI context selection
    @Published var aiContextSelection = AIContextSelection(selectedProjectIds: [])

    // MARK: - Constants

    /// The name used for the hidden default project (for notes created without selecting a project)
    static let defaultProjectName = "__default__"

    // MARK: - Cached Computed Properties

    private var _cachedActiveProjects: [KBProject]?
    private var _cachedArchivedProjects: [KBProject]?
    private var _cachedPinnedProjects: [KBProject]?
    private var _cachedRootProjects: [KBProject]?
    private var _cachedDefaultProject: KBProject??

    /// Check if a project is the hidden default project
    private func isDefaultProject(_ project: KBProject) -> Bool {
        project.name == Self.defaultProjectName
    }

    var activeProjects: [KBProject] {
        if let cached = _cachedActiveProjects { return cached }
        let result = projects.filter { !$0.isArchived && !isDefaultProject($0) }
        _cachedActiveProjects = result
        return result
    }

    var archivedProjects: [KBProject] {
        if let cached = _cachedArchivedProjects { return cached }
        let result = projects.filter { $0.isArchived && !isDefaultProject($0) }
        _cachedArchivedProjects = result
        return result
    }

    var pinnedProjects: [KBProject] {
        if let cached = _cachedPinnedProjects { return cached }
        let result = projects.filter { $0.isPinned && !$0.isArchived && !isDefaultProject($0) }
        _cachedPinnedProjects = result
        return result
    }

    var rootProjects: [KBProject] {
        if let cached = _cachedRootProjects { return cached }
        let result = projects.filter { $0.parentProjectId == nil && !$0.isArchived && !isDefaultProject($0) }
        _cachedRootProjects = result
        return result
    }

    var projectCount: Int {
        activeProjects.count
    }

    /// The default project for notes created without selecting a project (hidden from UI)
    var defaultProject: KBProject? {
        if let cached = _cachedDefaultProject { return cached }
        let result = projects.first { isDefaultProject($0) }
        _cachedDefaultProject = .some(result)
        return result
    }

    private func invalidateProjectsCaches() {
        _cachedActiveProjects = nil
        _cachedArchivedProjects = nil
        _cachedPinnedProjects = nil
        _cachedRootProjects = nil
        _cachedDefaultProject = nil
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

    /// Projects are workspace-scoped, and `aiContextSelection` holds ids of
    /// projects/notes/actions that no longer exist in the new workspace — an
    /// attached context that would be sent to the assistant as dangling refs.
    /// Both go, then the new workspace's projects are fetched.
    private func setupWorkspaceObserver() {
        NotificationCenter.default.publisher(for: .workspaceDidChange)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.projects = []
                    self.aiContextSelection.clear()
                    self.error = nil
                    self.isLoading = false
                    self.invalidateProjectsCaches()
                    print("📁 ProjectsService: cleared cache for workspace switch")
                    _ = try? await self.fetchProjects()
                }
            }
            .store(in: &cancellables)
    }

    private func setupCacheInvalidation() {
        $projects
            .sink { [weak self] _ in self?.invalidateProjectsCaches() }
            .store(in: &cancellables)
    }

    private func setupAuthObserver() {
        NotificationCenter.default.publisher(for: .authenticationComplete)
            .sink { [weak self] _ in
                Task {
                    try? await self?.fetchProjects()
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .userSignedOut)
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.projects = []
                    self?.aiContextSelection.clear()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - CRUD Operations

    /// Fetch all projects for the current user
    @discardableResult
    func fetchProjects(includeArchived: Bool = false) async throws -> [KBProject] {
        guard let userId = supabase.currentUser?.id else {
            throw ProjectsError.authRequired
        }

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
            // Scope reads to the active workspace when one is bootstrapped.
            // Before bootstrap completes we fall back to user-only scoping so
            // early callers still get data instead of an empty list.
            let workspaceId = await MainActor.run { WorkspaceService.shared.workspaceId }

            var query = supabase.client
                .from("projects")
                .select()
                .eq("user_id", value: userId.uuidString)

            if let workspaceId {
                query = query.eq("workspace_id", value: workspaceId.uuidString)
            }

            if !includeArchived {
                query = query.eq("is_archived", value: false)
            }

            let result: [KBProject] = try await query
                .order("is_pinned", ascending: false)
                .order("sort_order", ascending: true)
                .order("name", ascending: true)
                .execute()
                .value

            await MainActor.run {
                self.projects = result
            }

            print("📁 ProjectsService: Fetched \(result.count) projects (workspace: \(workspaceId?.uuidString ?? "none"))")
            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ ProjectsService: Failed to fetch projects: \(error)")
            throw error
        }
    }

    /// Create a new project
    @discardableResult
    func createProject(_ dto: CreateProjectDTO) async throws -> KBProject {
        guard let userId = supabase.currentUser?.id else {
            throw ProjectsError.authRequired
        }

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
            // `projects.workspace_id` is NOT NULL in the live schema — every insert
            // must carry the active workspace or Postgres rejects the row.
            let workspaceId = try await WorkspaceService.shared.requireWorkspaceId()

            let project = KBProject(
                userId: userId,
                name: dto.name,
                description: dto.description,
                icon: dto.icon ?? "folder",
                color: dto.color ?? "#6366F1",
                parentProjectId: dto.parentProjectId,
                workspaceId: workspaceId
            )

            let result: KBProject = try await supabase.client
                .from("projects")
                .insert(project)
                .select()
                .single()
                .execute()
                .value

            await MainActor.run {
                self.projects.insert(result, at: 0)
                self.sortProjects()
            }

            print("📁 ProjectsService: Created project: \(result.name)")

            NotificationCenter.default.post(name: .projectCreated, object: result)
            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ ProjectsService: Failed to create project: \(error)")
            throw error
        }
    }

    /// Get or create the hidden default project for notes without a project selection
    /// This project is hidden from the UI but satisfies the database constraint
    func getOrCreateDefaultProject() async throws -> KBProject {
        // First check if we already have it cached
        if let existing = defaultProject {
            return existing
        }

        // Try to fetch projects if we haven't yet
        if projects.isEmpty {
            try await fetchProjects()
        }

        // Check again after fetch
        if let existing = defaultProject {
            return existing
        }

        // Create the default project
        let dto = CreateProjectDTO(
            name: Self.defaultProjectName,
            description: "Default project for uncategorized notes",
            icon: "tray",
            color: "#6B7280"  // Gray color
        )

        return try await createProject(dto)
    }

    // MARK: - Child Projects

    /// Get child projects of a parent project
    func getChildProjects(parentId: UUID) -> [KBProject] {
        projects.filter { $0.parentProjectId == parentId && !$0.isArchived }
    }

    /// Get all descendants of a project
    func getAllDescendants(of projectId: UUID) -> [KBProject] {
        var descendants: [KBProject] = []
        let children = getChildProjects(parentId: projectId)
        descendants.append(contentsOf: children)

        for child in children {
            descendants.append(contentsOf: getAllDescendants(of: child.id))
        }

        return descendants
    }

    // MARK: - AI Context - Projects

    /// Get count of selected projects
    var selectedProjectCount: Int {
        aiContextSelection.projectCount
    }

    // MARK: - AI Context - Notes

    /// Add note to AI context
    func addNoteToAIContext(noteId: UUID) {
        aiContextSelection.addNote(noteId)
        NotificationCenter.default.post(name: .aiContextChanged, object: nil)
    }

    /// Remove note from AI context
    func removeNoteFromAIContext(noteId: UUID) {
        aiContextSelection.removeNote(noteId)
        NotificationCenter.default.post(name: .aiContextChanged, object: nil)
    }

    /// Get count of explicitly selected notes
    var selectedNoteCount: Int {
        aiContextSelection.noteCount
    }

    /// Get array of explicitly selected note IDs
    var selectedNoteIds: [UUID] {
        aiContextSelection.noteIdsArray
    }

    // MARK: - AI Context - Actions

    /// Get count of selected actions
    var selectedActionCount: Int {
        aiContextSelection.actionCount
    }

    /// Get array of selected action IDs
    var selectedActionIds: [UUID] {
        aiContextSelection.actionIdsArray
    }

    // MARK: - AI Context - Workflows

    /// Get count of selected workflows
    var selectedWorkflowCount: Int {
        aiContextSelection.workflowCount
    }

    /// Get array of selected workflow IDs
    var selectedWorkflowIds: [UUID] {
        aiContextSelection.workflowIdsArray
    }

    // MARK: - Helpers

    private func sortProjects() {
        projects.sort { lhs, rhs in
            // Pinned first
            if lhs.isPinned != rhs.isPinned {
                return lhs.isPinned
            }
            // Then by sort order
            if lhs.sortOrder != rhs.sortOrder {
                return lhs.sortOrder < rhs.sortOrder
            }
            // Then by name
            return lhs.name < rhs.name
        }
    }

    /// Get project by ID
    func getProject(by id: UUID) -> KBProject? {
        projects.first { $0.id == id }
    }
}

// MARK: - Notification Names

extension Notification.Name {
    static let projectCreated = Notification.Name("projectCreated")
    static let projectUpdated = Notification.Name("projectUpdated")
    static let projectDeleted = Notification.Name("projectDeleted")
    static let aiContextChanged = Notification.Name("aiContextChanged")
}
