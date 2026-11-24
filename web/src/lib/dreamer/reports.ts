/**
 * The Dreamer's reports on the parent's side (docs/plans/dreamer.md "How it
 * runs", migration 720 dreamer_report): what a home turn with reason
 * 'dreamer' carries, and marking it delivered after the turn.
 *
 * The plan reads the person's undelivered reports from the last 24 hours,
 * oldest first, at most DREAMER_TURN_MAX_REPORTS (never trusting the event's
 * payload for which). After the turn they are marked delivered
 * (`delivered_at`, `home_turn_id`) whether the agent spoke or stayed quiet:
 * the report was for it, and it has read it. One the turn could not deliver
 * (it failed, or ran out of reads) stays, and the next Dreamer update carries
 * it, until it is a day old. A turn that delivered three while more wait asks
 * for the next update at once, and one skipped while the person's session is
 * parked or busy asks again an hour later (dreamerFollowUpRequest), so no
 * report waits for the Dreamer's next run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DREAMER_TURN_MAX_REPORTS, HOME_TURN_REQUESTED_EVENT, type HomeTurnDreamer, type HomeTurnDreamerReport } from '@/lib/chat/home-turn'

/** How far back a Dreamer's update looks for undelivered reports. */
export const DREAMER_REPORT_WINDOW_MS = 24 * 60 * 60_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The person's undelivered reports in this workspace from the last 24 hours,
 * oldest first, at most DREAMER_TURN_MAX_REPORTS; null when there are none.
 * Throws on a failed read (the plan answers `lookup_failed`).
 */
export async function gatherDreamerReports(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  nowMs: number = Date.now(),
): Promise<HomeTurnDreamer | null> {
  const { data, error } = await supabase
    .from('dreamer_report')
    .select('id, prompt, reflection, created_at')
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .is('delivered_at', null)
    .gte('created_at', new Date(nowMs - DREAMER_REPORT_WINDOW_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(DREAMER_TURN_MAX_REPORTS)
  if (error) throw new Error(`dreamer_report read failed: ${error.message}`)
  const reports: HomeTurnDreamerReport[] = ((data ?? []) as Array<Record<string, unknown>>)
    .filter((r) => typeof r.id === 'string' && UUID_RE.test(r.id) && typeof r.prompt === 'string' && r.prompt.trim() && typeof r.created_at === 'string')
    .map((r) => ({ id: r.id as string, prompt: r.prompt as string, reflection: r.reflection === true, createdAt: r.created_at as string }))
  if (reports.length === 0) return null
  return { reports, reportIds: reports.map((r) => r.id) }
}

/**
 * Mark the reports a turn carried as delivered by it (only those still
 * undelivered, so a retried step changes nothing). THROWS on a failed
 * update, so the consumer's step is retried: a report left undelivered after
 * its turn would be carried again by a later update, beside newer reports,
 * under another dedupe key, and the agent would read it twice.
 */
export async function markDreamerReportsDelivered(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; reportIds: readonly string[]; homeTurnId: string },
  now: Date = new Date(),
): Promise<number> {
  const ids = args.reportIds.filter((id) => UUID_RE.test(id))
  if (ids.length === 0) return 0
  const { data, error } = await supabase
    .from('dreamer_report')
    .update({ delivered_at: now.toISOString(), home_turn_id: args.homeTurnId })
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .in('id', ids)
    .is('delivered_at', null)
    .select('id')
  if (error) throw new Error(`dreamer_report delivery not marked: ${error.message}`)
  return Array.isArray(data) ? data.length : 0
}

/**
 * Whether the person still has undelivered reports from the last 24 hours
 * (after a turn carried its three). Throws on a failed read (the step retries).
 */
export async function hasUndeliveredDreamerReports(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  nowMs: number = Date.now(),
): Promise<boolean> {
  return (await gatherDreamerReports(supabase, scope, nowMs)) !== null
}

// ── Leftovers: another update, so no report waits for the next run ──────────

/** How long a Dreamer update that could not run now waits before it is asked for again. */
export const DREAMER_RETRY_DELAY_MS = 60 * 60_000

/**
 * The skips a later try may clear: the home thread's session parked on the
 * person's question, or another home turn holding it past every wait. The
 * plan had reports to carry (it reads them before these), and they age out
 * of its 24-hour window, so retrying an hour later is a bounded chain. Every
 * other skip (autonomy off, the usage limit, nothing new, a gone thread, a
 * failed read) asks for nothing: the next report's own request tries again.
 */
export const DREAMER_RETRY_SKIPS: ReadonlySet<string> = new Set(['question_pending', 'busy'])

/** What a follow-up Dreamer update request is: `home/turn.requested`, reason 'dreamer', ids only. */
export interface DreamerFollowUpRequest {
  id: string
  name: typeof HOME_TURN_REQUESTED_EVENT
  ts?: number
  data: { conversationId: string; userId: string; workspaceId: string; workItemIds: string[]; reason: 'dreamer' }
}

/**
 * The next Dreamer update to ask for, or null:
 *   - after a turn that DELIVERED reports (it marked at least one) and left
 *     more undelivered: one more now (each turn carries up to three, so the
 *     chain ends when they do), keyed on the turn that delivered;
 *   - after a skip a later try may clear (DREAMER_RETRY_SKIPS): one an hour
 *     later, keyed on the hour, so a run of skips asks once an hour at most.
 * Pure.
 */
export function dreamerFollowUpRequest(
  ids: { conversationId: string; userId: string; workspaceId: string },
  after: { delivered: number; leftovers: boolean; homeTurnId: string } | { skipped: string; nowMs: number },
): DreamerFollowUpRequest | null {
  const data = { conversationId: ids.conversationId, userId: ids.userId, workspaceId: ids.workspaceId, workItemIds: [], reason: 'dreamer' as const }
  if ('delivered' in after) {
    if (after.delivered <= 0 || !after.leftovers) return null
    return { id: `home-turn-requested:dreamer-more:${after.homeTurnId}`, name: HOME_TURN_REQUESTED_EVENT, data }
  }
  if (!DREAMER_RETRY_SKIPS.has(after.skipped)) return null
  const hour = Math.floor(after.nowMs / DREAMER_RETRY_DELAY_MS)
  return { id: `home-turn-requested:dreamer-retry:${ids.conversationId}:${hour}`, name: HOME_TURN_REQUESTED_EVENT, ts: after.nowMs + DREAMER_RETRY_DELAY_MS, data }
}
