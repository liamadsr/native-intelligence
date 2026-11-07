/**
 * When a chat message came in, and the day lines between days (Liam,
 * 2026-10-18: the one chat gets the morning briefs and everything else at
 * random times, so a thin line names the day each one came in, as messaging
 * apps do).
 *
 * The time rides on the message itself, `metadata.createdAt` (an ISO string):
 *   - a stored message gets its row's `created_at` when it is read
 *     (history-page.ts, the whole-thread GET, the Realtime bridge). Every
 *     writer upserts with ignoreDuplicates, so the row's time is the first
 *     write's and never moves;
 *   - a message born in the window gets it as it is born: the person's send
 *     (chat-panel.tsx) and the reply's `start` chunk (eve-chat-transport.ts),
 *     so it survives the tab's snapshot too.
 * A message with no time (an old tab snapshot) joins the day before it.
 *
 * Client-safe and pure; the zone and "now" are arguments (the browser's own
 * zone by default), so the tests pin them.
 */

/** ui_message.metadata's key for when the message came in. */
export const MESSAGE_CREATED_AT_KEY = 'createdAt'

/** ui_message.metadata's label on a message the agent posted on its own (home-turn-server.ts). */
export const MESSAGE_LABEL_KEY = 'label'

type MaybeMessage = { id?: unknown; metadata?: unknown }

function metadataOf(message: MaybeMessage): Record<string, unknown> | null {
  const m = message.metadata
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null
}

/** When the message came in, in ms, or null when it doesn't say. */
export function messageTime(message: MaybeMessage): number | null {
  const raw = metadataOf(message)?.[MESSAGE_CREATED_AT_KEY]
  if (typeof raw !== 'string' || !raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/**
 * `uiMessage` with its stored row's `created_at` as `metadata.createdAt`. A
 * time the message already carries (its send) stands; anything that isn't a
 * message, or a time that isn't one, passes through untouched.
 */
export function withCreatedAt<T>(uiMessage: T, createdAt: unknown): T {
  if (!uiMessage || typeof uiMessage !== 'object' || Array.isArray(uiMessage)) return uiMessage
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return uiMessage
  const message = uiMessage as MaybeMessage
  if (messageTime(message) !== null) return uiMessage
  return { ...uiMessage, metadata: { ...(metadataOf(message) ?? {}), [MESSAGE_CREATED_AT_KEY]: createdAt } }
}

/** `metadata` with the time of now, unless it already says one. For a message the person sends. */
export function stampCreatedAt(metadata: unknown, now: number = Date.now()): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
  return typeof base[MESSAGE_CREATED_AT_KEY] === 'string' ? base : { ...base, [MESSAGE_CREATED_AT_KEY]: new Date(now).toISOString() }
}

// One formatter per zone and shape: building an Intl formatter is the slow part.
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(locale: string, timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone ?? ''}|${JSON.stringify(options)}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, ...(timeZone ? { timeZone } : {}) })
    formatters.set(key, f)
  }
  return f
}

/** `en-US` puts a narrow no-break space before AM/PM: a plain space reads the same and tests the same. */
function format(ms: number, timeZone: string | undefined, options: Intl.DateTimeFormatOptions, locale = 'en-US'): string {
  return formatter(locale, timeZone, options).format(new Date(ms)).replace(/[  ]/g, ' ')
}

/** The local calendar day of `ms`, as `YYYY-MM-DD`. */
export function dayKey(ms: number, timeZone?: string): string {
  return format(ms, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA')
}

function yearOf(ms: number, timeZone?: string): string {
  return format(ms, timeZone, { year: 'numeric' })
}

/** "Sunday, October 18", with the year when it isn't this year's. */
export function dayLabel(ms: number, opts: { now?: number; timeZone?: string } = {}): string {
  const now = opts.now ?? Date.now()
  const otherYear = yearOf(ms, opts.timeZone) !== yearOf(now, opts.timeZone)
  return format(ms, opts.timeZone, { weekday: 'long', month: 'long', day: 'numeric', ...(otherYear ? { year: 'numeric' } : {}) })
}

/** When a message came in: "7:32 PM" today, else its day above its time ("Oct 16" / "7:32 PM"). */
export function timeLabel(ms: number, opts: { now?: number; timeZone?: string } = {}): { day: string | null; time: string } {
  const now = opts.now ?? Date.now()
  const time = format(ms, opts.timeZone, { hour: 'numeric', minute: '2-digit' })
  if (dayKey(ms, opts.timeZone) === dayKey(now, opts.timeZone)) return { day: null, time }
  const otherYear = yearOf(ms, opts.timeZone) !== yearOf(now, opts.timeZone)
  return { day: format(ms, opts.timeZone, { month: 'short', day: 'numeric', ...(otherYear ? { year: 'numeric' } : {}) }), time }
}

/** ui_message.metadata.kind of a server-written home turn (home-turn.ts HOME_TURN_KIND; mirrored, not imported, to keep this module light). */
const HOME_TURN_KIND = 'home_turn'

/** What a home turn says it is when it carries no label (written before labels). */
const HOME_TURN_FALLBACK_LABELS: Record<string, string> = {
  digest: 'Daily digest',
  event: 'Heads up',
  helper_report: 'Update',
}

/**
 * The name of what the agent posted on its own ("Evening Brief", "Daily
 * digest"), drawn on a line above it, or null for any other message.
 */
export function messageSourceLabel(message: MaybeMessage): string | null {
  const meta = metadataOf(message)
  if (!meta || meta.kind !== HOME_TURN_KIND) return null
  const label = meta[MESSAGE_LABEL_KEY]
  if (typeof label === 'string' && label.trim()) return label.trim()
  return (typeof meta.reason === 'string' && HOME_TURN_FALLBACK_LABELS[meta.reason]) || null
}

/** A row the list draws: a line (a new day, what the agent posted, or both) or a message. */
export type DayLineRow<M> =
  | { type: 'line'; key: string; label: string }
  | { type: 'message'; message: M; time: number | null }

/**
 * The messages with a line before the first one of each local day, and before
 * each one the agent posted on its own (named). A new day and a name on the
 * same message share one line: "Friday, October 16 · Evening Brief".
 * `dayBefore`: the time of the message drawn just above these (the earlier
 * pages' last), so a day running across that seam gets one line, not two;
 * null draws the first message's day. A message with no time joins the day
 * before it. O(n), one pass.
 */
export function withDayLines<M extends MaybeMessage & { id: string }>(
  messages: readonly M[],
  opts: { dayBefore?: number | null; now?: number; timeZone?: string } = {},
): DayLineRow<M>[] {
  const out: DayLineRow<M>[] = []
  let lastDay = opts.dayBefore != null ? dayKey(opts.dayBefore, opts.timeZone) : null
  for (const message of messages) {
    const time = messageTime(message)
    const day = time !== null ? dayKey(time, opts.timeZone) : null
    const newDay = day !== null && day !== lastDay
    const source = messageSourceLabel(message)
    if (newDay || source) {
      const parts = [newDay && time !== null ? dayLabel(time, opts) : null, source].filter((p): p is string => !!p)
      out.push({ type: 'line', key: `line-${message.id}`, label: parts.join(' · ') })
    }
    if (day !== null) lastDay = day
    out.push({ type: 'message', message, time })
  }
  return out
}

/** The time of the last message that says one, or null. */
export function lastMessageTime(messages: readonly MaybeMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messageTime(messages[i])
    if (t !== null) return t
  }
  return null
}
