/**
 * The morning tidy (GEN-1166's optional loop; migration 446). A few minutes
 * after a person's morning digest (src/lib/inngest/email-auto-archive.ts,
 * started by the digest cron), Dial8 archives the day's receipts and
 * notifications from their inbox, says so in ONE message in the home thread,
 * and puts the batch back on Undo. No model: which threads qualify is the
 * index's own classification (src/lib/email/automated-sender.ts), so a
 * message's text never decides what moves. Apply with undo, not an approval
 * queue (Liam, 2026-10-20), and no setting: Undo is the control.
 *
 * A thread qualifies when its index row (this workspace, this person) is:
 *   • in the inbox, classified `notification` or `transactional` (receipts,
 *     statements, order and shipping notices, alerts, calendar mail);
 *     newsletters stay, since people read those;
 *   • not starred, not a draft, not marked as needing a reply; and live, at
 *     the mailbox, neither starred on any message nor flagged (Outlook): the
 *     index's star is the newest message's alone, and Outlook's is its
 *     importance (changeEmailThreads `skipStarred`);
 *   • quiet for AUTO_ARCHIVE_MIN_AGE_MS (a code that arrived a minute ago may
 *     be what the person is looking at), and newer than this workspace's last
 *     pass's cutoff before today (at most AUTO_ARCHIVE_LOOKBACK_MS back), so
 *     each thread is looked at once and the first pass never sweeps an old
 *     inbox;
 *   • about nothing the agent raised (no agent_event on the thread in the
 *     last AUTO_ARCHIVE_EVENT_DAYS: a reply it flagged, an arrival it told
 *     them about, a suspicious message);
 *   • from nobody whose mail the person put back (the senders of an undone
 *     batch stay in the inbox from then on).
 * At most AUTO_ARCHIVE_MAX threads a day, the newest first.
 *
 * Per PERSON, not per workspace: a mailbox linked to several workspaces has a
 * copy of each thread in each (src/lib/email/account-scope.ts), and the
 * digest sends one tidy per membership. So the kept senders, what the agent
 * raised and the day's cap are read across all the person's workspaces; the
 * first pass of the morning archives (the index follows in every copy), and
 * the others find nothing left to move. Only the window's start is the
 * workspace's own: each workspace's digest keeps its own clock (a member's
 * time zone) and may read a mailbox of its own, which a shared start would
 * leave gaps in.
 *
 * Archiving is update_email_thread's own path (./thread-triage.ts
 * changeEmailThreads, `archive: true`): the provider moves the thread, the
 * index follows, read state is left alone. One row per (workspace, person,
 * local date) holds the plan before anything moves, so a retried pass resumes
 * it instead of losing what the first attempt archived. Undo
 * (undoAutoArchive) runs `archive: false` on what the pass archived.
 *
 * What the person sees: the home-thread message (./auto-archive-part.ts),
 * and the agent reads one agent_log line (kind `mail_archived`) in its log.
 * Thread ids and sender addresses only; no subject, name or body.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'
import { appendLogLine, logDedupeKey, logLineFor } from '@/lib/log/agent-log'
import { changeEmailThreads, type ChangeOptions, type ThreadChange, type ThreadTriageOutcome } from './thread-triage'
import { MAX_THREADS_PER_UPDATE } from './triage-limits'
import {
  EMAIL_AUTO_ARCHIVE_MESSAGE_KIND,
  EMAIL_AUTO_ARCHIVE_PART_TYPE,
  autoArchiveMessageId,
  senderDomains,
  type EmailAutoArchivePartData,
} from './auto-archive-part'

/** The index's categories the tidy archives (newsletters stay). */
export const AUTO_ARCHIVE_CATEGORIES = ['notification', 'transactional'] as const
/** Mail quieter than this, only. */
export const AUTO_ARCHIVE_MIN_AGE_MS = 30 * 60_000
/** How far back a pass looks with no earlier cutoff (a day, and slack for the cron and a DST change). */
export const AUTO_ARCHIVE_LOOKBACK_MS = 26 * 60 * 60_000
/** The most threads one pass archives. */
export const AUTO_ARCHIVE_MAX = MAX_THREADS_PER_UPDATE
/** A thread the agent raised within this many days stays. */
export const AUTO_ARCHIVE_EVENT_DAYS = 7
/** Index rows a pass reads (before the sender and event filters). */
const CANDIDATE_ROWS = 300
/** Undone batches a pass reads for kept senders. */
const UNDONE_BATCHES = 200
/** Thread ids per agent_event read (they ride in the URL). */
const EVENT_READ_CHUNK = 50

const TABLE = 'email_auto_archive'

/** A read or write that failed because migration 446 isn't applied yet. */
function isPre446Error(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingColumnError(error, TABLE)
}

export interface AutoArchiveScope {
  workspaceId: string
  userId: string
}

interface BatchRow {
  id: string
  status: 'running' | 'done'
  cutoff_at: string
  thread_ids: string[]
  archived_ids: string[]
  senders: string[]
  undone_at: string | null
}

const BATCH_COLUMNS = 'id, status, cutoff_at, thread_ids, archived_ids, senders, undone_at'

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

function batchRow(value: unknown): BatchRow | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.cutoff_at !== 'string') return null
  return {
    id: r.id,
    status: r.status === 'done' ? 'done' : 'running',
    cutoff_at: r.cutoff_at,
    thread_ids: strings(r.thread_ids),
    archived_ids: strings(r.archived_ids),
    senders: strings(r.senders),
    undone_at: typeof r.undone_at === 'string' ? r.undone_at : null,
  }
}

/** The person's home thread in the workspace, or null (none yet: nowhere to say it, so no tidy). Throws on a failed read. */
export async function homeConversationId(supabase: SupabaseClient, scope: AutoArchiveScope): Promise<string | null> {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('user_id', scope.userId)
    .eq('workspace_id', scope.workspaceId)
    .eq('is_home', true)
    .limit(1)
  if (error) throw new Error(`home thread read failed: ${error.message}`)
  const id = (data as Array<{ id?: unknown }> | null)?.[0]?.id
  return typeof id === 'string' ? id : null
}

export interface AutoArchivePlan {
  threadIds: string[]
  /** The newest mail looked at: the next pass starts after it. */
  cutoffIso: string
  sinceIso: string
}

/**
 * Which threads a pass would archive now (see the header). Throws on a
 * failed read (the step retries).
 */
export async function autoArchivePlan(
  supabase: SupabaseClient,
  scope: AutoArchiveScope,
  nowMs = Date.now(),
  /** The day being planned: an earlier day's pass sets the window's start, and today's in another workspace takes from the cap. */
  date?: string,
): Promise<AutoArchivePlan> {
  // The window starts at this workspace's own last pass (each workspace's
  // digest keeps its own clock and may read its own mailbox; a mailbox two
  // workspaces share is archived in every copy by whichever went first).
  let lastQuery = supabase.from(TABLE).select('cutoff_at').eq('workspace_id', scope.workspaceId).eq('user_id', scope.userId)
  if (date) lastQuery = lastQuery.lt('local_date', date)
  const [last, undone, today] = await Promise.all([
    lastQuery.order('cutoff_at', { ascending: false }).limit(1),
    supabase
      .from(TABLE)
      .select('senders')
      .eq('user_id', scope.userId)
      .not('undone_at', 'is', null)
      .order('created_at', { ascending: false })
      .limit(UNDONE_BATCHES),
    date ? supabase.from(TABLE).select('archived_ids').eq('user_id', scope.userId).eq('local_date', date) : Promise.resolve({ data: [], error: null }),
  ])
  if (last.error) throw new Error(`${TABLE} read failed: ${last.error.message}`)
  if (undone.error) throw new Error(`${TABLE} read failed: ${undone.error.message}`)
  if (today.error) throw new Error(`${TABLE} read failed: ${today.error.message}`)
  const room = AUTO_ARCHIVE_MAX - ((today.data as Array<{ archived_ids?: unknown }> | null) ?? []).reduce((n, r) => n + strings(r.archived_ids).length, 0)

  const lastCutoff = Date.parse(String((last.data as Array<{ cutoff_at?: unknown }> | null)?.[0]?.cutoff_at ?? ''))
  const sinceMs = Math.max(nowMs - AUTO_ARCHIVE_LOOKBACK_MS, Number.isFinite(lastCutoff) ? lastCutoff : 0)
  const cutoffMs = nowMs - AUTO_ARCHIVE_MIN_AGE_MS
  const sinceIso = new Date(sinceMs).toISOString()
  const cutoffIso = new Date(Math.max(cutoffMs, sinceMs)).toISOString()
  if (cutoffMs <= sinceMs || room <= 0) return { threadIds: [], cutoffIso, sinceIso }

  const kept = new Set<string>()
  for (const row of (undone.data as Array<{ senders?: unknown }> | null) ?? []) for (const s of strings(row.senders)) kept.add(s.toLowerCase())

  const { data, error } = await supabase
    .from('email_thread_index')
    .select('provider_thread_id, from_email')
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .eq('folder', 'inbox')
    .in('auto_classified', [...AUTO_ARCHIVE_CATEGORIES])
    .not('is_starred', 'is', true)
    .not('is_draft', 'is', true)
    .not('needs_reply', 'is', true)
    .gt('last_message_at', sinceIso)
    .lte('last_message_at', cutoffIso)
    .order('last_message_at', { ascending: false })
    .limit(CANDIDATE_ROWS)
  if (error) throw new Error(`email_thread_index read failed: ${error.message}`)

  const ids: string[] = []
  const seen = new Set<string>()
  for (const row of (data as Array<{ provider_thread_id?: unknown; from_email?: unknown }> | null) ?? []) {
    const id = typeof row.provider_thread_id === 'string' ? row.provider_thread_id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const from = typeof row.from_email === 'string' ? row.from_email.trim().toLowerCase() : ''
    if (from && kept.has(from)) continue
    ids.push(id)
  }
  if (!ids.length) return { threadIds: [], cutoffIso, sinceIso }

  // Anything the agent raised about a thread, in any of the person's
  // workspaces, keeps it in the inbox. A few ids per read: provider thread
  // ids are long, and the list rides in the URL.
  const raised = new Set<string>()
  const sinceEvents = new Date(nowMs - AUTO_ARCHIVE_EVENT_DAYS * 24 * 60 * 60_000).toISOString()
  for (let i = 0; i < ids.length; i += EVENT_READ_CHUNK) {
    const { data: events, error: eventError } = await supabase
      .from('agent_event')
      .select('ref_id')
      .eq('user_id', scope.userId)
      .eq('ref_type', 'email_thread')
      .in('ref_id', ids.slice(i, i + EVENT_READ_CHUNK))
      .gte('occurs_at', sinceEvents)
    if (eventError) throw new Error(`agent_event read failed: ${eventError.message}`)
    for (const e of (events as Array<{ ref_id?: unknown }> | null) ?? []) raised.add(String(e.ref_id))
  }

  return { threadIds: ids.filter((id) => !raised.has(id)).slice(0, room), cutoffIso, sinceIso }
}

/** The archived threads' senders, as the index has them (lowercase), one per thread and in the given order. */
async function threadSenders(supabase: SupabaseClient, scope: AutoArchiveScope, threadIds: readonly string[]): Promise<string[]> {
  if (!threadIds.length) return []
  const { data, error } = await supabase
    .from('email_thread_index')
    .select('provider_thread_id, from_email')
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .in('provider_thread_id', [...threadIds])
  if (error) {
    console.warn('[auto-archive] sender read failed:', error.message)
    return []
  }
  const byThread = new Map<string, string>()
  for (const row of (data as Array<{ provider_thread_id?: unknown; from_email?: unknown }> | null) ?? []) {
    const from = typeof row.from_email === 'string' ? row.from_email.trim().toLowerCase() : ''
    if (typeof row.provider_thread_id === 'string' && from && !byThread.has(row.provider_thread_id)) byThread.set(row.provider_thread_id, from)
  }
  return threadIds.map((id) => byThread.get(id)).filter((s): s is string => !!s)
}

/** The threads, of these, whose index row says archived (any copy: the archive writes every one). */
async function archivedInIndex(supabase: SupabaseClient, scope: AutoArchiveScope, threadIds: readonly string[]): Promise<Set<string>> {
  if (!threadIds.length) return new Set()
  const { data, error } = await supabase
    .from('email_thread_index')
    .select('provider_thread_id')
    .eq('user_id', scope.userId)
    .eq('folder', 'archive')
    .in('provider_thread_id', [...threadIds])
  if (error) throw new Error(`email_thread_index read failed: ${error.message}`)
  return new Set(((data as Array<{ provider_thread_id?: unknown }> | null) ?? []).map((r) => String(r.provider_thread_id)))
}

/**
 * Write (or rewrite, on Undo) the batch's message in the home thread: one
 * data part, the server's own words. Never throws: a lost message leaves the
 * log line, and the batch still undoes from the route.
 */
export async function writeAutoArchiveMessage(
  supabase: SupabaseClient,
  scope: AutoArchiveScope & { conversationId: string },
  data: EmailAutoArchivePartData,
): Promise<boolean> {
  try {
    const messageId = autoArchiveMessageId(data.batch_id)
    const { error } = await supabase.from('chat_messages').upsert(
      {
        conversation_id: scope.conversationId,
        user_id: scope.userId,
        workspace_id: scope.workspaceId,
        role: 'assistant',
        ui_message: {
          id: messageId,
          role: 'assistant',
          parts: [{ type: EMAIL_AUTO_ARCHIVE_PART_TYPE, id: messageId, data }],
          metadata: { kind: EMAIL_AUTO_ARCHIVE_MESSAGE_KIND, batch_id: data.batch_id },
        },
      },
      { onConflict: 'conversation_id,ui_message_id' },
    )
    if (error) {
      console.warn('[auto-archive] message not written:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[auto-archive] message not written:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/** The part's data for a batch. Pure. */
export function autoArchivePart(batchId: string, senders: readonly string[], count: number, undone = false): EmailAutoArchivePartData {
  return { batch_id: batchId, count, ...senderDomains(senders), ...(undone ? { undone: true } : {}) }
}

export interface AutoArchiveDeps {
  change?: (userId: string, workspaceId: string, threadIds: readonly string[], change: ThreadChange, options?: ChangeOptions) => Promise<ThreadTriageOutcome[]>
  writeMessage?: typeof writeAutoArchiveMessage
  appendLog?: typeof appendLogLine
}

export type AutoArchiveResult =
  | { status: 'archived'; batchId: string; archived: number; failed: number }
  | { status: 'nothing' | 'already' | 'no_home_thread' | 'unavailable'; batchId?: string; archived?: number }

/**
 * Archive what moves on the day `date` was keyed on (see the header), once.
 * A row already done for the day is returned as is; one still `running` (a
 * retried step) is resumed. Throws on a failed read, and when the row can't
 * record what moved (no message goes out saying it can be undone), so the
 * step retries and resumes it; a lost message or log line never throws.
 */
export async function runAutoArchive(
  supabase: SupabaseClient,
  args: AutoArchiveScope & { date: string; nowMs?: number },
  deps: AutoArchiveDeps = {},
): Promise<AutoArchiveResult> {
  const scope = { workspaceId: args.workspaceId, userId: args.userId }
  const nowMs = args.nowMs ?? Date.now()

  const existing = await supabase
    .from(TABLE)
    .select(BATCH_COLUMNS)
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .eq('local_date', args.date)
    .maybeSingle()
  if (existing.error) {
    if (isPre446Error(existing.error)) return { status: 'unavailable' }
    throw new Error(`${TABLE} read failed: ${existing.error.message}`)
  }
  let row = batchRow(existing.data)
  if (row?.status === 'done') return { status: 'already', batchId: row.id, archived: row.archived_ids.length }

  const conversationId = await homeConversationId(supabase, scope)
  if (!conversationId) return { status: 'no_home_thread' }

  const resumed = !!row
  if (!row) {
    const plan = await autoArchivePlan(supabase, scope, nowMs, args.date)
    if (!plan.threadIds.length) return { status: 'nothing' }
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        {
          workspace_id: scope.workspaceId,
          user_id: scope.userId,
          local_date: args.date,
          status: 'running',
          cutoff_at: plan.cutoffIso,
          thread_ids: plan.threadIds,
        },
        { onConflict: 'workspace_id,user_id,local_date', ignoreDuplicates: true },
      )
      .select(BATCH_COLUMNS)
    if (error) throw new Error(`${TABLE} write failed: ${error.message}`)
    row = batchRow((data as unknown[] | null)?.[0])
    if (!row) {
      // Another attempt claimed the day first: theirs stands.
      return { status: 'already' }
    }
  }

  const change = deps.change ?? changeEmailThreads
  let outcomes: ThreadTriageOutcome[]
  try {
    outcomes = await change(scope.userId, scope.workspaceId, row.thread_ids, { archive: true }, { skipStarred: true })
  } catch (err) {
    console.warn('[auto-archive] archive failed:', err instanceof Error ? err.message : String(err))
    outcomes = row.thread_ids.map((threadId) => ({ threadId, status: 'failed' as const }))
  }
  // A resumed row: what the first attempt moved now reads `unchanged`. It
  // counts only where the index says the thread is archived now (the
  // archive wrote that); a thread that was never in the inbox (a stale row,
  // a starred one) does not, so Undo never moves it into the inbox.
  const resumedArchived = resumed
    ? await archivedInIndex(supabase, scope, outcomes.filter((o) => o.status === 'unchanged' && !o.kept).map((o) => o.threadId))
    : new Set<string>()
  // What Undo puts back: what moved, and a thread that partly moved.
  const archivedIds = outcomes
    .filter((o) => o.status === 'changed' || (o.status === 'failed' && !!o.undo) || resumedArchived.has(o.threadId))
    .map((o) => o.threadId)
  const failed = outcomes.filter((o) => o.status === 'failed' && !o.undo).length
  const perThread = await threadSenders(supabase, scope, archivedIds)
  const senders = [...new Set(perThread)].slice(0, AUTO_ARCHIVE_MAX)

  // Throws: a batch with no record of what moved could not be undone, so no
  // message says it can. The step retries, and resumes this row.
  const { error: doneError } = await supabase
    .from(TABLE)
    .update({ status: 'done', archived_ids: archivedIds, senders, updated_at: new Date(nowMs).toISOString() })
    .eq('id', row.id)
  if (doneError) throw new Error(`${TABLE} done mark failed: ${doneError.message}`)

  if (archivedIds.length) {
    await (deps.writeMessage ?? writeAutoArchiveMessage)(supabase, { ...scope, conversationId }, autoArchivePart(row.id, perThread, archivedIds.length))
    const line = logLineFor({ type: 'mail_archived', count: archivedIds.length })
    if (line) {
      await (deps.appendLog ?? appendLogLine)(
        { ...scope, kind: line.kind, line: line.line, refType: TABLE, refId: row.id, dedupeKey: logDedupeKey.mailArchived(row.id), at: new Date(nowMs).toISOString() },
        supabase,
      )
    }
  }
  return { status: 'archived', batchId: row.id, archived: archivedIds.length, failed }
}

export type UndoAutoArchiveResult =
  /** `gone`: threads deleted or in Trash or Spam since, which there is nothing to put back for. */
  | { ok: true; restored: number; failed: number; gone: number }
  | { ok: false; reason: 'not_found' | 'unavailable' | 'read_failed' }

/**
 * Put a batch back (`archive: false` on what it archived), mark it undone (its
 * senders stay in the inbox from then on), rewrite its message to say so, and
 * log it. Safe to repeat: a thread already back changes nothing. The row is
 * read for this person and workspace only.
 */
export async function undoAutoArchive(
  supabase: SupabaseClient,
  args: AutoArchiveScope & { batchId: string; nowMs?: number },
  deps: AutoArchiveDeps = {},
): Promise<UndoAutoArchiveResult> {
  const scope = { workspaceId: args.workspaceId, userId: args.userId }
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString()
  const { data, error } = await supabase
    .from(TABLE)
    .select(BATCH_COLUMNS)
    .eq('id', args.batchId)
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .maybeSingle()
  if (error) return { ok: false, reason: isPre446Error(error) ? 'unavailable' : 'read_failed' }
  const row = batchRow(data)
  if (!row) return { ok: false, reason: 'not_found' }

  const change = deps.change ?? changeEmailThreads
  const outcomes = row.archived_ids.length ? await change(scope.userId, scope.workspaceId, row.archived_ids, { archive: false }) : []
  const restored = outcomes.filter((o) => o.status === 'changed').length
  const gone = outcomes.filter((o) => o.status === 'not_found' || o.trashed).length
  const failed = outcomes.filter((o) => o.status === 'failed' && !o.trashed).length

  if (!row.undone_at) {
    const { error: markError } = await supabase.from(TABLE).update({ undone_at: nowIso, updated_at: nowIso }).eq('id', row.id).is('undone_at', null)
    if (markError) console.warn(`[auto-archive] ${TABLE} undo mark failed:`, markError.message)
    const line = logLineFor({ type: 'mail_archived', count: row.archived_ids.length, undone: true })
    if (line) {
      await (deps.appendLog ?? appendLogLine)(
        { ...scope, kind: line.kind, line: line.line, refType: TABLE, refId: row.id, dedupeKey: logDedupeKey.mailArchived(row.id, true), at: nowIso },
        supabase,
      )
    }
  }

  const conversationId = await homeConversationId(supabase, scope).catch(() => null)
  if (conversationId && row.archived_ids.length) {
    const perThread = await threadSenders(supabase, scope, row.archived_ids)
    await (deps.writeMessage ?? writeAutoArchiveMessage)(
      supabase,
      { ...scope, conversationId },
      autoArchivePart(row.id, perThread.length ? perThread : row.senders, row.archived_ids.length, true),
    )
  }
  return { ok: true, restored, failed, gone }
}
