/**
 * The agent's log (migration 329; docs/plans/always-on-agent.md §3, the Log
 * tier): one dated line per thing that happened, for one person in one
 * workspace. The main chat reads the newest lines each conversation (the `log`
 * turn-context section, ./log-section.ts); A6's "while you were away" reads
 * the table.
 *
 * ── Writers (templates, never a model) ──────────────────────────────────────
 *   • the work recorder: a row started, waits on you, finished, failed or was
 *     canceled (WorkHandle transitions, startWork, the review settle), through
 *     logWorkEvent;
 *   • the `flow/capture.processed` consumer (src/lib/inngest/agent-log-capture.ts):
 *     a meeting processed, for its owner only;
 *   • the capture pass (A2c): a `chat_checkpoint` line, through appendLogLine;
 *   • a canon section edit (decision 16, src/lib/documents/canon-edit.ts):
 *     "Native Intelligence updated Positioning in Product", for the person whose agent made
 *     it (or who applied it from its card) and, the one exception to the rule
 *     below, for the document's owners (its creator, or the workspace's owners
 *     and admins): they answer for what every agent reads, so each gets the
 *     line in their own log, in the same workspace;
 *   • the GitHub webhook (src/lib/agent-events/pr-changed.ts): a pull
 *     request linked to an action of the person's was merged, closed or
 *     reopened, or its checks fail ("Pull request merged: acme/web#7
 *     (ENG-42)"), never its title or body. A coding run's own merge already
 *     says so through its settle line, so its starter gets none.
 *   • the morning tidy (src/lib/email/auto-archive.ts): the receipts and
 *     notifications it archived, and the person's Undo of them.
 *   • arriving mail (src/lib/email/action-done-from-mail.ts): a to-do a
 *     confirmation marked done ("Marked GEN-42 done: …"), never the mail's
 *     subject or body, and the person's Undo of it.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *   • ONE (workspace, user) per line: the workspace walls hold (decision 2).
 *     Nothing here fans a line out to anyone else.
 *   • TEMPLATES ONLY: a line is a fixed phrase plus a clipped title (and, for
 *     a finish, a clipped result summary). No raw untrusted text beyond that:
 *     control and format characters and whitespace runs collapse, angle
 *     brackets become ‹ ›, a title is cut at 80 characters and a summary at
 *     90, and the line at 200 (the table's check). Migration 329's backfill
 *     applies the same rules in SQL.
 *   • IDEMPOTENT: every line carries a dedupe key, unique per (workspace,
 *     user); a second write of the same key is ignored. The keys are the
 *     backfill's, so a live line never doubles a backfilled one.
 *   • NEVER THROWS INTO A CALLER: a lost line is a gap in the log, never a
 *     failed run. appendLogLine logs and returns false.
 *   • WHAT THE PERSON WOULD WANT THEIR AGENT TO KNOW, not housekeeping: work
 *     they or their agents did for them, work waiting on them, results and
 *     failures. A quiet row (`source.quiet`), a delegated child (its parent's
 *     lines speak for it) and the housekeeping kinds (LOG_HOUSEKEEPING_KINDS)
 *     log nothing; the email-drafts pass logs only drafts made, or a failure.
 *     One filter (workEventLogged), mirrored by migration 329's backfill.
 *
 * Service-role only: the table has no client write policy.
 */
import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { isAreaKey, type AreaKey } from '@/lib/packs/registry'
import { WORK_KINDS, type WorkStatus } from '@/lib/work/types'

export const AGENT_LOG_KINDS = [
  'work_started',
  'work_waiting',
  'work_finished',
  'work_failed',
  'work_canceled',
  'capture_processed',
  'chat_checkpoint',
  // An agent's edit to a canon document (migration 376): the daily digest's
  // one line per edit (decision 16).
  'doc_updated',
  // A pull request linked to the person's action changed (migration 443).
  'pr_changed',
  // The morning tidy (migration 446, src/lib/email/auto-archive.ts): what it
  // archived, and an Undo of it. Its own message in the home thread stands
  // for it, so the digest leaves it out.
  'mail_archived',
  // Arriving mail marked a to-do done (migration 450,
  // src/lib/email/action-done-from-mail.ts), and an Undo of it. Its own
  // message in the home thread stands for it, so the digest leaves it out.
  'action_done_from_mail',
  // The evening look-ahead (migration 452, src/lib/look-ahead/): what it told
  // the person about tomorrow morning. Its own message in the home thread
  // stands for it, so the digest leaves it out.
  'look_ahead',
] as const
export type AgentLogKind = (typeof AGENT_LOG_KINDS)[number]

/** The table's cap on a line (migration 329). */
export const LOG_LINE_MAX = 200
/** A title in a line. */
export const LOG_TITLE_MAX = 80
/** A result summary in a line. */
export const LOG_SUMMARY_MAX = 90
/** A chat checkpoint's own text (A2c). */
export const LOG_CHECKPOINT_MAX = 180
/** The table's cap on a dedupe key. */
const DEDUPE_KEY_MAX = 300

/** Control and format characters (zero-width, bidi overrides, soft hyphen…). */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]+/gu

/**
 * A piece of text as it may sit in a line: invisible characters and whitespace
 * runs as one space, angle brackets as ‹ ›, trimmed, and cut at `max`
 * characters with an ellipsis. Null when nothing is left.
 */
export function clipLogText(text: string | null | undefined, max: number): string | null {
  if (typeof text !== 'string') return null
  const clean = text.replace(INVISIBLE_RE, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const chars = Array.from(clean)
  if (chars.length <= max) return clean
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** A whole line, cut at the table's cap. */
function capLine(line: string): string {
  return clipLogText(line, LOG_LINE_MAX) ?? ''
}

function title(text: string | null | undefined, fallback: string): string {
  return clipLogText(text, LOG_TITLE_MAX) ?? fallback
}

function withSummary(line: string, summary: string | null | undefined): string {
  const s = clipLogText(summary, LOG_SUMMARY_MAX)
  return s ? `${line} — ${s}` : line
}

/**
 * How a review ended: the person reviewed or dismissed it, acted on its
 * deliverable on that deliverable's own surface (`resolved`), or nobody acted
 * within the review TTL and the reaper closed it (`expired`).
 */
export type WorkSettleOutcome = 'reviewed' | 'dismissed' | 'resolved' | 'expired'

/** The events a line can say, each with what its template needs. */
export type LogEvent =
  | { type: 'work_started'; title: string | null }
  | { type: 'work_needs_input'; title: string | null }
  | { type: 'work_needs_review'; title: string | null; summary?: string | null }
  | { type: 'work_done'; title: string | null; summary?: string | null }
  | { type: 'work_failed'; title: string | null }
  | { type: 'work_canceled'; title: string | null }
  | { type: 'work_settled'; title: string | null; outcome: WorkSettleOutcome }
  | { type: 'capture_processed'; title: string | null }
  | { type: 'chat_checkpoint'; text: string | null }
  /** `from`: the outside text the edit rests on ("a web page"), said at the end of the line. */
  | { type: 'doc_updated'; section: string | null; title: string | null; reverted?: boolean; from?: string | null }
  | ({ type: 'pr_changed' } & PrChangeWords)
  /** The morning tidy archived `count` threads, or (`undone`) the person put them back. */
  | { type: 'mail_archived'; count: number; undone?: boolean }
  /** Arriving mail marked a to-do done (`from`: its sender's domain), or (`undone`) the person reopened it. */
  | { type: 'action_done_from_mail'; identifier: string | null; title: string | null; from?: string | null; undone?: boolean }

/** What a pull request's change is said with: Native Intelligence's own values, never the PR's title or body. */
export interface PrChangeWords {
  repo?: string | null
  number?: number | null
  state?: string | null
  /** The linked action's identifier (ENG-42). */
  action?: string | null
}

const PR_STATE_PHRASE: Readonly<Record<string, string>> = {
  merged: 'Pull request merged',
  closed: 'Pull request closed without merging',
  reopened: 'Pull request reopened',
  ci_failed: 'Checks failing on pull request',
}

/**
 * A pull request's change in Native Intelligence's words, "Pull request merged: acme/web#7
 * (ENG-42)": a fixed phrase, the repo and number, and the action's
 * identifier. The log line, "while you were away" and the digest all say it
 * this way. Pure.
 */
export function prChangeText(w: PrChangeWords): string {
  const what = PR_STATE_PHRASE[w.state ?? ''] ?? 'Pull request updated'
  const repo = clipLogText(w.repo, 140)
  const pr = repo && typeof w.number === 'number' && Number.isInteger(w.number) ? `${repo}#${w.number}` : 'a pull request'
  const action = clipLogText(w.action, 64)
  return `${what}: ${pr}${action ? ` (${action})` : ''}`
}

/**
 * The line for an event and the kind it is filed under: a fixed phrase, a
 * clipped title, and for a finish or a review a clipped summary. Null when
 * there is nothing to say (an empty checkpoint).
 */
export function logLineFor(event: LogEvent): { kind: AgentLogKind; line: string } | null {
  switch (event.type) {
    case 'work_started':
      return { kind: 'work_started', line: capLine(`Started: ${title(event.title, 'Untitled work')}`) }
    case 'work_needs_input':
      return { kind: 'work_waiting', line: capLine(`Waiting on you: ${title(event.title, 'Untitled work')} (it has a question)`) }
    case 'work_needs_review':
      return {
        kind: 'work_waiting',
        line: capLine(withSummary(`Ready for your review: ${title(event.title, 'Untitled work')}`, event.summary)),
      }
    case 'work_done':
      return { kind: 'work_finished', line: capLine(withSummary(`Finished: ${title(event.title, 'Untitled work')}`, event.summary)) }
    case 'work_failed':
      return { kind: 'work_failed', line: capLine(`Failed: ${title(event.title, 'Untitled work')}`) }
    case 'work_canceled':
      return { kind: 'work_canceled', line: capLine(`Canceled: ${title(event.title, 'Untitled work')}`) }
    case 'work_settled': {
      const t = title(event.title, 'Untitled work')
      if (event.outcome === 'dismissed') return { kind: 'work_canceled', line: capLine(`Dismissed: ${t}`) }
      if (event.outcome === 'reviewed') return { kind: 'work_finished', line: capLine(`Reviewed: ${t}`) }
      if (event.outcome === 'expired') return { kind: 'work_canceled', line: capLine(`Expired unreviewed: ${t}`) }
      return { kind: 'work_finished', line: capLine(`Done: ${t} (acted on)`) }
    }
    case 'capture_processed':
      return { kind: 'capture_processed', line: capLine(`Meeting processed: ${title(event.title, 'Untitled meeting')}`) }
    case 'chat_checkpoint': {
      const text = clipLogText(event.text, LOG_CHECKPOINT_MAX)
      return text ? { kind: 'chat_checkpoint', line: capLine(`Chat checkpoint: ${text}`) } : null
    }
    case 'doc_updated': {
      const section = clipLogText(event.section, LOG_TITLE_MAX) ?? 'a section'
      const doc = title(event.title, 'a document')
      const from = !event.reverted ? clipLogText(event.from ?? null, LOG_TITLE_MAX) : null
      return { kind: 'doc_updated', line: capLine(event.reverted ? `Native Intelligence reverted an edit to ${section} in ${doc}` : `Native Intelligence updated ${section} in ${doc}${from ? ` (from ${from})` : ''}`) }
    }
    case 'pr_changed':
      return { kind: 'pr_changed', line: capLine(prChangeText(event)) }
    case 'mail_archived': {
      const n = Math.max(0, Math.floor(event.count))
      if (n === 0) return null
      const threads = `${n} ${n === 1 ? 'receipt or notification' : 'receipts and notifications'}`
      return {
        kind: 'mail_archived',
        line: capLine(
          event.undone
            ? `Put back ${threads} the morning tidy archived; mail from those senders now stays in the inbox`
            : `Archived ${threads} from the inbox after the morning digest (Undo is on its message in the home thread)`,
        ),
      }
    }
    case 'action_done_from_mail': {
      const id = clipLogText(event.identifier, 64)
      const todo = `${id ? `${id} ` : ''}${title(event.title, 'a to-do')}`
      if (event.undone) return { kind: 'action_done_from_mail', line: capLine(`Reopened ${todo} after Undo; mail won't close it again`) }
      const from = clipLogText(event.from ?? null, LOG_TITLE_MAX)
      return {
        kind: 'action_done_from_mail',
        line: capLine(`Marked ${todo} done: a confirmation${from ? ` from ${from}` : ''} arrived (Undo is on its message in the home thread)`),
      }
    }
  }
}

/** The dedupe keys the live writers and migration 329's backfill share. */
export const logDedupeKey = {
  workStarted: (workItemId: string) => `work:${workItemId}:started`,
  /** A row can ask more than once: each ask is keyed by the instant of its move. */
  workNeedsInput: (workItemId: string, atIso: string) => `work:${workItemId}:needs_input:${Date.parse(atIso)}`,
  workNeedsReview: (workItemId: string) => `work:${workItemId}:needs_review`,
  workDone: (workItemId: string) => `work:${workItemId}:done`,
  workFailed: (workItemId: string) => `work:${workItemId}:failed`,
  workCanceled: (workItemId: string) => `work:${workItemId}:canceled`,
  workSettled: (workItemId: string) => `work:${workItemId}:settled`,
  captureProcessed: (captureId: string) => `capture:${captureId}:processed`,
  docUpdated: (documentId: string, revision: number) => `doc:${documentId}:rev:${revision}`,
  /** A batch of edits (an output connector's doc_proposals): one line per document per UTC day, and one more for a batch that rests on outside text. */
  docUpdatedDay: (documentId: string, day: string, outside = false) => `doc:${documentId}:day:${day}${outside ? ':outside' : ''}`,
  /** A pull request's change: its event's key (agentEventKey.prChanged), one line per change. */
  prChanged: (repoFullName: string, prNumber: number, state: string, pin: string) => `pr:${repoFullName.toLowerCase()}#${prNumber}:${state}:${pin}`,
  /** One morning tidy (an email_auto_archive row), and its Undo. */
  mailArchived: (batchId: string, undone = false) => `mail:auto-archive:${batchId}${undone ? ':undone' : ''}`,
  /** One to-do mail closed (an action_mail_done row), and its Undo. */
  actionDoneFromMail: (recordId: string, undone = false) => `mail:action-done:${recordId}${undone ? ':undone' : ''}`,
}

export interface AppendLogLineInput {
  workspaceId: string
  userId: string
  kind: AgentLogKind
  area?: AreaKey | string | null
  line: string
  refType?: string | null
  refId?: string | null
  dedupeKey: string
  /** When it happened (ISO). Defaults to now. */
  at?: string | null
}

function logWarn(op: string, err: unknown) {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
  console.warn(`[agent-log] ${op} skipped:`, message)
}

/**
 * Write one line for one person in one workspace, once per dedupe key (a
 * second write of the key is ignored). Never throws: a refused or failed
 * write is logged and returns false.
 */
export async function appendLogLine(input: AppendLogLineInput, supabase?: SupabaseClient): Promise<boolean> {
  try {
    if (!input.workspaceId || !input.userId) return false
    if (!(AGENT_LOG_KINDS as readonly string[]).includes(input.kind)) {
      logWarn('append', `unknown kind ${String(input.kind)}`)
      return false
    }
    const line = clipLogText(input.line, LOG_LINE_MAX)
    const dedupeKey = typeof input.dedupeKey === 'string' ? input.dedupeKey.trim() : ''
    if (!line || !dedupeKey || dedupeKey.length > DEDUPE_KEY_MAX) {
      logWarn('append', 'empty line or bad dedupe key')
      return false
    }
    const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString()
    const row = {
      workspace_id: input.workspaceId,
      user_id: input.userId,
      at,
      kind: input.kind,
      area: isAreaKey(input.area) ? input.area : null,
      line,
      ref_type: input.refType ?? null,
      ref_id: input.refId ?? null,
      dedupe_key: dedupeKey,
    }
    const client = supabase ?? getServiceClient()
    const { error } = await client
      .from('agent_log')
      .upsert(row, { onConflict: 'workspace_id,user_id,dedupe_key', ignoreDuplicates: true })
    if (error) {
      logWarn('append', error)
      return false
    }
    return true
  } catch (err) {
    logWarn('append', err)
    return false
  }
}

/** One line as the readers get it. */
export interface AgentLogLine {
  /** The bigint id as a string: the write order, and the chat's cursor. */
  id: string
  at: string
  kind: AgentLogKind
  area: string | null
  line: string
  refType: string | null
  refId: string | null
}

/**
 * How old a line must be before a reader serves it. The id (the chat's
 * cursor) is taken when the insert runs, not when it commits: a slow write
 * can commit after a later id is already visible, and a cursor past that
 * later id would skip it for good. Serving only lines written at least this
 * long ago lets every insert in flight land first (each is one statement).
 * Compared on `created_at`, the row's own write stamp, against this
 * process's clock; a line just written shows up a turn later.
 */
export const LOG_READ_SETTLE_MS = 5_000

/**
 * One person's newest lines in one workspace, oldest first: the `limit` most
 * recent by `at` (ties by id), only lines written at least LOG_READ_SETTLE_MS
 * ago, and with `afterId` only lines written after that one. Throws on a
 * failed read, so a caller can tell "no lines" from "couldn't read".
 */
export async function readRecentLog(
  args: { workspaceId: string; userId: string; limit: number; afterId?: string | null; nowMs?: number },
  supabase?: SupabaseClient,
): Promise<AgentLogLine[]> {
  const client = supabase ?? getServiceClient()
  const limit = Math.max(1, Math.min(200, Math.floor(args.limit)))
  const settledBefore = new Date((args.nowMs ?? Date.now()) - LOG_READ_SETTLE_MS).toISOString()
  let query = client
    .from('agent_log')
    .select('id, at, kind, area, line, ref_type, ref_id')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .lte('created_at', settledBefore)
  if (args.afterId && /^[0-9]{1,19}$/.test(args.afterId)) query = query.gt('id', args.afterId)
  const { data, error } = await query.order('at', { ascending: false }).order('id', { ascending: false }).limit(limit)
  if (error) throw new Error(`agent_log read failed: ${error.message}`)
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>
  return rows
    .map((row) => ({
      id: String(row.id),
      at: String(row.at),
      kind: row.kind as AgentLogKind,
      area: typeof row.area === 'string' ? row.area : null,
      line: typeof row.line === 'string' ? row.line : '',
      refType: typeof row.ref_type === 'string' ? row.ref_type : null,
      refId: typeof row.ref_id === 'string' ? row.ref_id : null,
    }))
    .filter((row) => /^[0-9]{1,19}$/.test(row.id) && row.line.length > 0 && Number.isFinite(Date.parse(row.at)))
    .reverse()
}

// ── Work items ────────────────────────────────────────────────────────────────

export interface WorkLogTarget {
  workItemId: string
  workspaceId: string
  /** The owner member (tracked_job.member_id); the line goes to its user. */
  memberId: string
  /** The owner's user id when already known (skips the member read). */
  userId?: string | null
  title: string | null
  area?: string | null
  /** tracked_job.kind: a housekeeping kind logs nothing (workEventLogged). */
  kind: string | null
  /** `source.quiet`: a quiet row logs nothing. */
  quiet: boolean
  /** A delegated child (`parent_id`, or `depth` > 0): its parent's lines speak for it. */
  child: boolean
}

/** The tracked_job columns workLogFacts reads: add them to a write's `.select()`. */
export const WORK_LOG_FACT_COLUMNS = 'kind, source, parent_id, depth'

/** What the log filter needs to know of a tracked_job row (WORK_LOG_FACT_COLUMNS). */
export function workLogFacts(row: {
  kind?: string | null
  source?: { quiet?: unknown } | null
  parent_id?: string | null
  depth?: number | null
}): Pick<WorkLogTarget, 'kind' | 'quiet' | 'child'> {
  return {
    kind: typeof row.kind === 'string' ? row.kind : null,
    quiet: row.source?.quiet === true,
    child: !!row.parent_id || (typeof row.depth === 'number' && row.depth > 0),
  }
}

/**
 * Work the log leaves out whatever happens to it: the system's own upkeep,
 * which the person never asked for and would not miss. Migration 329's
 * backfill lists the same kinds.
 *   • crm_enrichment: the per-record Enrich rows (quiet too);
 *   • triage_reconcile: the reconciler cron re-firing a capture's triage;
 *   • extraction: the one-shot extraction row, which repeats "Meeting processed";
 *   • proposal_age_out: the sweep that ages out stale proposals.
 */
export const LOG_HOUSEKEEPING_KINDS: readonly string[] = [
  WORK_KINDS.crmEnrichment,
  WORK_KINDS.triageReconcile,
  WORK_KINDS.extraction,
  WORK_KINDS.proposalAgeOut,
]
const HOUSEKEEPING: ReadonlySet<string> = new Set(LOG_HOUSEKEEPING_KINDS)

/**
 * Whether a work item's move is a line in its owner's log (the header's
 * "what the person would want their agent to know"). Not for a quiet row, a
 * delegated child, or a housekeeping kind. The daily email-drafts pass
 * (email-management cron) logs its drafts made (`Finished: … — N drafts ready
 * to review`) or its failure, never its start or a pass with nothing drafted.
 */
export function workEventLogged(target: Pick<WorkLogTarget, 'kind' | 'quiet' | 'child'>, event: WorkLogEvent): boolean {
  if (target.quiet || target.child) return false
  if (target.kind && HOUSEKEEPING.has(target.kind)) return false
  if (target.kind === WORK_KINDS.emailDrafts) {
    if (event.type === 'work_started') return false
    if (event.type === 'work_done' && !(typeof event.delivered === 'number' && event.delivered > 0)) return false
  }
  return true
}

/** The status-move events the recorder logs, and the move's instant (ISO). */
export type WorkLogEvent =
  | { type: 'work_started'; at: string }
  | { type: 'work_needs_input'; at: string }
  | { type: 'work_needs_review'; at: string; summary?: string | null }
  /** `delivered`: how many deliverables the finish carried. */
  | { type: 'work_done'; at: string; summary?: string | null; delivered?: number }
  | { type: 'work_failed'; at: string }
  | { type: 'work_canceled'; at: string }
  | { type: 'work_settled'; at: string; outcome: WorkSettleOutcome }

/**
 * The log event a status reached means, or null for one the log leaves out
 * (a move back to queued, a resume, a park on a child, a skip). A new row
 * (`start`) in a live status means it started. `at` is the move's instant:
 * the patch's `last_beat_at`, which every move and every insert stamps.
 */
export function workLogEventFor(
  status: WorkStatus,
  patch: Record<string, unknown>,
  opts: { start?: boolean } = {},
): WorkLogEvent | null {
  const at = typeof patch.last_beat_at === 'string' ? patch.last_beat_at : new Date().toISOString()
  const summary = typeof patch.result_summary === 'string' ? patch.result_summary : null
  const delivered = Array.isArray(patch.deliverables) ? patch.deliverables.length : 0
  switch (status) {
    case 'queued':
    case 'running':
    case 'waiting_on_child':
      return opts.start ? { type: 'work_started', at } : null
    case 'needs_input':
      return { type: 'work_needs_input', at }
    case 'needs_review':
      return { type: 'work_needs_review', at, summary }
    case 'done':
      return { type: 'work_done', at, summary, delivered }
    case 'failed':
      return { type: 'work_failed', at }
    case 'canceled':
      return { type: 'work_canceled', at }
    default:
      return null
  }
}

/** The owner member's user id, or null (a member row without a user, or a failed read). */
export async function memberUserId(supabase: SupabaseClient, workspaceId: string, memberId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('member')
      .select('user_id')
      .eq('id', memberId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) {
      logWarn('member read', error)
      return null
    }
    const userId = (data as { user_id?: unknown } | null)?.user_id
    return typeof userId === 'string' && userId ? userId : null
  } catch (err) {
    logWarn('member read', err)
    return null
  }
}

function workDedupeKey(target: WorkLogTarget, event: WorkLogEvent): string {
  switch (event.type) {
    case 'work_started':
      return logDedupeKey.workStarted(target.workItemId)
    case 'work_needs_input':
      return logDedupeKey.workNeedsInput(target.workItemId, event.at)
    case 'work_needs_review':
      return logDedupeKey.workNeedsReview(target.workItemId)
    case 'work_done':
      return logDedupeKey.workDone(target.workItemId)
    case 'work_failed':
      return logDedupeKey.workFailed(target.workItemId)
    case 'work_canceled':
      return logDedupeKey.workCanceled(target.workItemId)
    case 'work_settled':
      return logDedupeKey.workSettled(target.workItemId)
  }
}

/**
 * Log a work item's move for its owner, in its own workspace, when it is one
 * the log keeps (workEventLogged). Resolves the owner's user from the member
 * row unless given. Never throws.
 */
export async function logWorkEvent(supabase: SupabaseClient, target: WorkLogTarget, event: WorkLogEvent): Promise<boolean> {
  try {
    if (!target.workItemId || !target.workspaceId || !target.memberId) return false
    if (!workEventLogged(target, event)) return false
    const said = logLineFor({ ...event, title: target.title } as LogEvent)
    if (!said) return false
    const userId = target.userId ?? (await memberUserId(supabase, target.workspaceId, target.memberId))
    if (!userId) return false
    return await appendLogLine(
      {
        workspaceId: target.workspaceId,
        userId,
        kind: said.kind,
        area: target.area ?? null,
        line: said.line,
        refType: 'work_item',
        refId: target.workItemId,
        dedupeKey: workDedupeKey(target, event),
        at: event.at,
      },
      supabase,
    )
  } catch (err) {
    logWarn('work event', err)
    return false
  }
}

/**
 * Run a log write past the caller's own work without blocking it: next/server
 * `after()` holds the invocation open past the response, so a serverless
 * return can't drop the line; outside a request scope (tests, scripts) the
 * write just floats. The write never throws.
 */
export function deferLogWrite(work: Promise<unknown>): void {
  const settled = work.catch(() => {})
  try {
    after(settled)
  } catch {
    void settled
  }
}
