import type { SupabaseClient } from '@supabase/supabase-js'
import type { StatusChangeOrigin } from '@/lib/flows/types'
import { applyChange, type ApplyResult } from './apply-engine'
import type { ProposedChange } from './types'

/**
 * Claim a pending proposal, then apply it. Every path that accepts a proposal
 * goes through here: the single-apply route, apply-all, the accept_proposal
 * tool and the suggestions routes.
 *
 * Applying is CLAIM-then-execute, never read-then-execute-then-write. Two
 * concurrent accepts of one row (two clicks, two tabs, a click racing an
 * agent's accept_proposal) would otherwise both read status='pending' and both
 * run applyChange: two actions from one proposal. The guarded UPDATE is the
 * arbiter. Exactly one caller flips 'pending' → 'applied'; the other is told
 * `not_pending` and does nothing.
 *
 * When the work fails the claim is handed back (status 'pending' with the
 * error), so the row isn't wedged as 'applied' with nothing behind it.
 */
export type ClaimApplyResult =
  | {
      ok: true
      /** The change as applied, with any normalized change_type/entity_type. */
      change: ProposedChange
      entity_id: string | null
    }
  | { ok: false; reason: 'not_pending' }
  | { ok: false; reason: 'apply_failed'; error: string; code?: string }

export interface ClaimApplyArgs {
  workspaceId: string
  memberId: string
  userId?: string
  /** Who this apply is, for the status-change loop guard. Absent → a person. */
  origin?: StatusChangeOrigin
}

export async function claimAndApplyChange(
  supabase: SupabaseClient,
  change: ProposedChange,
  args: ClaimApplyArgs,
): Promise<ClaimApplyResult> {
  const now = new Date().toISOString()

  // ── Claim ────────────────────────────────────────────────────────────────
  // Everything knowable before the work runs, guarded by status='pending'.
  // Postgres serializes the two updates, so the loser matches zero rows;
  // .select() is what makes that visible (an unguarded update reports success
  // either way). error_message is cleared so an applied row never shows a
  // stale failure from an earlier attempt.
  const { data: claimed } = await supabase
    .from('proposed_change')
    .update({
      status: 'applied',
      applied_at: now,
      applied_by: args.memberId,
      error_message: null,
    })
    .eq('id', change.id)
    .eq('workspace_id', args.workspaceId)
    .eq('status', 'pending')
    .select('id')

  if (!claimed || claimed.length === 0) return { ok: false, reason: 'not_pending' }

  // ── Execute ──────────────────────────────────────────────────────────────
  const result: ApplyResult = args.origin
    ? await applyChange(supabase, change, args.workspaceId, args.memberId, args.userId, { origin: args.origin })
    : await applyChange(supabase, change, args.workspaceId, args.memberId, args.userId)

  if (!result.success) {
    // Hand the claim back. Best-effort: if this write is lost the row is
    // wedged as applied, which is still strictly better than two entities.
    await supabase
      .from('proposed_change')
      .update({
        status: 'pending',
        applied_at: null,
        applied_by: null,
        error_message: result.error ?? 'Apply failed',
      })
      .eq('id', change.id)
      .eq('workspace_id', args.workspaceId)
    return {
      ok: false,
      reason: 'apply_failed',
      error: result.error ?? 'Apply failed',
      ...(result.code ? { code: result.code } : {}),
    }
  }

  // ── Record what the claim couldn't know up front ─────────────────────────
  // If applyChange normalized the combo (a target-less assign applied as a
  // create), persist it so undo, dismiss and the card's label stay correct.
  await supabase
    .from('proposed_change')
    .update({
      result_entity_id: result.entity_id || null,
      ...(result.applied_change_type ? { change_type: result.applied_change_type } : {}),
      ...(result.applied_entity_type ? { entity_type: result.applied_entity_type } : {}),
    })
    .eq('id', change.id)
    .eq('workspace_id', args.workspaceId)

  return {
    ok: true,
    entity_id: result.entity_id ?? null,
    change: {
      ...change,
      status: 'applied',
      applied_at: now,
      applied_by: args.memberId,
      error_message: null,
      result_entity_id: result.entity_id ?? null,
      ...(result.applied_change_type ? { change_type: result.applied_change_type } : {}),
      ...(result.applied_entity_type ? { entity_type: result.applied_entity_type } : {}),
    },
  }
}
