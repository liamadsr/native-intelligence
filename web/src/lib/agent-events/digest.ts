/**
 * The daily digest (A6 slice 4; docs/plans/always-on-agent.md §5 "Optional:
 * one daily digest turn" and Defaults: 8:00 in the person's time zone, one
 * message in the home thread plus one bubble on the face).
 *
 * THE CRON (src/lib/inngest/agent-events.ts agentEventDigest, hourly): every
 * member whose zone (`member.time_zone`, migration 336, saved by the chat
 * spec; else the fallback chain in member-time-zone.ts pickTimeZone, ending at
 * UTC) reads DIGEST_LOCAL_HOUR (8) right now is a candidate, keyed on their
 * local date. Intl does the zone arithmetic, so a DST change moves the UTC
 * hour the digest runs at, never the local one. A member with no zone at all
 * is still scheduled, at 8:00 UTC (2026-10 PROD audit: half the active people
 * had none, and their quiet rows never reached a digest). Per candidate
 * (planDigestFor):
 *   • no home thread → skip (nothing to write into);
 *   • the turn for `digest:<local date>` already exists → skip (once a day);
 *   • autonomy off or a dormant workspace → skip. The kill switch FAILS
 *     CLOSED here (readAgentPausedState: a switch that can't be read counts
 *     as paused), because the digest spends money, as the mail arrival path
 *     does; the person's rows wait for "while you were away";
 *   • nothing to say → skip: no undelivered quiet/notify/turn agent_event
 *     row whose subject is still open (./freshness.ts drops a draft already
 *     sent, a question already answered) and no agent-log line since the
 *     last digest (at most a day back);
 *   • else one `home/turn.requested` (reason 'digest', the event ids and the
 *     local date), with an Inngest event id per conversation and date.
 *
 * THE TURN (src/lib/chat/home-turn-server.ts, A4's consumer): the plan re-reads
 * those rows (gatherDigest), builds the fenced body (digestBody →
 * buildHomeTurnBody 'digest'), and the model writes ONE summary (no_reply
 * allowed). Once eve accepted the message the rows are delivered
 * (markDigestDelivered, `delivered_key = digest:<date>`); when a reply was
 * written, one `agent_digest` notice goes out from the Assistant
 * (sendDigestNotice). The turn is billed to the person as `ai_chat`
 * (decision 8), through its run token.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName } from '@/lib/bots/bot-notice'
import { systemTeammateId } from '@/lib/work/system-teammates'
import { HOME_TURN_MAX_DIGEST_EVENTS, HOME_TURN_REQUESTED_EVENT, digestTurnKey, type HomeTurnDigest, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { collapseByRef, eventSummaryParts, expiredIds, markExpiredEvents, type AwayLogLine } from './away-section'
import { markSettledEvents, settledEventIds } from './freshness'
import type { AgentPausedState } from '@/lib/work/agent-paused'
import { isStorableTimeZone, pickTimeZone, profileTimeZones, type TimeZoneSource } from './member-time-zone'
import type { AgentEventKind, AgentEventRow } from './types'

/** The local hour the digest goes out at (Defaults: 8:00). */
export const DIGEST_LOCAL_HOUR = 8
/** At most this many lines in the digest's body (then "…and N more"). */
export const DIGEST_MAX_LINES = 12
/** The newest log lines a digest reads. */
export const DIGEST_LOG_LINES = 30
/** How far back a digest looks for log lines when the last one is older (or there is none). */
export const DIGEST_LOOKBACK_MS = 24 * 60 * 60_000
/** Members read per page, and the most pages one pass reads. */
const MEMBER_PAGE = 1000
const MEMBER_PAGES = 20

/** The person's local hour (0-23) and date (YYYY-MM-DD) in `timeZone` at `nowMs`, or null for a zone Intl refuses. Pure. */
export function localClock(timeZone: string, nowMs: number): { hour: number; date: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs))
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    const hour = Number(get('hour'))
    const date = `${get('year')}-${get('month')}-${get('day')}`
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return null
    return { hour, date }
  } catch {
    return null
  }
}

export interface DigestCandidate {
  memberId: string
  userId: string
  workspaceId: string
  timeZone: string
  /** Where `timeZone` came from (member-time-zone.ts pickTimeZone). */
  timeZoneSource?: TimeZoneSource
  /** The person's local date (the digest's key). */
  date: string
  /** The person's local hour now (one of the hours the scan was asked for). */
  hour?: number
}

/**
 * Every member whose zone reads one of `hours` now (8 o'clock, the digest's,
 * by default), with their local date and hour. The Now file's check-in
 * (src/lib/now/check-in.ts) rides the same scan at its slot hours, so the
 * members are read once an hour, not twice. The zone is the member's own
 * here, else down the fallback chain (pickTimeZone: the person's zone saved
 * in another workspace, then the legacy profile zone, then UTC), so a person
 * with no stored zone still gets a digest, at 8:00 UTC when nothing better
 * is known. Throws on a failed first read (the cron retries); a later page
 * that fails ends the list there.
 */
export async function findDigestCandidates(
  supabase: SupabaseClient,
  nowMs = Date.now(),
  hours: readonly number[] = [DIGEST_LOCAL_HOUR],
): Promise<DigestCandidate[]> {
  const wanted = new Set(hours)
  const members: Array<{ id: string; user_id: string; workspace_id: string; time_zone: unknown }> = []
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const { data, error } = await supabase
      .from('member')
      .select('id, user_id, workspace_id, time_zone')
      .order('id', { ascending: true })
      .range(page * MEMBER_PAGE, page * MEMBER_PAGE + MEMBER_PAGE - 1)
    if (error) {
      if (page === 0) throw new Error(`member read failed: ${error.message}`)
      console.warn('[agent-digest] member page read failed:', error.message)
      break
    }
    const rows = (data as Array<Record<string, unknown>> | null) ?? []
    for (const m of rows) {
      if (typeof m.id !== 'string' || typeof m.user_id !== 'string' || typeof m.workspace_id !== 'string') continue
      members.push({ id: m.id, user_id: m.user_id, workspace_id: m.workspace_id, time_zone: m.time_zone })
    }
    if (rows.length < MEMBER_PAGE) break
  }

  // The person's zone saved in any workspace (the first seen), then the legacy
  // profile zone for whoever has neither — read only for them.
  const zoneByUser = new Map<string, string>()
  for (const m of members) {
    if (isStorableTimeZone(m.time_zone) && !zoneByUser.has(m.user_id)) zoneByUser.set(m.user_id, m.time_zone)
  }
  const unzoned = members.filter((m) => !zoneByUser.has(m.user_id)).map((m) => m.user_id)
  const profileZones = unzoned.length ? await profileTimeZones(supabase, unzoned) : new Map<string, string>()

  const out: DigestCandidate[] = []
  const clockByZone = new Map<string, ReturnType<typeof localClock>>()
  for (const m of members) {
    const { timeZone, source } = pickTimeZone({
      member: m.time_zone,
      otherWorkspace: zoneByUser.get(m.user_id),
      profile: profileZones.get(m.user_id),
    })
    if (!clockByZone.has(timeZone)) clockByZone.set(timeZone, localClock(timeZone, nowMs))
    const clock = clockByZone.get(timeZone)
    if (!clock || !wanted.has(clock.hour)) continue
    out.push({ memberId: m.id, userId: m.user_id, workspaceId: m.workspace_id, timeZone, timeZoneSource: source, date: clock.date, hour: clock.hour })
  }
  return out
}

type DigestEventRow = Pick<AgentEventRow, 'id' | 'kind' | 'facts' | 'occurs_at' | 'ref_type' | 'ref_id'>

export interface DigestGather {
  events: DigestEventRow[]
  logLines: AwayLogLine[]
  sinceIso: string
  /** Every row the digest carries: the lines' rows and the ones folded into them (marked delivered together). */
  carriedIds?: string[]
}

const EVENT_COLUMNS = 'id, kind, facts, occurs_at, expires_at, ref_type, ref_id'

function eventRows(data: unknown, nowMs: number): DigestEventRow[] {
  return ((Array.isArray(data) ? data : []) as Array<Record<string, unknown>>)
    .filter((r) => r.id != null && typeof r.kind === 'string' && typeof r.occurs_at === 'string')
    // A meeting that has started has nothing left to say in a morning summary.
    .filter((r) => !(typeof r.expires_at === 'string' && Date.parse(r.expires_at) <= nowMs))
    .map((r) => ({
      id: String(r.id),
      kind: r.kind as AgentEventKind,
      facts: r.facts && typeof r.facts === 'object' && !Array.isArray(r.facts) ? (r.facts as AgentEventRow['facts']) : {},
      occurs_at: r.occurs_at as string,
      ref_type: typeof r.ref_type === 'string' ? r.ref_type : null,
      ref_id: typeof r.ref_id === 'string' ? r.ref_id : null,
    }))
}

/**
 * When the last digest went to this conversation (a sent or written turn for
 * another day), or null. Throws on a failed read.
 */
export async function lastDigestAt(supabase: SupabaseClient, conversationId: string, date: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('home_turn')
    .select('created_at, dedupe_key, status')
    .eq('conversation_id', conversationId)
    .eq('reason', 'digest')
    .in('status', ['sent', 'done'])
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw new Error(`home_turn read failed: ${error.message}`)
  const row = ((data as Array<Record<string, unknown>> | null) ?? []).find(
    (r) => r.dedupe_key !== digestTurnKey(date) && typeof r.created_at === 'string' && Number.isFinite(Date.parse(r.created_at)),
  )
  return row ? (row.created_at as string) : null
}

/**
 * What a digest for this person would carry: their undelivered quiet or
 * notify rows (plus any a retried turn for the same date already marked),
 * restricted to `eventIds` when the cron named them, and the agent-log lines
 * since the last digest (at most DIGEST_LOOKBACK_MS back) that no row stands
 * for. Throws on a failed read.
 */
export async function gatherDigest(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; conversationId: string; date: string; nowMs?: number; eventIds?: readonly string[] },
): Promise<DigestGather> {
  const nowMs = args.nowMs ?? Date.now()
  const key = digestTurnKey(args.date)
  const last = await lastDigestAt(supabase, args.conversationId, args.date)
  const sinceMs = Math.max(nowMs - DIGEST_LOOKBACK_MS, last ? Date.parse(last) : 0)
  const sinceIso = new Date(sinceMs).toISOString()

  const [undelivered, mine] = await Promise.all([
    supabase
      .from('agent_event')
      .select(EVENT_COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .in('outcome', ['quiet', 'notify', 'turn'])
      .is('delivered_at', null)
      .neq('state', 'expired')
      // The most pressing first (as the away section reads), the newest within each.
      .order('priority', { ascending: false })
      .order('occurs_at', { ascending: false })
      .limit(HOME_TURN_MAX_DIGEST_EVENTS),
    supabase
      .from('agent_event')
      .select(EVENT_COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('delivered_key', key)
      .order('occurs_at', { ascending: false })
      .limit(HOME_TURN_MAX_DIGEST_EVENTS),
  ])
  if (undelivered.error) throw new Error(`agent_event read failed: ${undelivered.error.message}`)
  if (mine.error) throw new Error(`agent_event read failed: ${mine.error.message}`)
  const byId = new Map<string, DigestEventRow>()
  for (const r of [...eventRows(mine.data, nowMs), ...eventRows(undelivered.data, nowMs)]) byId.set(r.id, r)
  await markExpiredEvents(supabase, expiredIds(undelivered.data, nowMs))
  // What settled since (a draft sent, a question answered): left out, and marked so.
  const settled = await settledEventIds(supabase, { workspaceId: args.workspaceId, userId: args.userId }, [...byId.values()], nowMs)
  await markSettledEvents(supabase, settled, nowMs)
  const named = args.eventIds ? new Set(args.eventIds) : null
  const open = [...byId.values()].filter((e) => !settled.has(e.id) && (!named || named.has(e.id)))
  // One line per item: its most pressing row (the others ride along, delivered with it).
  const { kept, folded } = collapseByRef(open)
  const events = kept.slice(0, HOME_TURN_MAX_DIGEST_EVENTS)
  const carried = [...events, ...folded].map((e) => e.id).slice(0, HOME_TURN_MAX_DIGEST_EVENTS)

  const { data: logData, error: logError } = await supabase
    .from('agent_log')
    .select('id, at, kind, line, ref_type, ref_id')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .gt('at', sinceIso)
    .order('at', { ascending: false })
    .order('id', { ascending: false })
    .limit(DIGEST_LOG_LINES)
  if (logError) throw new Error(`agent_log read failed: ${logError.message}`)
  const eventRefs = new Set(events.filter((e) => e.ref_type && e.ref_id).map((e) => `${e.ref_type}:${e.ref_id}`))
  const logLines: AwayLogLine[] = ((logData as Array<Record<string, unknown>> | null) ?? [])
    // The morning tidy's line and a to-do mail closed: each one's own message in the home thread says it
    // (src/lib/email/auto-archive.ts, src/lib/email/action-done-from-mail.ts).
    .filter((l) => typeof l.at === 'string' && typeof l.line === 'string' && l.kind !== 'chat_checkpoint' && l.kind !== 'mail_archived' && l.kind !== 'action_done_from_mail' && l.kind !== 'look_ahead')
    .map((l) => ({
      at: l.at as string,
      line: l.line as string,
      ref_type: typeof l.ref_type === 'string' ? l.ref_type : null,
      ref_id: typeof l.ref_id === 'string' ? l.ref_id : null,
      kind: typeof l.kind === 'string' ? l.kind : null,
    }))
    .filter((l) => !(l.ref_type && l.ref_id && eventRefs.has(`${l.ref_type}:${l.ref_id}`)))
  return { events, logLines, sinceIso, carriedIds: carried }
}

/** The most doc-update lines the digest names (then "…and N more"). */
export const DIGEST_MAX_DOC_LINES = 6

/**
 * The digest's "Doc updates" group (canon D2, decision 16): one line per
 * agent edit to a canon document ("Native Intelligence updated Positioning in Product"),
 * newest first, after everything else. Empty when there were none (hide
 * empty). Pure.
 */
export function docUpdateLines(logLines: readonly AwayLogLine[]): string[] {
  const docs = [...logLines].filter((l) => l.kind === 'doc_updated').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (docs.length === 0) return []
  const shown = docs.slice(0, DIGEST_MAX_DOC_LINES).map((l) => `- ${l.line}`)
  if (docs.length > shown.length) shown.push(`- …and ${docs.length - shown.length} more`)
  return ['Doc updates (each can be undone from the document’s history):', ...shown]
}

/** The digest's body input for what was gathered, or null when there is nothing to say. Pure. */
export function digestBody(gather: Pick<DigestGather, 'events' | 'logLines' | 'carriedIds'>, args: { date: string; timeZone: string }): HomeTurnDigest | null {
  if (gather.events.length === 0 && gather.logLines.length === 0) return null
  const docLines = docUpdateLines(gather.logLines)
  const otherLog = gather.logLines.filter((l) => l.kind !== 'doc_updated')
  const { counts, lines } = eventSummaryParts({
    events: gather.events,
    logLines: otherLog,
    timeZone: args.timeZone,
    maxLines: DIGEST_MAX_LINES,
    logLabel: 'log line',
  })
  const docCount = gather.logLines.length - otherLog.length
  if (docCount > 0) counts.push(`${docCount} doc update${docCount === 1 ? '' : 's'}`)
  return { date: args.date, timeZone: args.timeZone, counts, lines: [...lines, ...docLines], eventIds: gather.carriedIds ?? gather.events.map((e) => e.id) }
}

/** Why the cron sent no digest for a person. */
export type DigestSkip = 'no_home_thread' | 'already_sent' | 'paused' | 'dormant' | 'nothing_new' | 'lookup_failed'

export interface DigestRequest {
  /** Inngest's event id: one request per conversation and local date. */
  id: string
  name: typeof HOME_TURN_REQUESTED_EVENT
  data: HomeTurnRequestedData
}

export interface DigestPlanDeps {
  /** The kill switch's three states (readAgentPausedState): anything but 'active' skips (fail closed). */
  pausedState: (supabase: SupabaseClient, workspaceId: string) => Promise<AgentPausedState>
  isDormant: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
}

/** The request the cron sends for one person. Pure. */
export function digestRequest(conversationId: string, c: Pick<DigestCandidate, 'userId' | 'workspaceId' | 'date'>, eventIds: readonly string[]): DigestRequest {
  return {
    id: `home-turn-digest:${conversationId}:${c.date}`,
    name: HOME_TURN_REQUESTED_EVENT,
    data: {
      conversationId,
      userId: c.userId,
      workspaceId: c.workspaceId,
      workItemIds: [],
      reason: 'digest',
      eventIds: eventIds.slice(0, HOME_TURN_MAX_DIGEST_EVENTS),
      digestDate: c.date,
    },
  }
}

/**
 * One candidate's decision (see the header). Never throws: a failed read is
 * `lookup_failed` (the person is skipped this hour; their rows wait for
 * "while you were away").
 */
export async function planDigestFor(
  supabase: SupabaseClient,
  c: DigestCandidate,
  deps: DigestPlanDeps,
  nowMs = Date.now(),
): Promise<{ ok: true; request: DigestRequest } | { ok: false; reason: DigestSkip }> {
  try {
    const { data: convs, error: convError } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('user_id', c.userId)
      .eq('workspace_id', c.workspaceId)
      .eq('is_home', true)
      .limit(1)
    if (convError) return { ok: false, reason: 'lookup_failed' }
    const conversationId = (convs as Array<{ id?: unknown }> | null)?.[0]?.id
    if (typeof conversationId !== 'string') return { ok: false, reason: 'no_home_thread' }

    const { data: turns, error: turnError } = await supabase
      .from('home_turn')
      .select('id, status')
      .eq('conversation_id', conversationId)
      .eq('dedupe_key', digestTurnKey(c.date))
      .limit(1)
    if (turnError) return { ok: false, reason: 'lookup_failed' }
    const turn = (turns as Array<{ status?: unknown }> | null)?.[0]
    // A failed turn may go again (the consumer decides whether its claim can be retaken).
    if (turn && turn.status !== 'failed') return { ok: false, reason: 'already_sent' }

    // Fails CLOSED: this spends money, so a switch that can't be read is off.
    const state = await deps.pausedState(supabase, c.workspaceId).catch((): AgentPausedState => 'unknown')
    if (state !== 'active') return { ok: false, reason: 'paused' }
    if (await deps.isDormant(supabase, c.workspaceId).catch(() => false)) return { ok: false, reason: 'dormant' }

    const gather = await gatherDigest(supabase, { workspaceId: c.workspaceId, userId: c.userId, conversationId, date: c.date, nowMs })
    if (!digestBody(gather, { date: c.date, timeZone: c.timeZone })) return { ok: false, reason: 'nothing_new' }
    return { ok: true, request: digestRequest(conversationId, c, gather.carriedIds ?? gather.events.map((e) => e.id)) }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
}

/**
 * Mark the digest's rows delivered (`delivered_key = digest:<date>`, and the
 * home turn that carried them), fenced on not delivered yet, so a row "while
 * you were away" already showed keeps its own key. Never throws.
 */
export async function markDigestDelivered(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; eventIds: readonly string[]; date: string; homeTurnId: string; nowMs?: number },
): Promise<number> {
  if (!args.eventIds.length) return 0
  try {
    const { data, error } = await supabase
      .from('agent_event')
      .update({
        state: 'delivered',
        delivered_at: new Date(args.nowMs ?? Date.now()).toISOString(),
        delivered_key: digestTurnKey(args.date),
        home_turn_id: args.homeTurnId,
      })
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .in('id', [...args.eventIds])
      .is('delivered_at', null)
      .select('id')
    if (error) {
      console.warn('[agent-digest] delivery mark skipped:', error.message)
      return 0
    }
    return Array.isArray(data) ? data.length : 0
  } catch (err) {
    console.warn('[agent-digest] delivery mark skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}

/** The group key of a person's digest notice for a date: one per day. */
export function digestNoticeGroupKey(date: string): string {
  return `agent_digest:${date}`
}

/** What the digest's bubble says: Native Intelligence's words around the counts (no outside text). Pure. */
export function digestNoticeCopy(digest: Pick<HomeTurnDigest, 'counts'>): { title: string; sentence: string } {
  const counts = digest.counts.slice(0, 3)
  return {
    title: 'Your morning digest',
    sentence: counts.length ? `Your morning digest is in our thread: ${counts.join(' · ')}.` : 'Your morning digest is in our thread.',
  }
}

async function noticeIdByGroup(supabase: SupabaseClient, memberId: string, groupKey: string): Promise<string | null> {
  const { data } = await supabase
    .from('notification')
    .select('id')
    .eq('recipient_id', memberId)
    .eq('group_key', groupKey)
    .eq('type', 'agent_digest')
    .order('created_at', { ascending: false })
    .limit(1)
  const id = Array.isArray(data) ? (data[0] as { id?: unknown } | undefined)?.id : null
  return typeof id === 'string' ? id : null
}

/**
 * ONE `agent_digest` notice on the face for the day's digest, from the
 * Assistant (the one face; A3 maps it): sent once per person per date (a
 * notice already carrying the day's group key is returned, not re-sent).
 * Resolves to the notice id, or null. Never throws.
 */
export async function sendDigestNotice(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; conversationId: string; homeTurnId: string; digest: HomeTurnDigest },
): Promise<string | null> {
  try {
    const { data: member, error } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (error || typeof memberId !== 'string') return null
    const groupKey = digestNoticeGroupKey(args.digest.date)
    const existing = await noticeIdByGroup(supabase, memberId, groupKey)
    if (existing) return existing
    const face = await systemTeammateId(supabase, args.workspaceId, 'assistant')
    const copy = digestNoticeCopy(args.digest)
    const bot = face
      ? botNoticeMetadata({ teammateId: face, teammateName: await noticeTeammateName(supabase, args.workspaceId, face), sentence: copy.sentence })
      : {}
    const said = botNoticeCopy(bot, { title: copy.title, body: copy.sentence })
    await createNotification({
      workspaceId: args.workspaceId,
      recipientId: memberId,
      type: 'agent_digest',
      title: said.title,
      body: said.body,
      groupKey,
      metadata: {
        conversation_id: args.conversationId,
        home_turn_id: args.homeTurnId,
        digest_date: args.digest.date,
        counts: args.digest.counts.slice(0, 6),
        ...bot,
      },
    })
    return noticeIdByGroup(supabase, memberId, groupKey)
  } catch (err) {
    console.warn('[agent-digest] notice skipped:', err instanceof Error ? err.message : err)
    return null
  }
}

/** One `[agent-digest]` line per pass. Pure. */
export function digestLogLine(r: { candidates: number; sent: number; tidies?: number; skips: Partial<Record<DigestSkip, number>> }): string {
  const skips = Object.entries(r.skips)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ')
  return `[agent-digest] candidates=${r.candidates} sent=${r.sent}${r.tidies !== undefined ? ` tidies=${r.tidies}` : ''}${skips ? ` ${skips}` : ''}`
}
