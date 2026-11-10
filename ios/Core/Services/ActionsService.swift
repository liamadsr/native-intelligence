//
//  ActionsService.swift
//  Native Intelligence
//
//  Service for managing actions with Supabase backend
//

import Foundation
import Combine
import Supabase

// MARK: - Actions Service

class ActionsService: ObservableObject {
    static let shared = ActionsService()

    // MARK: - Published Properties

    @Published private(set) var actions: [Action] = []
    @Published private(set) var isLoading = false
    @Published private(set) var error: Error?

    // MARK: - Cached Computed Properties

    // These are lazily-written caches read straight from SwiftUI bodies, so they
    // are pinned to the main actor: a `var` that writes itself on read is not
    // safe to touch from a background task.

    @MainActor private var _cachedActiveActions: [Action]?
    @MainActor private var _cachedSuggestedActions: [Action]?
    @MainActor private var _cachedTodayActions: [Action]?
    @MainActor private var _cachedOverdueActions: [Action]?
    @MainActor private var _cachedCompletedActions: [Action]?
    @MainActor private var _cachedSnoozedActions: [Action]?
    @MainActor private var _cachedMeetingSuggestions: [Action]?

    /// Invalidate all cached computed properties (called when actions changes)
    @MainActor
    private func invalidateCaches() {
        _cachedActiveActions = nil
        _cachedSuggestedActions = nil
        _cachedTodayActions = nil
        _cachedOverdueActions = nil
        _cachedCompletedActions = nil
        _cachedSnoozedActions = nil
        _cachedMeetingSuggestions = nil
    }

    /// Active actions (confirmed or in_progress, excluding suggested/dismissed)
    @MainActor
    var activeActions: [Action] {
        if let cached = _cachedActiveActions { return cached }
        let result = actions.filter { ($0.status == .confirmed || $0.status == .inProgress) && !$0.isDismissed }
        _cachedActiveActions = result
        return result
    }

    /// AI-suggested actions awaiting user confirmation
    @MainActor
    var suggestedActions: [Action] {
        if let cached = _cachedSuggestedActions { return cached }
        let result = actions.filter { $0.status == .suggested && !$0.isDismissed }
        _cachedSuggestedActions = result
        return result
    }

    @MainActor
    var todayActions: [Action] {
        if let cached = _cachedTodayActions { return cached }
        let result = actions.filter { $0.isDueToday && ($0.status == .confirmed || $0.status == .inProgress) }
        _cachedTodayActions = result
        return result
    }

    @MainActor
    var overdueActions: [Action] {
        if let cached = _cachedOverdueActions { return cached }
        let result = actions.filter { $0.isOverdue && ($0.status == .confirmed || $0.status == .inProgress) }
        _cachedOverdueActions = result
        return result
    }

    @MainActor
    var completedActions: [Action] {
        if let cached = _cachedCompletedActions { return cached }
        let result = actions.filter { $0.status == .completed }
        _cachedCompletedActions = result
        return result
    }

    /// Actions currently snoozed (have future snoozed_until date)
    @MainActor
    var snoozedActions: [Action] {
        if let cached = _cachedSnoozedActions { return cached }
        let result = actions.filter { $0.isSnoozed }
        _cachedSnoozedActions = result
        return result
    }

    /// Meeting suggestions (suggested actions from meeting extraction)
    @MainActor
    var meetingSuggestions: [Action] {
        if let cached = _cachedMeetingSuggestions { return cached }
        let result = actions.filter { $0.isMeetingSuggestion }
        _cachedMeetingSuggestions = result
        return result
    }

    @MainActor
    var todayCount: Int {
        todayActions.count
    }

    @MainActor
    var overdueCount: Int {
        overdueActions.count
    }

    @MainActor
    var activeCount: Int {
        activeActions.count
    }

    @MainActor
    var suggestedCount: Int {
        suggestedActions.count
    }

    // MARK: - Lookup Methods

    /// Get an action by its ID
    func getAction(by id: UUID) -> Action? {
        actions.first { $0.id == id }
    }

    // MARK: - Private Properties

    private let supabase = SupabaseManager.shared
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Query Shape

    /// Every action fetch embeds the board column it points at.
    ///
    /// `actions` has no `status` column — an action's lifecycle is the category
    /// of the `workflow_state` row `status_id` references. Embedding it here
    /// means `Action.status` decodes ready-to-render, with no @MainActor lookup
    /// and no dependence on the default team's state cache.
    static let actionSelect = "*, workflow_state:workflow_state!status_id(id,name,category,color)"

    /// Same embed, but as an INNER join so PostgREST allows filtering on
    /// `workflow_state.category` (a filter on an embedded resource drops rows
    /// only when the embed is inner).
    static let actionSelectInner = "*, workflow_state:workflow_state!status_id!inner(id,name,category,color)"

    /// The workspace + person scope every query shares: rows in my workspace
    /// that are either mine or assigned to me.
    ///
    /// Returns the pieces rather than a query so each call site can chain in
    /// its own order (PostgREST builders are value types, but `.or()` has to
    /// land after the base `.eq`).
    private struct Scope {
        let userId: UUID
        let workspaceId: UUID?
        let memberId: UUID?

        /// `user_id.eq.X,assignee_id.eq.Y` — or just the user clause when the
        /// member id hasn't resolved yet (bootstrap not finished / no membership).
        var orClause: String? {
            guard let memberId else { return nil }
            return "user_id.eq.\(userId.uuidString),assignee_id.eq.\(memberId.uuidString)"
        }
    }

    private func currentScope() async throws -> Scope {
        guard let userId = supabase.currentUser?.id else {
            throw ActionsError.authRequired
        }
        let (wsId, memberId) = await MainActor.run {
            (WorkspaceService.shared.workspaceId, WorkspaceService.shared.activeMember?.id)
        }
        return Scope(userId: userId, workspaceId: wsId, memberId: memberId)
    }

    // MARK: - Initialization

    private init() {
        setupAuthObserver()
        setupCacheInvalidation()
        setupWorkspaceObserver()
    }

    /// `actions` is workspace-scoped (and every row carries a `team_id` +
    /// `status_id` belonging to the OLD workspace's team), so the cached array
    /// is meaningless after a switch. Clear synchronously on the main actor so
    /// Home never paints the previous workspace's action items, then refetch.
    private func setupWorkspaceObserver() {
        NotificationCenter.default.publisher(for: .workspaceDidChange)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.actions = []
                    self.error = nil
                    self.isLoading = false
                    self.invalidateCaches()
                    print("🔔 ActionsService: cleared cache for workspace switch")
                    _ = try? await self.fetchActions()
                }
            }
            .store(in: &cancellables)
    }

    private func setupCacheInvalidation() {
        // Invalidate caches whenever actions array changes. The caches are
        // @MainActor (SwiftUI reads them), so hop before clearing.
        $actions
            .sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.invalidateCaches()
                }
            }
            .store(in: &cancellables)
    }

    private func setupAuthObserver() {
        // Refresh actions when auth state changes
        NotificationCenter.default.publisher(for: .authenticationComplete)
            .sink { [weak self] _ in
                Task {
                    try? await self?.fetchActions()
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .userSignedOut)
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.actions = []
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Private Helpers

    /// Merges server actions with local actions, preserving optimistically-added items
    /// This prevents race conditions where newly created actions disappear
    /// because fetchActions() returns stale data before the server has processed the insert
    @MainActor
    private func mergeActions(serverActions: [Action]) {
        // Get IDs of all server actions
        let serverIds = Set(serverActions.map { $0.id })

        // Find local actions that aren't in the server response
        // These might be recently created actions that haven't propagated yet
        let recentlyCreatedCutoff = Date().addingTimeInterval(-30) // Actions created in last 30 seconds
        let localOnlyActions = actions.filter { action in
            !serverIds.contains(action.id) && action.createdAt > recentlyCreatedCutoff
        }

        if !localOnlyActions.isEmpty {
            print("🔔 ActionsService: Preserving \(localOnlyActions.count) recently created local actions")
        }

        // Merge: server actions + any recently created local-only actions
        var merged = serverActions
        for localAction in localOnlyActions {
            // Insert at the beginning since new actions should appear at top
            merged.insert(localAction, at: 0)
        }

        self.actions = merged
        self.sortActions()
    }

    // MARK: - CRUD Operations

    /// Start a scoped `actions` query: the right select (inner join when the
    /// caller needs to filter on the embedded workflow state), the workspace
    /// filter, and the "mine or assigned to me" clause.
    private func scopedQuery(_ scope: Scope, needsStateFilter: Bool) -> PostgrestFilterBuilder {
        var query = supabase.client
            .from("actions")
            .select(needsStateFilter ? Self.actionSelectInner : Self.actionSelect)

        if let wsId = scope.workspaceId {
            query = query.eq("workspace_id", value: wsId.uuidString)
        }

        if let orClause = scope.orClause {
            query = query.or(orClause)
        } else {
            // No resolved member yet — fall back to rows this user created.
            query = query.eq("user_id", value: scope.userId.uuidString)
        }

        return query
    }

    // MARK: - Mutation Scope

    /// Apply the SAME person scope a read uses to a write.
    ///
    /// Reads list rows that are mine OR assigned to me; a write that still
    /// pinned `.eq("user_id")` matched ZERO rows for anything a teammate created
    /// and assigned to me — and `.single()` then threw. Every mutation funnels
    /// through here so what you can see, you can change.
    ///
    /// Not workspace-filtered on purpose: `id` is already unique, and adding
    /// `workspace_id` would silently no-op a write before bootstrap resolves.
    private func scopedMutation(_ query: PostgrestFilterBuilder, _ scope: Scope) -> PostgrestFilterBuilder {
        if let orClause = scope.orClause {
            return query.or(orClause)
        }
        return query.eq("user_id", value: scope.userId.uuidString)
    }

    /// The team an action belongs to: local cache first, then a narrow fetch.
    /// `nil` when the row can't be found (caller falls back to the default team).
    private func resolveTeamId(for actionId: UUID) async -> UUID? {
        if let cached = await MainActor.run(body: { self.getAction(by: actionId)?.teamId }) {
            return cached
        }

        struct TeamIdRow: Decodable { let team_id: UUID? }
        do {
            let row: TeamIdRow = try await supabase.client
                .from("actions")
                .select("team_id")
                .eq("id", value: actionId.uuidString)
                .single()
                .execute()
                .value
            return row.team_id
        } catch {
            print("❌ ActionsService: Failed to resolve team for action \(actionId): \(error)")
            return nil
        }
    }

    /// Resolve `category`'s board column in the ACTION's own team, falling back
    /// to the default team only when the action's team can't be determined.
    private func stateId(for category: WorkflowStateCategory, actionId: UUID) async throws -> UUID? {
        if let teamId = await resolveTeamId(for: actionId),
           let stateId = try await WorkspaceService.shared.stateId(for: category, teamId: teamId) {
            return stateId
        }
        return await MainActor.run { WorkspaceService.shared.stateId(for: category) }
    }

    /// The category of a board column, looked up in the action's own team first
    /// and the default team's cache second. `nil` when the column is unknown —
    /// callers treat that as "not completed".
    private func category(ofState stateId: UUID, actionId: UUID) async -> WorkflowStateCategory? {
        if let teamId = await resolveTeamId(for: actionId),
           let states = try? await WorkspaceService.shared.states(forTeam: teamId),
           let match = states.first(where: { $0.id == stateId }) {
            return match.category
        }
        return await MainActor.run { WorkspaceService.shared.workflowState(stateId)?.category }
    }

    /// The default (new-work) column in the ACTION's own team, else the default
    /// team's.
    private func defaultStateId(actionId: UUID) async throws -> UUID? {
        if let teamId = await resolveTeamId(for: actionId),
           let stateId = try await WorkspaceService.shared.defaultStateId(forTeam: teamId) {
            return stateId
        }
        return await MainActor.run { WorkspaceService.shared.defaultStatusId }
    }

    /// Fetch actions for the current user, scoped to the active workspace.
    ///
    /// Note there is no `status` column to filter on: "active" means
    /// `confirmation = 'confirmed'` AND a board column in an open category;
    /// "suggested" means `confirmation = 'suggested'` and not dismissed.
    func fetchActions(filter: ActionFilter = .all, status: ActionStatus? = nil) async throws -> [Action] {
        let scope = try await currentScope()

        await MainActor.run {
            isLoading = true
            error = nil
        }

        defer {
            Task { @MainActor in
                isLoading = false
            }
        }

        let iso = ISO8601DateFormatter()

        do {
            let result: [Action]

            switch filter {
            case .today:
                let startOfDay = Calendar.current.startOfDay(for: Date())
                let endOfDay = Calendar.current.date(byAdding: .day, value: 1, to: startOfDay)!
                result = try await scopedQuery(scope, needsStateFilter: true)
                    .eq("confirmation", value: ActionConfirmation.confirmed)
                    .in("workflow_state.category", values: WorkflowStateCategory.openCategoryValues)
                    .gte("due_at", value: iso.string(from: startOfDay))
                    .lt("due_at", value: iso.string(from: endOfDay))
                    .order("due_at", ascending: true)
                    .execute()
                    .value

            case .tomorrow:
                let startOfTomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: Date()))!
                let endOfTomorrow = Calendar.current.date(byAdding: .day, value: 1, to: startOfTomorrow)!
                result = try await scopedQuery(scope, needsStateFilter: true)
                    .eq("confirmation", value: ActionConfirmation.confirmed)
                    .in("workflow_state.category", values: WorkflowStateCategory.openCategoryValues)
                    .gte("due_at", value: iso.string(from: startOfTomorrow))
                    .lt("due_at", value: iso.string(from: endOfTomorrow))
                    .order("due_at", ascending: true)
                    .execute()
                    .value

            case .thisWeek:
                let startOfDay = Calendar.current.startOfDay(for: Date())
                let endOfWeek = Calendar.current.date(byAdding: .day, value: 7, to: startOfDay)!
                result = try await scopedQuery(scope, needsStateFilter: true)
                    .eq("confirmation", value: ActionConfirmation.confirmed)
                    .in("workflow_state.category", values: WorkflowStateCategory.openCategoryValues)
                    .gte("due_at", value: iso.string(from: startOfDay))
                    .lt("due_at", value: iso.string(from: endOfWeek))
                    .order("due_at", ascending: true)
                    .execute()
                    .value

            case .suggested:
                result = try await scopedQuery(scope, needsStateFilter: false)
                    .eq("confirmation", value: ActionConfirmation.suggested)
                    .eq("is_dismissed", value: false)
                    .order("ai_confidence", ascending: false)
                    .order("created_at", ascending: false)
                    .execute()
                    .value

            case .overdue:
                result = try await scopedQuery(scope, needsStateFilter: true)
                    .eq("confirmation", value: ActionConfirmation.confirmed)
                    .in("workflow_state.category", values: WorkflowStateCategory.openCategoryValues)
                    .lt("due_at", value: iso.string(from: Date()))
                    .order("due_at", ascending: true)
                    .execute()
                    .value

            case .completed:
                result = try await scopedQuery(scope, needsStateFilter: true)
                    .eq("confirmation", value: ActionConfirmation.confirmed)
                    .eq("workflow_state.category", value: WorkflowStateCategory.completed.rawValue)
                    .order("completed_at", ascending: false)
                    .execute()
                    .value

            case .snoozed:
                // Snoozed rides on the snoozed_until timestamp, orthogonal to
                // whichever board column the action sits in.
                result = try await scopedQuery(scope, needsStateFilter: false)
                    .gt("snoozed_until", value: iso.string(from: Date()))
                    .order("snoozed_until", ascending: true)
                    .execute()
                    .value

            case .all:
                switch status {
                case .some(.suggested):
                    result = try await scopedQuery(scope, needsStateFilter: false)
                        .eq("confirmation", value: ActionConfirmation.suggested)
                        .eq("is_dismissed", value: false)
                        .order("ai_confidence", ascending: false)
                        .execute()
                        .value

                case .some(.completed):
                    result = try await scopedQuery(scope, needsStateFilter: true)
                        .eq("confirmation", value: ActionConfirmation.confirmed)
                        .eq("workflow_state.category", value: WorkflowStateCategory.completed.rawValue)
                        .order("completed_at", ascending: false)
                        .execute()
                        .value

                case .some(.cancelled):
                    result = try await scopedQuery(scope, needsStateFilter: true)
                        .in("workflow_state.category", values: [
                            WorkflowStateCategory.canceled.rawValue,
                            WorkflowStateCategory.lost.rawValue,
                        ])
                        .order("updated_at", ascending: false)
                        .execute()
                        .value

                case .some(.inProgress):
                    result = try await scopedQuery(scope, needsStateFilter: true)
                        .eq("confirmation", value: ActionConfirmation.confirmed)
                        .eq("workflow_state.category", value: WorkflowStateCategory.started.rawValue)
                        .order("due_at", ascending: true)
                        .execute()
                        .value

                case .some(.confirmed):
                    result = try await scopedQuery(scope, needsStateFilter: true)
                        .eq("confirmation", value: ActionConfirmation.confirmed)
                        .in("workflow_state.category", values: WorkflowStateCategory.openCategoryValues)
                        .order("due_at", ascending: true)
                        .execute()
                        .value

                case .none:
                    result = try await scopedQuery(scope, needsStateFilter: false)
                        .order("due_at", ascending: true)
                        .order("created_at", ascending: false)
                        .execute()
                        .value
                }
            }

            await MainActor.run {
                if filter == .all && status == nil {
                    // A fetch issued BEFORE the workspace switch must never land
                    // AFTER it: `mergeActions` assigns `self.actions` wholesale,
                    // so the old workspace's rows would repaint on top of the
                    // observer's `actions = []` and stay there. The scope was
                    // captured at entry, so comparing it against the live
                    // workspace tells us whether this result is still current.
                    guard scope.workspaceId == WorkspaceService.shared.workspaceId else {
                        print("🔔 ActionsService: discarded \(result.count) actions from a stale workspace fetch")
                        return
                    }
                    // Merge server results with local actions to preserve optimistically-added items
                    // This prevents newly created actions from disappearing due to race conditions
                    self.mergeActions(serverActions: result)
                }
            }

            print("🔔 ActionsService: Fetched \(result.count) actions (filter: \(filter.rawValue))")
            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ ActionsService: Failed to fetch actions: \(error)")
            throw error
        }
    }

    /// Create a new action
    func createAction(_ dto: CreateActionDTO) async throws -> Action {
        guard let userId = supabase.currentUser?.id else {
            throw ActionsError.authRequired
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
            // Workspace context is mandatory: workspace_id / team_id / status_id
            // are all NOT NULL, and the identifier trigger keys off team_id.
            //
            // `memberId` rides along on purpose: the website's "My actions" view
            // filters `assignee_id = member.id`, so a row created here with a NULL
            // assignee is invisible there even though it's mine.
            let context: (workspaceId: UUID, teamId: UUID, statusId: UUID, memberId: UUID?) =
                try await MainActor.run {
                    let ws = WorkspaceService.shared
                    return (
                        workspaceId: try ws.requireWorkspaceId(),
                        teamId: try ws.requireTeamId(),
                        statusId: try ws.requireStatusId(),
                        memberId: ws.activeMember?.id
                    )
                }
            let workspaceId = context.workspaceId
            let teamId = context.teamId
            let statusId = context.statusId
            let assigneeId = context.memberId

            if assigneeId == nil {
                print("⚠️ ActionsService: No active member — creating action with a NULL assignee_id")
            }

            let sourceType = dto.sourceType.flatMap { ActionSourceType(rawValue: $0) } ?? .user

            let action = Action(
                userId: userId,
                deviceId: DeviceManager.shared.deviceId,
                workspaceId: workspaceId,
                teamId: teamId,
                statusId: statusId,
                confirmation: dto.confirmation ?? ActionConfirmation.confirmed,
                milestoneId: dto.milestoneId,
                projectId: dto.projectId,
                assigneeId: assigneeId,
                title: dto.title,
                description: dto.description,
                dueAt: dto.dueAt,
                allDay: dto.allDay ?? false,
                links: dto.links ?? [],
                recurrenceRule: dto.recurrenceRule,
                assignees: dto.assignees ?? [],
                priority: ActionPriority.fromString(dto.priority),
                sortOrder: dto.sortOrder ?? 0,
                aiConfidence: dto.aiConfidence ?? 1.0,
                originalTranscript: dto.originalTranscript,
                contextSource: dto.contextSource,
                contextData: dto.contextData,
                sourceType: sourceType,
                sourceCaptureId: dto.sourceCaptureId,
                sourceSuggestionId: dto.sourceSuggestionId
            )

            let result: Action = try await supabase.client
                .from("actions")
                .insert(action)
                .select(Self.actionSelect)
                .single()
                .execute()
                .value

            await MainActor.run {
                self.actions.insert(result, at: 0)
                self.sortActions()
            }

            // Schedule notification if due date is set

            print("🔔 ActionsService: Created action: \(result.title)")

            // Post notification for UI updates
            await MainActor.run {
                NotificationCenter.default.post(name: .actionCreated, object: result)
            }

            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ ActionsService: Failed to create action: \(error)")
            throw error
        }
    }

    /// Update an existing action
    func updateAction(id: UUID, _ dto: UpdateActionDTO) async throws -> Action {
        let scope = try await currentScope()

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
            // Use the dueAtWasSet flag to distinguish "leave alone" from "clear".
            let shouldClearDueAt = dto.dueAtWasSet && dto.dueAt == nil
            let updates = ActionUpdatePayload(
                title: dto.title,
                description: dto.description,
                due_at: dto.dueAt.map { ISO8601DateFormatter().string(from: $0) },
                all_day: dto.allDay,
                priority: dto.priority,
                links: dto.links,
                recurrence_rule: dto.recurrenceRule,
                status_id: dto.statusId,
                confirmation: dto.confirmation,
                milestone_id: dto.milestoneId,
                project_id: dto.projectId,
                color: dto.color,
                sort_order: dto.sortOrder,
                assignees: dto.assignees,
                assigned_to_user: dto.assignedToUser,
                updated_at: ISO8601DateFormatter().string(from: Date()),
                shouldClearDueAt: shouldClearDueAt
            )

            let query = try supabase.client
                .from("actions")
                .update(updates)
                .eq("id", value: id.uuidString)

            let result: Action = try await scopedMutation(query, scope)
                .select(Self.actionSelect)
                .single()
                .execute()
                .value

            await MainActor.run {
                if let index = self.actions.firstIndex(where: { $0.id == id }) {
                    self.actions[index] = result
                    self.sortActions()
                }
            }

            // Reschedule notification

            // Notify observers that action was updated
            NotificationCenter.default.post(name: .actionUpdated, object: result)

            print("🔔 ActionsService: Updated action: \(result.title)")
            return result

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ ActionsService: Failed to update action: \(error)")
            throw error
        }
    }

    /// Delete an action
    func deleteAction(id: UUID) async throws {
        let scope = try await currentScope()

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
            let query = supabase.client
                .from("actions")
                .delete()
                .eq("id", value: id.uuidString)

            try await scopedMutation(query, scope).execute()

            await MainActor.run {
                self.actions.removeAll { $0.id == id }
            }

            // Cancel notification

            // Notify observers that action was deleted
            NotificationCenter.default.post(name: .actionDeleted, object: nil, userInfo: ["actionId": id])

            print("🔔 ActionsService: Deleted action")

        } catch {
            await MainActor.run {
                self.error = error
            }
            print("❌ ActionsService: Failed to delete action: \(error)")
            throw error
        }
    }

    /// Mark an action as completed — i.e. move it to the team's completed
    /// board column and stamp `completed_at`.
    ///
    /// Deliberately NOT the `complete_action` RPC: that function still writes
    /// `SET status = 'completed'`, and `actions.status` no longer exists, so it
    /// errors on every call.
    ///
    /// `statusId` lets the caller name a SPECIFIC completed column (the board's
    /// picker offers several); omit it and the action's own team's first
    /// completed column wins.
    func completeAction(id: UUID, statusId: UUID? = nil) async throws -> Action {
        let scope = try await currentScope()

        do {
            // Resolve against the ACTION's team, not the default team — an
            // action assigned to me can live in another team entirely.
            let resolvedStateId: UUID?
            if let statusId {
                resolvedStateId = statusId
            } else {
                resolvedStateId = try await stateId(for: .completed, actionId: id)
            }
            guard let completedStateId = resolvedStateId else {
                throw ActionsError.noCompletedState
            }

            let payload = StatusTransitionPayload(
                status_id: completedStateId,
                completed_at: ISO8601DateFormatter().string(from: Date()),
                clearCompletedAt: false,
                confirmation: ActionConfirmation.confirmed,
                updated_at: ISO8601DateFormatter().string(from: Date())
            )

            let query = try supabase.client
                .from("actions")
                .update(payload)
                .eq("id", value: id.uuidString)

            let result: Action = try await scopedMutation(query, scope)
                .select(Self.actionSelect)
                .single()
                .execute()
                .value

            await MainActor.run {
                if let index = self.actions.firstIndex(where: { $0.id == id }) {
                    self.actions[index] = result
                }
            }

            // Cancel notification

            print("🔔 ActionsService: Completed action: \(result.title)")

            // Post notification for UI updates
            await MainActor.run {
                NotificationCenter.default.post(name: .actionCompleted, object: result)
            }

            return result

        } catch {
            print("❌ ActionsService: Failed to complete action: \(error)")
            throw error
        }
    }

    /// Confirm an AI suggestion: `confirmation` suggested → confirmed, and land
    /// it in the team's default board column if it has no state yet.
    ///
    /// Not the `confirm_action` RPC — that one writes the dropped `status`
    /// column and fails.
    func confirmAction(_ actionId: UUID) async throws -> Action {
        let scope = try await currentScope()

        do {
            // Only supply a status_id when the row hasn't got one — never
            // yank a suggestion that already sits in a real column back to
            // the default. The default comes from the ACTION's own team.
            //
            // Same shape for the assignee: an extraction-born suggestion has a
            // NULL `assignee_id`, and confirming it is the moment it becomes
            // MY work — so stamp me, but only if nobody is on it already
            // (the website's "My actions" filters on this column).
            let existing = await MainActor.run { () -> (statusId: UUID?, assigneeId: UUID?, memberId: UUID?) in
                let row = self.actions.first(where: { $0.id == actionId })
                return (row?.statusId, row?.assigneeId, WorkspaceService.shared.activeMember?.id)
            }
            let fallbackStatusId = existing.statusId == nil
                ? try await defaultStateId(actionId: actionId)
                : nil
            let fallbackAssigneeId = existing.assigneeId == nil ? existing.memberId : nil

            let payload = ConfirmActionPayload(
                confirmation: ActionConfirmation.confirmed,
                status_id: fallbackStatusId,
                assignee_id: fallbackAssigneeId,
                updated_at: ISO8601DateFormatter().string(from: Date())
            )

            let query = try supabase.client
                .from("actions")
                .update(payload)
                .eq("id", value: actionId.uuidString)

            let result: Action = try await scopedMutation(query, scope)
                .select(Self.actionSelect)
                .single()
                .execute()
                .value

            await MainActor.run {
                if let index = self.actions.firstIndex(where: { $0.id == actionId }) {
                    self.actions[index] = result
                }
            }

            // Schedule notification if due date is set

            print("🔔 ActionsService: Confirmed suggestion: \(result.title)")

            // Post notification for UI updates and agent spawning
            await MainActor.run {
                NotificationCenter.default.post(name: .actionUpdated, object: result)
                NotificationCenter.default.post(name: .actionConfirmed, object: result)
            }

            return result

        } catch {
            print("❌ ActionsService: Failed to confirm action: \(error)")
            throw error
        }
    }

    /// Dismiss an AI suggestion (marks as is_dismissed = true)
    func dismissAction(_ actionId: UUID, reason: String? = nil) async throws {
        let scope = try await currentScope()

        do {
            // Direct update rather than the `dismiss_action` RPC: that function
            // gates on `status = 'suggested'`, a column that no longer exists.
            // Both reason columns are written — `dismissed_reason` is the legacy
            // one, `dismiss_reason` the one the website reads.
            let payload = DismissActionPayload(
                is_dismissed: true,
                dismissed_reason: reason,
                dismiss_reason: reason,
                dismissed_at: ISO8601DateFormatter().string(from: Date()),
                updated_at: ISO8601DateFormatter().string(from: Date())
            )

            let query = try supabase.client
                .from("actions")
                .update(payload)
                .eq("id", value: actionId.uuidString)

            try await scopedMutation(query, scope).execute()

            await MainActor.run {
                // Remove from local state or update the action
                if let index = self.actions.firstIndex(where: { $0.id == actionId }) {
                    self.actions[index].isDismissed = true
                    self.actions[index].dismissedReason = reason
                    self.actions[index].dismissReason = reason
                    self.actions[index].dismissedAt = Date()
                }
            }

            print("🔔 ActionsService: Dismissed suggestion: \(actionId)")

            // Post notification for UI updates
            await MainActor.run {
                NotificationCenter.default.post(name: .actionUpdated, object: nil, userInfo: ["actionId": actionId])
            }

        } catch {
            print("❌ ActionsService: Failed to dismiss action: \(error)")
            throw error
        }
    }

    /// Reopen a completed action: back to the team's default board column with
    /// `completed_at` cleared.
    func uncompleteAction(id: UUID) async throws -> Action {
        let scope = try await currentScope()

        do {
            // The ACTION's own team's default column — reopening into the
            // default team's column would strand a cross-team action.
            guard let reopenStatusId = try await defaultStateId(actionId: id) else {
                throw ActionsError.noDefaultState
            }

            let updates = StatusTransitionPayload(
                status_id: reopenStatusId,
                completed_at: nil,
                clearCompletedAt: true,
                confirmation: ActionConfirmation.confirmed,
                updated_at: ISO8601DateFormatter().string(from: Date())
            )

            let query = try supabase.client
                .from("actions")
                .update(updates)
                .eq("id", value: id.uuidString)

            let result: Action = try await scopedMutation(query, scope)
                .select(Self.actionSelect)
                .single()
                .execute()
                .value

            await MainActor.run {
                if let index = self.actions.firstIndex(where: { $0.id == id }) {
                    self.actions[index] = result
                }
            }

            // Reschedule notification if due date is set

            print("🔔 ActionsService: Reopened action: \(result.title)")

            await MainActor.run {
                NotificationCenter.default.post(name: .actionUpdated, object: result)
            }

            return result

        } catch {
            print("❌ ActionsService: Failed to reopen action: \(error)")
            throw error
        }
    }

    /// Move an action to a different board column (workflow state).
    ///
    /// Replaces the old `moveAction(toListId:)` — action lists were cut, and
    /// "where an action lives" is now the team's workflow state.
    @discardableResult
    func moveAction(id: UUID, toStatusId: UUID, sortOrder: Int? = nil) async throws -> Action {
        let scope = try await currentScope()

        do {
            // Leaving a completed column must clear `completed_at` — otherwise
            // a reopened action keeps a completion timestamp the UI still shows.
            // Resolve the destination's category in the ACTION's own team.
            let destinationCategory = await category(ofState: toStatusId, actionId: id)
            let shouldClearCompletedAt = destinationCategory != .completed

            let updates = MoveActionPayload(
                status_id: toStatusId,
                sort_order: sortOrder,
                updated_at: ISO8601DateFormatter().string(from: Date()),
                clearCompletedAt: shouldClearCompletedAt
            )

            let query = try supabase.client
                .from("actions")
                .update(updates)
                .eq("id", value: id.uuidString)

            let result: Action = try await scopedMutation(query, scope)
                .select(Self.actionSelect)
                .single()
                .execute()
                .value

            await MainActor.run {
                if let index = self.actions.firstIndex(where: { $0.id == id }) {
                    self.actions[index] = result
                }
            }

            print("🔔 ActionsService: Moved action to state \(toStatusId)")

            await MainActor.run {
                NotificationCenter.default.post(name: .actionUpdated, object: result)
            }

            return result

        } catch {
            print("❌ ActionsService: Failed to move action: \(error)")
            throw error
        }
    }

    /// Move an action into the first state of a given category (e.g. start it).
    /// The category resolves in the ACTION's own team.
    @discardableResult
    func moveAction(id: UUID, to category: WorkflowStateCategory) async throws -> Action {
        guard let statusId = try await stateId(for: category, actionId: id) else {
            throw ActionsError.noStateForCategory(category.rawValue)
        }
        return try await moveAction(id: id, toStatusId: statusId)
    }

    // MARK: - Search Operations

    /// Search actions by title (case-insensitive)
    func searchActions(query: String) async throws -> [Action] {
        let scope = try await currentScope()

        do {
            // Use ilike for case-insensitive search
            let actions: [Action] = try await scopedQuery(scope, needsStateFilter: false)
                .ilike("title", pattern: "%\(query)%")
                .order("due_at", ascending: true)
                .execute()
                .value

            print("🔔 ActionsService: Found \(actions.count) actions matching '\(query)'")
            return actions

        } catch {
            print("❌ ActionsService: Search failed: \(error)")
            throw error
        }
    }

    /// Delete all suggested actions linked to a specific note
    /// This is used when deleting a note or regenerating its summary
    /// Only deletes actions with status = 'suggested' to preserve confirmed/completed actions
    func deleteSuggestedActionsForNote(_ noteId: UUID) async throws {
        let scope = try await currentScope()

        do {
            // First, fetch the suggested actions from the database to get accurate IDs
            // This ensures we have the complete list, not just what's in the local cache.
            //
            // Scoped the same way every other mutation is: pinning `.eq("user_id")`
            // here skipped every suggestion a teammate's capture produced and
            // assigned to me, so they survived the capture delete as orphans.
            let prefetch = supabase.client
                .from("actions")
                .select(Self.actionSelect)
                .eq("source_capture_id", value: noteId.uuidString)
                .eq("confirmation", value: ActionConfirmation.suggested)

            let actionsToDelete: [Action] = try await scopedMutation(prefetch, scope)
                .execute()
                .value

            let actionIds = actionsToDelete.map { $0.id }

            // Delete from database - only suggested actions for this capture
            let deletion = supabase.client
                .from("actions")
                .delete()
                .eq("source_capture_id", value: noteId.uuidString)
                .eq("confirmation", value: ActionConfirmation.suggested)

            try await scopedMutation(deletion, scope).execute()

            // Remove from local cache - use the IDs we fetched from database
            await MainActor.run {
                // Signal change before mutating to ensure UI updates
                self.objectWillChange.send()
                self.actions.removeAll { actionIds.contains($0.id) }
            }

            // Cancel notifications for deleted actions

            print("🗑️ ActionsService: Deleted \(actionIds.count) suggested actions for note \(noteId)")

        } catch {
            print("❌ ActionsService: Failed to delete suggested actions for note: \(error)")
            throw error
        }
    }

    // MARK: - Helper Methods

    private func sortActions() {
        actions.sort { a1, a2 in
            // Overdue first
            if a1.isOverdue != a2.isOverdue {
                return a1.isOverdue
            }

            // Then by due date
            if let d1 = a1.dueAt, let d2 = a2.dueAt {
                return d1 < d2
            }

            // No due date goes last
            if a1.dueAt != nil && a2.dueAt == nil {
                return true
            }

            return false
        }
    }

    /// Refresh actions from the server
    func refresh() async throws {
        _ = try await fetchActions()
    }
}

// MARK: - Actions Error

enum ActionsError: LocalizedError {
    case authRequired
    case notFound
    case invalidData
    case noCompletedState
    case noDefaultState
    case noStateForCategory(String)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .authRequired:
            return "Please sign in to use actions"
        case .notFound:
            return "Action not found"
        case .invalidData:
            return "Invalid action data"
        case .noCompletedState:
            return "Your team has no \"Done\" column, so actions can't be completed."
        case .noDefaultState:
            return "Your team has no default column for new actions."
        case .noStateForCategory(let category):
            return "Your team has no \(category) column."
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

// MARK: - Notification Names

extension Notification.Name {
    static let actionCreated = Notification.Name("actionCreated")
    static let actionConfirmed = Notification.Name("actionConfirmed")
    static let actionCompleted = Notification.Name("actionCompleted")
    static let actionDeleted = Notification.Name("actionDeleted")
    static let actionUpdated = Notification.Name("actionUpdated")
}

// MARK: - Internal Payloads

/// Payload for updating an action (Encodable for Supabase).
/// Every key here is a live column — there is no `status`, `list_id` or `tags`.
private struct ActionUpdatePayload: Encodable {
    let title: String?
    let description: String?
    let due_at: String?
    let all_day: Bool?
    let priority: String?
    let links: [ActionLink]?
    let recurrence_rule: String?
    let status_id: UUID?
    let confirmation: String?
    let milestone_id: UUID?
    let project_id: UUID?
    let color: String?
    let sort_order: Int?
    let assignees: [ActionAssignee]?
    let assigned_to_user: Bool?
    let updated_at: String
    let shouldClearDueAt: Bool   // Flag to explicitly clear due_at

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        // Only encode non-nil values
        if let title { try container.encode(title, forKey: .title) }
        if let description { try container.encode(description, forKey: .description) }
        // For due_at, encode null explicitly if shouldClearDueAt is true
        if let due_at {
            try container.encode(due_at, forKey: .due_at)
        } else if shouldClearDueAt {
            try container.encodeNil(forKey: .due_at)
        }
        if let all_day { try container.encode(all_day, forKey: .all_day) }
        if let priority { try container.encode(priority, forKey: .priority) }
        if let links { try container.encode(links, forKey: .links) }
        if let recurrence_rule { try container.encode(recurrence_rule, forKey: .recurrence_rule) }
        if let status_id { try container.encode(status_id, forKey: .status_id) }
        if let confirmation { try container.encode(confirmation, forKey: .confirmation) }
        if let milestone_id { try container.encode(milestone_id, forKey: .milestone_id) }
        if let project_id { try container.encode(project_id, forKey: .project_id) }
        if let color { try container.encode(color, forKey: .color) }
        if let sort_order { try container.encode(sort_order, forKey: .sort_order) }
        if let assignees { try container.encode(assignees, forKey: .assignees) }
        if let assigned_to_user { try container.encode(assigned_to_user, forKey: .assigned_to_user) }
        try container.encode(updated_at, forKey: .updated_at)
    }

    private enum CodingKeys: String, CodingKey {
        case title, description, due_at, all_day, priority, links, recurrence_rule
        case status_id, confirmation, milestone_id, project_id, color, sort_order
        case assignees, assigned_to_user, updated_at
    }
}

/// Payload for a lifecycle move: a new board column plus `completed_at`.
/// `clearCompletedAt` forces an explicit JSON null, which Swift would otherwise
/// omit — leaving a stale completion timestamp on a reopened action.
private struct StatusTransitionPayload: Encodable {
    let status_id: UUID
    let completed_at: String?
    let clearCompletedAt: Bool
    let confirmation: String?
    let updated_at: String

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status_id, forKey: .status_id)
        if let completed_at {
            try container.encode(completed_at, forKey: .completed_at)
        } else if clearCompletedAt {
            try container.encodeNil(forKey: .completed_at)
        }
        if let confirmation { try container.encode(confirmation, forKey: .confirmation) }
        try container.encode(updated_at, forKey: .updated_at)
    }

    private enum CodingKeys: String, CodingKey {
        case status_id, completed_at, confirmation, updated_at
    }
}

/// Payload for confirming a suggestion.
private struct ConfirmActionPayload: Encodable {
    let confirmation: String
    let status_id: UUID?
    /// Only sent when the row had no assignee — never overwrites one.
    let assignee_id: UUID?
    let updated_at: String

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(confirmation, forKey: .confirmation)
        if let status_id { try container.encode(status_id, forKey: .status_id) }
        if let assignee_id { try container.encode(assignee_id, forKey: .assignee_id) }
        try container.encode(updated_at, forKey: .updated_at)
    }

    private enum CodingKeys: String, CodingKey {
        case confirmation, status_id, assignee_id, updated_at
    }
}

/// Payload for dismissing a suggestion. Both reason columns exist on the live
/// table; writing both keeps iOS and the website reading the same thing.
private struct DismissActionPayload: Encodable {
    let is_dismissed: Bool
    let dismissed_reason: String?
    let dismiss_reason: String?
    let dismissed_at: String
    let updated_at: String
}

/// Payload for moving an action to a different board column.
///
/// `clearCompletedAt` forces an explicit JSON null on `completed_at` when the
/// destination is NOT a completed column — leaving a stale completion timestamp
/// on an action dragged back out of Done.
private struct MoveActionPayload: Encodable {
    let status_id: UUID
    let sort_order: Int?
    let updated_at: String
    let clearCompletedAt: Bool

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status_id, forKey: .status_id)
        if let sort_order {
            try container.encode(sort_order, forKey: .sort_order)
        }
        if clearCompletedAt {
            try container.encodeNil(forKey: .completed_at)
        }
        try container.encode(updated_at, forKey: .updated_at)
    }

    private enum CodingKeys: String, CodingKey {
        case status_id, sort_order, completed_at, updated_at
    }
}

/// Payload for snoozing an action (a plain `snoozed_until` write).
private struct SnoozeActionPayload: Encodable {
    let snoozed_until: String
    let updated_at: String
}

/// Payload for reordering an action
private struct ReorderActionPayload: Encodable {
    let sort_order: Int
    let updated_at: String
}

/// Payload for tracking an action: confirm it, but mark it as someone else's.
private struct TrackActionPayload: Encodable {
    let confirmation: String
    let status_id: UUID?
    let assigned_to_user: Bool
    let updated_at: String

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(confirmation, forKey: .confirmation)
        if let status_id { try container.encode(status_id, forKey: .status_id) }
        try container.encode(assigned_to_user, forKey: .assigned_to_user)
        try container.encode(updated_at, forKey: .updated_at)
    }

    private enum CodingKeys: String, CodingKey {
        case confirmation, status_id, assigned_to_user, updated_at
    }
}
