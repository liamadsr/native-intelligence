/**
 * What the merge routes answer (the RPCs' JSON, migration 402), typed once for
 * the dialog and the pure helpers beside it. Server code keeps its own narrow
 * interfaces; this file is safe to import from a client component.
 */

export interface MergeBusy {
  live_captures: Array<{ id: string; title: string | null }>
  agent_runs: number
  flow_runs: number
  tracked_jobs: number
}

export interface DriftRow {
  check: string
  violations: number
}

export type MergeBlocker =
  | { code: 'source_busy'; detail: MergeBusy }
  | { code: 'drift'; source: DriftRow[]; destination: DriftRow[] }

export interface PreflightPerson {
  member_id?: string
  user_id: string
  display_name: string | null
  role?: string
  source_role?: string
  destination_role?: string
  role_after?: string
}

export interface PreflightPeople {
  joining: PreflightPerson[]
  in_both: PreflightPerson[]
  destination_members: number
  invites_moving: number
  invites_dropped: number
}

export interface PreflightTeam {
  source_team_id: string
  source_name: string
  source_slug: string
  source_prefix: string
  is_private: boolean
  is_first: boolean
  actions: number
  members: number
  collides: { slug: boolean; prefix: boolean }
  mode: 'own' | 'fold'
  destination_team_id: string | null
  name: string | null
  slug: string | null
  prefix: string | null
  identifiers: { reprefixed: number; renumbered: number }
  states_remapped: Array<{ from: string; to: string | null; actions: number }>
  active_cycle_conflict: boolean
  destination_team: { id: string; name: string; prefix: string } | null
}

export interface PreflightIntegration {
  provider: string
  source: boolean
  destination: boolean
  outcome: 'moves' | 'destination_wins'
  links_severed?: number
  provider_ids_cleared?: number
}

export interface PreflightIntegrations {
  tasks: PreflightIntegration[]
  crm: PreflightIntegration[]
  connected_accounts: number
  account_links: number
  mcp_servers: number
  /** The other workspace's live cloud environments (migration 420's environment, kind cloud). */
  cloud_environments: number
  /** Migration 420: the default cloud environment, and what runs in it afterwards. Absent from a preflight before 420. */
  default_cloud_environment?: PreflightDefaultCloud
  github_prs: number
}

/**
 * The default cloud environment (where runs with no project environment run:
 * loops, and projects with none) across a merge (migration 420).
 */
export interface PreflightDefaultCloud {
  /**
   * 'destination_keeps': both have one and this workspace keeps its own;
   * 'source_adopted': only the other has one, and it becomes this workspace's;
   * 'none': the other has none.
   */
  outcome: 'none' | 'source_adopted' | 'destination_keeps'
  source: { name: string; network_access: string } | null
  destination: { name: string; network_access: string } | null
  /** The other workspace's loops that start coding runs: afterwards they run in this workspace's default. */
  source_loops: number
  /** The other workspace's projects with no environment: pinned to its default, so they keep running there. */
  projects_pinned: number
}

export interface PreflightCollisions {
  contacts_folded: number
  companies_folded: number
  workspace_company_demoted: boolean
  documents_canon_demoted: Array<{ id: string; title: string | null; canon_key: string }>
  documents_reslugged: number
  views_reslugged: number
  recipes_reslugged: number
  packages_reslugged: number
  prospect_lists_renamed: number
  home_threads_demoted: number
  teammate_threads_demoted: number
  system_teammates_folded: number
  seeded_flows_dropped: number
  default_projects_folded: number
  thread_copies_folded: number
  account_links_deduped: number
  sequence_enrollments_exited: number
  singletons_dropped: Record<string, number>
}

export interface MergePlanTeam {
  source_team_id: string
  mode: 'own' | 'fold'
  destination_team_id?: string | null
  name?: string | null
  slug?: string | null
  prefix?: string | null
}

export interface MergePlan {
  teams: MergePlanTeam[]
  snapshot?: unknown
}

export interface PreflightResult {
  ok: boolean
  blockers: MergeBlocker[]
  source: { id: string; name: string; slug: string | null; created_at?: string }
  destination: { id: string; name: string; slug: string | null }
  busy: MergeBusy
  drift: { source: DriftRow[]; destination: DriftRow[] }
  people: PreflightPeople
  teams: PreflightTeam[]
  labels: { matched: number; created: number }
  integrations: PreflightIntegrations
  collisions: PreflightCollisions
  counts: Record<string, number>
  plan: MergePlan
}

export interface MergeOutcome {
  merge_id: string
  source: { id: string; name: string; slug?: string | null }
  destination: { id: string; name?: string; slug?: string | null }
  counts: Record<string, unknown>
  rows_before: Record<string, number>
  duration_ms?: number
  recovered?: true
}

export interface MergeResponse {
  ok: true
  merge: MergeOutcome
  snapshot: { prefix: string; total_rows: number; total_pages: number }
  members_told: number
}

/** The body of every error the routes answer with (src/lib/api-errors.ts). */
export interface MergeApiError {
  error: string
  code?: string
  details?: unknown
}
