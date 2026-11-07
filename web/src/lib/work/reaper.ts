/**
 * The reaper (ACTIVITY-AND-REVIEW-DESIGN §3.5): a live row that stopped
 * reporting is failed with "no report back" — NORTH-STAR invariant 4, "a
 * dispatch that never reports back times out into failed". Rides the
 * flow-schedule cron tick.
 *
 * One guard: a row mirroring an agent_run whose execution row is itself still
 * live is EXTENDED, not failed — the run is alive and its own settle watcher
 * owns its terminal state; the ledger just lost beats. The extension is one
 * deadline window per tick, so a run that really is dead still fails once its
 * execution row settles or stops being live.
 *
 * A row it fails gets the owner's "Failed" log line (agent-log.ts), as a
 * recorder failure does (a row it re-parks on a question gets "Waiting on
 * you", and a review it expires "Expired unreviewed"), and sends the failure
 * notice a recorder failure does (notify.ts notifyWorkFailed, for every
 * kind): unless the row is quiet
 * (`source.quiet`), at most one per (workspace, kind, teammate) per day, as
 * the owner's `work_failed` setting allows, with the bot keys, so it lands in
 * its bot's Notices and lights its dot; a row with no teammate comes from its
 * workspace's Assistant (but a sequence send). Only for a fail this tick won.
 * A safety net, not a stream (PROD: about one reaped row a day): at most
 * REAPER_NOTICES_PER_MEMBER notices per member per tick; past that the rows
 * still fail, and show as failed on their bot's page, without a notice.
 *
 * It also puts right the questions nobody can answer any more
 * (stale-questions.ts reconcileStaleQuestions): a needs_input row whose run is
 * gone or no longer waiting takes what its run says, quietly, and a live
 * question unanswered for WORK_INPUT_TTL_DAYS is given up, its run canceled.
 * Otherwise such a row would hold its bot on screen for good (a bot stays out
 * until everything it brought is settled: bots-v4 decision 23). And a running
 * row past its deadline whose run is parked on a question of its own goes
 * back to waiting on it rather than being extended forever (counted with
 * `questionsReconciled`).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isAgentRunLive, isDelegationPark } from '@/lib/agent-run/types'
import { deferLogWrite, logWorkEvent, workLogFacts, type WorkLogEvent } from '@/lib/log/agent-log'
import { notifyWorkFailed } from './notify'
import { SETTLED_SELECT, logWorkSettle, type SettledRow } from './resolve'
import { reconcileStaleQuestions } from './stale-questions'
import { DEFAULT_WORK_DEADLINES, WORK_REVIEW_TTL_DAYS, type WorkDeadlines, type WorkProgress, type WorkSource } from './types'

export const REAPER_BATCH = 200
/** Failure notices one tick sends one member, at most (see the header). */
export const REAPER_NOTICES_PER_MEMBER = 3
export const NO_REPORT_BACK = 'No report back — the run stopped reporting and was marked failed'

interface StaleRow {
  id: string
  kind: string
  status: 'queued' | 'running'
  agent_run_id: string | null
  workspace_id: string
  member_id: string
  title: string
  source: WorkSource | null
  ai_team_member_id: string | null
  /** Its area (migration 318), carried to the failure notice. */
  area?: string | null
  /** Read for the log filter (agent-log.ts workLogFacts). */
  parent_id?: string | null
  depth?: number | null
}

/** The owner's log line for a move the reaper won (agent-log.ts); never throws. */
function logReaped(supabase: SupabaseClient, row: StaleRow, event: WorkLogEvent): void {
  deferLogWrite(
    logWorkEvent(
      supabase,
      {
        workItemId: row.id,
        workspaceId: row.workspace_id,
        memberId: row.member_id,
        title: row.title,
        area: row.area ?? null,
        ...workLogFacts(row),
      },
      event,
    ),
  )
}

export interface ReapOutcome {
  failed: number
  extended: number
  /** needs_review rows older than the review TTL, closed as expired. */
  expired: number
  /** needs_input rows whose run was gone or had moved on, put right (stale-questions.ts). */
  questionsReconciled: number
  /** Live questions unanswered past WORK_INPUT_TTL_DAYS, given up with their runs. */
  questionsExpired: number
}

export async function reapStaleWork(
  supabase: SupabaseClient,
  opts: { nowIso?: string; deadlines?: Partial<WorkDeadlines>; reviewTtlDays?: number; inputTtlDays?: number } = {},
): Promise<ReapOutcome> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const deadlines: WorkDeadlines = { ...DEFAULT_WORK_DEADLINES, ...opts.deadlines }
  const out: ReapOutcome = { failed: 0, extended: 0, expired: 0, questionsReconciled: 0, questionsExpired: 0 }
  out.expired = await expireStaleReviews(supabase, nowIso, opts.reviewTtlDays ?? WORK_REVIEW_TTL_DAYS)
  const questions = await reconcileStaleQuestions(supabase, { nowIso, ...(opts.inputTtlDays !== undefined ? { ttlDays: opts.inputTtlDays } : {}) })
  out.questionsReconciled = questions.reconciled
  out.questionsExpired = questions.expired

  const { data, error } = await supabase
    .from('tracked_job')
    .select('id, kind, status, agent_run_id, workspace_id, member_id, title, source, ai_team_member_id, area, parent_id, depth')
    .in('status', ['queued', 'running'])
    .lt('deadline_at', nowIso)
    .order('deadline_at', { ascending: true })
    .limit(REAPER_BATCH)
  if (error) {
    console.error('[work] reaper scan failed:', error.message)
    return out
  }
  const rows = (data ?? []) as StaleRow[]
  if (rows.length === 0) return out

  // One read for every linked execution row, not one per stale row.
  const agentRunIds = [...new Set(rows.map((r) => r.agent_run_id).filter((x): x is string => !!x))]
  const liveAgentRuns = new Set<string>()
  // Runs parked on a question of their own (not a delegation park), with what they ask.
  const askingRuns = new Map<string, unknown[]>()
  if (agentRunIds.length > 0) {
    const { data: runs } = await supabase.from('agent_run').select('id, status, pending_input').in('id', agentRunIds)
    for (const run of (runs ?? []) as Array<{ id: string; status: string; pending_input?: unknown }>) {
      if (isAgentRunLive(run.status)) liveAgentRuns.add(run.id)
      if (run.status === 'needs_input' && !isDelegationPark(run.pending_input)) {
        const questions = (run.pending_input as { questions?: unknown } | null)?.questions
        askingRuns.set(run.id, Array.isArray(questions) ? questions : [])
      }
    }
  }

  const now = Date.parse(nowIso)
  // Notices sent this tick, per member (REAPER_NOTICES_PER_MEMBER).
  const noticed = new Map<string, number>()
  for (const row of rows) {
    // A running row whose run is parked on a question (it re-parked and the
    // ledger missed it, or a reconcile read the run just before it did): back
    // to waiting on that question, not extended forever with its loader on.
    // Quiet, but new again (`opened_at` cleared): it is a question you
    // haven't seen.
    // The batch read only says it may be so: the run is read again right
    // before the re-park, so a question answered since is never re-asked.
    const asks =
      row.status === 'running' && row.agent_run_id && askingRuns.has(row.agent_run_id)
        ? await askingNow(supabase, row.agent_run_id, liveAgentRuns)
        : undefined
    if (asks) {
      const { data: reparked } = await supabase
        .from('tracked_job')
        .update({
          status: 'needs_input',
          needs: { kind: 'input', questions: asks },
          current_step: 'Waiting on your answer',
          last_beat_at: nowIso,
          deadline_at: null,
          opened_at: null,
        })
        .eq('id', row.id)
        .eq('status', 'running')
        .select('id')
        .maybeSingle()
      if (reparked) {
        out.questionsReconciled += 1
        logReaped(supabase, row, { type: 'work_needs_input', at: nowIso })
      }
      continue
    }
    if (row.agent_run_id && liveAgentRuns.has(row.agent_run_id)) {
      const window = row.status === 'queued' ? deadlines.queued : deadlines.running
      const { data: extended } = await supabase
        .from('tracked_job')
        .update({ last_beat_at: nowIso, deadline_at: new Date(now + window).toISOString() })
        .eq('id', row.id)
        .in('status', ['queued', 'running'])
        .select('id')
        .maybeSingle()
      if (extended) out.extended += 1
      continue
    }
    const { data: failed } = await supabase
      .from('tracked_job')
      .update({
        status: 'failed',
        error_message: NO_REPORT_BACK,
        current_step: null,
        finished_at: nowIso,
        last_beat_at: nowIso,
        deadline_at: null,
      })
      .eq('id', row.id)
      .in('status', ['queued', 'running'])
      .select('id')
      .maybeSingle()
    if (!failed) continue
    out.failed += 1
    // The owner's log line, as a recorder failure writes (agent-log.ts); never throws.
    logReaped(supabase, row, { type: 'work_failed', at: nowIso })
    // The notice a recorder failure sends (see the header); best-effort, never throws.
    const sentToMember = noticed.get(row.member_id) ?? 0
    if (row.source?.quiet !== true && sentToMember < REAPER_NOTICES_PER_MEMBER) {
      const sent = await notifyWorkFailed(
        supabase,
        {
          id: row.id,
          workspace_id: row.workspace_id,
          member_id: row.member_id,
          kind: row.kind,
          title: row.title,
          needs: null,
          deliverables: [],
          result_summary: null,
          error_message: NO_REPORT_BACK,
          ai_team_member_id: row.ai_team_member_id ?? null,
          area: row.area ?? null,
        },
        { nowIso },
      )
      if (sent) noticed.set(row.member_id, sentToMember + 1)
    }
  }
  return out
}

/**
 * What a run parked on a question of its own asks, read now; undefined when it
 * isn't (answered, moved on, a delegation park, or the read failed). Keeps
 * `live` true to the fresh read, so the row then extends or fails on it.
 */
async function askingNow(supabase: SupabaseClient, runId: string, live: Set<string>): Promise<unknown[] | undefined> {
  const { data, error } = await supabase.from('agent_run').select('id, status, pending_input').eq('id', runId).maybeSingle()
  if (error || !data) return undefined
  const run = data as { status: string; pending_input?: unknown }
  if (isAgentRunLive(run.status)) live.add(runId)
  else live.delete(runId)
  if (run.status !== 'needs_input' || isDelegationPark(run.pending_input)) return undefined
  const questions = (run.pending_input as { questions?: unknown } | null)?.questions
  return Array.isArray(questions) ? questions : []
}

/**
 * A needs_review item nobody acted on for the review TTL closes as done,
 * flagged `expired` on its progress (design §9.2) — "Needs you" cannot grow
 * without bound, and the Recent list still says what happened. Quiet: no
 * notification for an expiry, only the owner's "Expired unreviewed" log line.
 */
async function expireStaleReviews(supabase: SupabaseClient, nowIso: string, ttlDays: number): Promise<number> {
  const cutoff = new Date(Date.parse(nowIso) - ttlDays * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('tracked_job')
    .select(`${SETTLED_SELECT}, progress`)
    .eq('status', 'needs_review')
    .lt('finished_at', cutoff)
    .order('finished_at', { ascending: true })
    .limit(REAPER_BATCH)
  if (error) {
    console.error('[work] review expiry scan failed:', error.message)
    return 0
  }
  let expired = 0
  for (const row of (data ?? []) as unknown as Array<SettledRow & { progress: WorkProgress | null }>) {
    const progress: WorkProgress = { ...(row.progress ?? {}), review: 'expired' }
    const { data: closed } = await supabase
      .from('tracked_job')
      .update({ status: 'done', needs: null, reviewed_at: nowIso, last_beat_at: nowIso, progress })
      .eq('id', row.id)
      .eq('status', 'needs_review')
      .select('id')
      .maybeSingle()
    if (!closed) continue
    expired += 1
    logWorkSettle(supabase, row, 'expired', nowIso)
  }
  return expired
}
