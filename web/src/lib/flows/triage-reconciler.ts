/**
 * Triage reconciler — pure eligibility logic (Phase 3, WS-4a).
 *
 * F4: capture_processed fires only on the batch-extraction happy path, so most
 * captures never get triaged and their proposals pile up silently. The
 * reconciler cron (route.ts) re-fires capture_processed for captures that STILL
 * need triage. This module is the convergence guarantee: given the gathered
 * rows, decide WHICH captures to fire — and make that decision terminate so the
 * fire loop can't re-fire the same capture forever (LOOP-CLOSURE-PHASE3-PLAN.md
 * WS-4a). No Supabase here; the route gathers, this decides. Unit-tested.
 */

/** A pending proposal, scoped by the caller to workspaces with a triage flow.
 *  capture_id is nullable in the table (a proposal from chat or a sweep has no
 *  capture); such a row can never be reconciled — there is no capture to fire. */
export interface PendingProposalRow {
  id: string
  capture_id: string | null
  workspace_id: string
}

/**
 * Lifetime cap on reconcile fires per capture. A reconcile that didn't settle a
 * capture's proposals in two tries won't on the third: the model already judged
 * what it could, and a re-fire only asks again (2026-10 PROD audit: 238 fires
 * in 7 days over 19 captures under the old once-per-24h rule, which never
 * stopped). Counted from the tracked_job kind='triage_reconcile' ledger.
 */
export const MAX_RECONCILES_PER_CAPTURE = 2

/**
 * How long after a capture finished (ended, and its end-of-meeting pass stamped)
 * before the reconciler may touch it. The real capture.processed is emitted by
 * that pass; firing earlier triages the same capture twice. Past the batch
 * route's own 600s ceiling, so a capture still unstamped by then had its pass
 * fail, and the reconcile is the heal.
 */
export const RECONCILE_SETTLE_MS = 15 * 60 * 1000

/** The capture columns the readiness check reads. */
export interface ReconcileCaptureRow {
  id: string
  visibility: string | null
  ended_at: string | null
  batch_processed_at: string | null
  /** An eval/demo capture never fires loops (docs/plans/evals.md §5.2). */
  is_eval?: boolean | null
  /** `finalized.reason` is 'stale' on a capture the abandoned sweep retired. */
  metadata?: Record<string, unknown> | null
}

export type CaptureReadiness = 'ready' | 'missing' | 'eval' | 'private' | 'recording' | 'retired' | 'settling'

/**
 * May a reconcile fire for this capture now? Never a private capture (the
 * dispatcher skips it, so the fire does nothing), never one still recording
 * (`ended_at` null — its own end-of-meeting pass will emit capture.processed),
 * never one the abandoned sweep retired (an open capture quiet past its
 * lookback, closed with no pass: Triage on a meeting from weeks ago is what
 * the retire exists to avoid; src/lib/captures/abandoned.ts), and never within
 * RECONCILE_SETTLE_MS of the later of its end and its batch stamp. A missing
 * row (deleted capture) or an eval capture is never ready either.
 */
export function captureReadiness(row: ReconcileCaptureRow | null | undefined, nowMs: number): CaptureReadiness {
  if (!row) return 'missing'
  if (row.is_eval === true) return 'eval'
  if (row.visibility === 'private') return 'private'
  if (!row.ended_at) return 'recording'
  if ((row.metadata?.finalized as { reason?: unknown } | undefined)?.reason === 'stale') return 'retired'
  const endedMs = Date.parse(row.ended_at)
  const batchMs = row.batch_processed_at ? Date.parse(row.batch_processed_at) : Number.NaN
  const settledFrom = Math.max(Number.isFinite(endedMs) ? endedMs : 0, Number.isFinite(batchMs) ? batchMs : 0)
  if (nowMs - settledFrom < RECONCILE_SETTLE_MS) return 'settling'
  return 'ready'
}

/**
 * The captures that hold ≥1 genuinely un-triaged pending proposal (not decided
 * in a ledger, not holding a live card), in first-seen order — the set the
 * route then loads capture rows and ledger counts for. Null capture ids never
 * appear.
 */
export function collectCandidateCaptureIds(input: {
  pendingProposals: PendingProposalRow[]
  decidedProposalIds: ReadonlySet<string>
  liveCardProposalIds: ReadonlySet<string>
}): Array<{ capture_id: string; workspace_id: string }> {
  const out: Array<{ capture_id: string; workspace_id: string }> = []
  const seen = new Set<string>()
  for (const p of input.pendingProposals) {
    if (!p.capture_id || seen.has(p.capture_id)) continue
    if (input.decidedProposalIds.has(p.id) || input.liveCardProposalIds.has(p.id)) continue
    seen.add(p.capture_id)
    out.push({ capture_id: p.capture_id, workspace_id: p.workspace_id })
  }
  return out
}

/**
 * Captures already reconciled MAX_RECONCILES_PER_CAPTURE times (any outcome:
 * a failed dispatch still counts, its row is the attempt). Rows with no
 * capture id (the pre-fix null-capture fires) count for nothing.
 */
export function exhaustedCaptureIds(
  jobs: Array<{ source: { capture_id?: unknown } | null }>,
  max: number = MAX_RECONCILES_PER_CAPTURE,
): Set<string> {
  const counts = new Map<string, number>()
  for (const j of jobs) {
    const cid = j.source?.capture_id
    if (typeof cid !== 'string' || !cid) continue
    counts.set(cid, (counts.get(cid) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const [cid, n] of counts) if (n >= max) out.add(cid)
  return out
}

export interface EligibleCapture {
  workspace_id: string
  capture_id: string
}

export interface EligibilityInput {
  /** All pending proposals in the candidate workspaces, ideally oldest-first
   *  (the caller's order is preserved when picking the capped set). */
  pendingProposals: PendingProposalRow[]
  /** Proposal ids that appear in ANY verdict ledger of the lookback window,
   *  decided or left to the user — already judged, so they must not re-trigger
   *  a fire. */
  decidedProposalIds: ReadonlySet<string>
  /** Proposal ids holding a LIVE (pending, unexpired) attention card — already
   *  surfaced to the user; re-firing would re-card the same proposal. */
  liveCardProposalIds: ReadonlySet<string>
  /** Captures that hit the lifetime reconcile cap (exhaustedCaptureIds). */
  exhaustedCaptureIds: ReadonlySet<string>
  /** Captures not ready to reconcile (captureReadiness ≠ 'ready': private,
   *  still recording, settling, or missing). Absent → none. */
  unreadyCaptureIds?: ReadonlySet<string>
  /** Workspaces whose loop would fail the AI usage / subscription gate — a fire
   *  there only fails (and notifies) `subscription_required`. Absent → none. */
  blockedWorkspaceIds?: ReadonlySet<string>
  /** Max captures to fire this tick. */
  cap: number
}

/**
 * Collect the proposal ids judged in a set of verdict flow_runs. Pure walk of
 * the jsonb ledger — defensive because action_results is untyped jsonb from the
 * DB. A proposal that appears here has been judged and must never re-trigger a
 * reconcile fire. Two places count:
 *  - `verdict.entries[].proposal_id`: the run decided it;
 *  - `verdict.submitted.needs_user[].proposal_id`: the run deliberately left it
 *    to the user (a work proposal, a question). Whether it was then carded,
 *    suppressed, attempted or overflowed, it was judged: re-firing only asks the
 *    model again, and a second answer can differ (Sep 29, capture d6af9249: a
 *    writer work proposal came back as a create action and its card then hid the
 *    daily sweep's writer proposal). The gate's `attempts[]` are drawn from the
 *    needs_user items, so they need no walk of their own.
 */
export function extractDecidedProposalIds(
  runs: Array<{ action_results?: unknown }>,
): Set<string> {
  const decided = new Set<string>()
  const addIds = (items: unknown) => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      const pid = (item as { proposal_id?: unknown } | null)?.proposal_id
      if (typeof pid === 'string' && pid) decided.add(pid)
    }
  }
  for (const run of runs) {
    const results = run.action_results
    if (!Array.isArray(results)) continue
    for (const result of results) {
      const verdict = (result as { verdict?: unknown } | null)?.verdict as
        | { entries?: unknown; submitted?: { needs_user?: unknown } | null }
        | null
        | undefined
      addIds(verdict?.entries)
      addIds(verdict?.submitted?.needs_user)
    }
  }
  return decided
}

/**
 * The eligibility filter. A capture is eligible iff it has ≥1 pending proposal
 * that is NEITHER already decided in a verdict ledger NOR already holding a live
 * card, the capture is ready (finished, settled, not private), it has been
 * reconciled fewer than MAX_RECONCILES_PER_CAPTURE times, and its workspace
 * passes the usage gate. A proposal with no capture never qualifies. Returns at
 * most `cap` captures, deduped, in first-seen order of the input (so an
 * oldest-first proposal scan yields oldest captures first).
 *
 * This is the convergence core (WS-4a): a carded-but-unaccepted proposal stays
 * status='pending', so a naive "has a pending proposal" rule re-fires forever —
 * the decided/live-card exclusions remove exactly the proposals that a re-fire
 * could only re-card, and the lifetime per-capture cap bounds the rest.
 */
export function selectEligibleCaptures(input: EligibilityInput): EligibleCapture[] {
  const { pendingProposals, decidedProposalIds, liveCardProposalIds, exhaustedCaptureIds, cap } = input
  const unready = input.unreadyCaptureIds ?? new Set<string>()
  const blockedWs = input.blockedWorkspaceIds ?? new Set<string>()
  const eligible: EligibleCapture[] = []
  const seen = new Set<string>()

  for (const p of pendingProposals) {
    if (!p.capture_id) continue
    if (seen.has(p.capture_id)) continue
    if (exhaustedCaptureIds.has(p.capture_id)) continue
    if (unready.has(p.capture_id)) continue
    if (blockedWs.has(p.workspace_id)) continue
    // The proposal must be genuinely un-triaged: neither judged nor already a card.
    if (decidedProposalIds.has(p.id)) continue
    if (liveCardProposalIds.has(p.id)) continue
    seen.add(p.capture_id)
    eligible.push({ workspace_id: p.workspace_id, capture_id: p.capture_id })
    if (eligible.length >= cap) break
  }

  return eligible
}
