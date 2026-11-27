/**
 * Writing the track record (docs/plans/earned-autonomy.md §1): one
 * autonomy_outcome row per settled card, from the two functions every card's
 * answer goes through (safety/approvals.ts approveToolCall, denyToolCall) and
 * the expiry sweep. Behind EARNED_AUTONOMY (empty is off).
 *
 * Best effort and never in the way: it never throws, and a failed write
 * (migration 723 not applied yet, a network blip) is logged and dropped. A
 * card's answer never waits on it or fails because of it. Idempotent: the
 * unique (source, source_id, outcome) drops a second write of the same row.
 *
 * Whose record: the approval's owner (tool_approval.user_id), the only one who
 * may answer it (caller.ts mayApprove). A guest's call (context.guest) is the
 * guest's agent's work, not the person's own agent's, so it isn't counted.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { earnedAutonomyRecording } from './config'
import { kindOfCall } from './kind'
import type { AutonomyOutcomeKind } from './rules'

export interface SettledApproval {
  id: string
  workspace_id: string
  user_id: string
  tool: string
  input: unknown
  context?: unknown
}

export interface RecordedOutcome {
  approval: SettledApproval
  outcome: Extract<AutonomyOutcomeKind, 'approved' | 'approved_edited' | 'dismissed' | 'expired' | 'failed'>
  editRatio?: number | null
}

/** The row to write, or null when this approval isn't counted. Pure. */
export function outcomeRow({ approval, outcome, editRatio }: RecordedOutcome): Record<string, unknown> | null {
  if (!approval?.id || !approval.workspace_id || !approval.user_id || typeof approval.tool !== 'string' || !approval.tool) return null
  const context = approval.context && typeof approval.context === 'object' ? (approval.context as Record<string, unknown>) : {}
  if (context.guest) return null
  const kind = kindOfCall({ tool: approval.tool, input: approval.input, context })
  const ratio = outcome === 'approved_edited' && typeof editRatio === 'number' && Number.isFinite(editRatio) ? Math.min(1, Math.max(0, editRatio)) : null
  return {
    workspace_id: approval.workspace_id,
    user_id: approval.user_id,
    kind_key: kind.key.slice(0, 400),
    tool: kind.tool.slice(0, 200),
    channel: kind.channel,
    audience: kind.audience,
    source: 'tool_approval',
    source_id: approval.id,
    outcome,
    edit_ratio: ratio,
  }
}

/** Record settled approvals. Never throws; a no-op while EARNED_AUTONOMY is off. */
export async function recordApprovalOutcomes(
  supabase: SupabaseClient,
  outcomes: readonly RecordedOutcome[],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!earnedAutonomyRecording(env)) return
  try {
    const rows = outcomes.map(outcomeRow).filter((r): r is Record<string, unknown> => r !== null)
    if (!rows.length) return
    const { error } = await supabase
      .from('autonomy_outcome')
      .upsert(rows, { onConflict: 'source,source_id,outcome', ignoreDuplicates: true })
    if (error) console.warn('[earned-autonomy] record failed', JSON.stringify({ count: rows.length, error: error.message }))
  } catch (err) {
    console.warn('[earned-autonomy] record failed', err instanceof Error ? err.message : String(err))
  }
}
