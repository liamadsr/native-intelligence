//
//  WorkspaceService.swift
//  dial8
//
//  Resolves and caches the signed-in user's active workspace, default team, and
//  default workflow state.
//
//  Why this exists: the backend schema is workspace-scoped. Core tables require
//  `workspace_id` NOT NULL (and `actions` also `team_id` + `status_id`). The app
//  historically had no workspace concept, so every insert failed. This service
//  is the single source of truth for those IDs — call `bootstrap()` after
//  sign-in, then read `workspaceId` / `defaultTeamId` / `defaultStatusId` when
//  building inserts.
//
//  Membership is provisioned server-side at signup (`handle_new_user` trigger),
//  so this service only READS the user's membership — it never creates one.
//

import Foundation
import Combine
import Supabase

@MainActor
final class WorkspaceService: ObservableObject {
    static let shared = WorkspaceService()

    // MARK: - Published state

    /// The active workspace's id. `nil` until `bootstrap()` succeeds.
    @Published private(set) var workspaceId: UUID?
    /// The default team within the active workspace (earliest-created).
    @Published private(set) var defaultTeamId: UUID?
    /// The default workflow state for the default team (where new actions land).
    @Published private(set) var defaultStatusId: UUID?

    /// The full active workspace record (for name/logo in UI).
    @Published private(set) var activeWorkspace: Workspace?
    /// The user's membership in the active workspace (role, display name).
    @Published private(set) var activeMember: WorkspaceMember?
    /// All workspaces the user belongs to (for a future switcher).
    @Published private(set) var memberships: [WorkspaceMember] = []
    /// The workspace rows behind `memberships`, name-ordered — what the switcher
    /// lists. Fetched in ONE query so a switcher doesn't cost N round trips.
    @Published private(set) var workspaces: [Workspace] = []
    /// True while `switchWorkspace(to:)` is re-bootstrapping.
    @Published private(set) var isSwitching = false
    /// Workflow states for the default team, indexed by id (for status display).
    @Published private(set) var workflowStatesByID: [UUID: WorkflowState] = [:]

    /// Workflow states keyed by team id — the default team's row lands here on
    /// bootstrap, other teams are fetched on demand.
    ///
    /// Why this exists: `actions` is WORKSPACE-scoped, so an action assigned to
    /// me can live in another team. Resolving "the completed column" against the
    /// default team's cache would write a FOREIGN team's `status_id`, which the
    /// board then can't render. Every lifecycle transition resolves through
    /// `states(forTeam:)` / `stateId(for:teamId:)` instead.
    @Published private(set) var statesByTeam: [UUID: [WorkflowState]] = [:]

    /// True once a bootstrap attempt has completed (success or failure).
    @Published private(set) var hasBootstrapped = false

    /// True once `workspaces` has actually been FILLED — not merely attempted.
    ///
    /// ⚠️ This is deliberately NOT `hasBootstrapped`, which flips in a `defer`
    /// that also runs when bootstrap throws, and which is true even when step 2's
    /// non-fatal `workspace` query came back empty. Anything that has to
    /// distinguish "the user belongs to no workspaces" from "we never got a list"
    /// must read THIS — the watch does exactly that, and believing an empty list
    /// there wipes the user's persisted workspace choice.
    ///
    /// Mirrors `CalendarAPIService.hasLoaded`, and is cleared by `reset()`.
    @Published private(set) var hasLoadedWorkspaces = false
    @Published private(set) var isBootstrapping = false
    @Published private(set) var lastError: Error?

    private var client: SupabaseClient { SupabaseManager.shared.client }

    private init() {}

    // MARK: - Derived helpers

    /// Whether the workspace context is fully resolved and safe to write with.
    var isReady: Bool {
        workspaceId != nil && defaultTeamId != nil && defaultStatusId != nil
    }

    /// Look up a workflow state by id (e.g. to render an action's status).
    func workflowState(_ id: UUID?) -> WorkflowState? {
        guard let id else { return nil }
        return workflowStatesByID[id]
    }

    /// The id of the first workflow state in the default team with the given
    /// category (lowest `sort_order` wins, matching the board's column order).
    ///
    /// Used by mutation paths that need to express a lifecycle transition as a
    /// `status_id` write — `actions` has no `status` column, so "complete this"
    /// means "move it to the team's completed column".
    func stateId(for category: WorkflowStateCategory) -> UUID? {
        workflowStatesByID.values
            .filter { $0.category == category }
            .sorted { $0.sortOrder < $1.sortOrder }
            .first?.id
    }

    /// The default state id, or the first state of the given category, or nil.
    /// Handy where either is acceptable (e.g. reopening a completed action).
    func stateId(for category: WorkflowStateCategory, fallbackToDefault: Bool) -> UUID? {
        stateId(for: category) ?? (fallbackToDefault ? defaultStatusId : nil)
    }

    /// All workflow-state ids in the default team whose category is "open work".
    var openStateIds: [UUID] {
        let open = Set(WorkflowStateCategory.openCategories)
        return workflowStatesByID.values
            .filter { open.contains($0.category) }
            .sorted { $0.sortOrder < $1.sortOrder }
            .map(\.id)
    }

    // MARK: - Per-team workflow states

    /// The board columns for an arbitrary team, cached after the first fetch.
    ///
    /// No `entity_kind` filter: that column exists only on the DEV database
    /// (an unmigrated experiment the website never references — every DEV row
    /// is 'action' anyway) and PROD rejects the query with
    /// "column workflow_state.entity_kind does not exist". The website resolves
    /// board columns by team alone; mirror it.
    func states(forTeam teamId: UUID) async throws -> [WorkflowState] {
        if let cached = statesByTeam[teamId] { return cached }

        let states: [WorkflowState] = try await client
            .from("workflow_state")
            .select()
            .eq("team_id", value: teamId.uuidString)
            .order("sort_order", ascending: true)
            .execute()
            .value

        statesByTeam[teamId] = states
        print("🏢 WorkspaceService: cached \(states.count) workflow states for team \(teamId)")
        return states
    }

    /// The first board column of `category` in `teamId` (board order), or nil.
    ///
    /// This is the cross-team counterpart of `stateId(for:)` — mutation paths
    /// must use it so a transition lands in the ACTION's own team.
    func stateId(for category: WorkflowStateCategory, teamId: UUID) async throws -> UUID? {
        let states = try await states(forTeam: teamId)
        return states.first { $0.category == category }?.id
    }

    /// The team's default column (where new/reopened actions land), or nil.
    func defaultStateId(forTeam teamId: UUID) async throws -> UUID? {
        let states = try await states(forTeam: teamId)
        return (states.first { $0.isDefault } ?? states.first)?.id
    }

    // MARK: - Errors

    enum WorkspaceError: LocalizedError {
        case notAuthenticated
        case noMembership
        case noTeam
        case noDefaultState
        case notAMember
        case captureInProgress

        var errorDescription: String? {
            switch self {
            case .notAuthenticated: return "Not signed in."
            case .noMembership: return "Your account isn't a member of any workspace yet."
            case .noTeam: return "No team found in your workspace."
            case .noDefaultState: return "No default workflow state configured for your team."
            case .notAMember: return "You're not a member of that workspace."
            case .captureInProgress: return "Finish the current capture before switching workspaces."
            }
        }
    }

    // MARK: - Selection persistence

    /// The remembered workspace is PER USER: two accounts on one device must not
    /// inherit each other's choice, and sign-out deliberately keeps the key so
    /// signing back in lands where you left off.
    private static func selectionKey(for userId: UUID) -> String {
        "dial8.workspace.selectedId.\(userId.uuidString)"
    }

    private func storedSelection(for userId: UUID) -> UUID? {
        UserDefaults.standard.string(forKey: Self.selectionKey(for: userId))
            .flatMap { UUID(uuidString: $0) }
    }

    private func storeSelection(_ workspaceId: UUID?, for userId: UUID) {
        let key = Self.selectionKey(for: userId)
        if let workspaceId {
            UserDefaults.standard.set(workspaceId.uuidString, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // MARK: - Bootstrap

    /// Resolve the active workspace, default team, and default workflow state for
    /// the signed-in user. Idempotent; safe to call on every sign-in / session
    /// restore. Throws `WorkspaceError` if the user has no resolvable context.
    @discardableResult
    func bootstrap() async throws -> Bool {
        guard let userId = SupabaseManager.shared.currentUser?.id else {
            throw WorkspaceError.notAuthenticated
        }
        // Honour the remembered choice; fall back to the earliest membership.
        return try await bootstrap(preferring: storedSelection(for: userId))
    }

    /// The one resolution path. `preferring` selects WHICH membership becomes
    /// active; everything downstream (team, states) is identical, which is why
    /// `switchWorkspace(to:)` reuses this rather than duplicating the logic.
    @discardableResult
    private func bootstrap(preferring preferredWorkspaceId: UUID?) async throws -> Bool {
        guard let userId = SupabaseManager.shared.currentUser?.id else {
            throw WorkspaceError.notAuthenticated
        }

        isBootstrapping = true
        lastError = nil
        defer {
            isBootstrapping = false
            hasBootstrapped = true
        }

        do {
            // 1) Memberships for this user (RLS: "Members can view workspace members").
            let members: [WorkspaceMember] = try await client
                .from("member")
                .select()
                .eq("user_id", value: userId.uuidString)
                .order("created_at", ascending: true)
                .execute()
                .value

            guard !members.isEmpty else {
                throw WorkspaceError.noMembership
            }
            // A stored preference only wins while it is still a membership —
            // losing access to a workspace must not strand the app on it.
            let preferred = preferredWorkspaceId.flatMap { wanted in
                members.first { $0.workspaceId == wanted }
            }
            guard let activeMember = preferred ?? members.first else {
                throw WorkspaceError.noMembership
            }
            self.memberships = members
            self.activeMember = activeMember
            let wsId = activeMember.workspaceId
            self.workspaceId = wsId

            // 2) Every workspace the user belongs to, in ONE query, so the
            //    switcher has names without N round trips. Non-fatal.
            let ids = members.map { $0.workspaceId.uuidString }
            let rows: [Workspace] = (try? await client
                .from("workspace")
                .select()
                .in("id", values: ids)
                .execute()
                .value) ?? []
            self.workspaces = rows.sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            // Only claim a list when there IS one. `rows` is a `try?` above, so an
            // empty result here means the query failed or returned nothing — in
            // neither case may a consumer treat `workspaces` as authoritative.
            if !rows.isEmpty { self.hasLoadedWorkspaces = true }
            self.activeWorkspace = rows.first { $0.id == wsId }

            // 3) Default team = earliest-created team in the workspace, matching
            //    the website's canonical resolution in actions/route.ts.
            let teams: [Team] = try await client
                .from("team")
                .select()
                .eq("workspace_id", value: wsId.uuidString)
                .order("created_at", ascending: true)
                .execute()
                .value

            guard let defaultTeam = teams.first else {
                throw WorkspaceError.noTeam
            }
            self.defaultTeamId = defaultTeam.id

            // 4) Workflow states for the default team; cache all, pick the default.
            //    Team-scoped only — see states(forTeam:) for why there is no
            //    `entity_kind` filter (DEV-only column; PROD rejects it).
            let states: [WorkflowState] = try await client
                .from("workflow_state")
                .select()
                .eq("team_id", value: defaultTeam.id.uuidString)
                .order("sort_order", ascending: true)
                .execute()
                .value

            self.workflowStatesByID = Dictionary(
                states.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }
            )
            self.statesByTeam[defaultTeam.id] = states

            guard let defaultState = states.first(where: { $0.isDefault }) ?? states.first else {
                throw WorkspaceError.noDefaultState
            }
            self.defaultStatusId = defaultState.id

            print("🏢 WorkspaceService: bootstrapped ws=\(wsId) team=\(defaultTeam.id) status=\(defaultState.id) (\(defaultState.name))")
            return true
        } catch {
            self.lastError = error
            print("❌ WorkspaceService: bootstrap failed: \(error)")
            throw error
        }
    }

    // MARK: - Switching

    /// Make `workspaceId` the active workspace and re-resolve team/state context.
    ///
    /// The capture guard lives at the call site (`iOSRecordingService`), but it is
    /// repeated here so no caller can route around it and orphan a recording in the
    /// old workspace.
    ///
    /// On success a `.workspaceDidChange` notification tells every cache-holding
    /// service to drop its rows and refetch. On failure the previous selection is
    /// restored so a half-switched app can't write into the wrong workspace.
    func switchWorkspace(to workspaceId: UUID) async throws {
        guard let userId = SupabaseManager.shared.currentUser?.id else {
            throw WorkspaceError.notAuthenticated
        }
        guard memberships.contains(where: { $0.workspaceId == workspaceId }) else {
            throw WorkspaceError.notAMember
        }
        guard workspaceId != self.workspaceId else { return }

        if iOSRecordingService.shared.hasActiveSession {
            throw WorkspaceError.captureInProgress
        }

        let previous = self.workspaceId
        isSwitching = true
        defer { isSwitching = false }

        // Nothing team-scoped may survive the hop: a stale `defaultStatusId`
        // belongs to the OLD workspace's team and would be written verbatim onto
        // the next action created here — a cross-workspace foreign key.
        defaultTeamId = nil
        defaultStatusId = nil
        statesByTeam = [:]
        workflowStatesByID = [:]

        storeSelection(workspaceId, for: userId)

        do {
            try await bootstrap(preferring: workspaceId)
        } catch {
            // Put the preference back and re-resolve the old workspace so the
            // app is left in a usable state rather than a blank one.
            storeSelection(previous, for: userId)

            // `bootstrap` assigns `self.workspaceId` at step 1 and can still
            // throw at `.noTeam` / `.noDefaultState` afterwards, so the failed
            // attempt may have left the id pointing at the workspace we never
            // actually switched into. If the recovery bootstrap ALSO fails —
            // likely, since it is usually the same network fault — that partial
            // write would stand: `requireWorkspaceId()` would hand out the new
            // workspace while every service still shows the old one's rows, and
            // the next capture/contact/project would be stamped with it. No
            // `.workspaceDidChange` was posted either, so nothing would correct
            // it. Clear the partial write instead, so `requireWorkspaceId()`
            // throws rather than lying.
            let recovered = previous == nil ? false : ((try? await bootstrap(preferring: previous)) ?? false)
            if !recovered {
                self.workspaceId = nil
                self.activeMember = nil
                self.activeWorkspace = nil
                print("⚠️ WorkspaceService: switch failed AND recovery failed — cleared workspace context")
            }

            throw error
        }

        print("🏢 WorkspaceService: switched to \(workspaceId)")
        NotificationCenter.default.post(
            name: .workspaceDidChange,
            object: nil,
            userInfo: ["workspaceId": workspaceId]
        )
    }

    /// Clear all cached workspace context (call on sign-out).
    ///
    /// Deliberately KEEPS the stored selection: the key is per user, so signing
    /// back in should land in the workspace you were last using.
    func reset() {
        workspaceId = nil
        defaultTeamId = nil
        defaultStatusId = nil
        activeWorkspace = nil
        activeMember = nil
        memberships = []
        workspaces = []
        workflowStatesByID = [:]
        statesByTeam = [:]
        hasBootstrapped = false
        hasLoadedWorkspaces = false
        isSwitching = false
        lastError = nil
        print("🏢 WorkspaceService: reset")
    }

    // MARK: - Convenience accessors for inserts

    /// The active workspace id or a thrown error — use in service insert paths
    /// so a missing context surfaces clearly instead of a raw NOT NULL violation.
    func requireWorkspaceId() throws -> UUID {
        guard let workspaceId else { throw WorkspaceError.noMembership }
        return workspaceId
    }

    func requireTeamId() throws -> UUID {
        guard let defaultTeamId else { throw WorkspaceError.noTeam }
        return defaultTeamId
    }

    func requireStatusId() throws -> UUID {
        guard let defaultStatusId else { throw WorkspaceError.noDefaultState }
        return defaultStatusId
    }
}

// MARK: - Notifications

extension Notification.Name {
    /// Posted (on the main queue) after the active workspace has been switched
    /// AND the new team/state context is resolved. `userInfo["workspaceId"]`
    /// carries the new `UUID`.
    ///
    /// Every service that caches workspace-scoped rows must observe this, clear
    /// synchronously, then refetch — rows from the previous workspace rendering
    /// under the new one is the bug this notification exists to prevent.
    static let workspaceDidChange = Notification.Name("dial8.workspaceDidChange")
}
