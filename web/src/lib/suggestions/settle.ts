import type { SupabaseClient } from '@supabase/supabase-js'
import { claimAndApplyChange } from '@/lib/proposed-changes/claim-apply'
import { deleteAppliedEntity, updateAppliedEntity, type AppliedEditFields } from '@/lib/proposed-changes/apply-engine'
import { undoAppliedProposal } from '@/lib/proposed-changes/undo-applied'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { isAssignableTeammate, FOREIGN_AI_MEMBER_ERROR } from '@/lib/workspace-fences'
import { checkDrift, type Drift } from './drift'

/**
 * Settling a suggestion, wherever it is shown: accept, dismiss, modify, undo.
 * The /api/account/suggestions routes call these with the person's own
 * (RLS-bound) client, so a suggestion they can't see is a 404 here, and every
 * write lands in the suggestion's own workspace, which may not be the one the
 * person has open.
 *
 * Accepting is claim-then-apply (claim-apply.ts), after the drift check: a
 * suggestion whose change already holds expires instead of applying, and one
 * whose target someone else changed since it was staged asks first (`force`
 * applies anyway). When one applies, its twins (the same fingerprint, pending
 * in another home: yesterday's brief, a chat) expire.
 */

export interface SettleResult {
  status: number
  body: Record<string, unknown>
}

const ok = (body: Record<string, unknown>): SettleResult => ({ status: 200, body })
const fail = (status: number, error: string, code?: string, details?: unknown): SettleResult => ({
  status,
  body: { error, ...(code ? { code } : {}), ...(details !== undefined ? { details } : {}) },
})

/** Writable fields a person can modify before accepting (the card's pills). */
export const EDITABLE_FIELDS = [
  'title', 'description', 'priority', 'due_date', 'status_to',
  'assignee_name', 'assignee_member_id', 'assignee_contact_id',
  'team_id', 'project_id', 'entity_id', 'labels',
  'email_to_name', 'email_to_address', 'email_subject', 'email_context',
  'display_text',
] as const

async function loadVisible(supabase: SupabaseClient, id: string): Promise<ProposedChange | null> {
  const { data } = await supabase.from('proposed_change').select('*').eq('id', id).maybeSingle()
  return (data as unknown as ProposedChange | null) ?? null
}

async function memberIdIn(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<string | null> {
  const { data } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/** Expire a pending row the drift check found moot. Guarded on pending. */
export async function expireSuggestion(
  supabase: SupabaseClient,
  id: string,
  reason: 'already_true' | 'target_deleted' | 'applied_elsewhere' | 'ttl' | 'run_undelivered',
): Promise<boolean> {
  const { data } = await supabase
    .from('proposed_change')
    .update({ status: 'expired', expire_reason: reason })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
  return ((data as unknown[] | null) ?? []).length > 0
}

/** Pending twins of an applied suggestion expire: the change is made. */
async function expireTwins(supabase: SupabaseClient, change: ProposedChange): Promise<void> {
  const fingerprint = (change as unknown as { fingerprint?: string | null }).fingerprint
  if (!fingerprint) return
  await supabase
    .from('proposed_change')
    .update({ status: 'expired', expire_reason: 'applied_elsewhere' })
    .eq('workspace_id', change.workspace_id)
    .eq('fingerprint', fingerprint)
    .eq('status', 'pending')
    .neq('id', change.id)
}

function driftResult(change: ProposedChange, drift: Drift): SettleResult | null {
  if (drift.kind === 'already_true') {
    return fail(409, 'This change has already been made.', 'already_true', { change: { ...change, status: 'expired', expire_reason: 'already_true' } })
  }
  if (drift.kind === 'target_deleted') {
    return fail(409, 'What this suggestion changes no longer exists.', 'target_deleted', { change: { ...change, status: 'expired', expire_reason: 'target_deleted' } })
  }
  if (drift.kind === 'changed') {
    return fail(409, 'It changed since this was suggested.', 'target_changed', { fields: drift.fields })
  }
  return null
}

export async function applySuggestion(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<SettleResult> {
  const change = await loadVisible(supabase, id)
  if (!change) return fail(404, 'Not found')
  if (change.status !== 'pending') return fail(409, `Already ${change.status}`, 'not_pending', { status: change.status })

  const memberId = await memberIdIn(supabase, userId, change.workspace_id)
  if (!memberId) return fail(403, 'Not a member of this workspace')

  const drift = await checkDrift(supabase, change as never)
  if (drift.kind === 'already_true' || drift.kind === 'target_deleted') {
    await expireSuggestion(supabase, change.id, drift.kind)
    return driftResult(change, drift)!
  }
  if (drift.kind === 'changed' && !opts.force) return driftResult(change, drift)!

  const outcome = await claimAndApplyChange(supabase, change, {
    workspaceId: change.workspace_id,
    memberId,
    userId,
  })
  if (!outcome.ok && outcome.reason === 'not_pending') return fail(409, 'Already accepted', 'not_pending')
  if (!outcome.ok) {
    const auth = outcome.code === 'MCP_TOKEN_EXPIRED' || outcome.code === 'MCP_SERVER_DISCONNECTED'
    return fail(auth ? 401 : 500, outcome.error, outcome.code)
  }
  await expireTwins(supabase, outcome.change)
  return ok({ change: outcome.change, entity_id: outcome.entity_id })
}

/** Accept several in order. Each is claimed on its own; drifted ones are skipped and reported. */
export async function applySuggestions(
  supabase: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<SettleResult> {
  const results: Array<{ id: string; status: 'applied' | 'skipped' | 'failed'; code?: string; error?: string; entity_id?: string | null }> = []
  for (const id of [...new Set(ids)]) {
    const r = await applySuggestion(supabase, userId, id)
    if (r.status === 200) results.push({ id, status: 'applied', entity_id: (r.body.entity_id as string | null) ?? null })
    else if (r.status === 409 || r.status === 404) results.push({ id, status: 'skipped', code: r.body.code as string | undefined, error: r.body.error as string })
    else results.push({ id, status: 'failed', code: r.body.code as string | undefined, error: r.body.error as string })
  }
  return ok({
    applied: results.filter((r) => r.status === 'applied').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  })
}

export async function dismissSuggestion(supabase: SupabaseClient, userId: string, id: string): Promise<SettleResult> {
  const change = await loadVisible(supabase, id)
  if (!change) return fail(404, 'Not found')
  if (change.status === 'dismissed') return fail(409, 'Already dismissed', 'not_pending', { status: change.status })
  if (!(await memberIdIn(supabase, userId, change.workspace_id))) return fail(403, 'Not a member of this workspace')

  // Dismissing an applied create removes what it created, as on the capture
  // page; an applied update changed something that already existed, so only
  // the suggestion is dismissed.
  if (change.status === 'applied' && change.change_type === 'create' && change.result_entity_id) {
    const result = await deleteAppliedEntity(
      supabase,
      change.change_type,
      change.entity_type,
      change.result_entity_id,
      change.workspace_id,
    )
    if (!result.success && result.code !== 'NOT_CREATED_BY_PROPOSAL') return fail(500, result.error ?? 'Delete failed')
  }

  const { data, error } = await supabase
    .from('proposed_change')
    .update({ status: 'dismissed', result_entity_id: null })
    .eq('id', id)
    .eq('workspace_id', change.workspace_id)
    .in('status', ['pending', 'applied', 'expired'])
    .select()
    .maybeSingle()
  if (error) return fail(500, error.message)
  if (!data) return fail(409, 'It changed just now', 'not_pending')
  return ok({ change: data })
}

export async function undoSuggestion(supabase: SupabaseClient, userId: string, id: string): Promise<SettleResult> {
  const change = await loadVisible(supabase, id)
  if (!change) return fail(404, 'Not found')
  if (!(await memberIdIn(supabase, userId, change.workspace_id))) return fail(403, 'Not a member of this workspace')
  const result = await undoAppliedProposal(supabase, { workspaceId: change.workspace_id, changeId: id })
  if (!result.ok) return fail(result.status, result.error, result.code)
  return ok({ change: result.change })
}

/**
 * Modify a suggestion. Pending: the staged values change (fix the assignee,
 * the date) before accepting. Applied: the edit reaches through to the entity
 * it created, so the pills keep working after an accept.
 */
export async function editSuggestion(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<SettleResult> {
  const existing = await loadVisible(supabase, id)
  if (!existing) return fail(404, 'Not found')
  if (existing.status === 'dismissed' || existing.status === ('expired' as string)) {
    return fail(400, `Cannot edit a ${existing.status} suggestion`)
  }
  const workspaceId = existing.workspace_id
  if (!(await memberIdIn(supabase, userId, workspaceId))) return fail(403, 'Not a member of this workspace')

  const updates: Record<string, unknown> = {}
  for (const field of EDITABLE_FIELDS) if (field in body) updates[field] = body[field]

  // An agent assignee rides in `extra`. It is the DELEGATE beside the member
  // (decision 9, as the apply engine writes it): setting it keeps the member.
  // An external contact can't sit beside an agent, so a contact gives way.
  const editingAgent = 'assignee_ai_member_id' in body
  if (editingAgent) {
    const aiId = (body.assignee_ai_member_id as string | null) || null
    if (aiId && !(await isAssignableTeammate(supabase, aiId, workspaceId))) return fail(400, FOREIGN_AI_MEMBER_ERROR)
    updates.extra = { ...((existing.extra as Record<string, unknown> | null) ?? {}), assignee_ai_member_id: aiId }
    if (aiId && existing.assignee_contact_id) {
      updates.assignee_contact_id = null
      if (!existing.assignee_member_id) updates.assignee_name = null
    }
  }
  if (Object.keys(updates).length === 0) return fail(400, 'No valid fields to update')

  if (existing.status === 'applied') {
    if (!existing.result_entity_id) return fail(400, 'This applied change has no linked entity to edit')
    const fields: AppliedEditFields = {}
    if ('title' in updates) fields.title = updates.title as string | null
    if ('description' in updates) fields.description = updates.description as string | null
    if ('priority' in updates) fields.priority = updates.priority as string | null
    if ('due_date' in updates) fields.due_date = updates.due_date as string | null
    if ('status_to' in updates) fields.status_to = updates.status_to as string | null
    if ('assignee_member_id' in updates) fields.assignee_member_id = updates.assignee_member_id as string | null
    if (editingAgent) fields.assignee_ai_member_id = (body.assignee_ai_member_id as string | null) || null
    if ('team_id' in updates) fields.team_id = updates.team_id as string | null
    const result = await updateAppliedEntity(supabase, existing.entity_type, existing.result_entity_id, workspaceId, fields, userId)
    if (!result.success) return fail(400, result.error ?? 'Edit failed')
  }

  const { data, error } = await supabase
    .from('proposed_change')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select()
    .maybeSingle()
  if (error) return fail(500, error.message)
  return ok({ change: data })
}
