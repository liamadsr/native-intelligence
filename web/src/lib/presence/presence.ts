/**
 * Presence: whether a person is at a Native Intelligence app right now, and how far they
 * have read their home thread (docs/plans/reach-follows-you.md §1 and §2).
 *
 * The router (part C) uses both to decide where an agent message goes: a
 * banner when the person is present, a text when they are not. This module is
 * the part every side shares, so it is pure and client-safe: the ping's
 * shape and its parser, the thresholds, and the rules that turn what a client
 * observes into a state. The store (store.ts) writes rows, and the client
 * (client.ts) decides when to ping.
 *
 * The thresholds live here, on the web side, so tuning them never needs a
 * desktop release: the desktop only reports raw idle seconds and the lock.
 */

/** Present = an `active` row whose `active_at` is at most this old. */
export const PRESENT_WINDOW_MS = 5 * 60_000

/** The web counts as active while the tab is visible and focused and had input this recently. */
export const WEB_INPUT_WINDOW_MS = 4 * 60_000

/** The desktop counts as idle after this many seconds without input anywhere on the Mac. */
export const DESKTOP_IDLE_SECONDS = 180

/**
 * How often an active client re-sends `active`. Under PRESENT_WINDOW_MS so a
 * person who stays at the app never drops out between two pings.
 */
export const KEEPALIVE_MS = 4 * 60_000

/** The client evaluates at most once per this long, however many events fire. */
export const EVALUATE_THROTTLE_MS = 10_000

/** A home thread on screen counts as read only with input (or a focus) this recent. */
export const SEEN_INPUT_WINDOW_MS = 2 * 60_000

/**
 * In a meeting = a row that says so (`in_meeting`) whose `meeting_at` is at
 * most this old. The desktop re-sends it every KEEPALIVE_MS while the
 * meeting lasts, whatever the row's state, and says when it ends; this
 * window only covers a desktop that quit mid-meeting. Twice the present
 * window: a ping can run a minute late (the client's tick, a throttled
 * background timer), and a gap here would send routine messages mid-meeting.
 */
export const MEETING_WINDOW_MS = 10 * 60_000

/**
 * The desktop stops saying "in a meeting" once one has lasted this long
 * without a break: a recording left running overnight is not a meeting.
 */
export const MEETING_REPORT_MAX_MS = 4 * 60 * 60_000

export const PRESENCE_SURFACES = ['web', 'desktop', 'ios'] as const
export type PresenceSurface = (typeof PRESENCE_SURFACES)[number]

export const PRESENCE_STATES = ['active', 'idle', 'locked', 'hidden'] as const
export type PresenceState = (typeof PRESENCE_STATES)[number]

/**
 * Which states each surface may write. The web writes only `active`: a stale
 * row is its absence, so a tab that closes or hides can never mark another
 * live tab (which shares its client id) absent. The desktop's main window
 * reads the Mac's idle time and lock; iOS will report foreground or not.
 */
export const SURFACE_STATES: Record<PresenceSurface, readonly PresenceState[]> = {
  web: ['active'],
  desktop: ['active', 'idle', 'locked'],
  ios: ['active', 'hidden'],
}

/** The newest message time of the home thread the person had on screen. */
export interface PresenceSeen {
  conversationId: string
  /** ISO 8601 with a zone (`Z` or an offset). */
  through: string
}

/**
 * The body of `POST /api/presence`. `state` is absent only on a seen-only
 * ping: a desktop window other than main reports what the person read but
 * never writes the row's state, which is main's alone (all desktop windows
 * share one row, and a pop-out's `active` would hide main's `locked`).
 */
export interface PresencePing {
  clientId: string
  surface: PresenceSurface
  state?: PresenceState
  seen?: PresenceSeen
  /**
   * The desktop only, on a ping with a state: its person is in a meeting now
   * (the app is recording one, or detected a call in another app). Absent
   * when the desktop can't tell: the row's meeting mark is left as it was.
   */
  meeting?: boolean
}

/** A `user_presence` row as the router reads it. */
export interface PresenceRow {
  client_id: string
  surface: PresenceSurface
  state: PresenceState
  active_at: string | null
  updated_at: string
  /** Whether this client's last word was "in a meeting" (migration 666). */
  in_meeting?: boolean | null
  /** When this client last said its person is in a meeting; kept after the meeting ends. Null or absent for never. */
  meeting_at?: string | null
}

export type ParsedPresencePing = { ok: true; ping: PresencePing } | { ok: false; error: string }

/** The client id's shape, the same as migration 454's check. */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A full ISO 8601 instant with a zone, so Postgres reads it the same in every session. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

export function isPresenceClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID_RE.test(value)
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT_RE.test(value) && Number.isFinite(Date.parse(value))
}

/**
 * The ping, or why it isn't one. A state the surface never writes is refused
 * (the web sending `hidden` would be a bug, and the server holds the line).
 * An off-shape `seen` refuses the whole ping rather than being dropped, so a
 * client bug shows up as a 400 instead of reads that silently never land.
 */
export function parsePresencePing(body: unknown): ParsedPresencePing {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object' }
  const b = body as Record<string, unknown>
  if (!isPresenceClientId(b.clientId)) return { ok: false, error: 'clientId must be 8 to 64 letters, digits, dashes or underscores' }
  if (typeof b.surface !== 'string' || !(PRESENCE_SURFACES as readonly string[]).includes(b.surface)) {
    return { ok: false, error: 'surface must be web, desktop or ios' }
  }
  const surface = b.surface as PresenceSurface
  const seenOnly = (b.state === undefined || b.state === null) && b.seen !== undefined && b.seen !== null
  if (!seenOnly && (typeof b.state !== 'string' || !(SURFACE_STATES[surface] as readonly string[]).includes(b.state))) {
    return { ok: false, error: `state must be one of ${SURFACE_STATES[surface].join(', ')} for ${surface}` }
  }
  const ping: PresencePing = seenOnly ? { clientId: b.clientId, surface } : { clientId: b.clientId, surface, state: b.state as PresenceState }
  if (b.meeting !== undefined && b.meeting !== null) {
    if (typeof b.meeting !== 'boolean') return { ok: false, error: 'meeting must be true or false' }
    // Only the desktop knows (it records the meeting, or sees the call), and only its main window writes the row.
    if (surface !== 'desktop' || seenOnly) return { ok: false, error: 'meeting is the desktop main window\'s to say, on a ping with a state' }
    ping.meeting = b.meeting
  }
  if (b.seen !== undefined && b.seen !== null) {
    if (typeof b.seen !== 'object' || Array.isArray(b.seen)) return { ok: false, error: 'seen must be an object' }
    const seen = b.seen as Record<string, unknown>
    if (!isUuid(seen.conversationId)) return { ok: false, error: 'seen.conversationId must be a uuid' }
    if (!isIsoInstant(seen.through)) return { ok: false, error: 'seen.through must be an ISO 8601 time with a zone' }
    ping.seen = { conversationId: seen.conversationId, through: seen.through }
  }
  return { ok: true, ping }
}

/**
 * Whether the person is at any Native Intelligence app: some row says `active` and that
 * ping is at most PRESENT_WINDOW_MS old. A row in any other state, or an
 * active one that went stale, says nothing either way.
 */
export function isPresent(rows: readonly Pick<PresenceRow, 'state' | 'active_at'>[], now: number = Date.now()): boolean {
  return rows.some((row) => {
    if (row.state !== 'active' || !row.active_at) return false
    const at = Date.parse(row.active_at)
    return Number.isFinite(at) && now - at <= PRESENT_WINDOW_MS
  })
}

/**
 * Whether the person is in a meeting, as far as a desktop of theirs knows:
 * some row says so and its `meeting_at` is at most MEETING_WINDOW_MS old.
 * The row's state says nothing here: someone listening on a call touches
 * nothing for minutes.
 */
export function inMeeting(rows: readonly Pick<PresenceRow, 'in_meeting' | 'meeting_at'>[], now: number = Date.now()): boolean {
  return rows.some((row) => {
    if (row.in_meeting !== true || !row.meeting_at) return false
    const at = Date.parse(row.meeting_at)
    return Number.isFinite(at) && now - at <= MEETING_WINDOW_MS && at <= now + MEETING_WINDOW_MS
  })
}

/**
 * When a desktop of theirs last said "in a meeting" (ms), over or not; null
 * for never. A time ahead of now (a clock gone wrong) counts as now.
 */
export function lastMeetingAt(rows: readonly Pick<PresenceRow, 'meeting_at'>[], now: number = Date.now()): number | null {
  let last: number | null = null
  for (const row of rows) {
    const at = row.meeting_at ? Date.parse(row.meeting_at) : NaN
    if (Number.isFinite(at)) last = Math.max(last ?? 0, Math.min(at, now))
  }
  return last
}

/** What the desktop's `presence_state` command reports. */
export interface DesktopPresenceReading {
  idleSeconds: number
  locked: boolean
}

/**
 * The desktop main window's state from the Mac's reading: a locked screen
 * (or another user on the console) is `locked`, no input for more than
 * DESKTOP_IDLE_SECONDS is `idle`, and anything else is `active`. Native Intelligence may be
 * in the background: a native banner still reaches someone using the Mac.
 */
export function desktopState({ idleSeconds, locked }: DesktopPresenceReading): Extract<PresenceState, 'active' | 'idle' | 'locked'> {
  if (locked) return 'locked'
  if (idleSeconds > DESKTOP_IDLE_SECONDS) return 'idle'
  return 'active'
}

/** What a page can see of itself when it decides whether its person is there. */
export interface PageReading {
  visible: boolean
  focused: boolean
  /** When the page last had input (ms), 0 for never. */
  lastInputAt: number
}

/** The web rule: a visible, focused page with input in the last WEB_INPUT_WINDOW_MS. */
export function webActive(page: PageReading, now: number): boolean {
  return page.visible && page.focused && page.lastInputAt > 0 && now - page.lastInputAt <= WEB_INPUT_WINDOW_MS
}

/**
 * Whether what is on screen counts as read: the page is visible and focused,
 * with input (a focus counts) in the last SEEN_INPUT_WINDOW_MS. A tab left
 * open on the home thread while the person is away reads nothing.
 */
export function readingNow(page: PageReading, now: number): boolean {
  return page.visible && page.focused && page.lastInputAt > 0 && now - page.lastInputAt <= SEEN_INPUT_WINDOW_MS
}
