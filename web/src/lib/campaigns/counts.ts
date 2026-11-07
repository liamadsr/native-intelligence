/**
 * A sending campaign's counts (roadmap D2), computed from its sequence's
 * enrollments every time they are read, so they can't drift from what the
 * engine did:
 *
 *   recipients  enrollments in the campaign's sequence that a launch armed
 *               (one staged and never launched, say from a declined card,
 *               reached no one and is not counted)
 *   sent        people sent at least one email (the engine advances
 *               current_step_order only on a sent step)
 *   replied     exited 'replied' (a reply stops the sequence for them)
 *   opted_out   exited 'opted_out' (on the opt-out list before a later
 *               step), plus the people a launch skipped because they were
 *               on it already (campaign.stats.skipped_opted_out)
 *   active      still in the sequence
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/paging'
import type { CampaignCounts, CampaignStats } from './shape'

export const EMPTY_COUNTS: CampaignCounts = Object.freeze({ recipients: 0, sent: 0, replied: 0, opted_out: 0, active: 0 })

/** Fold one sequence's enrollments into counts. Pure. */
export function countEnrollments(
  rows: ReadonlyArray<{ status: string | null; exit_reason: string | null; current_step_order: number | null; next_send_at?: string | null }>,
  stats: CampaignStats | null | undefined,
): CampaignCounts {
  const counts = { ...EMPTY_COUNTS, opted_out: stats?.skipped_opted_out ?? 0 }
  for (const e of rows) {
    // Staged and never launched: nobody was reached.
    if (e.status === 'active' && (e.current_step_order ?? 0) === 0 && (e.next_send_at ?? null) === null) continue
    counts.recipients += 1
    if ((e.current_step_order ?? 0) > 0) counts.sent += 1
    if (e.exit_reason === 'replied') counts.replied += 1
    if (e.exit_reason === 'opted_out') counts.opted_out += 1
    if (e.status === 'active') counts.active += 1
  }
  return counts
}

/**
 * Counts for each campaign that has a sequence, keyed by campaign id; a
 * campaign without one gets none. Throws on a failed read.
 */
export async function campaignCounts(
  supabase: SupabaseClient,
  args: { workspaceId: string; campaigns: ReadonlyArray<{ id: string; sequence_id: string | null; stats?: CampaignStats | null }> },
): Promise<Map<string, CampaignCounts>> {
  const out = new Map<string, CampaignCounts>()
  const sequenceIds = [...new Set(args.campaigns.map((c) => c.sequence_id).filter((id): id is string => !!id))]
  if (sequenceIds.length === 0) return out
  type Row = { sequence_id: string; status: string | null; exit_reason: string | null; current_step_order: number | null; next_send_at: string | null }
  const { data: rows, error } = await fetchAllRows<Row>(() =>
    supabase
      .from('sequence_enrollment')
      .select('id, sequence_id, status, exit_reason, current_step_order, next_send_at')
      .eq('workspace_id', args.workspaceId)
      .in('sequence_id', sequenceIds),
  )
  if (error) throw new Error(`campaign counts failed: ${error.message}`)
  const bySequence = new Map<string, Row[]>()
  for (const r of rows) bySequence.set(r.sequence_id, [...(bySequence.get(r.sequence_id) ?? []), r])
  for (const c of args.campaigns) {
    if (!c.sequence_id) continue
    out.set(c.id, countEnrollments(bySequence.get(c.sequence_id) ?? [], c.stats))
  }
  return out
}

/** "12 sent · 3 replied · 1 opted out". Pure. */
export function describeCounts(counts: CampaignCounts): string {
  return `${counts.sent} sent · ${counts.replied} replied · ${counts.opted_out} opted out`
}
