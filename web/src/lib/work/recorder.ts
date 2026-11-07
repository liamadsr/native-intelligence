/**
 * The work recorder — the ONLY way the ledger is written
 * (ACTIVITY-AND-REVIEW-DESIGN §3.2).
 *
 *   const work = await startWork(supabase, { workspaceId, memberId, kind, title, … })
 *   await work.step('Reading the thread from Dana')
 *   await work.needInput(questions)
 *   await work.finish({ summary, deliverables, review: { kind: 'review', verb: 'review' } })
 *   await work.fail('Model timed out') / work.skip('Workspace dormant') / work.cancel()
 *
 * Rules the helper enforces so producers cannot get them wrong:
 *   • IDEMPOTENT START — `startWork` with a `runKey` returns the existing row's
 *     handle on an Inngest retry (unique (kind, run_key)); never a duplicate.
 *   • CAS TRANSITIONS — every write is fenced on the statuses it may leave; a
 *     terminal row is never overwritten, a parked row only resumes through
 *     `resume()`.
 *   • STEP COALESCING — `step()` writes at most once per 2s per item and trails
 *     the latest text, so a burst of tool calls costs one UPDATE. `finish` /
 *     `fail` flush first, so no step is lost at the end.
 *   • NAMES, NEVER INPUTS — the step line is a phrase (step-phrases.ts) built
 *     from tool names; the recorder never sees tool arguments.
 *   • NEVER THROWS — a lost beat is a UI gap, not a failed run. Every method
 *     logs and returns; an insert that fails yields an INERT handle whose
 *     methods no-op, so producers need no null checks.
 *   • NOTIFICATIONS ARE A SIDE EFFECT OF STATUS — a won transition into
 *     needs_input / needs_review sends `work_needs_you`, into failed a grouped
 *     `work_failed` (notify.ts), both targeting the item. Producers never call
 *     createNotification for work themselves. `quiet` (per item, or per
 *     finish) is the explicit opt-out a flow's deliver.notification=false
 *     maps to. Routine done is silent. A chat helper's RESULT (ready for
 *     review) that went to the owner's HOME thread sends no push either: the
 *     home turn tells the person, or stays quiet (one telling, not three). Its
 *     question or failure still pushes.
 *     The inbox event records whether the notice REALLY went out (a failure
 *     folded into the day's grouped notice did not).
 *   • WAITING ON YOU AGAIN RE-ARMS "OPENED" — a won move into needs_input
 *     (`needInput`) or needs_review (`finish` with a review) is followed by a
 *     separate, best-effort write clearing `opened_at` (migration 295: opened
 *     since it last started waiting on you), so a row the owner opened while
 *     it asked a question calls for them again when it comes back with a
 *     draft. Neither CAS set holds its own target status, so every such move
 *     is a real one, needs_input → needs_review included (a new ask); a
 *     needs_review row is never re-entered here, and no other write touches
 *     the column. The status write never names the column: the ledger's moves
 *     do not depend on the bots' column, and a failed re-arm (a database
 *     without migration 295) is skipped with one log line, the move and its
 *     push untouched.
 *   • A CHAT-REQUESTED ROW REPORTS BACK HOME — a won move of a row with
 *     origin 'chat' and a `source.chat_conversation_id` (main chat's
 *     `start_helper`) into needs_review, needs_input, failed or canceled
 *     appends one message in its teammate's name to the owner's home thread,
 *     wherever it was asked (chat-report.ts; bots v2 phase 7). Like the push, only for a transition
 *     that happened here; unlike it, `quiet` does not silence it (it is the
 *     answer to the person's own request, not a nudge).
 *   • EVERY MOVE THAT MATTERS IS A LOG LINE — a new row (started, or its
 *     outcome for a one-shot row) and a won move into needs_input,
 *     needs_review, done, failed or canceled write one templated line to the
 *     owner's agent log (src/lib/log/agent-log.ts, migration 329), in the
 *     row's own workspace. After the write commits, off the caller's path
 *     (deferLogWrite), never throwing; a lost CAS logs nothing, and the
 *     dedupe key makes a retried start a no-op. Not for a quiet row, a
 *     delegated child or a housekeeping kind (agent-log.ts workEventLogged).
 *   • AND AN EVENT IN THE AGENT'S INBOX — beside that line, a move into
 *     needs_input, needs_review, done or failed writes one agent_event for the
 *     owner (src/lib/agent-events/work.ts, migration 336; A6), with the same
 *     filter, saying whether this move's notice went out, so the router
 *     records that notice instead of sending another. Off the caller's path,
 *     never throwing.
 *
 * Service-role only: the table has no client write policy (migration 170).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordDeliveredTouches } from './touch'
import { notifyWorkFailed, notifyWorkNeedsYou } from './notify'
import { deliverWorkReport, type WorkReportOutcome } from './chat-report'
import { recordPrepReadyForRun } from '@/lib/agent-events/meeting-soon'
import { isTeammateReportStatus, type TeammateReportStatus } from '@/lib/chat/teammate-report'
import { isAreaKey, type AreaKey } from '@/lib/packs/registry'
import { workArea } from './work-area'
import { deferLogWrite, logWorkEvent, memberUserId, workEventLogged, workLogEventFor, workLogFacts, type WorkLogEvent } from '@/lib/log/agent-log'
import { recordAgentEvents } from '@/lib/agent-events/record'
import { workAgentEvent } from '@/lib/agent-events/work'
import {
  DEFAULT_WORK_DEADLINES,
  WORK_STEP_LOG_CAP,
  isWorkTerminal,
  type WorkActor,
  type WorkDeadlines,
  type WorkDeliverable,
  type WorkItem,
  type WorkNeeds,
  type WorkProgress,
  type WorkSource,
  type WorkStatus,
  type WorkStep,
} from './types'

/** Two writes closer than this coalesce into one trailing write. */
export const STEP_COALESCE_MS = 2000

/** A keep-alive within this window of the row's last write is skipped — a log
 *  pump posting every stdout chunk must not cost an UPDATE per chunk. Well
 *  inside the shortest reaper window (20 min running). */
export const BEAT_COALESCE_MS = 10_000

/** Postgres unique-violation — the idempotent-start signal. */
const UNIQUE_VIOLATION = '23505'

const OPEN_FOR_STEP: WorkStatus[] = ['queued', 'running']
const OPEN_FOR_FINISH: WorkStatus[] = ['queued', 'running', 'needs_input', 'waiting_on_child']
const OPEN_FOR_FAIL: WorkStatus[] = ['queued', 'running', 'needs_input', 'waiting_on_child', 'needs_review']

export interface StartWorkInput {
  workspaceId: string
  /** The owner — whose Activity feed the row appears in. */
  memberId: string
  kind: string
  title: string
  actor?: WorkActor
  source?: WorkSource
  /** Idempotency key (an Inngest event id, an agent_run id). */
  runKey?: string | null
  /** Defaults to 'queued'. 'running' for work that executes right away; a
   *  terminal status records a one-shot row in a single write (a cron sweep). */
  status?: WorkStatus
  progress?: WorkProgress
  resultSummary?: string | null
  skipReason?: string | null
  errorMessage?: string | null
  deliverables?: WorkDeliverable[]
  agentRunId?: string | null
  flowRunId?: string | null
  deadlines?: Partial<WorkDeadlines>
  /** Never notify for this item (a flow whose deliver.notification is off). */
  quiet?: boolean
  /** Where the work came from (migration 280). Absent → the column default,
   *  'user'. The auto-attempt gate writes 'attempt'. */
  origin?: 'user' | 'loop' | 'attempt' | 'delegation' | 'chat'
  /** The teammate doing the work (migration 280), when one is known. */
  aiTeamMemberId?: string | null
  /**
   * The area the work belongs to (migration 318, work-area.ts): the writer's
   * when it knows it (a loop's skills), else its kind's (KIND_AREAS), else
   * none. Its face is picked from it, and its notices carry it.
   */
  area?: AreaKey | null
  /** The delegation tree (migration 280): the item that handed this work
   *  over, the tree's root item, and how deep this one sits (root 0). */
  parentId?: string | null
  rootId?: string | null
  depth?: number
}

export interface FinishWorkArgs {
  summary?: string | null
  deliverables?: WorkDeliverable[]
  /** Set when a deliverable waits on the user: the row lands in Needs you as
   *  `needs_review` instead of `done`. */
  review?: Extract<WorkNeeds, { kind: 'review' }> | null
  progress?: WorkProgress
  /** Land in Needs you without the push (an explicit producer opt-out). */
  quiet?: boolean
  /**
   * A `done` with no review still reports to the asking chat (a meeting prep:
   * delivered there with its goal box, waiting on nobody; chat-report.ts).
   * Without it a `done` reports nothing, as ever.
   */
  reportDone?: boolean
}

export interface WorkHandle {
  /** The row id, or null for an inert handle. */
  readonly id: string | null
  readonly kind: string
  readonly workspaceId: string
  readonly memberId: string
  /** The teammate doing the work (`ai_team_member_id`), or null: what a
   *  producer stamps on the cards and notices the run leaves (bots v3 1a). */
  readonly aiTeamMemberId: string | null
  /** The area the work belongs to (`tracked_job.area`, migration 318), or null. */
  readonly area: AreaKey | null
  readonly inert: boolean
  /** Live one-liner (+ optional per-kind counters). Flips queued → running. */
  step(text: string, progress?: WorkProgress): Promise<void>
  /** Keep-alive without a new step (a heartbeat route). */
  beat(): Promise<void>
  /** Back-links learned after start (the flow_run id, the agent_run id). */
  link(refs: { agentRunId?: string | null; flowRunId?: string | null; source?: WorkSource }): Promise<void>
  /** Silence this item's pushes (a flow whose deliver.notification is off).
   *  Persisted on the row so a later handle over it stays silent too. */
  mute(): Promise<void>
  /** Park on a question: → needs_input, then not opened yet (`opened_at` cleared, best-effort). */
  needInput(questions: unknown[]): Promise<void>
  /** Park on the teammates this work was handed to: → waiting_on_child. */
  waitOnChild(args: { workItemId: string | null; role: string; label: string; count: number }): Promise<void>
  /** Un-park: needs_input / waiting_on_child → running. */
  resume(): Promise<void>
  /** Settle: → done, or → needs_review when `review` is set (then not opened yet: `opened_at` cleared, best-effort). */
  finish(args?: FinishWorkArgs): Promise<void>
  fail(message: string, args?: { summary?: string | null }): Promise<void>
  skip(reason: string): Promise<void>
  cancel(reason?: string | null): Promise<void>
  /** Write any coalesced step now. */
  flush(): Promise<void>
}

function nowIso(): string {
  return new Date().toISOString()
}

function deadlineFor(status: WorkStatus, deadlines: WorkDeadlines, from = Date.now()): string | null {
  if (status === 'queued') return new Date(from + deadlines.queued).toISOString()
  if (status === 'running') return new Date(from + deadlines.running).toISOString()
  return null
}

function logError(op: string, err: unknown) {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
  console.error(`[work] ${op} failed:`, message)
}

/** A handle whose every method no-ops — returned when the row could not be
 *  written (or a producer has no owner to record for), so a ledger failure
 *  never fails the work it records. */
export function inertWork(input: { kind: string; workspaceId: string; memberId: string }): WorkHandle {
  return inertHandle(input)
}

function inertHandle(input: { kind: string; workspaceId: string; memberId: string }): WorkHandle {
  const noop = async () => {}
  return {
    id: null,
    kind: input.kind,
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    aiTeamMemberId: null,
    area: null,
    inert: true,
    step: noop,
    beat: noop,
    link: noop,
    mute: noop,
    needInput: noop,
    waitOnChild: noop,
    resume: noop,
    finish: noop,
    fail: noop,
    skip: noop,
    cancel: noop,
    flush: noop,
  }
}

class Recorder implements WorkHandle {
  readonly inert = false
  readonly id: string
  readonly kind: string
  readonly workspaceId: string
  readonly memberId: string
  /** The run this item mirrors, if any — stamped on its touches. */
  private readonly agentRunId: string | null
  /** The chat that asked for this work (origin 'chat'), which hears its settles. */
  private readonly chatConversationId: string | null
  /** The row's back-references, for a kind-specific report (a local agent's session and folder). */
  private readonly source: WorkSource | null
  /** The teammate doing it, named in the chat's report and on its notices. */
  readonly aiTeamMemberId: string | null
  /** Its area, on its notices (bot-notice.ts `area`). */
  readonly area: AreaKey | null

  private status: WorkStatus
  private startedAt: string | null
  private progress: WorkProgress
  private steps: WorkStep[]
  private readonly title: string
  private quiet: boolean
  private readonly deadlines: WorkDeadlines
  /** Last write by THIS handle — the step-coalescing clock (0 on attach so a
   *  re-attached handle's first step always writes at once). */
  private lastWriteAt = 0
  /** The row's last beat as far as this handle knows — seeded from the row on
   *  attach so a fresh process (one request per beat) still throttles. */
  private lastBeatAt: number
  private pendingStep: { text: string; progress?: WorkProgress } | null = null
  /** The owner member's user, read once for the log (null reads are retried). */
  private ownerUser: Promise<string | null> | null = null
  /** A delegated child (parent_id or depth > 0): the log leaves its moves out. */
  private readonly child: boolean
  /** The routine a flow run fired from (its flow id), for the inbox's daily collapse. */
  private readonly flowId: string | null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> = Promise.resolve()

  constructor(
    private readonly supabase: SupabaseClient,
    row: WorkItem,
    deadlines: WorkDeadlines,
    opts: { quiet?: boolean } = {},
  ) {
    this.id = row.id
    this.kind = row.kind
    this.workspaceId = row.workspace_id
    this.memberId = row.member_id
    this.agentRunId = row.agent_run_id ?? null
    const chat = row.source?.chat_conversation_id
    this.chatConversationId = row.origin === 'chat' && typeof chat === 'string' && chat ? chat : null
    this.source = row.source ?? null
    this.aiTeamMemberId = row.ai_team_member_id ?? null
    this.area = isAreaKey(row.area) ? row.area : null
    this.status = row.status
    this.startedAt = row.started_at
    this.title = row.title
    this.quiet = opts.quiet ?? row.source?.quiet === true
    this.child = workLogFacts(row).child
    const flowId = (row.source as { flow_id?: unknown } | null | undefined)?.flow_id
    this.flowId = typeof flowId === 'string' && flowId ? flowId : null
    this.progress = { ...(row.progress ?? {}) }
    this.steps = Array.isArray(row.progress?.steps) ? [...row.progress.steps] : []
    delete this.progress.steps
    this.deadlines = deadlines
    const beat = row.last_beat_at ? Date.parse(row.last_beat_at) : NaN
    this.lastBeatAt = Number.isFinite(beat) ? beat : 0
  }

  /** Serialize writes per handle so a trailing flush never races a settle. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.inflight.then(op, op)
    this.inflight = next.catch(() => {})
    return next
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async step(text: string, progress?: WorkProgress): Promise<void> {
    if (isWorkTerminal(this.status)) return
    this.pendingStep = { text, progress }
    const since = Date.now() - this.lastWriteAt
    if (since >= STEP_COALESCE_MS) {
      this.clearTimer()
      await this.flush()
      return
    }
    if (!this.timer) {
      const wait = STEP_COALESCE_MS - since
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, wait)
      // Never keep a process alive just to write a step line.
      const t = this.timer as unknown as { unref?: () => void }
      t.unref?.()
    }
  }

  async flush(): Promise<void> {
    const pending = this.pendingStep
    if (!pending) return
    this.pendingStep = null
    this.clearTimer()
    const at = nowIso()
    this.steps.push({ at, text: pending.text })
    if (this.steps.length > WORK_STEP_LOG_CAP) this.steps = this.steps.slice(-WORK_STEP_LOG_CAP)
    if (pending.progress) this.progress = { ...this.progress, ...pending.progress }
    const patch: Record<string, unknown> = {
      current_step: pending.text,
      progress: { ...this.progress, steps: this.steps },
      status: 'running',
      last_beat_at: at,
      deadline_at: deadlineFor('running', this.deadlines),
    }
    if (!this.startedAt) {
      this.startedAt = at
      patch.started_at = at
    }
    await this.enqueue(async () => {
      try {
        // supabase-js returns a rejected write as `error`, it does not throw.
        const { data, error } = await this.supabase
          .from('tracked_job')
          .update(patch)
          .eq('id', this.id)
          .in('status', OPEN_FOR_STEP)
          .select('id')
          .maybeSingle()
        if (error) return logError('step', error)
        this.lastWriteAt = this.lastBeatAt = Date.now()
        if (data && this.status === 'queued') this.status = 'running'
      } catch (err) {
        logError('step', err)
      }
    })
  }

  async beat(): Promise<void> {
    if (isWorkTerminal(this.status)) return
    if (Date.now() - this.lastBeatAt < BEAT_COALESCE_MS) return
    const at = nowIso()
    await this.enqueue(async () => {
      try {
        const { error } = await this.supabase
          .from('tracked_job')
          .update({ last_beat_at: at, deadline_at: deadlineFor(this.status, this.deadlines) })
          .eq('id', this.id)
          .in('status', OPEN_FOR_STEP)
        if (error) return logError('beat', error)
        this.lastWriteAt = this.lastBeatAt = Date.now()
      } catch (err) {
        logError('beat', err)
      }
    })
  }

  async link(refs: { agentRunId?: string | null; flowRunId?: string | null; source?: WorkSource }): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (refs.agentRunId !== undefined) patch.agent_run_id = refs.agentRunId
    if (refs.flowRunId !== undefined) patch.flow_run_id = refs.flowRunId
    if (Object.keys(patch).length === 0 && !refs.source) return
    await this.enqueue(async () => {
      try {
        if (refs.source) {
          // Merge, never replace: a producer adding one ref must not drop another's.
          const { data: current } = await this.supabase
            .from('tracked_job')
            .select('source')
            .eq('id', this.id)
            .maybeSingle()
          patch.source = { ...((current?.source as WorkSource | null) ?? {}), ...refs.source }
        }
        const { error } = await this.supabase.from('tracked_job').update(patch).eq('id', this.id)
        if (error) logError('link', error)
      } catch (err) {
        logError('link', err)
      }
    })
  }

  async mute(): Promise<void> {
    this.quiet = true
    await this.link({ source: { quiet: true } })
  }

  async needInput(questions: unknown[]): Promise<void> {
    await this.flush()
    const at = nowIso()
    await this.transition(
      {
        status: 'needs_input',
        needs: { kind: 'input', questions },
        current_step: 'Waiting on your answer',
        last_beat_at: at,
        deadline_at: null,
        ...(this.startedAt ? {} : { started_at: at }),
      },
      OPEN_FOR_STEP,
      'needs_input',
      'needInput',
    )
  }

  async waitOnChild(args: { workItemId: string | null; role: string; label: string; count: number }): Promise<void> {
    await this.flush()
    const at = nowIso()
    const needs: WorkNeeds | null = args.workItemId
      ? { kind: 'child', work_item_id: args.workItemId, role: args.role, ...(args.count > 1 ? { count: args.count } : {}) }
      : null
    await this.transition(
      {
        status: 'waiting_on_child',
        needs,
        current_step: args.count > 1 ? `Waiting on ${args.count} teammates` : `Waiting on ${args.label}`,
        last_beat_at: at,
        // No reaper deadline: the parent waits as long as its children run, and
        // each child has its own. The parent's agent_run is not reaped while
        // parked either (the stale-run reaper never selects needs_input).
        deadline_at: null,
        ...(this.startedAt ? {} : { started_at: at }),
      },
      OPEN_FOR_STEP,
      'waiting_on_child',
      'waitOnChild',
    )
  }

  async resume(): Promise<void> {
    const at = nowIso()
    await this.transition(
      {
        status: 'running',
        needs: null,
        current_step: 'Picking the work back up',
        last_beat_at: at,
        deadline_at: deadlineFor('running', this.deadlines),
      },
      ['needs_input', 'waiting_on_child'],
      'running',
      'resume',
    )
  }

  async finish(args: FinishWorkArgs = {}): Promise<void> {
    await this.flush()
    const at = nowIso()
    if (args.progress) this.progress = { ...this.progress, ...args.progress }
    const status: WorkStatus = args.review ? 'needs_review' : 'done'
    const before = this.status
    await this.transition(
      {
        status,
        needs: args.review ?? null,
        result_summary: args.summary ?? null,
        deliverables: args.deliverables ?? [],
        progress: { ...this.progress, steps: this.steps },
        current_step: null,
        finished_at: at,
        last_beat_at: at,
        deadline_at: null,
        ...(this.startedAt ? {} : { started_at: at }),
      },
      OPEN_FOR_FINISH,
      status,
      'finish',
      { quiet: args.quiet, reportDone: args.reportDone === true && status === 'done' },
    )
    // Sequence step 2: what the item delivered, as touches — only for the
    // finish that actually happened here (a lost CAS means someone else
    // settled the row and recorded its own). Fail-soft.
    if (this.status === status && before !== status && args.deliverables?.length) {
      await recordDeliveredTouches(this.supabase, {
        workspaceId: this.workspaceId,
        workItemId: this.id,
        agentRunId: this.agentRunId,
        deliverables: args.deliverables,
      })
    }
  }

  async fail(message: string, args: { summary?: string | null } = {}): Promise<void> {
    await this.flush()
    const at = nowIso()
    await this.transition(
      {
        status: 'failed',
        error_message: message,
        ...(args.summary !== undefined ? { result_summary: args.summary } : {}),
        progress: { ...this.progress, steps: this.steps },
        current_step: null,
        needs: null,
        finished_at: at,
        last_beat_at: at,
        deadline_at: null,
      },
      OPEN_FOR_FAIL,
      'failed',
      'fail',
    )
  }

  async skip(reason: string): Promise<void> {
    await this.flush()
    const at = nowIso()
    await this.transition(
      {
        status: 'skipped',
        skip_reason: reason,
        current_step: null,
        finished_at: at,
        last_beat_at: at,
        deadline_at: null,
      },
      OPEN_FOR_STEP,
      'skipped',
      'skip',
    )
  }

  async cancel(reason?: string | null): Promise<void> {
    await this.flush()
    const at = nowIso()
    await this.transition(
      {
        status: 'canceled',
        error_message: reason ?? null,
        current_step: null,
        needs: null,
        finished_at: at,
        last_beat_at: at,
        deadline_at: null,
      },
      OPEN_FOR_FAIL,
      'canceled',
      'cancel',
    )
  }

  private async transition(
    patch: Record<string, unknown>,
    from: WorkStatus[],
    to: WorkStatus,
    op: string,
    opts: { quiet?: boolean; reportDone?: boolean } = {},
  ): Promise<void> {
    await this.enqueue(async () => {
      let won = false
      try {
        const { data, error } = await this.supabase
          .from('tracked_job')
          .update(patch)
          .eq('id', this.id)
          .in('status', from)
          .select('id')
          .maybeSingle()
        if (error) {
          logError(op, error)
          return
        }
        // Lost CAS (already settled elsewhere): keep the local status honest by
        // reading nothing — the next call's guard re-checks the row anyway.
        if (data) {
          this.status = to
          won = true
        }
        this.lastWriteAt = this.lastBeatAt = Date.now()
      } catch (err) {
        logError(op, err)
      }
      if (!won) return
      // The owner's log line, once per won move, after the write committed.
      const event = workLogEventFor(to, patch)
      if (event) this.logMove(event)
      if (to === 'needs_input' || to === 'needs_review') await this.rearmOpened(to)
      // The chat that asked hears back, once per won move (chat-report.ts),
      // in the owner's home thread. Before the push: a RESULT that went home
      // (ready for review) is told by the home turn (it may stay quiet), so
      // no push goes out too. A question or a failure keeps its push: a quiet
      // turn must never leave one unseen.
      // A `done` reports only when its producer asked (a meeting prep: FinishWorkArgs.reportDone).
      const reportable = isTeammateReportStatus(to) && (to !== 'done' || opts.reportDone === true)
      // A question asks at home even when no chat asked for the work (P13: a
      // loop's run, a Start, a coding run's pre-check): never a For you card.
      const asksHome = to === 'needs_input' && !this.quiet && !opts.quiet
      const reported = (this.chatConversationId || asksHome) && reportable ? await this.reportToChat(to, patch) : null
      const resultTold = reported?.muted === true && to === 'needs_review'
      // The push, only for a transition that actually happened here (a lost
      // CAS means someone else settled the row — and notified, if it mattered).
      const notified = !this.quiet && !opts.quiet && !resultTold ? await this.notifyFor(to, patch) : false
      // The inbox event says whether a notice REALLY went out (a failure
      // grouped into the day's notice did not), so the router never claims one.
      // A failure whose report landed in the home thread is told there (the
      // report and its home turn): the router mustn't tell it again.
      if (event) this.recordEvent(event, notified, { toldHome: reported?.muted === true && to === 'failed' })
      // A meeting prep that just became ready: its meeting's "prep is ready"
      // row, now, when the meeting is close (meeting-soon.ts).
      if ((to === 'needs_review' || to === 'done') && this.quiet && this.agentRunId) this.prepReady()
    })
  }

  /** A quiet server helper settled: when it is a meeting prep, its "prep ready" row (off the caller's path, never throwing). */
  private prepReady(): void {
    const agentRunId = this.agentRunId
    if (!agentRunId) return
    deferLogWrite(recordPrepReadyForRun(this.supabase, { workspaceId: this.workspaceId, agentRunId }).then(() => undefined))
  }

  /**
   * One line in the owner's agent log for a move this handle made, off the
   * caller's path (deferLogWrite). Never throws; a member without a user
   * logs nothing.
   */
  logMove(event: WorkLogEvent): void {
    const facts = { kind: this.kind, quiet: this.quiet, child: this.child }
    // The filter logWorkEvent applies, ahead of the member read.
    if (!workEventLogged(facts, event)) return
    deferLogWrite(
      (async () => {
        this.ownerUser ??= memberUserId(this.supabase, this.workspaceId, this.memberId)
        const userId = await this.ownerUser
        if (!userId) {
          this.ownerUser = null
          return
        }
        await logWorkEvent(
          this.supabase,
          { workItemId: this.id, workspaceId: this.workspaceId, memberId: this.memberId, userId, title: this.title, area: this.area, ...facts },
          event,
        )
      })(),
    )
  }

  /**
   * The move as an event in the owner's agent inbox (A6, agent-events/work.ts),
   * with the log's filter, off the caller's path. `notified`: this move's
   * notice went out (the router records it, never resends). Never throws.
   */
  recordEvent(event: WorkLogEvent, notified: boolean, opts: { toldHome?: boolean } = {}): void {
    const facts = { kind: this.kind, quiet: this.quiet, child: this.child }
    if (!workEventLogged(facts, event)) return
    if (event.type !== 'work_needs_input' && event.type !== 'work_needs_review' && event.type !== 'work_done' && event.type !== 'work_failed') return
    deferLogWrite(
      (async () => {
        this.ownerUser ??= memberUserId(this.supabase, this.workspaceId, this.memberId)
        const userId = await this.ownerUser
        if (!userId) {
          this.ownerUser = null
          return
        }
        // A finish collapses per local day: the owner's zone (member.time_zone), else UTC.
        let timeZone: string | null = null
        if (event.type === 'work_done') {
          try {
            const { data } = await this.supabase.from('member').select('time_zone').eq('id', this.memberId).eq('workspace_id', this.workspaceId).maybeSingle()
            const zone = (data as { time_zone?: unknown } | null)?.time_zone
            timeZone = typeof zone === 'string' ? zone : null
          } catch {
            timeZone = null
          }
        }
        const input = workAgentEvent(
          { workItemId: this.id, workspaceId: this.workspaceId, userId, title: this.title, area: this.area, kind: this.kind, flowId: this.flowId },
          event,
          { notified, timeZone, toldHome: opts.toldHome === true },
        )
        if (input) await recordAgentEvents([input], this.supabase)
      })(),
    )
  }

  /**
   * The row just started waiting on its owner: it is not opened since
   * (migration 295), so its teammate's bot may call again. A write of its own
   * after the move, fenced on the status just written (a later move or settle
   * wins) and on a stamp being there (a row never opened is left as it is,
   * with no realtime UPDATE).
   * Best-effort: an error (a database without the column) is logged and
   * skipped, never thrown, and never changes the move or its push.
   */
  private async rearmOpened(status: 'needs_input' | 'needs_review'): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('tracked_job')
        .update({ opened_at: null })
        .eq('id', this.id)
        .eq('status', status)
        .not('opened_at', 'is', null)
      if (error) console.warn('[work] opened_at re-arm skipped:', error.message)
    } catch (err) {
      console.warn('[work] opened_at re-arm skipped:', err instanceof Error ? err.message : err)
    }
  }

  private async reportToChat(
    to: TeammateReportStatus,
    patch: Record<string, unknown>,
  ): Promise<WorkReportOutcome | null> {
    // No asking chat: only a question goes (to the owner's home thread).
    if (!this.chatConversationId && to !== 'needs_input') return null
    return deliverWorkReport(
      this.supabase,
      {
        id: this.id,
        workspace_id: this.workspaceId,
        member_id: this.memberId,
        title: this.title,
        agent_run_id: this.agentRunId,
        ai_team_member_id: this.aiTeamMemberId,
        chat_conversation_id: this.chatConversationId,
        kind: this.kind,
        source: this.source,
        needs: (patch.needs as WorkNeeds | null | undefined) ?? null,
        deliverables: (patch.deliverables as WorkDeliverable[] | undefined) ?? [],
        result_summary: (patch.result_summary as string | null | undefined) ?? null,
        error_message: (patch.error_message as string | null | undefined) ?? null,
        ...(this.quiet ? { quiet: true } : {}),
      },
      to,
    )
  }

  /** The push for a move; true only when a notice really went out. */
  private async notifyFor(to: WorkStatus, patch: Record<string, unknown>): Promise<boolean> {
    const row = {
      id: this.id,
      workspace_id: this.workspaceId,
      member_id: this.memberId,
      kind: this.kind,
      title: this.title,
      needs: (patch.needs as WorkNeeds | null | undefined) ?? null,
      deliverables: (patch.deliverables as WorkDeliverable[] | undefined) ?? [],
      result_summary: (patch.result_summary as string | null | undefined) ?? null,
      error_message: (patch.error_message as string | null | undefined) ?? null,
      ai_team_member_id: this.aiTeamMemberId,
      area: this.area,
    }
    if (to === 'needs_input' || to === 'needs_review') return notifyWorkNeedsYou(row, to, this.supabase)
    if (to === 'failed') return notifyWorkFailed(this.supabase, row)
    return false
  }
}

/** Build a handle over an existing row (found by run key or a back-link). */
export function attachWork(
  supabase: SupabaseClient,
  row: WorkItem,
  deadlines?: Partial<WorkDeadlines>,
): WorkHandle {
  return new Recorder(supabase, row, { ...DEFAULT_WORK_DEADLINES, ...deadlines })
}

/**
 * Insert the row and return its handle. With a `runKey`, a second call for the
 * same (kind, runKey) returns the EXISTING row's handle (an Inngest retry
 * continues the same item). Never throws: a failed insert returns an inert
 * handle and logs.
 */
export async function startWork(supabase: SupabaseClient, input: StartWorkInput): Promise<WorkHandle> {
  const deadlines: WorkDeadlines = { ...DEFAULT_WORK_DEADLINES, ...input.deadlines }
  const status: WorkStatus = input.status ?? 'queued'
  const terminal = isWorkTerminal(status)
  const at = nowIso()
  const area = workArea(input.kind, input.area)
  const row = {
    workspace_id: input.workspaceId,
    member_id: input.memberId,
    kind: input.kind,
    title: input.title,
    status,
    actor: input.actor ?? 'system',
    current_step: null,
    progress: input.progress ?? {},
    result_summary: input.resultSummary ?? null,
    error_message: input.errorMessage ?? null,
    skip_reason: input.skipReason ?? null,
    deliverables: input.deliverables ?? [],
    needs: null,
    source: { ...(input.source ?? {}), ...(input.quiet ? { quiet: true } : {}) },
    run_key: input.runKey ?? null,
    agent_run_id: input.agentRunId ?? null,
    flow_run_id: input.flowRunId ?? null,
    // A row created past 'queued' carries its lifecycle stamps so the feed can
    // render "ran at" / "finished at" for a row that never sat queued.
    started_at: status === 'queued' ? null : at,
    finished_at: terminal ? at : null,
    last_beat_at: at,
    deadline_at: deadlineFor(status, deadlines),
    // Only when set, so every existing writer inserts exactly the row it did.
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.aiTeamMemberId ? { ai_team_member_id: input.aiTeamMemberId } : {}),
    ...(area ? { area } : {}),
    ...(input.parentId ? { parent_id: input.parentId } : {}),
    ...(input.rootId ? { root_id: input.rootId } : {}),
    ...(input.depth ? { depth: input.depth } : {}),
  }
  try {
    const { data, error } = await supabase.from('tracked_job').insert(row).select('*').maybeSingle()
    if (!error && data) {
      const handle = new Recorder(supabase, data as WorkItem, deadlines, { quiet: input.quiet })
      // A new row is a log line: it started, or (a one-shot row) its outcome.
      const event = workLogEventFor(status, row, { start: true })
      if (event) {
        handle.logMove(event)
        // A row written already settled sends no notice (no transition ran).
        handle.recordEvent(event, false)
      }
      return handle
    }
    if (error?.code === UNIQUE_VIOLATION && input.runKey) {
      const existing = await findWork(supabase, { kind: input.kind, runKey: input.runKey })
      if (existing) return new Recorder(supabase, existing, deadlines, { quiet: input.quiet })
    }
    logError('start', error ?? 'no row returned')
  } catch (err) {
    logError('start', err)
  }
  return inertHandle(input)
}

/** Look a row up by its idempotency key or a back-link. */
export async function findWork(
  supabase: SupabaseClient,
  ref: { kind?: string; runKey?: string; agentRunId?: string; flowRunId?: string },
): Promise<WorkItem | null> {
  try {
    let query = supabase.from('tracked_job').select('*')
    if (ref.runKey) {
      query = query.eq('run_key', ref.runKey)
      if (ref.kind) query = query.eq('kind', ref.kind)
    } else if (ref.agentRunId) {
      query = query.eq('agent_run_id', ref.agentRunId)
    } else if (ref.flowRunId) {
      query = query.eq('flow_run_id', ref.flowRunId)
    } else {
      return null
    }
    const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
    return (data as WorkItem | null) ?? null
  } catch (err) {
    logError('find', err)
    return null
  }
}

/** A handle for a row a producer only knows by reference; inert when none exists. */
export async function workFor(
  supabase: SupabaseClient,
  ref: { kind?: string; runKey?: string; agentRunId?: string; flowRunId?: string },
  fallback: { kind: string; workspaceId: string; memberId: string } = {
    kind: ref.kind ?? 'unknown',
    workspaceId: '',
    memberId: '',
  },
): Promise<WorkHandle> {
  const row = await findWork(supabase, ref)
  return row ? attachWork(supabase, row) : inertHandle(fallback)
}
