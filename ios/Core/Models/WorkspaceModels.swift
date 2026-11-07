//
//  WorkspaceModels.swift
//  dial8
//
//  Codable models for the workspace / team / workflow-state hierarchy.
//
//  Background: the backend schema is workspace-scoped. Every core table
//  (`actions`, `captures`, `contacts`, `projects`, `attachments`, …) requires a
//  `workspace_id` (and `actions` also requires `team_id` + `status_id`). These
//  models back `WorkspaceService`, which resolves the signed-in user's active
//  workspace / default team / default workflow state so the rest of the data
//  layer can supply those IDs on insert.
//
//  Field names/CodingKeys mirror the live schema (Dial8 DEV/PRD) exactly.
//

import Foundation

// MARK: - Member

/// A row in `public.member` — the signed-in user's membership in a workspace.
struct WorkspaceMember: Codable, Identifiable, Equatable {
    let id: UUID
    let userId: UUID
    let workspaceId: UUID
    let role: String            // owner | admin | member
    let displayName: String
    let avatarURL: String?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case workspaceId = "workspace_id"
        case role
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case createdAt = "created_at"
    }
}

// MARK: - Workspace

/// A row in `public.workspace`.
struct Workspace: Codable, Identifiable, Equatable {
    let id: UUID
    let name: String
    let slug: String
    let plan: String
    let logoURL: String?
    let description: String?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name, slug, plan
        case logoURL = "logo_url"
        case description
        case createdAt = "created_at"
    }
}

// MARK: - Team

/// A row in `public.team`. `issuePrefix`/`issueCounter` back the server-side
/// `generate_action_identifier` trigger (e.g. "ENG-42") — the app never
/// computes identifiers itself.
struct Team: Codable, Identifiable, Equatable {
    let id: UUID
    let workspaceId: UUID
    let name: String
    let slug: String
    let icon: String?
    let color: String?
    let issuePrefix: String
    let isPrivate: Bool
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case name, slug, icon, color
        case issuePrefix = "issue_prefix"
        case isPrivate = "is_private"
        case createdAt = "created_at"
    }
}

// MARK: - Workflow State

/// The category of a workflow state, mirroring the Postgres enum used by
/// `workflow_state.category`. Decoded tolerantly so a new backend category
/// never breaks the whole fetch.
enum WorkflowStateCategory: String, Codable, Equatable, CaseIterable {
    case backlog
    case unstarted
    case started
    case completed
    case canceled
    case won
    case lost
    case triage
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WorkflowStateCategory(rawValue: raw) ?? .unknown
    }

    /// Categories that count as "open work" on the board — an action in one of
    /// these is still on someone's plate. Mirrors the website's active filter
    /// (`status=active` in `api/account/actions/route.ts`), plus `won` which the
    /// sales pipeline uses as a live-but-successful column.
    static let openCategories: [WorkflowStateCategory] = [.backlog, .unstarted, .started, .won]

    /// Raw strings for the open categories — use when building PostgREST `.in()`
    /// filters on the embedded `workflow_state.category` column.
    static let openCategoryValues: [String] = openCategories.map(\.rawValue)
}

/// A row in `public.workflow_state` — the board columns for a team.
/// `isDefault` marks the state new actions land in (exactly one per team).
struct WorkflowState: Codable, Identifiable, Equatable {
    let id: UUID
    let teamId: UUID
    let name: String
    let category: WorkflowStateCategory
    let color: String
    let sortOrder: Int
    let isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case teamId = "team_id"
        case name, category, color
        case sortOrder = "sort_order"
        case isDefault = "is_default"
    }

    /// Whether an action in this state should be treated as "done" for UI.
    var isDone: Bool {
        switch category {
        case .completed, .canceled, .lost: return true
        default: return false
        }
    }
}
