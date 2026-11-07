/**
 * The event turn (A6 follow-up; docs/plans/always-on-agent.md §5 "needs the
 * agent's judgment now: a turn on the home thread"). The router sorts some
 * rows `turn` (./router.ts turnRuleFor: mail from someone the person knows
 * that needs a reply, a meeting the live agent left open asks or staged
 * proposals in, a teammate's mention, a reminder coming due, a failure; or
 * Jev's pick where it is proven, ./router.ts applyJev) and asks for one home
 * turn, reason 'event'. Its plan (src/lib/chat/home-turn-server.ts) runs
 * gatherEventTurn:
 *
 *   • every undelivered `turn` row of the person's from the last
 *     EVENT_TURN_WINDOW_MS (the debounce keeps only the last request, so the
 *     payload's ids are never trusted for what to carry);
 *   • minus what settled since (./freshness.ts: a draft sent, a thread
 *     answered, an approval decided), marked so it is never read again.
 *
 * The body names each thread or item in a line, by Dial8's own phrase around
 * a clipped title (a mail row: the sender's address, never a subject), with its pointer (`email_draft <id>`,
 * `capture <id>`…) so the agent can open it with its read tools and point the
 * person at the review pile. Never mail text. Once the agent WROTE a reply,
 * the rows are marked delivered (`home_turn:<row id>`). A quiet turn (no_reply)
 * means the agent judged them handled: they are marked too (so the next mail
 * doesn't bring them back), except an approval, which still waits on the
 * person and stays for "while you were away" and the digest.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { clipLogText } from '@/lib/log/agent-log'
import type { HomeTurnEvents } from '@/lib/chat/home-turn'
import { HOME_TURN_MAX_DIGEST_EVENTS } from '@/lib/chat/home-turn'
import { markSettledEvents, settledEventIds } from './freshness'
import { EMAIL_KIND_PHRASE, MENTION_PHRASE } from './away-section'
import { meetingWhen } from './meeting-time'
import { NOTICE_KINDS, type AgentEventKind, type AgentEventRow } from './types'

/**
 * The kinds a quiet turn never delivers: they wait on the person (a question,
 * a failure, an approval), or the person asked for them (a reminder), so a
 * `[quiet]` reply leaves them for "while you were away" and the digest.
 */
export const UNSEEN_WAITING_KINDS: readonly AgentEventKind[] = ['work.needs_input', 'work.failed', 'work.approval', 'reminder.due', 'sequence.failed', 'connection.needs_reconnect', 'quote.received']

/** How far back an event turn looks for undelivered turn rows. */
export const EVENT_TURN_WINDOW_MS = 24 * 60 * 60_000
/** At most this many lines in one event turn (then "…and N more"). */
export const EVENT_TURN_MAX_LINES = 12

export type EventTurnRow = Pick<AgentEventRow, 'id' | 'kind' | 'facts' | 'occurs_at' | 'ref_type' | 'ref_id'>

/**
 * The person's undelivered turn rows, oldest first, minus the settled ones
 * (marked). Throws on a failed read.
 */
export async function gatherEventTurn(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; nowMs?: number },
): Promise<EventTurnRow[]> {
  const nowMs = args.nowMs ?? Date.now()
  const { data, error } = await supabase
    .from('agent_event')
    .select('id, kind, facts, occurs_at, expires_at, ref_type, ref_id')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .eq('outcome', 'turn')
    .eq('state', 'routed')
    .is('delivered_at', null)
    .gte('created_at', new Date(nowMs - EVENT_TURN_WINDOW_MS).toISOString())
    .order('occurs_at', { ascending: true })
    .limit(HOME_TURN_MAX_DIGEST_EVENTS)
  if (error) throw new Error(`agent_event read failed: ${error.message}`)
  const rows: EventTurnRow[] = ((data as Array<Record<string, unknown>> | null) ?? [])
    .filter((r) => r.id != null && typeof r.kind === 'string' && typeof r.occurs_at === 'string')
    .filter((r) => !(typeof r.expires_at === 'string' && Date.parse(r.expires_at) <= nowMs))
    .map((r) => ({
      id: String(r.id),
      kind: r.kind as AgentEventKind,
      facts: r.facts && typeof r.facts === 'object' && !Array.isArray(r.facts) ? (r.facts as AgentEventRow['facts']) : {},
      occurs_at: r.occurs_at as string,
      ref_type: typeof r.ref_type === 'string' ? r.ref_type : null,
      ref_id: typeof r.ref_id === 'string' ? r.ref_id : null,
    }))
  const settled = await settledEventIds(supabase, args, rows, nowMs)
  await markSettledEvents(supabase, settled, nowMs)
  return rows.filter((r) => !settled.has(r.id))
}

/**
 * Why a thread got no draft, when a limit held it back (the mail seam's
 * templated `reason`): such a thread is never drafted by an event turn's
 * helper either, which would get round the limit.
 */
export const NO_DRAFT_BECAUSE: Readonly<Record<string, string>> = {
  cap: "today's limit of automatic drafts was reached",
  paused: 'agent work is switched off',
  usage: 'the AI usage limit was reached',
  dormant: 'drafting is paused while the workspace is quiet',
}

/**
 * A pointer the agent can open with its read tools (never outside text). A
 * notice's event points at its notification, which the agent can't open: its
 * pointer is what the notification points at (an action, a capture…), when
 * known.
 */
function pointer(row: Pick<EventTurnRow, 'kind' | 'facts' | 'ref_type' | 'ref_id'>): string {
  if (NOTICE_KINDS.has(row.kind)) {
    const f = row.facts ?? {}
    return typeof f.targetType === 'string' && typeof f.targetId === 'string' && f.targetType && f.targetId
      ? ` [${f.targetType.slice(0, 40)} ${f.targetId.slice(0, 120)}]`
      : ''
  }
  return row.ref_type && row.ref_id ? ` [${row.ref_type} ${row.ref_id.slice(0, 120)}]` : ''
}

/**
 * One row's line: Dial8's phrase around a clipped title, then its pointer.
 * A mail row names the sender's address and its contact pointer, never a
 * subject (no stored mail): the agent reads the thread live if it must. A
 * meeting change names its times in `timeZone` (the person's), with the zone,
 * so the agent never works out a time itself. Pure.
 */
export function eventTurnLine(row: EventTurnRow, timeZone: string | null = null): string {
  const f = row.facts ?? {}
  const title = clipLogText(f.title, 80) ?? 'Untitled'
  const from = clipLogText(f.from, 120)
  const by = from ? ` from ${from}` : ''
  const contact = typeof f.contactId === 'string' && f.contactId ? ` [contact ${f.contactId.slice(0, 64)}]` : ''
  switch (row.kind) {
    case 'email.drafted':
      return `- Reply needed${by}${contact}. A draft is ready in the review pile (Mail, To review).${pointer(row)}`
    case 'email.needs_reply': {
      // E3 (decision 1): Jev wasn't sure a reply is needed, so none was guessed at: ask first.
      if (f.reason === 'unsure') {
        return `- Maybe a reply${by}${contact}: Dial8 wasn't sure one is needed, so none was drafted. Ask the person whether they want a reply; draft one only if they say yes.${pointer(row)}`
      }
      // A draft held back by a limit stays held back: say why, and that it is not to be drafted.
      const held = typeof f.reason === 'string' ? NO_DRAFT_BECAUSE[f.reason] : undefined
      return held
        ? `- Reply needed${by}${contact}. No draft: ${held}. Do not draft it; tell the person.${pointer(row)}`
        : `- Reply needed${by}${contact}. No draft yet.${pointer(row)}`
    }
    case 'capture.processed': {
      const asks = f.openAsks ?? 0
      const proposals = f.pendingProposals ?? 0
      const parts = [
        asks > 0 ? `${asks} open ${asks === 1 ? 'question' : 'questions'} from the live agent nobody answered in the call` : null,
        proposals > 0 ? `${proposals} staged ${proposals === 1 ? 'proposal' : 'proposals'} waiting for review` : null,
      ].filter(Boolean)
      // Their first capture while getting started (docs/plans/getting-started-skill.md): its step 3.
      if (f.firstRun === true) {
        const left = parts.length ? ` Also: ${parts.join('; ')}.` : ''
        return `- Their first capture while getting started is processed: “${title}”. Its notes and to-dos are ready: show them what it pulled out (getting-started step 3).${left}${pointer(row)}`
      }
      // Raised by Jev (router.ts applyJev) with nothing left open: the meeting itself is the news.
      if (!parts.length) return `- Meeting over: “${title}”. Its summary, actions and decisions are ready.${pointer(row)}`
      return `- Meeting over: “${title}”: ${parts.join('; ')}.${pointer(row)}`
    }
    case 'email.arrived': {
      const what = (EMAIL_KIND_PHRASE[f.emailKind ?? ''] ?? 'An email').toLowerCase()
      const ask = f.needsInput ? ' It asks them for something only they can answer.' : ''
      return `- ${what.charAt(0).toUpperCase()}${what.slice(1)}${by}${contact}${f.shouldKnow ? ', worth telling the person about' : ''}.${ask} Read it live before saying what it is.${pointer(row)}`
    }
    case 'meeting.changed': {
      const n = typeof f.attendeeCount === 'number' ? f.attendeeCount : 0
      const others = n > 0 ? ` (with ${n} ${n === 1 ? 'other person' : 'other people'})` : ''
      const was = meetingWhen(row.occurs_at, timeZone)
      if (f.change === 'moved' && f.movedTo) {
        return `- A meeting moved: “${title}”${others}, from ${was} to ${meetingWhen(f.movedTo, timeZone)}.${pointer(row)}`
      }
      if (f.change === 'cancelled') return `- A meeting was cancelled: “${title}”${others}, which was at ${was}.${pointer(row)}`
      return `- A meeting is no longer on the person's calendar: “${title}”${others}, which was at ${was} (cancelled, or moved more than a day away).${pointer(row)}`
    }
    case 'work.approval': {
      // An unattended run's card asks in this thread (P13); a chat door's sits in the chat that raised it.
      const where = f.door === 'chat' ? 'Its card is in the chat that asked for it' : 'Its card is already in this thread'
      return `- Waiting for the person's approval (held by ${f.door === 'chat' ? 'a chat' : `an unattended ${clipLogText(f.door, 20) ?? 'run'}`}): “${title}”. ${where}; only the person can approve it there.${pointer(row)}`
    }
    case 'mention':
      return `- ${MENTION_PHRASE[f.notificationType ?? ''] ?? 'A teammate wants them'}: “${title}”.${pointer(row)}`
    case 'reminder.due':
      return `- A reminder the person set came due: “${title}”.${pointer(row)}`
    case 'work.failed':
      return `- A background job failed: “${title}”.${pointer(row)}`
    case 'sequence.failed':
      return `- An outreach sequence of theirs had a problem: “${title}”.${pointer(row)}`
    case 'connection.needs_reconnect': {
      // Dial8's own catalog id (cleanFacts kept it short): connect takes it.
      const catalogId = typeof f.catalogId === 'string' && /^[a-z0-9-]{1,40}$/.test(f.catalogId) ? f.catalogId : null
      const how = catalogId
        ? `Call connect with catalog_id "${catalogId}": its card's Reconnect signs them in again, keeping its tool settings.`
        : 'Its Reconnect button is on its page in Settings › Connectors; point them there.'
      return `- “${title}” needs the person to sign in again: its sign-in expired and couldn't be renewed, so its tools fail until they reconnect. ${how} Say it once, in a line.${pointer(row)}`
    }
    case 'quote.received':
      // Roadmap B1: the title is Dial8's own words and numbers (receive.ts quoteEventTitle); what the customer typed is read with get_quote, fenced.
      // Roadmap F3: the owner's yes is book_quote (a time the customer chose) or send_quote (the price and the booking link), each its own card.
      return `- A new quote request from the business's website, ${title}.${contact} Read it with get_quote, then tell the person in a few lines who it is, what they want and the price. If the customer already chose a time (its requested dates, or their notes), offer to book it and on their yes call book_quote; otherwise ask for or confirm the price and on their yes call send_quote. A payment link can follow (send_payment_link, its own card).${pointer(row)}`
    case 'job.paid':
      // Roadmap C2: Dial8's own words (paid.ts paidText); the owner's text about it didn't go out.
      return `- A customer paid: “${title}”. Tell the person in a line; nothing else to do.${pointer(row)}`
    default:
      return `- ${title}${pointer(row)}`
  }
}

/** The event turn's body input, or null when there is nothing to carry. Pure. */
export function eventTurnBody(rows: readonly EventTurnRow[], timeZone: string | null = null): HomeTurnEvents | null {
  if (!rows.length) return null
  const lines = rows.map((row) => eventTurnLine(row, timeZone))
  const shown = lines.slice(0, EVENT_TURN_MAX_LINES)
  if (lines.length > shown.length) shown.push(`- …and ${lines.length - shown.length} more`)
  return { lines: shown, eventIds: rows.map((r) => r.id) }
}

/**
 * Mark rows a home turn carried delivered (`delivered_key = home_turn:<row>`,
 * `home_turn_id`), fenced on not delivered yet. Never throws; the count marked.
 */
export async function markEventsDelivered(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; eventIds: readonly string[]; homeTurnId: string; nowMs?: number; exceptWaiting?: boolean },
): Promise<number> {
  if (!args.eventIds.length) return 0
  try {
    let query = supabase
      .from('agent_event')
      .update({
        state: 'delivered',
        delivered_at: new Date(args.nowMs ?? Date.now()).toISOString(),
        delivered_key: `home_turn:${args.homeTurnId}`,
        home_turn_id: args.homeTurnId,
      })
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .in('id', [...args.eventIds])
      .is('delivered_at', null)
      .eq('state', 'routed')
    // A quiet turn: the agent judged these handled, so they are not told again
    // with the next mail; only what waits on the person (an approval) stays.
    if (args.exceptWaiting) query = query.not('kind', 'in', `(${UNSEEN_WAITING_KINDS.join(',')})`)
    const { data, error } = await query.select('id')
    if (error) {
      console.warn('[agent-event] home turn delivery mark skipped:', error.message)
      return 0
    }
    return Array.isArray(data) ? data.length : 0
  } catch (err) {
    console.warn('[agent-event] home turn delivery mark skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * A helper's report turn covered these work items: their undelivered rows
 * (a question, a review, a failure, a finish) are delivered by it, so the
 * away section and the digest don't say them again (one helper result, one
 * telling). On a QUIET turn (`exceptWaiting`) the waiting kinds (a question,
 * a failure, an approval) stay undelivered: nobody told the person. Only routed rows: one still `new` is the router's, an expired one stays expired. Never
 * throws; the count marked.
 */
export async function markWorkEventsDelivered(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; workItemIds: readonly string[]; homeTurnId: string; nowMs?: number; exceptWaiting?: boolean },
): Promise<number> {
  if (!args.workItemIds.length) return 0
  try {
    let query = supabase
      .from('agent_event')
      .update({
        state: 'delivered',
        delivered_at: new Date(args.nowMs ?? Date.now()).toISOString(),
        delivered_key: `home_turn:${args.homeTurnId}`,
        home_turn_id: args.homeTurnId,
      })
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('ref_type', 'work_item')
      .in('ref_id', [...args.workItemIds])
      .is('delivered_at', null)
      .eq('state', 'routed')
    // A quiet turn told nobody: a question, a failure or an approval stays for the away section.
    if (args.exceptWaiting) query = query.not('kind', 'in', `(${UNSEEN_WAITING_KINDS.join(',')})`)
    const { data, error } = await query.select('id')
    if (error) {
      console.warn('[agent-event] report delivery mark skipped:', error.message)
      return 0
    }
    return Array.isArray(data) ? data.length : 0
  } catch (err) {
    console.warn('[agent-event] report delivery mark skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}
