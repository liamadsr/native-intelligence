/**
 * One inbox (docs/plans/channels-inbox.md, phase 2): what needs the person,
 * made of the records that already say so. Nothing here is stored as an
 * item: the list is the person's own notifications (Signal channels'
 * messages, DMs, mentions, assignments, comments, shares, reminders, work
 * that needs them), grouped by conversation, and their mail that needs a
 * reply or is important. The inbox owns one thing only, "held until"
 * (migration 702's inbox_hold).
 *
 * Pure and client-safe: the route reads the rows, this file makes the list.
 *
 *   key         `n:<group_key>` for a grouped conversation (a channel's own
 *               messages, a thread), `n:<id>` for a notification on its own,
 *               `mail:<thread index id>` for a mail thread: what a hold names.
 *   Done        a notification item: every row in it archived (is_archived);
 *               a mail item: the thread archived, as Mail's E does.
 *   Hold        gone from the list until `held_until`, then back at the top;
 *               back sooner if something new arrives in it after it was held.
 */

/** A notification row as the inbox reads it (the columns the shell's route reads). */
export interface InboxNotificationRow {
  id: string
  type: string
  title: string | null
  body: string | null
  actor_id: string | null
  target_type: string | null
  target_id: string | null
  context_type: string | null
  context_id: string | null
  is_read: boolean
  group_key: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  actor?: { id: string; display_name: string | null; avatar_url: string | null } | null
}

/** A mail thread that needs the person, as the inbox reads it (subject read live, as Mail does). */
export interface InboxMailRow {
  /** The thread's index row (email_thread_index.id). */
  id: string
  provider_thread_id: string
  account_id: string | null
  last_message_at: string | null
  is_unread: boolean
  needs_reply: boolean
  auto_classified: string | null
  subject?: string | null
  from_name?: string | null
  from_email?: string | null
  snippet?: string | null
}

/** A hold (migration 702's inbox_hold): an item away until a time. */
export interface InboxHold {
  item_key: string
  held_until: string
  held_at: string
}

export type InboxCategory = 'messages' | 'mentions' | 'mail' | 'other'
export const INBOX_FILTERS = ['all', 'messages', 'mentions', 'mail', 'held'] as const
export type InboxFilter = (typeof INBOX_FILTERS)[number]

export function isInboxFilter(value: unknown): value is InboxFilter {
  return typeof value === 'string' && (INBOX_FILTERS as readonly string[]).includes(value)
}

/** Where an item opens, in the inbox's own pane. */
export type InboxOpen =
  | { kind: 'team_chat'; channelId: string; messageId: string; threadRootId: string | null }
  | { kind: 'mail'; threadIndexId: string; providerThreadId: string; accountId: string | null }
  | { kind: 'record'; type: string; id: string }
  | { kind: 'none' }

export interface InboxItem {
  key: string
  source: 'notification' | 'mail'
  category: InboxCategory
  /** The newest moment in it. */
  at: string
  title: string
  body: string | null
  unread: boolean
  /** How many notifications it gathers (a conversation's messages); 1 for mail. */
  count: number
  /** The notifications Done archives and opening reads. */
  notificationIds: string[]
  actor: { id: string; name: string; avatarUrl: string | null } | null
  open: InboxOpen
  /** The type behind it ('team_chat_message', 'mentioned', 'mail', …): its icon. */
  type: string
  /** While held: when it comes back. */
  heldUntil?: string
}

/** Notification types the inbox counts as "mentions and assignments". */
const MENTION_TYPES = new Set(['mentioned', 'action_assigned', 'comment_added', 'comment_reply', 'record_shared', 'capture_shared'])

/** A notification type's category. */
export function notificationCategory(type: string): InboxCategory {
  if (type === 'team_chat_message') return 'messages'
  if (MENTION_TYPES.has(type)) return 'mentions'
  return 'other'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/** Where a notification opens: its team chat message, else the record it names. */
export function notificationOpen(row: InboxNotificationRow): InboxOpen {
  if (row.type === 'team_chat_message') {
    const channelId = str(row.metadata?.channel_id) ?? (row.context_type === 'team_chat_channel' ? row.context_id : null)
    const messageId = str(row.metadata?.message_id) ?? row.target_id
    if (channelId && messageId) return { kind: 'team_chat', channelId, messageId, threadRootId: str(row.metadata?.thread_root_id) }
  }
  if (row.target_type && row.target_id) return { kind: 'record', type: row.target_type, id: row.target_id }
  if (row.context_type && row.context_id) return { kind: 'record', type: row.context_type, id: row.context_id }
  return { kind: 'none' }
}

/**
 * Notifications as items: one per conversation (`group_key`), else one per
 * row. An item reads as its newest row, counts its rows, is unread while any
 * is, and carries every row's id. Newest first.
 */
export function notificationItems(rows: readonly InboxNotificationRow[]): InboxItem[] {
  const groups = new Map<string, InboxNotificationRow[]>()
  for (const row of rows) {
    const key = `n:${row.group_key || row.id}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const items: InboxItem[] = []
  for (const [key, list] of groups) {
    list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    const top = list[0]
    items.push({
      key,
      source: 'notification',
      category: notificationCategory(top.type),
      at: top.created_at,
      title: top.title?.trim() || 'Notification',
      body: top.body,
      unread: list.some((r) => !r.is_read),
      count: list.length,
      notificationIds: list.map((r) => r.id),
      actor: top.actor ? { id: top.actor.id, name: top.actor.display_name?.trim() || 'A teammate', avatarUrl: top.actor.avatar_url } : null,
      open: notificationOpen(top),
      type: top.type,
    })
  }
  return items.sort(byNewest)
}

/** Mail that needs the person as items: "To respond" or important, newest first. */
export function mailItems(rows: readonly InboxMailRow[]): InboxItem[] {
  return rows
    .filter((r) => r.needs_reply || r.auto_classified === 'important')
    .map(
      (r): InboxItem => ({
        key: `mail:${r.id}`,
        source: 'mail',
        category: 'mail',
        at: r.last_message_at ?? new Date(0).toISOString(),
        title: r.from_name?.trim() || r.from_email?.trim() || 'Mail',
        body: r.subject?.trim() || null,
        unread: r.is_unread,
        count: 1,
        notificationIds: [],
        actor: null,
        open: { kind: 'mail', threadIndexId: r.id, providerThreadId: r.provider_thread_id, accountId: r.account_id },
        type: r.needs_reply ? 'mail_to_respond' : 'mail_important',
      }),
    )
    .sort(byNewest)
}

function byNewest(a: { at: string }, b: { at: string }): number {
  return Date.parse(b.at) - Date.parse(a.at)
}

/**
 * The list with holds applied: an item held until a time still ahead, with
 * nothing new in it since it was held, is set aside (`held`, soonest back
 * first); everything else is listed, newest first, a hold that ran out
 * putting its item back at the top as if it arrived then. Holds whose item
 * is gone are dropped.
 */
export function applyHolds(items: readonly InboxItem[], holds: readonly InboxHold[], now: Date = new Date()): { listed: InboxItem[]; held: InboxItem[] } {
  const holdOf = new Map(holds.map((h) => [h.item_key, h]))
  const listed: Array<InboxItem & { sortAt: number }> = []
  const held: InboxItem[] = []
  for (const item of items) {
    const hold = holdOf.get(item.key)
    const at = Date.parse(item.at)
    if (!hold) {
      listed.push({ ...item, sortAt: at })
      continue
    }
    const until = Date.parse(hold.held_until)
    const since = Date.parse(hold.held_at)
    const newSince = Number.isFinite(since) && at > since
    if (Number.isFinite(until) && until > now.getTime() && !newSince) {
      held.push({ ...item, heldUntil: hold.held_until })
    } else {
      // Back: at the top as of when its hold ended (or its news, if later).
      listed.push({ ...item, sortAt: Math.max(at, Number.isFinite(until) && !newSince ? Math.min(until, now.getTime()) : at) })
    }
  }
  listed.sort((a, b) => b.sortAt - a.sortAt)
  held.sort((a, b) => Date.parse(a.heldUntil!) - Date.parse(b.heldUntil!))
  return { listed: listed.map(({ sortAt: _s, ...item }) => item), held }
}

/** The items a filter shows (Held is the held list itself). */
export function filterItems(items: readonly InboxItem[], filter: InboxFilter): InboxItem[] {
  if (filter === 'all' || filter === 'held') return [...items]
  return items.filter((i) => i.category === filter)
}

/** The hold menu's choices. */
export const HOLD_CHOICES = ['hour', 'evening', 'tomorrow', 'next_week'] as const
export type HoldChoice = (typeof HOLD_CHOICES)[number]
/** The longest hold 702 accepts. */
export const HOLD_MAX_MS = 90 * 24 * 60 * 60_000

export function isHoldChoice(value: unknown): value is HoldChoice {
  return typeof value === 'string' && (HOLD_CHOICES as readonly string[]).includes(value)
}

/**
 * When a hold ends, from `now` on the device's clock (the person's):
 *   an hour;
 *   this evening, 18:00 (after 17:00 already: tomorrow evening);
 *   tomorrow, 8:00;
 *   next week, Monday 8:00 (on a Monday: the one after).
 */
export function holdUntil(choice: HoldChoice, now: Date = new Date()): Date {
  if (choice === 'hour') return new Date(now.getTime() + 3_600_000)
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  if (choice === 'evening') return new Date(y, m, now.getHours() >= 17 ? d + 1 : d, 18, 0, 0, 0)
  if (choice === 'tomorrow') return new Date(y, m, d + 1, 8, 0, 0, 0)
  const days = ((8 - now.getDay()) % 7) || 7
  return new Date(y, m, d + days, 8, 0, 0, 0)
}

export function holdChoiceLabel(choice: HoldChoice, now: Date = new Date()): string {
  if (choice === 'hour') return 'In an hour'
  if (choice === 'evening') return now.getHours() >= 17 ? 'Tomorrow evening' : 'This evening'
  if (choice === 'tomorrow') return 'Tomorrow morning'
  return 'Next week'
}

/** Why a hold's end is refused, or null: a time ahead, within 90 days. */
export function holdUntilError(raw: unknown, now: Date = new Date()): string | null {
  if (typeof raw !== 'string') return 'until must be a time'
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return 'until must be a time'
  if (at <= now.getTime()) return 'until must be in the future'
  if (at - now.getTime() > HOLD_MAX_MS) return 'an item is held for 90 days at most'
  return null
}

const ITEM_KEY = /^(n:[A-Za-z0-9_:.-]{1,200}|mail:[0-9a-f-]{36})$/i

/** True for an item key the inbox makes (what a hold may name). */
export function isInboxItemKey(value: unknown): value is string {
  return typeof value === 'string' && ITEM_KEY.test(value)
}
