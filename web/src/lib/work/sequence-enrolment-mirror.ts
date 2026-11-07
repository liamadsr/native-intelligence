/**
 * Sequence enrolments in the work ledger (docs/plans/agent-orchestration-product.md
 * §1.1, Sequence row 11). The `sequence_enrollment` row stays the source of
 * truth; its `tracked_job` row (kind `sequence_enrolment`, `run_key =
 * enrollment.id`) is the Activity projection, at the ENROLMENT grain — one row
 * per contact in a sequence, never one per email (§1.1: a row per send would
 * flood the feed).
 *
 *   running   while the drip has steps left: "Sent 2 of 4 · next due Oct 3"
 *   done      exited completed / replied / opted_out
 *   canceled  exited removed
 *   failed    exited failed (a send failed, or the dispatcher gave up)
 *
 * WHY A RECONCILE PASS, NOT A CALL AT EVERY WRITE: an enrolment is written from
 * a dozen places (the dispatcher's exit and reaper passes, the send function's
 * finalize and exits, the enrolment routes, bulk removal, sequence delete,
 * company delete, two AI tools, and `merge_contacts()` in SQL). Every one of
 * them bumps `updated_at` (trigger `sequence_enrollment_updated_at`, mig 227),
 * so the dispatcher's clock — every 5 minutes — reads the enrolments that
 * changed since a window ago and projects each as it is STORED. A new exit
 * site cannot be missed, and a write that lost a race is never what Activity
 * shows. The cost is up to one tick of latency on a drip measured in days.
 *
 * DEADLINES: a drip waits days between steps, and the ledger reaper fails a
 * running row past its `deadline_at` (20 minutes by default). So each row's
 * running deadline is its own next send plus DEADLINE_SLACK_MS, and the same
 * pass re-arms the rows whose deadline is near (a paused sequence writes no
 * enrolment, so nothing else would). A drip that really stalls — its next send
 * long past and nothing moving — is failed by the reaper, as any silent run is.
 *
 * Owner: the sequence's creator (`sequence.created_by`), else whoever enrolled
 * the contact. The engine already notifies its own failures
 * (`notifySequenceIssue`), so these rows are QUIET: the ledger never sends a
 * second push for the same failed send.
 *
 * Service client only; every function is fail-soft (a lost projection is a UI
 * gap, never a failed tick).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, startWork, type WorkHandle } from './recorder'
import { resolveMemberId } from './agent-run-mirror'
import { recordWorkTouches } from './touch'
import { isWorkTerminal, WORK_KINDS, type WorkDeadlines, type WorkItem } from './types'

/** How far back the pass looks for changed enrolments. The dispatcher ticks
 *  every 5 minutes; 30 covers a few missed ticks. */
export const ENROLMENT_SCAN_WINDOW_MS = 30 * 60_000
/** One pass reads at most this many enrolments (the engine is sized for tens). */
export const ENROLMENT_SCAN_LIMIT = 500
/** A running row's deadline: its next send plus this. */
export const DEADLINE_SLACK_MS = 2 * 24 * 60 * 60_000
/** Rows whose deadline falls within this are re-armed by the pass. */
export const REARM_WITHIN_MS = 24 * 60 * 60_000

const TITLE_MAX = 120

export interface EnrolmentRow {
  id: string
  workspace_id: string
  sequence_id: string
  contact_id: string | null
  contact_email: string
  enrolled_by: string | null
  status: 'active' | 'exited'
  exit_reason: 'replied' | 'completed' | 'removed' | 'opted_out' | 'failed' | null
  current_step_order: number
  next_send_at: string | null
  sequence: { id: string; name: string; created_by: string | null; status: string; timezone: string | null } | null
}

interface SendRow {
  enrollment_id: string
  status: string
  error: string | null
  updated_at: string
}

export interface EnrolmentFacts {
  /** Emails the engine has sent for this enrolment. */
  sent: number
  /** Active steps in the sequence (never below `sent`). */
  total: number
  /** The latest failed send's error, if any. */
  lastError: string | null
}

export interface EnrolmentSyncOutcome {
  scanned: number
  started: number
  stepped: number
  settled: number
  rearmed: number
  errored: number
}

function warn(what: string, err: unknown) {
  console.warn(`[work] sequence enrolment mirror (${what}) failed:`, err instanceof Error ? err.message : err)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function dueDate(iso: string, timezone: string | null): string {
  const d = new Date(iso)
  try {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone || 'UTC' })
  } catch {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
}

export function enrolmentTitle(e: Pick<EnrolmentRow, 'contact_email' | 'sequence'>): string {
  const name = e.sequence?.name?.trim() || 'a sequence'
  const title = `Emailing ${e.contact_email} · ${name}`
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
}

/** The live line for an active enrolment. */
export function enrolmentStepText(e: EnrolmentRow, facts: EnrolmentFacts): string {
  if (e.sequence && e.sequence.status !== 'active') return `Paused after ${facts.sent} of ${facts.total} — the sequence is ${e.sequence.status}`
  const next = e.next_send_at ? ` · next due ${dueDate(e.next_send_at, e.sequence?.timezone ?? null)}` : ''
  if (facts.sent === 0) return `Step 1 of ${facts.total}${next.replace(' · next', '')}`
  return `Sent ${facts.sent} of ${facts.total}${next}`
}

/** What an exited enrolment settles as. */
export type EnrolmentSettle =
  | { kind: 'finish'; summary: string }
  | { kind: 'cancel'; reason: string }
  | { kind: 'fail'; message: string; summary: string }

export function enrolmentSettle(e: EnrolmentRow, facts: EnrolmentFacts): EnrolmentSettle {
  const after = facts.sent === 0 ? 'before the first email' : `after ${plural(facts.sent, 'email')}`
  switch (e.exit_reason) {
    case 'completed':
      return { kind: 'finish', summary: `Sent all ${plural(facts.sent, 'email')}` }
    case 'replied':
      return { kind: 'finish', summary: `Replied ${after} — the drip stopped` }
    case 'opted_out':
      return { kind: 'finish', summary: `Opted out ${after}` }
    case 'removed':
      return { kind: 'cancel', reason: `Removed from the sequence ${after}` }
    case 'failed':
    default:
      return {
        kind: 'fail',
        message: facts.lastError || 'A send failed, so the drip stopped',
        summary: `Stopped ${after}`,
      }
  }
}

/** True when the enrolment has started sending (or is scheduled to): a staged,
 *  never-launched enrolment gets no row. */
export function enrolmentLaunched(e: EnrolmentRow, facts: EnrolmentFacts): boolean {
  return facts.sent > 0 || (e.status === 'active' && e.next_send_at !== null)
}

/** The running deadline for a row: its next send plus the slack, at least the slack. */
export function enrolmentDeadlines(e: EnrolmentRow, now: Date): Partial<WorkDeadlines> {
  const untilNext = e.next_send_at ? Math.max(0, new Date(e.next_send_at).getTime() - now.getTime()) : 0
  return { running: untilNext + DEADLINE_SLACK_MS }
}

const ENROLMENT_SELECT =
  'id, workspace_id, sequence_id, contact_id, contact_email, enrolled_by, status, exit_reason, current_step_order, next_send_at, sequence:sequence_id(id, name, created_by, status, timezone)'

/** Ids per `.in()` read: a pass holds up to ~1000 ids, far past a sane GET URL. */
const IN_CHUNK = 100

async function readInChunks<T>(
  ids: string[],
  read: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await read(ids.slice(i, i + IN_CHUNK))
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as T[]))
  }
  return rows
}

async function readFacts(
  supabase: SupabaseClient,
  enrolments: EnrolmentRow[],
): Promise<Map<string, EnrolmentFacts>> {
  const ids = enrolments.map((e) => e.id)
  const sequenceIds = [...new Set(enrolments.map((e) => e.sequence_id))]
  const [sends, stepsRes] = await Promise.all([
    readInChunks<SendRow>(ids, (part) =>
      supabase.from('sequence_send').select('enrollment_id, status, error, updated_at').in('enrollment_id', part),
    ),
    supabase.from('sequence_step').select('sequence_id').eq('is_active', true).in('sequence_id', sequenceIds),
  ])
  if (stepsRes.error) throw new Error(stepsRes.error.message)
  const stepsBySequence = new Map<string, number>()
  for (const s of (stepsRes.data ?? []) as Array<{ sequence_id: string }>) {
    stepsBySequence.set(s.sequence_id, (stepsBySequence.get(s.sequence_id) ?? 0) + 1)
  }
  const facts = new Map<string, EnrolmentFacts>()
  for (const e of enrolments) facts.set(e.id, { sent: 0, total: stepsBySequence.get(e.sequence_id) ?? 0, lastError: null })
  const lastFailedAt = new Map<string, string>()
  for (const s of sends) {
    const f = facts.get(s.enrollment_id)
    if (!f) continue
    if (s.status === 'sent') f.sent += 1
    if (s.status === 'failed' && s.error && (lastFailedAt.get(s.enrollment_id) ?? '') < s.updated_at) {
      f.lastError = s.error
      lastFailedAt.set(s.enrollment_id, s.updated_at)
    }
  }
  for (const f of facts.values()) f.total = Math.max(f.total, f.sent)
  return facts
}

async function ownerMemberId(supabase: SupabaseClient, e: EnrolmentRow): Promise<string | null> {
  return (
    (await resolveMemberId(supabase, e.workspace_id, e.sequence?.created_by ?? null)) ??
    (await resolveMemberId(supabase, e.workspace_id, e.enrolled_by))
  )
}

async function recordSentTouch(supabase: SupabaseClient, handle: WorkHandle, e: EnrolmentRow): Promise<void> {
  if (!handle.id || !e.contact_id) return
  await recordWorkTouches(supabase, [
    {
      workspaceId: e.workspace_id,
      workItemId: handle.id,
      toolName: 'sequence_send',
      entityType: 'contact',
      entityId: e.contact_id,
      verb: 'wrote',
    },
  ])
}

type SyncResult = 'started' | 'stepped' | 'settled' | 'rearmed' | 'none'

/**
 * Project one enrolment, as stored, onto its ledger row (creating it when the
 * drip has launched). Exported for the unit tests.
 */
export async function syncEnrolment(
  supabase: SupabaseClient,
  e: EnrolmentRow,
  facts: EnrolmentFacts,
  row: WorkItem | null,
  now: Date = new Date(),
): Promise<SyncResult> {
  if (row && isWorkTerminal(row.status)) return 'none'
  const deadlines = enrolmentDeadlines(e, now)
  let handle: WorkHandle
  let started = false
  if (row) {
    handle = attachWork(supabase, row, deadlines)
  } else {
    if (!enrolmentLaunched(e, facts)) return 'none'
    const memberId = await ownerMemberId(supabase, e)
    if (!memberId) return 'none'
    handle = await startWork(supabase, {
      workspaceId: e.workspace_id,
      memberId,
      kind: WORK_KINDS.sequenceEnrolment,
      title: enrolmentTitle(e),
      actor: 'system',
      status: 'running',
      runKey: e.id,
      quiet: true,
      deadlines,
      progress: { done: facts.sent, total: facts.total },
      source: {
        sequence_id: e.sequence_id,
        enrollment_id: e.id,
        ...(e.contact_id ? { entity_type: 'contact', entity_id: e.contact_id } : {}),
      },
    })
    if (handle.inert) return 'none'
    started = true
    if (facts.sent > 0) await recordSentTouch(supabase, handle, e)
  }

  // A send since the row last saw the enrolment (the start records its own).
  const previousSent = typeof row?.progress?.done === 'number' ? row.progress.done : 0
  const sentSince = !started && facts.sent > previousSent

  if (e.status === 'exited') {
    // The last email and the exit usually land in the same tick.
    if (sentSince) await recordSentTouch(supabase, handle, e)
    const settle = enrolmentSettle(e, facts)
    const progress = { done: facts.sent, total: facts.total }
    if (settle.kind === 'finish') await handle.finish({ summary: settle.summary, progress })
    else if (settle.kind === 'cancel') await handle.cancel(settle.reason)
    else await handle.fail(settle.message, { summary: settle.summary })
    return 'settled'
  }

  const text = enrolmentStepText(e, facts)
  if (started || row?.current_step !== text) {
    await handle.step(text, { done: facts.sent, total: facts.total })
    await handle.flush()
    if (sentSince) await recordSentTouch(supabase, handle, e)
    return started ? 'started' : 'stepped'
  }
  // Unchanged: re-arm a deadline that is close, without a new step line.
  const deadline = row?.deadline_at ? new Date(row.deadline_at).getTime() : 0
  if (deadline - now.getTime() < REARM_WITHIN_MS) {
    await handle.beat()
    return 'rearmed'
  }
  return 'none'
}

/**
 * The dispatcher's ledger pass: every enrolment written in the last window,
 * plus every running row whose deadline is near, projected as stored.
 */
export async function syncSequenceEnrolmentLedger(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<EnrolmentSyncOutcome> {
  const out: EnrolmentSyncOutcome = { scanned: 0, started: 0, stepped: 0, settled: 0, rearmed: 0, errored: 0 }
  try {
    const since = new Date(now.getTime() - ENROLMENT_SCAN_WINDOW_MS).toISOString()
    const nearDeadline = new Date(now.getTime() + REARM_WITHIN_MS).toISOString()
    const [changedRes, dueRes] = await Promise.all([
      supabase
        .from('sequence_enrollment')
        .select(ENROLMENT_SELECT)
        .gte('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(ENROLMENT_SCAN_LIMIT),
      supabase
        .from('tracked_job')
        .select('run_key')
        .eq('kind', WORK_KINDS.sequenceEnrolment)
        .in('status', ['queued', 'running'])
        .lt('deadline_at', nearDeadline)
        .limit(ENROLMENT_SCAN_LIMIT),
    ])
    if (changedRes.error) throw new Error(changedRes.error.message)
    if (dueRes.error) throw new Error(dueRes.error.message)

    const byId = new Map<string, EnrolmentRow>()
    for (const e of (changedRes.data ?? []) as unknown as EnrolmentRow[]) byId.set(e.id, e)
    const rearmIds = ((dueRes.data ?? []) as Array<{ run_key: string | null }>)
      .map((r) => r.run_key)
      .filter((k): k is string => !!k && !byId.has(k))
    if (rearmIds.length > 0) {
      const rearmed = await readInChunks<EnrolmentRow>(rearmIds, (part) =>
        supabase.from('sequence_enrollment').select(ENROLMENT_SELECT).in('id', part),
      )
      for (const e of rearmed) byId.set(e.id, e)
    }
    const enrolments = [...byId.values()]
    out.scanned = enrolments.length
    if (enrolments.length === 0) return out

    const [facts, jobRows] = await Promise.all([
      readFacts(supabase, enrolments),
      readInChunks<WorkItem>(
        enrolments.map((e) => e.id),
        (part) => supabase.from('tracked_job').select('*').eq('kind', WORK_KINDS.sequenceEnrolment).in('run_key', part),
      ),
    ])
    const rows = new Map<string, WorkItem>()
    for (const r of jobRows) if (r.run_key) rows.set(r.run_key, r)

    for (const e of enrolments) {
      try {
        const result = await syncEnrolment(supabase, e, facts.get(e.id)!, rows.get(e.id) ?? null, now)
        if (result !== 'none') out[result] += 1
      } catch (err) {
        out.errored += 1
        warn(`enrolment ${e.id}`, err)
      }
    }
  } catch (err) {
    out.errored += 1
    warn('pass', err)
  }
  return out
}
