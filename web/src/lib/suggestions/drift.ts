import type { SupabaseClient } from '@supabase/supabase-js'
import { actionBase, loadActionForSuggestion, type ActionBase } from './target'

/**
 * Has the target moved since the suggestion was staged?
 *
 * A suggestion about an existing action records the action's fields when it
 * was staged (`base`). Before it's applied, and when its card loads, the
 * action's current fields are compared with that snapshot for every field the
 * suggestion changes:
 *   • the action already has the proposed value for every field → already_true
 *     (someone did it by hand: the card says "Already done", the row expires);
 *   • someone else changed a field the suggestion changes → changed (the card
 *     asks "Changed since: now In Progress. Apply anyway?");
 *   • the action is gone → target_deleted.
 */
export type Drift =
  | { kind: 'none' }
  | { kind: 'already_true' }
  | { kind: 'target_deleted' }
  | { kind: 'changed'; fields: Array<{ field: string; was: unknown; now: unknown }> }

export interface DriftRow {
  id: string
  workspace_id: string
  status: string
  change_type: string
  entity_type: string
  entity_id: string | null
  status_to?: string | null
  priority?: string | null
  due_date?: string | null
  assignee_member_id?: string | null
  assignee_contact_id?: string | null
  extra?: Record<string, unknown> | null
  base?: Record<string, unknown> | null
}

const same = (a: unknown, b: unknown) =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

/** The fields an action suggestion changes: [field, proposed, base key]. */
function proposedFields(row: DriftRow): Array<{ field: string; proposed: unknown; key: keyof ActionBase }> {
  const out: Array<{ field: string; proposed: unknown; key: keyof ActionBase }> = []
  if (row.status_to) out.push({ field: 'status', proposed: row.status_to, key: 'status' })
  if (row.priority) out.push({ field: 'priority', proposed: row.priority, key: 'priority' })
  if (row.due_date) out.push({ field: 'due_date', proposed: row.due_date, key: 'due_date' })
  if (row.assignee_member_id) out.push({ field: 'assignee', proposed: row.assignee_member_id, key: 'assignee_id' })
  else if (row.assignee_contact_id) out.push({ field: 'assignee', proposed: row.assignee_contact_id, key: 'assignee_contact_id' })
  const moveTo = row.extra?.move_to_project_id
  if (typeof moveTo === 'string' && moveTo) out.push({ field: 'project', proposed: moveTo, key: 'project_id' })
  return out
}

/** Whether a row is one the drift check applies to. */
export function isDriftCheckable(row: DriftRow): boolean {
  return (
    row.status === 'pending' &&
    row.entity_type === 'action' &&
    !!row.entity_id &&
    !!row.base &&
    (row.change_type === 'update' || row.change_type === 'assign' || row.change_type === 'delete')
  )
}

/** Pure comparison of a suggestion with its target's current fields. */
export function compareActionDrift(row: DriftRow, current: ActionBase | null): Drift {
  if (!current) return { kind: 'target_deleted' }
  if (row.change_type === 'delete') return { kind: 'none' }
  const fields = proposedFields(row)
  if (fields.length === 0) return { kind: 'none' }
  const base = (row.base ?? {}) as Partial<ActionBase>
  let done = 0
  const changed: Array<{ field: string; was: unknown; now: unknown }> = []
  for (const f of fields) {
    const now = current[f.key]
    if (same(now, f.proposed)) {
      done++
      continue
    }
    const was = base[f.key]
    if (!same(was, now)) {
      // Status reads by name; show names, not ids.
      changed.push({ field: f.field, was: was ?? null, now: now ?? null })
    }
  }
  if (done === fields.length) return { kind: 'already_true' }
  if (changed.length) return { kind: 'changed', fields: changed }
  return { kind: 'none' }
}

/** Drift for many rows with one read per workspace. Rows the check doesn't apply to are left out. */
export async function annotateDrift(supabase: SupabaseClient, rows: DriftRow[]): Promise<Map<string, Drift>> {
  const out = new Map<string, Drift>()
  const checkable = rows.filter(isDriftCheckable)
  if (checkable.length === 0) return out

  const byWorkspace = new Map<string, string[]>()
  for (const r of checkable) {
    const ids = byWorkspace.get(r.workspace_id) ?? []
    ids.push(r.entity_id!)
    byWorkspace.set(r.workspace_id, ids)
  }
  const current = new Map<string, ActionBase>()
  for (const [workspaceId, ids] of byWorkspace) {
    const { data } = await supabase
      .from('actions')
      .select(
        'id, workspace_id, team_id, identifier, title, status_id, assignee_id, assignee_contact_id, due_at, priority, project_id, workflow_state:workflow_state!status_id(name, category)',
      )
      .eq('workspace_id', workspaceId)
      .in('id', [...new Set(ids)])
    for (const row of (data as unknown as Parameters<typeof actionBase>[0][] | null) ?? []) {
      current.set(row.id, actionBase(row))
    }
  }
  for (const r of checkable) out.set(r.id, compareActionDrift(r, current.get(r.entity_id!) ?? null))
  return out
}

/** Drift for one row (the apply path). */
export async function checkDrift(supabase: SupabaseClient, row: DriftRow): Promise<Drift> {
  if (!isDriftCheckable(row)) return { kind: 'none' }
  const [action] = await loadActionForSuggestion(supabase, [row.workspace_id], { id: row.entity_id! })
  return compareActionDrift(row, action ? actionBase(action) : null)
}
