import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveActionTarget } from '@/lib/proposed-changes/resolve-action-target'
import { resolveContactIdByName } from '@/lib/people/name-match'
import type { SuggestEntityType } from './types'

/**
 * Resolving what a suggestion is about, and snapshotting it.
 *
 * An agent names its target the way people do: "GEN-297", a uuid it read
 * from a tool, or a title. Identifiers and uuids resolve exactly, across every
 * workspace the person belongs to (a brief written in one workspace can be
 * about an action in another); a title resolves fuzzily in the run's own
 * workspace and refuses when it's ambiguous, because changing the wrong item
 * is worse than not suggesting.
 *
 * `base` is the target's relevant fields at staging time. The apply-time drift
 * check compares it with the target's current fields (drift.ts).
 */

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The fields of an action the drift check and the card read. */
export interface ActionBase {
  status_id: string | null
  status: string | null
  status_category: string | null
  assignee_id: string | null
  assignee_contact_id: string | null
  due_date: string | null
  priority: string | null
  project_id: string | null
}

export type ResolvedTarget =
  | {
      ok: true
      workspaceId: string
      entityId: string
      /** "GEN-297 'Follow up with Kenan'" — for the tool result. */
      label: string
      teamId: string | null
      base: Record<string, unknown> | null
    }
  | { ok: false; refusal: 'target_not_found' | 'target_ambiguous'; note: string }

interface ActionRow {
  id: string
  workspace_id: string
  team_id: string | null
  identifier: string | null
  title: string | null
  status_id: string | null
  assignee_id: string | null
  assignee_contact_id: string | null
  due_at: string | null
  priority: string | null
  project_id: string | null
  workflow_state: { name: string | null; category: string | null } | null
}

const ACTION_COLUMNS =
  'id, workspace_id, team_id, identifier, title, status_id, assignee_id, assignee_contact_id, due_at, priority, project_id, workflow_state:workflow_state!status_id(name, category)'

export function actionBase(row: ActionRow): ActionBase {
  return {
    status_id: row.status_id,
    status: row.workflow_state?.name ?? null,
    status_category: row.workflow_state?.category ?? null,
    assignee_id: row.assignee_id,
    assignee_contact_id: row.assignee_contact_id,
    due_date: row.due_at ? row.due_at.slice(0, 10) : null,
    priority: row.priority,
    project_id: row.project_id,
  }
}

function actionLabel(row: { identifier: string | null; title: string | null; id: string }): string {
  return `${row.identifier ?? row.id}${row.title ? ` '${row.title}'` : ''}`
}

/** Pick the row in the preferred workspace, else the only one, else ambiguous. */
function pickOne<T extends { workspace_id: string }>(rows: T[], preferred: string): T | 'ambiguous' | null {
  if (rows.length === 0) return null
  const here = rows.filter((r) => r.workspace_id === preferred)
  if (here.length === 1) return here[0]
  if (here.length > 1) return 'ambiguous'
  return rows.length === 1 ? rows[0] : 'ambiguous'
}

/** Load one action with the columns base needs, fenced to the given workspaces. */
export async function loadActionForSuggestion(
  supabase: SupabaseClient,
  workspaceIds: string[],
  by: { id?: string; identifier?: string },
): Promise<ActionRow[]> {
  let q = supabase.from('actions').select(ACTION_COLUMNS).in('workspace_id', workspaceIds)
  if (by.id) q = q.eq('id', by.id)
  if (by.identifier) q = q.eq('identifier', by.identifier.toUpperCase())
  const { data } = await q.limit(5)
  return (data as unknown as ActionRow[]) ?? []
}

async function resolveAction(
  supabase: SupabaseClient,
  target: string,
  summary: string,
  workspaceIds: string[],
  preferred: string,
): Promise<ResolvedTarget> {
  let rows: ActionRow[] = []
  if (UUID_RE.test(target)) {
    rows = await loadActionForSuggestion(supabase, workspaceIds, { id: target })
  } else if (IDENTIFIER_RE.test(target)) {
    rows = await loadActionForSuggestion(supabase, workspaceIds, { identifier: target })
  } else {
    const fuzzy = await resolveActionTarget(supabase, preferred, { title: target, displayText: summary })
    if (!fuzzy) {
      return {
        ok: false,
        refusal: 'target_not_found',
        note: `No single open action matches "${target}". Name it by identifier (e.g. GEN-42).`,
      }
    }
    rows = await loadActionForSuggestion(supabase, [preferred], { id: fuzzy.id })
  }
  const row = pickOne(rows, preferred)
  if (row === 'ambiguous') {
    return { ok: false, refusal: 'target_ambiguous', note: `"${target}" matches actions in more than one workspace.` }
  }
  if (!row) return { ok: false, refusal: 'target_not_found', note: `No action "${target}" in your workspaces.` }
  return {
    ok: true,
    workspaceId: row.workspace_id,
    entityId: row.id,
    label: actionLabel(row),
    teamId: row.team_id,
    base: actionBase(row) as unknown as Record<string, unknown>,
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/** Projects: by uuid, else by exact (case-insensitive) name. */
async function resolveProject(
  supabase: SupabaseClient,
  target: string,
  workspaceIds: string[],
  preferred: string,
): Promise<ResolvedTarget> {
  let q = supabase
    .from('projects')
    .select('id, workspace_id, name, status, lead_id, target_date')
    .in('workspace_id', workspaceIds)
  q = UUID_RE.test(target) ? q.eq('id', target) : q.ilike('name', escapeLike(target))
  const { data } = await q.limit(5)
  const rows = (data as unknown as Array<{
    id: string; workspace_id: string; name: string | null; status: string | null; lead_id: string | null; target_date: string | null
  }>) ?? []
  const row = pickOne(rows, preferred)
  if (row === 'ambiguous') return { ok: false, refusal: 'target_ambiguous', note: `More than one project is named "${target}".` }
  if (!row) return { ok: false, refusal: 'target_not_found', note: `No project named "${target}".` }
  return {
    ok: true,
    workspaceId: row.workspace_id,
    entityId: row.id,
    label: `project '${row.name ?? row.id}'`,
    teamId: null,
    base: { status: row.status, lead_id: row.lead_id, target_date: row.target_date },
  }
}

/** Milestones live under a project, which carries the workspace. */
async function resolveMilestone(
  supabase: SupabaseClient,
  target: string,
  workspaceIds: string[],
  preferred: string,
): Promise<ResolvedTarget> {
  let q = supabase
    .from('milestone')
    .select('id, name, status, target_date, project:projects!inner(workspace_id)')
    .in('project.workspace_id', workspaceIds)
  q = UUID_RE.test(target) ? q.eq('id', target) : q.ilike('name', escapeLike(target))
  const { data } = await q.limit(5)
  const rows = ((data as unknown as Array<{
    id: string; name: string | null; status: string | null; target_date: string | null; project: { workspace_id: string } | null
  }>) ?? [])
    .filter((r) => r.project?.workspace_id)
    .map((r) => ({ ...r, workspace_id: r.project!.workspace_id }))
  const row = pickOne(rows, preferred)
  if (row === 'ambiguous') return { ok: false, refusal: 'target_ambiguous', note: `More than one milestone is named "${target}".` }
  if (!row) return { ok: false, refusal: 'target_not_found', note: `No milestone named "${target}".` }
  return {
    ok: true,
    workspaceId: row.workspace_id,
    entityId: row.id,
    label: `milestone '${row.name ?? row.id}'`,
    teamId: null,
    base: { status: row.status, target_date: row.target_date },
  }
}

export async function resolveSuggestionTarget(
  supabase: SupabaseClient,
  args: {
    entity: SuggestEntityType
    target: string
    summary: string
    /** Every workspace the person belongs to. */
    workspaceIds: string[]
    /** The run's / conversation's own workspace; wins ties. */
    preferredWorkspaceId: string
    userId: string
  },
): Promise<ResolvedTarget> {
  const target = args.target.trim()
  switch (args.entity) {
    case 'action':
      return resolveAction(supabase, target, args.summary, args.workspaceIds, args.preferredWorkspaceId)
    case 'project':
      return resolveProject(supabase, target, args.workspaceIds, args.preferredWorkspaceId)
    case 'milestone':
      return resolveMilestone(supabase, target, args.workspaceIds, args.preferredWorkspaceId)
    case 'contact': {
      const id = UUID_RE.test(target)
        ? target
        : await resolveContactIdByName(supabase, args.preferredWorkspaceId, target, args.userId)
      if (!id) return { ok: false, refusal: 'target_not_found', note: `No contact "${target}".` }
      const { data } = await supabase
        .from('contact')
        .select('id, workspace_id, full_name')
        .eq('id', id)
        .in('workspace_id', args.workspaceIds)
        .maybeSingle()
      const row = data as { id: string; workspace_id: string; full_name: string | null } | null
      if (!row) return { ok: false, refusal: 'target_not_found', note: `No contact "${target}".` }
      return { ok: true, workspaceId: row.workspace_id, entityId: row.id, label: `contact '${row.full_name ?? row.id}'`, teamId: null, base: null }
    }
  }
}
