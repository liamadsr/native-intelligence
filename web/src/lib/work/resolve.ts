/**
 * How a "Needs you" item stops waiting (ACTIVITY-AND-REVIEW-DESIGN §4.2-4.3).
 *
 * Two doors out of `needs_review`, both landing on `done` with `reviewed_at`:
 *
 *   • resolveWorkForDeliverable — the human acted on the deliverable on ITS OWN
 *     surface (sent the draft, merged the PR, accepted the card, opened the
 *     document from the item). Per deliverable: the acted-on ref is stamped
 *     `resolved_at`, and the item completes once every deliverable that carries
 *     a human verb is resolved ("send one → still waiting; send the second →
 *     done"). Called from those surfaces' routes; the user never has to "mark
 *     reviewed" for the common paths.
 *   • settleReview — the item's own "Mark reviewed" / "Dismiss" verbs (the
 *     PATCH /api/account/activity/[id] route and the main agent's
 *     settle_work_item, both through settleWorkReview), fenced on the owning
 *     member.
 *
 * Beside them, markOpened: the owner opened the item's panel, so it is no
 * longer new (its bot stops calling for it). Not a door out: it changes no
 * status.
 *
 * Both doors write one line to the owner's agent log for a settle they won
 * (src/lib/log/agent-log.ts: "Reviewed", "Dismissed", or "Done … (acted
 * on)"), in the row's own workspace, off the caller's path and never
 * throwing.
 *
 * Send / Accept / Merge themselves never live here (NORTH-STAR invariant 5).
 * Service-role only (no client write policy); never throws — a lost resolve is
 * a stale row in "Needs you", not a failed send.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkDeliverable, WorkDeliverableType, WorkItem, WorkProgress } from './types'
import { jsonbNeedle } from '@/lib/supabase/jsonb-needle'
import { WORK_LOG_FACT_COLUMNS, deferLogWrite, logWorkEvent, workLogFacts, type WorkSettleOutcome } from '@/lib/log/agent-log'
import { completeActionOnReview } from '@/lib/actions/agent-finish'

/** Deliverable types whose own surface carries the human verb, so acting there
 *  resolves the item. The rest (a capture the run archived, a contact it
 *  touched, a link) never hold an item open on their own. */
export const RESOLVABLE_DELIVERABLE_TYPES: ReadonlySet<WorkDeliverableType> = new Set<WorkDeliverableType>([
  'email_draft',
  'pr',
  'document',
  'action',
  'attention_cards',
  'prospect_list',
])

/** At most this many waiting items are touched per call (one deliverable
 *  rarely belongs to more than one item). */
const RESOLVE_BATCH = 50

export interface ResolveOutcome {
  /** Items whose deliverable was stamped resolved. */
  touched: string[]
  /** The subset that had nothing left to review and flipped to done. */
  completed: string[]
}

function logError(op: string, err: unknown) {
  console.error(`[work] ${op} failed:`, err instanceof Error ? err.message : err)
}

/** Every waiting item that lists this deliverable stamps it resolved; an item
 *  with no unresolved reviewable deliverable left completes. A delivered
 *  (`done`) item that lists it stamps it too and stays done (a drafting pass:
 *  its sent draft is no longer the one "Review draft" opens on, Phase 6 of
 *  docs/plans/chat-ui-polish.md). */
export async function resolveWorkForDeliverable(
  supabase: SupabaseClient,
  ref: { type: WorkDeliverableType; id: string },
  opts: { nowIso?: string } = {},
): Promise<ResolveOutcome> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const out: ResolveOutcome = { touched: [], completed: [] }
  if (!ref.id) return out
  try {
    const { data, error } = await supabase
      .from('tracked_job')
      .select('id, status, deliverables')
      .in('status', ['needs_review', 'done'])
      // jsonb containment: the needle must be JSON text (jsonb-needle.ts) — a bare
      // JS array is sent as a Postgres array literal and PostgREST rejects it.
      .contains('deliverables', jsonbNeedle([{ type: ref.type, id: ref.id }]))
      .limit(RESOLVE_BATCH)
    if (error) {
      logError('resolve scan', error)
      return out
    }
    for (const row of (data ?? []) as Array<{ id: string; status?: string; deliverables: WorkDeliverable[] | null }>) {
      let stamped = false
      const deliverables = (Array.isArray(row.deliverables) ? row.deliverables : []).map((d) => {
        if (d.type !== ref.type || d.id !== ref.id || d.resolved_at) return d
        stamped = true
        return { ...d, resolved_at: nowIso }
      })
      if (row.status === 'done') {
        // Delivered: the deliverable is stamped and nothing else moves.
        if (!stamped) continue
        const { data: kept } = await supabase.from('tracked_job').update({ deliverables }).eq('id', row.id).eq('status', 'done').select('id').maybeSingle()
        if (kept) out.touched.push(row.id)
        continue
      }
      const complete = !deliverables.some((d) => RESOLVABLE_DELIVERABLE_TYPES.has(d.type) && !d.resolved_at)
      const patch: Record<string, unknown> = complete
        ? { deliverables, status: 'done', needs: null, reviewed_at: nowIso, last_beat_at: nowIso }
        : { deliverables, last_beat_at: nowIso }
      const { data: won } = await supabase
        .from('tracked_job')
        .update(patch)
        .eq('id', row.id)
        .eq('status', 'needs_review')
        .select(complete ? SETTLED_SELECT : 'id')
        .maybeSingle()
      if (!won) continue
      out.touched.push(row.id)
      if (complete) {
        out.completed.push(row.id)
        logWorkSettle(supabase, won as unknown as SettledRow, 'resolved', nowIso)
        // The person accepted the work on its own surface: the action the job
        // worked is Done, as their Reviewed would make it (decision 9).
        await completeReviewedAction(supabase, won as unknown as SettledRow)
      }
    }
  } catch (err) {
    logError('resolve', err)
  }
  return out
}

/**
 * A person marked an action Done by hand (the board, the ticket, or the
 * action tools on their word): every job waiting on review that worked that
 * action (`source.action_id`) is reviewed with it, so its card leaves "Needs
 * you" (decision 9: the person's Done is their review). Rides the shared
 * status-change event (inngest/action-done-review.ts), the one place the
 * PATCH route and the tools both pass through. Each row goes through
 * settleWorkReview, so its handoffs and notices settle as the Reviewed button
 * would. Never throws; returns the rows it settled.
 */
export async function resolveWorkForAction(
  supabase: SupabaseClient,
  args: { actionId: string; workspaceId: string },
): Promise<string[]> {
  const settled: string[] = []
  if (!args.actionId) return settled
  try {
    const { data, error } = await supabase
      .from('tracked_job')
      .select('id, workspace_id, member_id, progress, source')
      .eq('workspace_id', args.workspaceId)
      .eq('status', 'needs_review')
      .contains('source', jsonbNeedle({ action_id: args.actionId }))
      .limit(RESOLVE_BATCH)
    if (error) {
      logError('resolve by action', error)
      return settled
    }
    for (const row of (data ?? []) as Array<Pick<WorkItem, 'id' | 'workspace_id' | 'member_id' | 'progress' | 'source'>>) {
      const out = await settleWorkReview(supabase, row, 'reviewed')
      if (out.changed) settled.push(row.id)
    }
  } catch (err) {
    logError('resolve by action', err)
  }
  return settled
}

/** What a won settle reads back for the owner's log line (add it to the write's `.select()`). */
export const SETTLED_SELECT = `id, workspace_id, member_id, title, area, ${WORK_LOG_FACT_COLUMNS}`
export type SettledRow = Pick<WorkItem, 'id' | 'workspace_id' | 'member_id' | 'title'> & {
  area?: string | null
  kind?: string | null
  source?: WorkItem['source'] | null
  parent_id?: string | null
  depth?: number | null
}

/**
 * The owner's log line for a review settle this caller won (agent-log.ts):
 * these doors, and the reaper's expiry (reaper.ts). Never throws.
 */
export function logWorkSettle(supabase: SupabaseClient, row: SettledRow, outcome: WorkSettleOutcome, nowIso: string): void {
  if (!row?.id || !row.workspace_id || !row.member_id) return
  deferLogWrite(
    logWorkEvent(
      supabase,
      {
        workItemId: row.id,
        workspaceId: row.workspace_id,
        memberId: row.member_id,
        title: row.title ?? null,
        area: row.area ?? null,
        ...workLogFacts(row),
      },
      { type: 'work_settled', at: nowIso, outcome },
    ),
  )
}

/**
 * The item's own review verbs. CAS on needs_review and fenced on the owning
 * member (the route reads the row under RLS first, then hands it here). The
 * outcome is kept on `progress.review` so the Recent list can tell a reviewed
 * item from a dismissed one.
 */
export async function settleReview(
  supabase: SupabaseClient,
  row: Pick<WorkItem, 'id' | 'member_id' | 'progress'>,
  outcome: 'reviewed' | 'dismissed',
  opts: { nowIso?: string } = {},
): Promise<boolean> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const progress: WorkProgress = { ...(row.progress ?? {}), review: outcome }
  try {
    const { data } = await supabase
      .from('tracked_job')
      .update({ status: 'done', needs: null, reviewed_at: nowIso, last_beat_at: nowIso, progress })
      .eq('id', row.id)
      .eq('member_id', row.member_id)
      .eq('status', 'needs_review')
      .select(SETTLED_SELECT)
      .maybeSingle()
    if (data) logWorkSettle(supabase, data as unknown as SettledRow, outcome, nowIso)
    return !!data
  } catch (err) {
    logError('settleReview', err)
    return false
  }
}

/**
 * The owner opened the item's panel (migration 295): stamp `opened_at` when
 * it is empty. Fenced on the owning member and CAS on `opened_at IS NULL`, so
 * a second open (or two at once) never moves it; only the recorder clears it,
 * when the row starts waiting on the owner again (needInput, finish with a
 * review), and then the next open stamps it anew. Any status: an opened item
 * is no longer new, whatever it is doing. Touches nothing else (not
 * `last_beat_at`, the reaper's clock). The route proves the caller owns the
 * row before it hands it here. Returns whether this call stamped it; never
 * throws (on a database without migration 295 the write errors and this
 * returns false: a quiet no-op).
 */
export async function markOpened(
  supabase: SupabaseClient,
  row: Pick<WorkItem, 'id' | 'member_id'>,
  opts: { nowIso?: string } = {},
): Promise<boolean> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  try {
    const { data } = await supabase
      .from('tracked_job')
      .update({ opened_at: nowIso })
      .eq('id', row.id)
      .eq('member_id', row.member_id)
      .is('opened_at', null)
      .select('id')
      .maybeSingle()
    return !!data
  } catch (err) {
    logError('markOpened', err)
    return false
  }
}

/**
 * Opening an item reads its notices (bots v3 1b, "Opening the item reads the
 * notice"): the owner's unread notifications that point at it (target
 * `work_item`, the item's id: the verdict digest, `work_needs_you`,
 * `work_failed`, "Flow skipped") are marked read, so the bot's dot clears and
 * the banners leave on every device (the realtime UPDATE carries it). Fenced on the owning
 * member, so it only ever reads their own notices. Returns how many it read;
 * never throws.
 */
export async function markItemNoticesRead(
  supabase: SupabaseClient,
  row: Pick<WorkItem, 'id' | 'member_id'>,
  opts: { nowIso?: string } = {},
): Promise<number> {
  if (!row.member_id) return 0
  const nowIso = opts.nowIso ?? new Date().toISOString()
  try {
    const { data, error } = await supabase
      .from('notification')
      .update({ is_read: true, read_at: nowIso })
      .eq('recipient_id', row.member_id)
      .eq('target_type', 'work_item')
      .eq('target_id', row.id)
      .eq('is_read', false)
      .select('id')
    if (error) throw new Error(error.message)
    return Array.isArray(data) ? data.length : 0
  } catch (err) {
    logError('markItemNoticesRead', err)
    return 0
  }
}

/** What the review verbs did (settleWorkReview). */
export interface WorkReviewOutcome {
  /** This call settled the row (false: it wasn't waiting on review any more). */
  changed: boolean
  /** Its handoffs waiting on review, settled with it (row 14). */
  handoffs: number
  /** Its owner's unread notices for it and for those handoffs, now read. */
  noticesRead: number
}

/**
 * The item's own review verbs, end to end: ONE path for the item's Reviewed
 * and Dismiss buttons (PATCH /api/account/activity/[id]) and the main agent's
 * `settle_work_item` (bots-v4 Phase A2). Settles the row (settleReview: CAS on
 * needs_review, fenced on its member); when this call settled it, its
 * handoffs waiting on review go with it (settleReviewSubtree, row 14) and the
 * owner's unread notices for it and for each handoff it settled are read
 * (markItemNoticesRead, fenced on the owner as each settle is), so the bot
 * stops counting what's done, as opening the item reads them. The
 * caller proves the row is the caller's own before it hands it here. Never
 * throws.
 *
 * Reviewed on a job that worked an action marks that action Done
 * (decision 9: an agent's finish leaves the action in review, and the
 * person's Reviewed is what completes it; src/lib/actions/agent-finish.ts).
 * Dismiss leaves the action where it is.
 */
export async function settleWorkReview(
  supabase: SupabaseClient,
  row: Pick<WorkItem, 'id' | 'member_id' | 'progress'> & ReviewedActionRef,
  outcome: 'reviewed' | 'dismissed',
  opts: { nowIso?: string } = {},
): Promise<WorkReviewOutcome> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const changed = await settleReview(supabase, row, outcome, { nowIso })
  if (!changed) return { changed, handoffs: 0, noticesRead: 0 }
  if (outcome === 'reviewed') await completeReviewedAction(supabase, row, { waitForMerge: true })
  const handoffs = await settleReviewSubtree(supabase, row, outcome, { nowIso })
  let noticesRead = await markItemNoticesRead(supabase, row, { nowIso })
  for (const id of handoffs) noticesRead += await markItemNoticesRead(supabase, { id, member_id: row.member_id }, { nowIso })
  return { changed, handoffs: handoffs.length, noticesRead }
}

/** What settleWorkReview reads to find the action a job worked: its workspace and `source.action_id`. */
interface ReviewedActionRef {
  workspace_id?: string | null
  source?: WorkItem['source'] | Record<string, unknown> | null
}

/**
 * The action a reviewed job worked (`source.action_id`), marked Done as its
 * owner's act (completeActionOnReview). Reads the owner's user id for the
 * status-change actor. Fail-soft: never throws, and a job with no action is
 * a no-op.
 *
 * `waitForMerge` (the Reviewed verb): a coding job whose PR has not merged
 * leaves the action as it is. Reviewing the PR isn't shipping it; the merge
 * (the GitHub webhook's resolveWorkForDeliverable / completeActionsForMergedPr)
 * marks it Done.
 */
async function completeReviewedAction(
  supabase: SupabaseClient,
  row: Pick<WorkItem, 'id' | 'member_id'> & ReviewedActionRef,
  opts: { waitForMerge?: boolean } = {},
): Promise<void> {
  const rawActionId = (row.source as { action_id?: unknown } | null | undefined)?.action_id
  const actionId = typeof rawActionId === 'string' && rawActionId ? rawActionId : null
  if (!actionId || !row.workspace_id) return
  try {
    if (opts.waitForMerge) {
      const { data: job } = await supabase.from('tracked_job').select('kind, deliverables').eq('id', row.id).maybeSingle()
      const j = job as { kind?: string | null; deliverables?: WorkDeliverable[] | null } | null
      const unmergedPr = (Array.isArray(j?.deliverables) ? j!.deliverables : []).some((d) => d?.type === 'pr' && !d.resolved_at)
      if (j?.kind === 'coding_run' && unmergedPr) return
    }
    const { data: owner } = await supabase.from('member').select('user_id').eq('id', row.member_id).maybeSingle()
    const actorUserId = (owner as { user_id?: string } | null)?.user_id
    if (!actorUserId) return
    await completeActionOnReview(supabase, { actionId, workspaceId: row.workspace_id, actorUserId })
  } catch (err) {
    logError('completeReviewedAction', err)
  }
}

/** How deep the subtree walk goes: the policy caps delegation depth at 2. */
const SUBTREE_MAX_DEPTH = 4

/**
 * Settle the handoffs under an item the person just reviewed or dismissed
 * (row 14): a delegated child waiting on review is reviewed WITH the row that
 * handed it the work, so it leaves "Needs you" with it and records the same
 * outcome. Fenced on the owning member and on `needs_review`, so a child that
 * is still running, or already settled, is left alone. Returns the ids of
 * the rows it settled. Never throws.
 */
export async function settleReviewSubtree(
  supabase: SupabaseClient,
  root: Pick<WorkItem, 'id' | 'member_id'>,
  outcome: 'reviewed' | 'dismissed',
  opts: { nowIso?: string } = {},
): Promise<string[]> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const settled: string[] = []
  let frontier = [root.id]
  try {
    for (let depth = 0; depth < SUBTREE_MAX_DEPTH && frontier.length > 0; depth++) {
      const { data } = await supabase
        .from('tracked_job')
        .select('id, member_id, status, progress')
        .in('parent_id', frontier)
        .eq('member_id', root.member_id)
      const children = (data ?? []) as Array<Pick<WorkItem, 'id' | 'member_id' | 'status' | 'progress'>>
      for (const child of children) {
        if (child.status !== 'needs_review') continue
        if (await settleReview(supabase, child, outcome, { nowIso })) settled.push(child.id)
      }
      frontier = children.map((c) => c.id)
    }
  } catch (err) {
    logError('settleReviewSubtree', err)
  }
  return settled
}
