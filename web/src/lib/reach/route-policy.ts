/**
 * Which of the agent's messages in the home thread follow the person out of
 * the app, and what each one says when it does (docs/plans/reach-follows-you.md
 * §3, Liam's answers in §7). The router (./route.ts) gathers the rows, decides
 * where they go and sends them; this file only reads one row at a time, so it
 * is pure: no reads, no clock.
 *
 *   routes                                   never routes
 *   a home turn's written message:           a text or Slack turn's reply
 *     helper_report, event, digest,            (answered in that channel)
 *     check_in, guest_ask, agent_answer,     an approval's result
 *     approval                               a run's batched suggestions
 *   the look-ahead, when it has a text and   a teammate's report chip
 *     is still ahead of what it is about     a prep-only report (a banner, no text)
 *   a guest's note, a guest's request        a look-ahead past its shelf life
 *   an approval asked at home
 *
 * The system decides where a message goes; the agent decides only whether to
 * say something (Liam, 2026-10-31). Nothing here is the model's choice: the
 * one signal the agent gives is how urgent a message is
 * (`metadata.urgent_by`), and only the router reads it.
 *
 * What a text says is the message's own final answer (replyTextOfParts: never
 * the narration between tool calls), then each held approval's reply-code
 * prompt; a look-ahead's checked text; a guest's own words, never clipped.
 */
import { approvalIdOfToolOutput, ASK_MESSAGE_KIND } from '@/lib/attention/chat-asks'
import { replyTextOfParts } from '@/lib/chat/channel-reply'
import { HOME_TURN_KIND, type HomeTurnReason } from '@/lib/chat/home-turn'
import {
  GUEST_MESSAGE_MESSAGE_KIND as GUEST_MESSAGE_KIND,
  GUEST_MESSAGE_PART_TYPE,
  GUEST_REQUEST_MESSAGE_KIND as GUEST_REQUEST_KIND,
  GUEST_REQUEST_PART_TYPE,
  guestVia,
  type GuestChannel,
} from '@/lib/guests/chat-parts'
import { LOOK_AHEAD_MESSAGE_KIND } from '@/lib/look-ahead/message-kind'
import { lookAheadTextKey } from '@/lib/look-ahead/message'
import { isIsoInstant, isUuid } from '@/lib/presence/presence'
import type { ReachRefType } from './notice'

/** The home-turn reasons whose written message routes. Text, Slack and a linked agent's ask are answered where they came from. */
export const ROUTED_HOME_TURN_REASONS: ReadonlySet<HomeTurnReason> = new Set<HomeTurnReason>([
  'helper_report',
  'event',
  'digest',
  'check_in',
  'guest_ask',
  'agent_answer',
  'approval',
])

/**
 * The message kinds the router reads (ui_message.metadata.kind), for its one
 * query. Everything else in the thread (report chips, guest activity lines,
 * batched suggestions, an approval's result) never routes.
 */
export const ROUTED_MESSAGE_KINDS = [HOME_TURN_KIND, LOOK_AHEAD_MESSAGE_KIND, GUEST_MESSAGE_KIND, GUEST_REQUEST_KIND, ASK_MESSAGE_KIND] as const

/** The home-turn reasons whose writer already put a notification on the face (agent_digest, agent_check_in): no banner of the router's. */
const NOTIFYING_REASONS: ReadonlySet<string> = new Set(['digest', 'check_in'])

/**
 * A look-ahead message written before its writer stamped `look_ahead_until`:
 * it goes stale this long after it was written (the evening's 19:00 message
 * by quiet hours at 21:00).
 */
export const LOOK_AHEAD_FALLBACK_SHELF_MS = 2 * 60 * 60_000

/** How far ahead an urgent message's deadline may be and still get through quiet hours. */
export const URGENT_MAX_AHEAD_MS = 18 * 60 * 60_000
/** And no later than this long after quiet hours end: a deadline at noon can wait for the morning. */
export const URGENT_AFTER_QUIET_MS = 2 * 60 * 60_000

/** One home-thread row as the router reads it. */
export interface RouteRow {
  /** chat_messages.id */
  id: string
  created_at: string
  ui_message: { id?: unknown; parts?: unknown; metadata?: Record<string, unknown> | null } | null
}

export type RouteKind = 'home_turn' | 'look_ahead' | 'guest_message' | 'guest_request' | 'approval_ask'

/** What a message is claimed under in reach_notice: one send per thing and channel. */
export interface RouteRef {
  type: ReachRefType
  id: string
}

export interface RoutedMessage {
  kind: RouteKind
  /** Its claim. A message whose ref was claimed on any channel already went out. */
  ref: RouteRef
  /** What a text says before any approval's prompt; '' when only approvals are carried. Null: nothing to text (a banner at most). */
  text: string | null
  /** False: a banner when the person is at an app, never a text (a prep-only report, a look-ahead with nothing textable). */
  textable: boolean
  /** Its writer already put a notification on the face (a look-ahead, a digest, a check-in): the router adds no banner. */
  notifies: boolean
  /** The approvals it carries, by tool_approval id: each one's reply-code prompt follows the text while it is still pending. */
  approvalIds: string[]
  /** The agent marked it urgent: an ISO 8601 deadline with an offset (part D), else null. */
  urgentBy: string | null
}

export type RowRoute = ({ routes: true } & RoutedMessage) | { routes: false }

const NEVER: RowRoute = { routes: false }

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The approvals a home turn held as the person's cards: each `APPROVAL_REQUIRED` call's approval id, in order. */
export function heldApprovalIds(parts: unknown): string[] {
  const ids: string[] = []
  for (const p of Array.isArray(parts) ? (parts as Array<Record<string, unknown>>) : []) {
    if (p?.type !== 'dynamic-tool' || p.state !== 'output-available' || typeof p.toolName !== 'string') continue
    const id = approvalIdOfToolOutput(p.toolName, p.output)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function urgentByOf(meta: Record<string, unknown>): string | null {
  return isIsoInstant(meta.urgent_by) ? meta.urgent_by : null
}

/** An ISO 8601 instant at the end of a travel heads-up's id (`look-ahead:travel:<key>:<startIso>`; the key may hold colons). */
const TRAVEL_START_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))$/

/**
 * When a look-ahead stops being worth a text: its writer's `look_ahead_until`
 * (the evening's quiet start, the first item's start, a departure's time),
 * else, for an older row, a departure's start from its id or two hours after
 * it was written. Null when nothing says. Pure.
 */
export function lookAheadUntil(row: RouteRow): number | null {
  const meta = row.ui_message?.metadata ?? {}
  if (isIsoInstant(meta.look_ahead_until)) return Date.parse(meta.look_ahead_until)
  const id = typeof row.ui_message?.id === 'string' ? row.ui_message.id : ''
  if (id.startsWith('look-ahead:travel:')) {
    const start = TRAVEL_START_RE.exec(id)?.[1]
    return start && Number.isFinite(Date.parse(start)) ? Date.parse(start) : null
  }
  const written = Date.parse(row.created_at)
  return Number.isFinite(written) ? written + LOOK_AHEAD_FALLBACK_SHELF_MS : null
}

function firstPartData(parts: unknown, type: string): Record<string, unknown> | null {
  const part = Array.isArray(parts) ? (parts as Array<{ type?: unknown; data?: unknown }>).find((p) => p?.type === type) : undefined
  return part?.data && typeof part.data === 'object' ? (part.data as Record<string, unknown>) : null
}

/**
 * Whether one row routes, and how (the table in the header). `userId` keys a
 * look-ahead's claim per person (lookAheadTextKey: one text per person, slot
 * and date, whichever workspace writes it); `nowMs` ends a look-ahead's shelf
 * life (a morning's car pick-up never goes out after the morning). Pure but
 * for the default clock.
 */
export function routeOf(row: RouteRow, userId: string, nowMs: number = Date.now()): RowRoute {
  const ui = row.ui_message
  const meta = ui?.metadata && typeof ui.metadata === 'object' ? ui.metadata : {}
  const parts = ui?.parts
  const urgentBy = urgentByOf(meta)
  switch (meta.kind) {
    case HOME_TURN_KIND: {
      if (typeof meta.reason !== 'string' || !ROUTED_HOME_TURN_REASONS.has(meta.reason as HomeTurnReason)) return NEVER
      // A reply posted back to a channel (text, Slack) was answered there.
      if (typeof meta.channel === 'string') return NEVER
      // A quiet turn written only for its card (finishHomeTurn's ended_quiet): its words were narration, so the card goes alone.
      const text = meta.ended_quiet === true ? '' : replyTextOfParts(parts)
      const approvalIds = heldApprovalIds(parts)
      if (!text && approvalIds.length === 0) return NEVER
      return {
        routes: true,
        kind: 'home_turn',
        ref: { type: 'home_message', id: row.id },
        text,
        // A report that is only meeting preps (finishHomeTurn's prep_only) is a banner: the prep waits for the meeting.
        textable: meta.prep_only !== true,
        notifies: NOTIFYING_REASONS.has(meta.reason),
        approvalIds,
        urgentBy,
      }
    }
    case LOOK_AHEAD_MESSAGE_KIND: {
      const messageId = typeof ui?.id === 'string' ? ui.id : null
      if (!messageId) return NEVER
      // Only its checked text (no booking found only in mail, no unanswered invite). With none there is nothing
      // to do: it already notified, and it never texts.
      const sms = typeof meta.look_ahead_sms === 'string' && meta.look_ahead_sms.trim() ? meta.look_ahead_sms.trim() : null
      if (!sms) return NEVER
      // Its shelf life: "Tomorrow morning: 7:30 am" is wrong the next day, a heads-up after the departure is noise.
      const until = lookAheadUntil(row)
      if (until !== null && until <= nowMs) return NEVER
      return { routes: true, kind: 'look_ahead', ref: { type: 'look_ahead', id: lookAheadTextKey(userId, messageId) }, text: sms, textable: true, notifies: true, approvalIds: [], urgentBy }
    }
    case GUEST_MESSAGE_KIND: {
      const data = firstPartData(parts, GUEST_MESSAGE_PART_TYPE)
      const guest = data?.guest && typeof data.guest === 'object' ? (data.guest as Record<string, unknown>) : null
      const name = typeof guest?.name === 'string' ? oneLine(guest.name) : ''
      const words = typeof data?.text === 'string' ? data.text.trim() : ''
      const fromId = typeof ui?.id === 'string' && ui.id.startsWith('guest-message:') ? ui.id.slice('guest-message:'.length) : null
      const noteId = isUuid(meta.note_id) ? meta.note_id : isUuid(fromId) ? fromId : null
      if (!name || !words || !noteId) return NEVER
      return {
        routes: true,
        kind: 'guest_message',
        ref: { type: 'guest_message', id: noteId },
        // Their own words, whole: a guest's note is never clipped.
        text: `${name} (to your agent, ${guestVia(guest?.channel === 'slack' || guest?.channel === 'dial8' ? (guest.channel as GuestChannel) : 'sms')}): ${words}`,
        textable: true,
        notifies: false,
        approvalIds: [],
        urgentBy: urgentBy ?? (isIsoInstant(data?.urgent_by) ? (data.urgent_by as string) : null),
      }
    }
    case GUEST_REQUEST_KIND: {
      const data = firstPartData(parts, GUEST_REQUEST_PART_TYPE)
      if (!data || data.status !== 'pending') return NEVER
      // Never the name they texted (anyone with the code can JOIN): the last four digits only.
      const last4 = typeof data.phone_last4 === 'string' && /^\d{4}$/.test(data.phone_last4) ? data.phone_last4 : null
      const text = last4
        ? `Someone asked to text your agent from a number ending ${last4}. Allow or ignore them in Dial8.`
        : 'Someone asked to text your agent. Allow or ignore them in Dial8.'
      return { routes: true, kind: 'guest_request', ref: { type: 'home_message', id: row.id }, text, textable: true, notifies: false, approvalIds: [], urgentBy: null }
    }
    case ASK_MESSAGE_KIND: {
      const approvalId = isUuid(meta.approval_id) ? meta.approval_id : null
      if (!approvalId) return NEVER
      const line = Array.isArray(parts) ? (parts as Array<{ type?: unknown; text?: unknown }>).find((p) => p?.type === 'text' && typeof p.text === 'string') : undefined
      return {
        routes: true,
        kind: 'approval_ask',
        // Claimed as the approval, so a text turn's own prompt for it (textRaisedApprovals) and this one never both go.
        ref: { type: 'tool_approval', id: approvalId },
        text: typeof line?.text === 'string' ? line.text.trim() : '',
        textable: true,
        notifies: false,
        approvalIds: [approvalId],
        urgentBy,
      }
    }
    default:
      return NEVER
  }
}

/** A message with what it carries, ready to send: its text, and the approvals still pending (in order). */
export interface OutboundMessage<A = unknown> {
  text: string
  approvals: A[]
}

/**
 * The text a message goes out as: its words, then each approval's reply-code
 * prompt (`prompt`: src/lib/sms/approvals.ts approvalPromptText), blank lines
 * between. '' when there is nothing. Pure.
 */
export function awayTextBody<A>(message: OutboundMessage<A>, prompt: (approval: A) => string): string {
  return [message.text.trim(), ...message.approvals.map(prompt)].filter((s) => s.length > 0).join('\n\n')
}

/**
 * Whether an urgent message gets through quiet hours now (part D): its
 * deadline is in the future, at most 18 h away, and no later than 2 h after
 * quiet hours end (`quietEndMs`). Jess at 21:07 about a 09:00 call goes at
 * once; a deadline at noon waits for the morning. Pure.
 */
export function urgentNow(urgentBy: string | null, nowMs: number, quietEndMs: number): boolean {
  if (!urgentBy) return false
  const by = Date.parse(urgentBy)
  if (!Number.isFinite(by)) return false
  return by > nowMs && by - nowMs <= URGENT_MAX_AHEAD_MS && by <= quietEndMs + URGENT_AFTER_QUIET_MS
}

/** The words of the person's banner (an `agent_message` notification): the newest message's first words, and how many more there are. Pure. */
export function agentMessageNoticeCopy(preview: string | null, count: number): { title: string; sentence: string } {
  const more = count > 1 ? ` (+${count - 1} more)` : ''
  const line = preview ? oneLine(preview) : ''
  if (!line) return { title: 'New message', sentence: count > 1 ? `${count} new messages in our thread.` : 'A new message in our thread.' }
  return { title: 'New message', sentence: `${line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line}${more}` }
}
