/**
 * Questions nobody can answer any more (bots-v4 decision 23, the 2026-10-08
 * review of "a bot stays out until what it brought is settled").
 *
 * A ledger row waits on a question (`needs_input`) only while a work or
 * coding run is parked on one: the agent-run mirror is the only writer of
 * that status (agent-run-mirror.ts → recorder.ts needInput), so every such
 * row is a `work_run` or `coding_run` (QUESTION_KINDS) and its truth is its
 * agent_run. Two ways it outlives its run:
 *
 *  - the run is gone: deleting a tracked action cascades its agent_run away
 *    (agent_run_action_id_fkey ON DELETE CASCADE), and the ledger row lives on
 *    with `agent_run_id` set null (migration 272);
 *  - the run moved on but the mirror's write didn't land (it is best-effort):
 *    the run resumed, finished, failed or was canceled, and the row still
 *    says it waits on you.
 *
 * Such a row can't be answered (the respond path needs a run parked on the
 * question), and since a bot stays on screen until everything it brought is
 * settled, it would hold its bot out for good. So:
 *
 *  - the reaper reconciles it (reconcileStaleQuestions, from reaper.ts),
 *    reading its run again right before each write: a row whose run is gone
 *    is canceled; one whose run failed or was canceled takes that outcome;
 *    one whose run finished (completed or pr_open) becomes what the mirror's
 *    own finish would have made it (a work run's result or a PR waits on your
 *    review, `needs_review` with its deliverables and its needs-you notice;
 *    a coding run with nothing to review ends `done`); one whose run is going
 *    again goes back to running, with a running deadline, so the stale-run
 *    reaper owns it from there (and that reaper moves a running row whose run
 *    re-parked on a question back to waiting: reaper.ts). Otherwise quietly:
 *    no failure notice, no push, and its unread notices are read; only the
 *    owner's log line a recorder move would write (agent-log.ts: "Finished",
 *    "Failed" or "Canceled"; nothing for a run going again). Only rows
 *    that have sat still past QUESTION_RECONCILE_GRACE_MS, so a mirror write
 *    in flight is never raced; rows with no run at all are read first, and
 *    the rest a page at a time, so many live questions never hide them. A
 *    row whose run is still parked on the question is a live question and is
 *    left alone;
 *  - a live question unanswered for WORK_INPUT_TTL_DAYS (14 days, as long as
 *    a review waits) is given up: its run is canceled first, the way Stop
 *    cancels it (a CAS to `canceling`, then `agent/run.cancel`, which settles
 *    the run and frees its session), and the row only if that CAS won; one
 *    answered in the meantime is left for the next tick;
 *  - the person can say so themselves: "Stop waiting" on the item (the bubble
 *    and the item panel, PATCH /api/account/activity/[id] { action:
 *    'stop_waiting' }) and the main agent's settle_work_item `dismiss` run
 *    stopWaitingOnQuestion, which does for one row what the reaper does and
 *    refuses a live question (that one is answered, or its run stopped).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isAgentRunLive } from '@/lib/agent-run/types'
import { deferLogWrite, logWorkEvent, workLogEventFor, workLogFacts } from '@/lib/log/agent-log'
import { SETTLED_SELECT, markItemNoticesRead, type SettledRow } from './resolve'
import type { AgentRunDeliverable } from './agent-run-mirror'
import { DEFAULT_WORK_DEADLINES, WORK_INPUT_TTL_DAYS, WORK_KINDS, type WorkStatus } from './types'

/** The only kinds a ledger row waits on a question in: runs the agent-run mirror records. */
export const QUESTION_KINDS: readonly string[] = [WORK_KINDS.workRun, WORK_KINDS.codingRun]

/** How long a waiting row must have sat still before the reaper reconciles it: past any mirror write in flight. */
export const QUESTION_RECONCILE_GRACE_MS = 10 * 60 * 1000

/** Rows one scan page reads. */
export const QUESTION_RECONCILE_BATCH = 200

/** Pages of waiting rows with a run one tick reads, at most (QUESTION_RECONCILE_BATCH each). */
export const QUESTION_RECONCILE_PAGES = 5

export const QUESTION_RUN_GONE = 'Stopped waiting: the run that asked this is gone'
export const QUESTION_RUN_SETTLED = 'Stopped waiting: the run that asked this had already finished'
export const QUESTION_TTL_REASON = `Canceled: the question went unanswered for ${WORK_INPUT_TTL_DAYS} days`

/** The run behind a waiting row, as far as the question goes. */
export type QuestionRunState =
  /** Its run is still parked on a question: a live question. */
  | { state: 'waiting' }
  /** No run: deleted with its action, or never linked. */
  | { state: 'gone' }
  /** Its run is in flight again (resumed, or being canceled). */
  | { state: 'moved' }
  /** Its run settled; the row takes this outcome. */
  | { state: 'settled'; to: Extract<WorkStatus, 'done' | 'failed' | 'canceled'> }

/** What a run's status says of the question its ledger row waits on. Pure. */
export function questionRunState(run: { status: string } | null): QuestionRunState {
  if (!run) return { state: 'gone' }
  if (run.status === 'needs_input') return { state: 'waiting' }
  if (isAgentRunLive(run.status)) return { state: 'moved' }
  if (run.status === 'failed') return { state: 'settled', to: 'failed' }
  if (run.status === 'canceled') return { state: 'settled', to: 'canceled' }
  // completed, pr_open, or anything else terminal: the work finished.
  return { state: 'settled', to: 'done' }
}

/** A waiting row as the reconcile reads it. */
export interface QuestionRow {
  id: string
  member_id: string
  workspace_id: string
  agent_run_id: string | null
}

/** What the reconcile reads of a run: its status, and what a settled one finished with (the mirror's finish rebuilds the review from it). */
export interface QuestionRun {
  id: string
  status: string
  result_summary?: string | null
  deliverables?: unknown
  pr_url?: string | null
}

const RUN_SELECT = 'id, status, result_summary, deliverables, pr_url'

/**
 * The run a row points at, read in the row's workspace, right before the row
 * is acted on (a run read earlier can have moved since: answered, re-parked,
 * settled); null when there's none.
 */
async function loadRun(supabase: SupabaseClient, row: QuestionRow): Promise<QuestionRun | null> {
  if (!row.agent_run_id) return null
  const { data, error } = await supabase
    .from('agent_run')
    .select(RUN_SELECT)
    .eq('id', row.agent_run_id)
    .eq('workspace_id', row.workspace_id)
    .maybeSingle()
  if (error) throw new Error(`run: ${error.message}`)
  return (data as QuestionRun | null) ?? null
}

/** The row's status now (fenced on its member), or null when it can't be read. */
async function statusNow(supabase: SupabaseClient, row: QuestionRow): Promise<string | null> {
  const now = await supabase.from('tracked_job').select('status').eq('id', row.id).eq('member_id', row.member_id).maybeSingle()
  return (now.data as { status?: string } | null)?.status ?? null
}

/**
 * A run that finished (completed or pr_open) while its row still waited on a
 * question: the row becomes what the mirror's own finish would have made it
 * (agent-run-mirror.ts mirrorAgentRunStatus, fed from the run's stored result
 * and deliverables): a work run's result, or a coding run's PR, waits on your
 * review (`needs_review`, with its deliverables, its needs-you notice and not
 * opened yet), a coding run with nothing to review just ends. Should that
 * write not land, the row closes `done`, quietly, so it never stays waiting.
 */
async function finishFromRun(supabase: SupabaseClient, row: QuestionRow, run: QuestionRun, nowIso: string): Promise<WorkStatus | null> {
  const { mirrorAgentRunStatus } = await import('./agent-run-mirror')
  const summary = typeof run.result_summary === 'string' ? run.result_summary : null
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: run.id, workspaceId: row.workspace_id },
    run.status === 'pr_open'
      ? { status: 'pr_open', prUrl: run.pr_url ?? null, summary }
      : {
          status: 'completed',
          summary,
          deliverables: Array.isArray(run.deliverables) ? (run.deliverables as AgentRunDeliverable[]) : null,
        },
  )
  const status = await statusNow(supabase, row)
  if (status && status !== 'needs_input') return status as WorkStatus
  return closeRow(supabase, row, 'done', nowIso)
}

/** Close a waiting row, CAS-fenced on `needs_input` and its member, quietly; its unread notices read. The status, or null when another write got there first. */
async function closeRow(
  supabase: SupabaseClient,
  row: QuestionRow,
  to: Extract<WorkStatus, 'done' | 'failed' | 'canceled'>,
  nowIso: string,
  reason?: string,
): Promise<WorkStatus | null> {
  return writeRow(supabase, row, {
    status: to,
    needs: null,
    current_step: null,
    finished_at: nowIso,
    last_beat_at: nowIso,
    deadline_at: null,
    ...(to === 'done' ? {} : { error_message: reason ?? QUESTION_RUN_SETTLED }),
  }, nowIso)
}

async function writeRow(supabase: SupabaseClient, row: QuestionRow, patch: Record<string, unknown>, nowIso: string): Promise<WorkStatus | null> {
  const { data, error } = await supabase
    .from('tracked_job')
    .update(patch)
    .eq('id', row.id)
    .eq('member_id', row.member_id)
    .eq('status', 'needs_input')
    .select(SETTLED_SELECT)
    .maybeSingle()
  if (error) throw new Error(`close: ${error.message}`)
  if (!data) return null
  const status = patch.status as WorkStatus
  logMove(supabase, data as unknown as SettledRow, status, patch)
  await markItemNoticesRead(supabase, row, { nowIso })
  return status
}

/** The owner's log line for a move this pass won, as the recorder's own move would write it (agent-log.ts). Never throws. */
function logMove(supabase: SupabaseClient, row: SettledRow, status: WorkStatus, patch: Record<string, unknown>): void {
  const event = workLogEventFor(status, patch)
  if (!event || !row?.id || !row.workspace_id || !row.member_id) return
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
      event,
    ),
  )
}

/**
 * Move one waiting row to what its run, read just now, says (see the header).
 * The new status, or null when the run still waits on the question or
 * another write got there first.
 */
async function applyRunState(
  supabase: SupabaseClient,
  row: QuestionRow,
  run: QuestionRun | null,
  nowIso: string,
): Promise<WorkStatus | null> {
  const state = questionRunState(run)
  switch (state.state) {
    case 'waiting':
      return null
    case 'moved':
      return writeRow(supabase, row, {
        status: 'running',
        needs: null,
        current_step: 'Picking the work back up',
        last_beat_at: nowIso,
        deadline_at: new Date(Date.parse(nowIso) + DEFAULT_WORK_DEADLINES.running).toISOString(),
      }, nowIso)
    case 'gone':
      return closeRow(supabase, row, 'canceled', nowIso, QUESTION_RUN_GONE)
    case 'settled':
      if (state.to === 'done' && run) return finishFromRun(supabase, row, run, nowIso)
      return closeRow(supabase, row, state.to, nowIso)
  }
}

export type StopWaitingOutcome =
  /** It no longer waits on an answer: `status` is what it is now (a finished run's review waits on you as `needs_review`). */
  | { outcome: 'stopped'; status: WorkStatus }
  /** Its run is still parked on the question: answer it, or stop the run. */
  | { outcome: 'live' }
  /** It wasn't waiting on an answer (`status`), or another write settled it first. */
  | { outcome: 'not_waiting'; status: string }

/**
 * "Stop waiting" on one row (see the header): for a question whose run is
 * gone or no longer waiting. The caller has already proven the row is the
 * person's own; `supabase` is the client that writes (the service client, or
 * the tool routes').
 */
export async function stopWaitingOnQuestion(
  supabase: SupabaseClient,
  row: QuestionRow & { status: string },
  opts: { nowIso?: string } = {},
): Promise<StopWaitingOutcome> {
  if (row.status !== 'needs_input') return { outcome: 'not_waiting', status: row.status }
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const run = await loadRun(supabase, row)
  if (questionRunState(run).state === 'waiting') return { outcome: 'live' }
  const status = await applyRunState(supabase, row, run, nowIso)
  if (status) return { outcome: 'stopped', status }
  return { outcome: 'not_waiting', status: (await statusNow(supabase, row)) ?? 'unknown' }
}

export interface QuestionReconcileOutcome {
  /** Rows whose run was gone or had moved on, put right. */
  reconciled: number
  /** Live questions past WORK_INPUT_TTL_DAYS, given up (run and row canceled). */
  expired: number
}

type Scanned = QuestionRow & { last_beat_at: string }

const SCAN_SELECT = 'id, member_id, workspace_id, agent_run_id, last_beat_at'

/**
 * The waiting rows past the grace, oldest first: those with no run at all
 * first (one page: each is put right this tick), then those with a run, a
 * page at a time by a (`last_beat_at`, `id`) cursor, so pages of live
 * questions don't hide the rows behind them and rows sharing a beat (a
 * reaper tick stamps every row it moves with one time) are never skipped at
 * a page's edge; at most QUESTION_RECONCILE_PAGES pages. The park stamps
 * `last_beat_at` and a parked run doesn't beat, so it is when the row started
 * waiting.
 */
async function* scanWaiting(supabase: SupabaseClient, graceIso: string): AsyncGenerator<Scanned[]> {
  const base = () =>
    supabase.from('tracked_job').select(SCAN_SELECT).eq('status', 'needs_input').in('kind', [...QUESTION_KINDS]).lt('last_beat_at', graceIso)
  const read = async (q: ReturnType<typeof base>, limit: number): Promise<Scanned[]> => {
    const { data, error } = await q.order('last_beat_at', { ascending: true }).order('id', { ascending: true }).limit(limit)
    if (error) throw new Error(`scan: ${error.message}`)
    return (data ?? []) as Scanned[]
  }
  const orphans = await read(base().is('agent_run_id', null), QUESTION_RECONCILE_BATCH)
  if (orphans.length) yield orphans
  let after: { beat: string; id: string } | null = null
  for (let page = 0; page < QUESTION_RECONCILE_PAGES; page++) {
    const withRun = () => base().not('agent_run_id', 'is', null)
    let rows: Scanned[]
    if (!after) {
      rows = await read(withRun(), QUESTION_RECONCILE_BATCH)
    } else {
      // Past (beat, id): the rest of the cursor's beat by id, then the later beats.
      const tied = await read(withRun().eq('last_beat_at', after.beat).gt('id', after.id), QUESTION_RECONCILE_BATCH)
      const later = tied.length < QUESTION_RECONCILE_BATCH ? await read(withRun().gt('last_beat_at', after.beat), QUESTION_RECONCILE_BATCH - tied.length) : []
      rows = [...tied, ...later]
    }
    if (rows.length === 0) return
    yield rows
    if (rows.length < QUESTION_RECONCILE_BATCH) return
    const last = rows[rows.length - 1]
    after = { beat: last.last_beat_at, id: last.id }
  }
}

/** The reaper's pass over waiting rows (see the header). Never throws. */
export async function reconcileStaleQuestions(
  supabase: SupabaseClient,
  opts: { nowIso?: string; ttlDays?: number; graceMs?: number } = {},
): Promise<QuestionReconcileOutcome> {
  const out: QuestionReconcileOutcome = { reconciled: 0, expired: 0 }
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const now = Date.parse(nowIso)
  const graceIso = new Date(now - (opts.graceMs ?? QUESTION_RECONCILE_GRACE_MS)).toISOString()
  const ttlCutoff = now - (opts.ttlDays ?? WORK_INPUT_TTL_DAYS) * 24 * 60 * 60 * 1000
  try {
    for await (const rows of scanWaiting(supabase, graceIso)) {
      for (const row of rows) {
        try {
          // Read right before acting: an answer, a re-park or a settle since the scan wins.
          const run = await loadRun(supabase, row)
          if (questionRunState(run).state !== 'waiting') {
            if (await applyRunState(supabase, row, run, nowIso)) out.reconciled += 1
            continue
          }
          // A live question: left alone until the TTL.
          if (Date.parse(row.last_beat_at) >= ttlCutoff || !row.agent_run_id) continue
          if (await giveUpQuestion(supabase, row, row.agent_run_id, nowIso)) out.expired += 1
        } catch (err) {
          console.error('[work] question reconcile failed for a row:', err instanceof Error ? err.message : err)
        }
      }
    }
  } catch (err) {
    console.error('[work] question reconcile failed:', err instanceof Error ? err.message : err)
  }
  return out
}

/**
 * Give up a live question past the TTL: cancel its RUN first, the way Stop
 * does (a CAS from `needs_input` to `canceling`, then `agent/run.cancel`,
 * which settles the run and frees its session), and cancel the row only if
 * that CAS won. If it lost, the person answered (or the run moved) in the
 * meantime: the row is left, and the next tick reads it as it is then.
 */
async function giveUpQuestion(supabase: SupabaseClient, row: QuestionRow, runId: string, nowIso: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('agent_run')
    .update({ status: 'canceling' })
    .eq('id', runId)
    .eq('workspace_id', row.workspace_id)
    .eq('status', 'needs_input')
    .select('id')
  if (error) throw new Error(`run cancel: ${error.message}`)
  if (!data || (Array.isArray(data) && data.length === 0)) return false
  const closed = await closeRow(supabase, row, 'canceled', nowIso, QUESTION_TTL_REASON)
  try {
    const { inngest } = await import('@/lib/inngest/client')
    await inngest.send({ name: 'agent/run.cancel', data: { agent_run_id: runId, workspace_id: row.workspace_id, reason: QUESTION_TTL_REASON } })
  } catch (err) {
    console.error('[work] canceling an unanswered run failed:', err instanceof Error ? err.message : err)
  }
  return closed !== null
}
