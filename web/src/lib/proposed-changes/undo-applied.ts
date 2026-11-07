/**
 * Un-apply one applied proposal: delete the entity it created and put it back
 * to `pending`, so the person can edit, dismiss or apply it again. The logic
 * behind POST /api/account/captures/[id]/proposed-changes/[changeId]/undo,
 * shared with Extraction's undo of one pass (undo-extraction-pass.ts, bots v3
 * Phase 5).
 *
 * Only `create` proposals can be undone: they spawned a fresh entity that can
 * safely go. An `update`/`assign` proposal changed something that already
 * existed, which can't be reversed without its prior state, so it is refused.
 *
 * Fenced on `workspaceId` (and the capture, when given). `expectEntityId`: the
 * undo happens only while the proposal still names that entity, so a proposal
 * applied again since (a different entity) is left alone.
 *
 * `refuseIfChangedSince` (Extraction's undo of a pass, which runs at a bot's
 * hand over many entries): the entity is left alone, CHANGED_SINCE, when the
 * person has worked on it since it was applied: its row was updated after
 * `applied_at` (actions and milestones carry an updated_at trigger), it has a
 * comment, or (an action) it has sub-actions. The per-proposal Undo button
 * doesn't ask: the person clicking it is looking at the entity.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteAppliedEntity } from './apply-engine'

export type UndoAppliedResult =
  | { ok: true; change: Record<string, unknown> }
  | { ok: false; status: number; error: string; code?: string }

export async function undoAppliedProposal(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    changeId: string
    captureId?: string
    expectEntityId?: string | null
    refuseIfChangedSince?: boolean
  },
): Promise<UndoAppliedResult> {
  let q = supabase.from('proposed_change').select('*').eq('id', args.changeId).eq('workspace_id', args.workspaceId)
  if (args.captureId) q = q.eq('capture_id', args.captureId)
  const { data: change } = await q.maybeSingle()

  if (!change) return { ok: false, status: 404, error: 'Not found' }
  if (change.status !== 'applied') return { ok: false, status: 400, error: 'Change is not applied', code: 'NOT_APPLIED' }
  if (change.change_type !== 'create') {
    return {
      ok: false,
      status: 400,
      error: `Cannot undo a ${change.change_type} change — it modified existing data, not created it.`,
      code: 'NOT_CREATED_BY_PROPOSAL',
    }
  }
  if (args.expectEntityId !== undefined && (change.result_entity_id ?? null) !== (args.expectEntityId ?? null)) {
    return { ok: false, status: 409, error: 'This proposal was applied again since', code: 'REAPPLIED' }
  }
  if (
    args.refuseIfChangedSince &&
    change.result_entity_id &&
    (await entityChangedSince(supabase, args.workspaceId, change.entity_type, change.result_entity_id, change.applied_at))
  ) {
    return { ok: false, status: 409, error: 'It was worked on since it was applied', code: 'CHANGED_SINCE' }
  }

  // Delete the entity this proposal created (best-effort: if it's already gone,
  // we still re-stage the proposal so the person isn't stuck).
  if (change.result_entity_id) {
    const result = await deleteAppliedEntity(
      supabase,
      change.change_type,
      change.entity_type,
      change.result_entity_id,
      args.workspaceId,
    )
    if (!result.success && result.code !== 'NOT_CREATED_BY_PROPOSAL') {
      return { ok: false, status: 500, error: result.error ?? 'Delete failed' }
    }
  }

  // Re-stage the proposal as pending and clear all apply tracking.
  const { data, error } = await supabase
    .from('proposed_change')
    .update({
      status: 'pending',
      applied_at: null,
      applied_by: null,
      result_entity_id: null,
      auto_accepted: false,
      error_message: null,
    })
    .eq('id', args.changeId)
    .eq('workspace_id', args.workspaceId)
    .select()
    .single()

  if (error) return { ok: false, status: 500, error: error.message }
  return { ok: true, change: data as Record<string, unknown> }
}

/** Edits within this long of the apply are the apply's own (its follow-up writes), not the person's. */
export const CHANGED_SINCE_SLACK_MS = 60_000

/** Tables whose rows carry an updated_at trigger (actions, milestone); decision has none. */
const UPDATED_AT_TABLE: Record<string, string> = { action: 'actions', milestone: 'milestone' }

/**
 * True when the person has worked on the entity since `appliedAt`: an
 * updated_at past it (beyond the slack), a comment on it, or (an action) a
 * sub-action under it. A read that fails counts as changed: when in doubt,
 * the undo leaves it alone.
 */
export async function entityChangedSince(
  supabase: SupabaseClient,
  workspaceId: string,
  entityType: string,
  entityId: string,
  appliedAt: string | null | undefined,
): Promise<boolean> {
  try {
    const table = UPDATED_AT_TABLE[entityType]
    const appliedMs = appliedAt ? Date.parse(appliedAt) : NaN
    if (table) {
      // milestone has no workspace_id column: it is fenced through its project.
      const isMilestone = entityType === 'milestone'
      let q = supabase
        .from(table)
        .select(isMilestone ? 'updated_at, project:project_id(workspace_id)' : 'updated_at')
        .eq('id', entityId)
      if (!isMilestone) q = q.eq('workspace_id', workspaceId)
      const { data, error } = await q.maybeSingle<{
        updated_at: string | null
        project?: { workspace_id: string } | null
      }>()
      if (error) return true
      if (isMilestone && data && data.project?.workspace_id !== workspaceId) return true
      const updatedMs = data?.updated_at ? Date.parse(data.updated_at) : NaN
      // No applied_at to compare against: only an unknown update is a change.
      if (Number.isFinite(updatedMs) && (!Number.isFinite(appliedMs) || updatedMs > appliedMs + CHANGED_SINCE_SLACK_MS)) {
        return true
      }
    }
    const { data: comments, error: commentError } = await supabase
      .from('comment')
      .select('id')
      .eq('commentable_type', entityType)
      .eq('commentable_id', entityId)
      .limit(1)
    if (commentError || (comments ?? []).length > 0) return true
    if (entityType === 'action') {
      const { data: children, error: childError } = await supabase
        .from('actions')
        .select('id')
        .eq('parent_id', entityId)
        .eq('workspace_id', workspaceId)
        .limit(1)
      if (childError || (children ?? []).length > 0) return true
    }
    return false
  } catch {
    return true
  }
}
