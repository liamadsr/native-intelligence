/**
 * The presence client: tells the server, cheaply, whether the person is at
 * this Native Intelligence app, and how far they have read their home thread
 * (docs/plans/reach-follows-you.md §1 and §2). One per page, started by
 * PresenceMount (src/app/account/presence-mount.tsx) for the signed-in
 * person; the chat panel reports the home thread it shows with
 * reportHomeView.
 *
 * What it costs while the page sits there (WKWebView idle CPU matters): four
 * passive input listeners that only record when input happened, a focus and
 * a visibility listener, and one 60 s interval. No animation frames, no idle
 * callbacks, nothing faster than a minute. Every trigger goes through one
 * evaluation, at most once per EVALUATE_THROTTLE_MS (a later trigger in that
 * window runs once at its end), so a ping is at most one POST per 10 s and,
 * for a person sitting at the app, one every 4 to 5 minutes.
 *
 * The rules, per window:
 *   - The web: send `active` while the page is visible and focused with
 *     input in the last 4 minutes, when the last ping is about 4 minutes old
 *     (KEEPALIVE_MS). Nothing else, ever: a stale row is the web's absence,
 *     so a tab that hides or closes never marks another live tab (they share
 *     a client id) absent.
 *   - Desktop windows other than main: never a state. All desktop windows
 *     share one row, and main sends `idle` or `locked` only when it changes,
 *     so a pop-out's `active` would hide a locked Mac until main's next
 *     change. They send seen-only pings (the route leaves the row's state
 *     alone); the Mac's own reading in main covers the person using a
 *     pop-out.
 *   - The desktop's main window: read the Mac's idle time and lock
 *     (`presence_state`) and send `active`, `idle` or `locked` when it
 *     changes, and every 4 minutes while active. Native Intelligence may be in the
 *     background: a native banner still reaches someone using the Mac. A
 *     desktop build without the command falls back to the web rule, still as
 *     `surface: 'desktop'`.
 *   - Seen rides on a ping: the home thread's newest message time, sent only
 *     while the page is visible and focused with input (a focus counts) in
 *     the last 2 minutes, and only when it is newer than the last one sent.
 *
 * All windows of one browser, or of the desktop app, share the client id
 * (localStorage), so they share one row: one per browser or app install.
 *
 * No sendBeacon on pagehide: the web has nothing to say when a page goes (its
 * absence is a row going stale), and a seen is only worth sending while the
 * person is looking. The route still reads text/plain bodies, for iOS and
 * any later beacon.
 */
import { isDesktopApp } from '@/lib/platform'
import { getThisWebviewLabel, presenceState, type DesktopPresence } from '@/lib/tauri-bridge'
import {
  EVALUATE_THROTTLE_MS,
  KEEPALIVE_MS,
  desktopState,
  isPresenceClientId,
  isUuid,
  readingNow,
  webActive,
  type PageReading,
  type PresencePing,
  type PresenceState,
  type PresenceSurface,
} from './presence'

/** localStorage key of this browser's (or app install's) presence client id. */
export const PRESENCE_CLIENT_ID_KEY = 'dial8:presence-client-id'

/** The one interval: every evaluation that isn't triggered by an event. */
export const PRESENCE_TICK_MS = 60_000

/**
 * A keepalive is due this much before KEEPALIVE_MS. The 60 s tick lands at an
 * arbitrary phase from the last ping, so without it the gap between two pings
 * could reach 5 minutes, the edge of PRESENT_WINDOW_MS, and the person would
 * flicker absent for a moment.
 */
const KEEPALIVE_SLACK_MS = 5_000

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

interface HomeView {
  conversationId: string
  newestAt: number
  token: number
}

interface SeenMark {
  conversationId: string
  through: number
}

interface Session {
  userId: string
  clientId: string
  surface: PresenceSurface
  /** Resolved once: only the desktop's main window reads `presence_state`. */
  mainWindow: Promise<boolean>
  lastInputAt: number
  lastPingAt: number
  lastSentState: PresenceState | null
  lastEvalAt: number
  seenSent: SeenMark | null
  trailing: ReturnType<typeof setTimeout> | null
  interval: ReturnType<typeof setInterval> | null
  inflight: boolean
  pendingEval: boolean
  stopped: boolean
  removeListeners: () => void
}

let session: Session | null = null
/** The home thread on screen. Module-level: the chat panel can mount before the session starts. */
let homeView: HomeView | null = null
let viewToken = 0
/** The client id when localStorage refuses: kept for the page's life, so a restart reuses it. */
let memoryClientId: string | null = null

function randomClientId(): string {
  const bytes = new Uint8Array(16)
  try {
    crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** This browser's client id: the stored one, else a fresh one stored (or kept in memory when storage throws). */
export function presenceClientId(): string {
  try {
    const stored = localStorage.getItem(PRESENCE_CLIENT_ID_KEY)
    if (isPresenceClientId(stored)) return stored
  } catch {
    // No storage (a private window, blocked site data): an id for this page only.
    return (memoryClientId ??= randomClientId())
  }
  const fresh = memoryClientId ?? randomClientId()
  memoryClientId = fresh
  try {
    localStorage.setItem(PRESENCE_CLIENT_ID_KEY, fresh)
  } catch {
    // Read but not written (storage full): the in-memory id stands for this page.
  }
  return fresh
}

function pageNow(s: Session): PageReading {
  return { visible: document.visibilityState === 'visible', focused: document.hasFocus(), lastInputAt: s.lastInputAt }
}

/** The seen to send now, or null: the page is being read, and the thread's newest time is past the last one sent. */
function seenToSend(s: Session, page: PageReading, now: number): SeenMark | null {
  const view = homeView
  if (!view || !readingNow(page, now)) return null
  const sent = s.seenSent
  if (sent && sent.conversationId === view.conversationId && view.newestAt <= sent.through) return null
  return { conversationId: view.conversationId, through: view.newestAt }
}

async function send(s: Session, ping: PresencePing, seen: SeenMark | null, now: number): Promise<void> {
  const before = { lastPingAt: s.lastPingAt, lastSentState: s.lastSentState, seenSent: s.seenSent }
  s.lastPingAt = now
  if (ping.state) s.lastSentState = ping.state
  if (seen) s.seenSent = seen
  try {
    await fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ping),
      credentials: 'same-origin',
      keepalive: true,
    })
    // A refusal (a 500 before migration 454 is applied, a 401 mid sign-out)
    // still counts as sent: the next ping waits out the keepalive or a change
    // instead of retrying every minute.
  } catch {
    // Offline: nothing landed, so the next evaluation tries again.
    s.lastPingAt = before.lastPingAt
    s.lastSentState = before.lastSentState
    s.seenSent = before.seenSent
  }
}

async function evaluate(s: Session): Promise<void> {
  if (s.stopped) return
  if (s.inflight) {
    s.pendingEval = true
    return
  }
  s.inflight = true
  s.lastEvalAt = Date.now()
  try {
    let reading: DesktopPresence | null = null
    const main = await s.mainWindow
    if (main) reading = await presenceState()
    if (s.stopped) return
    const now = Date.now()
    const page = pageNow(s)
    const seen = seenToSend(s, page, now)
    // A desktop window other than main: what was read, never a state.
    if (s.surface === 'desktop' && !main) {
      if (!seen) return
      const ping: PresencePing = { clientId: s.clientId, surface: s.surface, seen: { conversationId: seen.conversationId, through: new Date(seen.through).toISOString() } }
      await send(s, ping, seen, now)
      return
    }
    // The Mac's own reading in the main window; elsewhere (and on a desktop
    // without the command) the page's: active or nothing to say.
    const state: PresenceState | null = reading ? desktopState(reading) : webActive(page, now) ? 'active' : null
    if (!state) return
    const keepaliveDue = now - s.lastPingAt >= KEEPALIVE_MS - KEEPALIVE_SLACK_MS
    const due = reading ? state !== s.lastSentState || (state === 'active' && keepaliveDue) : keepaliveDue
    if (!due && !seen) return
    const ping: PresencePing = { clientId: s.clientId, surface: s.surface, state }
    if (seen) ping.seen = { conversationId: seen.conversationId, through: new Date(seen.through).toISOString() }
    await send(s, ping, seen, now)
  } finally {
    s.inflight = false
    if (s.pendingEval && !s.stopped) {
      s.pendingEval = false
      requestEvaluate(s)
    }
  }
}

/** Evaluate now, or once when the throttle window ends (one pending run at most). */
function requestEvaluate(s: Session): void {
  if (s.stopped) return
  const wait = s.lastEvalAt + EVALUATE_THROTTLE_MS - Date.now()
  if (wait <= 0) {
    void evaluate(s)
    return
  }
  if (s.trailing) return
  s.trailing = setTimeout(() => {
    s.trailing = null
    requestEvaluate(s)
  }, wait)
}

function stopSession(s: Session): void {
  if (s.stopped) return
  s.stopped = true
  s.removeListeners()
  if (s.interval) clearInterval(s.interval)
  if (s.trailing) clearTimeout(s.trailing)
  s.interval = null
  s.trailing = null
  if (session === s) session = null
}

/**
 * Start presence for `userId` in this page; returns the stop. Starting again
 * (another person signed in, React's strict-mode double effect) stops the
 * previous session first, so there is never more than one.
 */
export function startPresence(userId: string): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  if (session) stopSession(session)
  const desktop = isDesktopApp()
  const s: Session = {
    userId,
    clientId: presenceClientId(),
    surface: desktop ? 'desktop' : 'web',
    mainWindow: desktop ? getThisWebviewLabel().then((label) => label === 'main', () => false) : Promise.resolve(false),
    lastInputAt: 0,
    lastPingAt: 0,
    lastSentState: null,
    lastEvalAt: Number.NEGATIVE_INFINITY,
    seenSent: null,
    trailing: null,
    interval: null,
    inflight: false,
    pendingEval: false,
    stopped: false,
    removeListeners: () => {},
  }
  const onInput = () => {
    s.lastInputAt = Date.now()
  }
  // Focusing a window is the person's own act (a click, a switch): it counts as input.
  const onFocus = () => {
    s.lastInputAt = Date.now()
    requestEvaluate(s)
  }
  const onVisibility = () => requestEvaluate(s)
  const inputOptions: AddEventListenerOptions = { passive: true, capture: true }
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, inputOptions)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)
  s.removeListeners = () => {
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, inputOptions)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibility)
  }
  s.interval = setInterval(() => requestEvaluate(s), PRESENCE_TICK_MS)
  session = s
  requestEvaluate(s)
  return () => stopSession(s)
}

/**
 * The chat panel shows the home thread `conversationId`, whose newest message
 * came in at `newestAt` (ms). Returns the clear, for when the panel leaves the
 * home thread or unmounts (a later report replaces this one either way).
 */
export function reportHomeView(conversationId: string, newestAt: number): () => void {
  if (!isUuid(conversationId) || !Number.isFinite(newestAt)) return () => {}
  const token = ++viewToken
  homeView = { conversationId, newestAt, token }
  if (session) requestEvaluate(session)
  return () => {
    if (homeView?.token === token) homeView = null
  }
}
