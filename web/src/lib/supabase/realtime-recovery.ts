'use client'

/**
 * Global Realtime recovery watchdog.
 *
 * INCIDENT: in the desktop app's WKWebView, the Supabase Realtime websocket
 * dies when the laptop sleeps overnight and is NEVER re-established for the rest
 * of the session — every realtime surface (live-agent capture notes, chat,
 * entity sync, attention rail) goes silently dead while REST/API traffic keeps
 * working (server-side cookie auth), so the app *looks* healthy. Root cause is a
 * combination of: (1) the OS killing the TCP socket while main-thread timers are
 * frozen, so the client's own heartbeat never fires the onclose that would
 * trigger auto-reconnect; and (2) even once a reconnect fires, join pushes use
 * the CACHED access token — expired after an overnight gap — so channels can be
 * RLS-rejected into an `errored` rejoin loop on a stale JWT.
 *
 * This module runs ONE watchdog (mounted once from the dashboard shell) that, on
 * any wake signal, forces the recovery the SDK won't do on its own:
 *
 *   RECOVERY ORDER (deliberate — see per-step comments):
 *     1. auth.getSession()  — force-refreshes an expired/near-expiry token via
 *        GoTrue and, on a real refresh, fires TOKEN_REFRESHED which supabase-js
 *        already forwards into realtime.setAuth(). We ALSO call setAuth()
 *        explicitly (step 2) as defense-in-depth in case no refresh occurred but
 *        the cached socket token is nonetheless stale relative to the channels.
 *     2. realtime.setAuth(freshToken) — updates the cached accessTokenValue that
 *        join/rejoin pushes read from, so the channels' own rejoinTimer picks up
 *        a valid JWT on its next tick.
 *     3. knockStaleChannels() — knock every still-`joined`/`joining` channel into
 *        the rejoin path BEFORE connect(). This is the load-bearing fix for the
 *        WKWebView zombie case: when the OS swallows the socket close, channels
 *        stay `joined` with NO rejoinTimer scheduled (rejoinTimers are only armed
 *        from channel error/timeout events; _onConnOpen never rejoins;
 *        channel.subscribe() is a silent no-op unless state==='closed'). So after
 *        a fresh socket opens they'd be deaf forever. We reproduce what the SDK's
 *        own _onConnClose does (RealtimeClient._triggerChanError() →
 *        channel._trigger('phx_error') → state='errored' + rejoinTimer.
 *        scheduleTimeout()); the rejoin resends the joinPush with the fresh token
 *        and re-fires each subscribe callback with 'SUBSCRIBED', re-triggering
 *        every hook's catch-up refetch. `errored`/`closed`/`leaving` channels are
 *        left alone (errored ones already have rejoinTimers).
 *     4. realtime.connect() — a safe no-op if already open/connecting; wakes a
 *        dead socket. We do NOT call disconnect() first: disconnect() sets a
 *        manual-disconnect flag that briefly suppresses auto-reconnect, and it's
 *        unnecessary when the goal is just to force a reconnect on a dead socket.
 *
 *   The knock in step 3 replaces the old "let each channel's independently-
 *   running rejoinTimer heal it" assumption, which is WRONG for the zombie case:
 *   a channel that stayed `joined` through a swallowed close never had a
 *   rejoinTimer scheduled in the first place. We knock only on the unhealthy
 *   (repair) path — a healthy no-op never touches channels.
 *
 * THRASH-PROOF: overlapping triggers (visibilitychange + focus + online + the
 * periodic poll all fire together on wake) are debounced/serialized into ONE
 * recovery pass; a healthy socket is a fast no-op; and the periodic poll only
 * runs while the document is visible. The SDK's own de-dup (getSession coalesces
 * concurrent refreshes; connect() no-ops when connected) covers the rest.
 */

import { createClient } from '@/lib/supabase/client'

// How long the tab must have been hidden before a wake is treated as suspect.
// Quick alt-tabs (<30s) never kill the socket, so reconnecting on every flip
// would cause needless refetch storms for users who switch windows frequently.
const HIDDEN_SUSPECT_MS = 30_000
// Periodic staleness check cadence while the tab is visible. This is the
// load-bearing half of the fix for a frozen WKWebView where visibilitychange /
// online may never fire (or fire too late) on wake — an independent timer that
// re-arms whenever JS resumes eventually catches a dead socket.
const POLL_INTERVAL_MS = 30_000
// Don't run more than one full recovery pass (with its auth network round-trip)
// within this window, no matter how many triggers fire.
const MIN_PASS_INTERVAL_MS = 5_000
// Coalesce triggers that fire within a few ms of each other into one pass.
const DEBOUNCE_MS = 150

type ConnectionState = 'connecting' | 'open' | 'closing' | 'closed'

// A realtime channel state, per @supabase/realtime-js CHANNEL_STATES.
type ChannelState = 'closed' | 'errored' | 'joined' | 'joining' | 'leaving'

// The subset of RealtimeChannel we touch. All underscore-private on a
// caret-ranged dep, so every access is guarded (see knockStaleChannels).
interface ChannelLike {
  state?: ChannelState
  _trigger?: (event: string, payload?: unknown, ref?: string) => void
}

interface RealtimeLike {
  isConnected(): boolean
  connectionState(): ConnectionState
  connect(): void
  setAuth(token?: string | null): Promise<void>
  // Underscore-private on the client; used to knock stale channels into the
  // rejoin path. Optional + feature-detected so a dep bump that renames it
  // degrades to the per-channel fallback rather than throwing.
  _triggerChanError?: () => void
  getChannels?: () => ChannelLike[]
}

interface AuthLike {
  getSession(): Promise<{ data: { session: { access_token?: string } | null } }>
}

interface SupabaseLike {
  realtime: RealtimeLike
  auth: AuthLike
}

// phx_error — the event RealtimeChannel binds its _onError handler to (which
// sets state='errored' and schedules the rejoinTimer). Matches
// CHANNEL_EVENTS.error in @supabase/realtime-js constants.
const CHANNEL_ERROR_EVENT = 'phx_error'

/**
 * Knock every still-`joined`/`joining` channel into the SDK's rejoin path.
 *
 * The WKWebView zombie case: the OS kills the socket but the client never sees
 * the onclose, so channels remain `joined` with NO rejoinTimer scheduled. Once a
 * fresh socket opens, nothing re-joins them — they're deaf. This reproduces what
 * the SDK's own `_onConnClose` does on a normal close: fire each channel's error
 * event, which its `_onError` binding turns into `state='errored'` +
 * `rejoinTimer.scheduleTimeout()`. The rejoin then resends the joinPush (with the
 * now-fresh access token) and re-fires each subscribe callback with 'SUBSCRIBED'.
 *
 * Defensive because these are underscore-private APIs on a caret-ranged dep:
 *   - Prefer client `_triggerChanError()` (iterates channels itself).
 *   - Else iterate `getChannels()` and per-channel `_trigger('phx_error')`, but
 *     ONLY for channels in `joined`/`joining` (leave `closed`/`errored`/`leaving`
 *     alone — errored ones already have a rejoinTimer; the SDK's own
 *     _triggerChanError has no such guard, but its _onError is a no-op on
 *     closed/leaving anyway, so scoping here is strictly safer).
 *   - Else warn and rely on the bare connect() + heartbeat reconnect.
 *
 * Call ONLY on the repair (socket-unhealthy) path — never on a healthy no-op.
 */
function knockStaleChannels(realtime: RealtimeLike): void {
  try {
    if (typeof realtime._triggerChanError === 'function') {
      realtime._triggerChanError()
      return
    }
    if (typeof realtime.getChannels === 'function') {
      const channels = realtime.getChannels() ?? []
      for (const ch of channels) {
        if (
          (ch?.state === 'joined' || ch?.state === 'joining') &&
          typeof ch._trigger === 'function'
        ) {
          ch._trigger(CHANNEL_ERROR_EVENT)
        }
      }
      return
    }
    console.warn(
      '[realtime-watchdog] no channel-knock API on realtime client — stale channels may stay deaf until their own rejoin fires',
    )
  } catch {
    // best-effort; the bare connect() + heartbeat reconnect remain the fallback
  }
}

/**
 * Is the socket unhealthy enough to warrant a recovery pass? A `closed` state is
 * the obvious dead case. `connecting` is transient and left alone (a pass would
 * just race the in-flight connect). `open` is treated as healthy here: this
 * watchdog cannot cheaply prove an OPEN socket is a zombie without private
 * heartbeat state, so zombie-OPEN detection is delegated to the client-level
 * heartbeatCallback (see client.ts) which fires connect() on a missed beat.
 */
function isSocketUnhealthy(realtime: RealtimeLike): boolean {
  try {
    if (realtime.isConnected()) return false
    const state = realtime.connectionState()
    // Don't fight an in-flight connect; only act on a settled-dead socket.
    return state === 'closed'
  } catch {
    // If the client can't even report state, assume dead and try to recover.
    return true
  }
}

/**
 * Run one recovery pass. Returns true iff it actually repaired a dead socket
 * (used for the ops breadcrumb — silent on the healthy fast path).
 */
async function runRecoveryPass(supabase: SupabaseLike): Promise<boolean> {
  if (!isSocketUnhealthy(supabase.realtime)) return false

  // 1. Force a token refresh if the cached access token is expired / within the
  //    90s expiry margin. getSession() is not a passive read — GoTrue upgrades a
  //    stale session via a network refresh_token call and coalesces concurrent
  //    callers, so this is safe to call from multiple triggers.
  let freshToken: string | undefined
  try {
    const { data } = await supabase.auth.getSession()
    freshToken = data.session?.access_token
  } catch {
    // Refresh failed (offline / refresh_token expired). Still attempt a socket
    // reconnect below — a genuinely signed-out session falls back to the anon
    // key, which this watchdog cannot repair (requires re-login).
  }

  // 2. Push the (possibly refreshed) token into the realtime client so channel
  //    rejoin pushes carry a valid JWT. Passing undefined lets setAuth resolve
  //    the token itself via the client's access-token callback.
  try {
    await supabase.realtime.setAuth(freshToken)
  } catch {
    // best-effort
  }

  // 3. Knock stale `joined`/`joining` channels into the rejoin path BEFORE
  //    connect(). Without this, channels that stayed `joined` through a swallowed
  //    close have no rejoinTimer and go deaf on the fresh socket forever. Runs
  //    only here — the socket-unhealthy repair path — never on a healthy no-op.
  knockStaleChannels(supabase.realtime)

  // 4. Wake the socket. connect() no-ops if already open/connecting.
  try {
    supabase.realtime.connect()
  } catch {
    // best-effort; the heartbeat-driven reconnect remains the fallback
  }

  return true
}

// ── Shared trigger state (module-scoped) ─────────────────────────
// Hoisted out of startRealtimeWatchdog so the exported requestRecovery() entry
// point (used by use-realtime-entities' wake/online handler) funnels through the
// SAME debounce/throttle/serialization as the watchdog's own event handlers —
// one recovery semantic, one budget, no divergence. A single browser has one
// singleton supabase client (createClient caches it), so one shared budget is
// correct.
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let lastPassAt = 0

type Resolver = (repaired: boolean) => void

// Resolvers for callers that arrived during the CURRENT debounce window. The
// debounce callback claims this array wholesale (`const batch = pendingResolvers;
// pendingResolvers = []`) so it owns exactly the waiters it accumulated; later
// arrivals start a fresh window and can never be settled by an earlier pass.
//
// WHY the ownership matters: one flat module array settled from three unscoped
// sites let a suppressed/throttled window drain the resolvers of a pass that was
// still IN FLIGHT — that pass repaired a dead socket (repairId advanced) but its
// caller had already been resolved `false`, so `hadFailure` never latched and the
// catch-up refetch never ran. Every settle site below settles a batch it owns.
let pendingResolvers: Resolver[] = []

// Waiters that joined while a pass was already running. They are settled with
// THAT pass's real outcome (see runningBatch below) rather than a conservative
// `false`, because the in-flight pass is doing exactly the repair they asked for.
let runningBatch: Resolver[] | null = null

function settleBatch(batch: Resolver[], repaired: boolean): void {
  for (const resolve of batch) resolve(repaired)
}

// Monotonic id of the last pass that ACTUALLY repaired a dead socket. Callers
// use it to tell "a real gap happened" from "a healthy wake did nothing", and
// the entities channel stamps it on the `ni:realtime-recovered` event so
// downstream listeners can correlate one fan-out with one repair.
let lastRepairId = 0

/** The id of the last pass that actually repaired a dead socket (0 = none). */
export function getLastRepairId(): number {
  return lastRepairId
}

/**
 * Coalesce + throttle a recovery request into one pass. Collapses burst triggers
 * (visibilitychange + focus + online all firing on wake) into a single pass, and
 * never runs the auth round-trip more than once per MIN_PASS_INTERVAL_MS. A
 * healthy socket is a fast no-op that does NOT consume the throttle budget.
 *
 * Every caller waiting on the current debounce window is resolved with the
 * pass's real outcome: `true` only when runRecoveryPass repaired a dead socket.
 * A throttled or healthy-no-op call resolves `false` — that is what stops
 * use-realtime-entities from latching `hadFailure` (and thus manufacturing a
 * spurious app-wide fan-out) on a healthy return to the app.
 *
 * RESOLVER OWNERSHIP: the debounce callback claims the waiters accumulated in
 * its own window and settles ONLY those. A window that lands while a pass is
 * already running hands its waiters to that pass (runningBatch) instead of
 * resolving them false — they asked for exactly the repair that pass is doing.
 * Nothing ever settles a batch it does not own, so an in-flight real repair can
 * no longer have its waiters stolen (and told `false`) by a later suppressed
 * trigger.
 */
function triggerRecovery(): void {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    // Claim this window's waiters up front: from here on, only this invocation
    // (or the pass it starts) may settle them.
    const batch = pendingResolvers
    pendingResolvers = []
    const now = Date.now()
    if (runningBatch) {
      // A pass is already in flight doing the exact repair these callers want.
      // Join it: they'll be settled with ITS real outcome when it finishes,
      // rather than being told `false` about a repair that is actually running.
      // (`runningBatch` is non-null for exactly as long as a pass runs: it IS
      // the in-flight flag, so there is no second `running` boolean to drift.)
      runningBatch.push(...batch)
      return
    }
    if (now - lastPassAt < MIN_PASS_INTERVAL_MS) {
      // Throttled: no pass is running and we won't start one, so we cannot
      // claim a repair we did not observe. Our own waiters (and only ours) get
      // the conservative `false`.
      settleBatch(batch, false)
      return
    }
    const supabase = createClient() as unknown as SupabaseLike
    // Fast no-op check BEFORE marking a pass — a healthy socket must not
    // consume the throttle budget, or a real problem seconds later would be
    // suppressed.
    if (!isSocketUnhealthy(supabase.realtime)) {
      settleBatch(batch, false)
      return
    }
    lastPassAt = now
    // Late arrivals append here while the pass runs and share its outcome.
    runningBatch = batch
    void runRecoveryPass(supabase)
      .then((repaired) => {
        if (repaired) {
          lastRepairId++
          // One ops breadcrumb per actual repair (silent otherwise).
          console.warn('[realtime-watchdog] dead socket detected — forced session refresh + reconnect')
        }
        return repaired
      })
      .catch(() => false)
      .then((repaired) => {
        const settled = runningBatch ?? batch
        runningBatch = null
        // Settle AFTER the pass truly finished (knock + connect included), not
        // on a fixed-delay poll — otherwise a slow getSession round-trip would
        // resolve waiters before the repair, under-latching a genuine gap.
        settleBatch(settled, repaired)
      })
  }, DEBOUNCE_MS)
}

/**
 * Request a recovery pass from outside the watchdog (e.g. use-realtime-entities'
 * own wake/online handler). Delegates to the SAME debounce/throttle/serialization
 * as the watchdog, and runs the identical repair routine (knockStaleChannels
 * included), so the zombie-channel semantic can't diverge between the two code
 * paths. SSR-safe: resolves false with no window (no socket to repair).
 *
 * Resolves `true` ONLY when the pass this call joined actually repaired a dead
 * socket. NOTE: the caller still owns its own catch-up plumbing (arming its
 * channel's next SUBSCRIBED to refetch) — this only handles socket + channel
 * repair.
 */
export function requestRecovery(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    pendingResolvers.push(resolve)
    triggerRecovery()
  })
}

// ── Self-refetch dedup (module-scoped, shared across every hook) ──
// A single real repair makes knockStaleChannels error EVERY channel, so each
// shell singleton (attention rail, live work runs, in-app messages,
// notifications, the email inbox) refetches from its OWN channel's
// SUBSCRIBED-after-failure — and then AGAIN when the entities channel's
// recovery dispatches `ni:realtime-recovered`. That is the double-refetch
// half of the measured wake storm (21 requests with one calendar tab, 40 with
// six). A hook marks its own catch-up here and skips the global event's
// duplicate if it lands inside the window.
//
// The map is MODULE-level on purpose: a surface's channel effect (Mail, a dialog) unmounts
// whenever its dialog closes, so a useRef-scoped map would forget the mark
// across a close/reopen and the dedup would silently stop working.
const SELF_REFETCH_WINDOW_MS = 3_000

interface SelfRefetchMark {
  /** Wall-clock time after which this mark no longer suppresses anything. */
  expiry: number
  /** getLastRepairId() as of the mark — the repair this catch-up accounted for. */
  repairId: number
}

const recentSelfRefetch = new Map<string, SelfRefetchMark>()

/**
 * Record that `key` just refetched on its own channel's recovery. Keys must be
 * the FULL channel name (e.g. `notifications:${memberId}`): a workspace switch
 * changes memberId, and a bare literal would let the old member's mark suppress
 * the new member's genuine catch-up.
 *
 * The mark stamps the CURRENT repair id alongside the expiry so the dedup can be
 * exact rather than merely temporal (see wasSelfRefetchedRecently).
 *
 * The window (3s) sits between the entities channel's 0–2s dispatch jitter
 * (use-realtime-entities.ts) and MIN_PASS_INTERVAL_MS (5s): long enough that the
 * global event for THIS repair is always caught, short enough that two genuinely
 * separate repairs (≥5s apart by the throttle) are never conflated.
 */
export function markSelfRefetched(key: string, windowMs: number = SELF_REFETCH_WINDOW_MS): void {
  recentSelfRefetch.set(key, { expiry: Date.now() + windowMs, repairId: lastRepairId })
}

/**
 * True iff `key` marked its own catch-up for the SAME gap the caller is now
 * reacting to, and that mark is still inside its window.
 *
 * `repairId` is the id carried on the `ni:realtime-recovered` event. When
 * given, it must match the id stamped at mark time: the mark then suppresses
 * only the echo of the repair it actually accounted for, so a SECOND real repair
 * landing inside the same 3s window still gets its catch-up refetch (the purely
 * temporal check would have swallowed it). Omit it to fall back to the window
 * alone — correct for callers with no event to read an id from.
 *
 * NOTE both sides read the same counter, so a channel that dropped and
 * re-subscribed with NO watchdog pass involved (Supabase's own reconnect) marks
 * and matches on the unchanged id — that gap still dedupes correctly.
 */
export function wasSelfRefetchedRecently(key: string, repairId?: number): boolean {
  const mark = recentSelfRefetch.get(key)
  if (mark === undefined) return false
  if (Date.now() > mark.expiry) {
    recentSelfRefetch.delete(key)
    return false
  }
  if (repairId !== undefined && repairId !== mark.repairId) return false
  return true
}

/**
 * The repair id stamped on a `ni:realtime-recovered` event, or undefined when
 * the event carries none (a hand-rolled dispatch, or an older bundle). Pass the
 * result straight to wasSelfRefetchedRecently: undefined degrades that check to
 * the time-window behaviour, so a missing id can never make the dedup WRONG,
 * only less precise.
 */
export function repairIdFromRecoveredEvent(event: Event): number | undefined {
  const detail = (event as CustomEvent<{ repairId?: unknown }>).detail
  const id = detail?.repairId
  return typeof id === 'number' ? id : undefined
}

/** Test-only: drop every dedup mark (module state outlives a component tree). */
export function __resetSelfRefetchMarks(): void {
  recentSelfRefetch.clear()
}

/**
 * Start the global watchdog. Idempotent per module load (a second call while one
 * is already running is a no-op) and SSR-safe (returns a no-op teardown when
 * there's no window). Returns a teardown that removes every listener/interval.
 */
let activeTeardown: (() => void) | null = null

export function startRealtimeWatchdog(): () => void {
  // SSR / non-browser: nothing to watch.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {}
  }
  // Already running — don't stack listeners. Hand back the existing teardown so
  // a caller that mounts twice (StrictMode) still gets a working cleanup.
  if (activeTeardown) return activeTeardown

  let hiddenAt: number | null = null

  // All triggers funnel through the shared, module-scoped throttle so external
  // requestRecovery() callers share the same budget.
  const trigger = () => triggerRecovery()

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    // Became visible: only suspect a dead socket if hidden long enough for the
    // OS/WebView to have plausibly killed it.
    const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0
    hiddenAt = null
    if (hiddenFor >= HIDDEN_SUSPECT_MS) trigger()
  }

  const onFocus = () => trigger()
  const onOnline = () => trigger()

  // Periodic check runs ONLY while visible — a hidden tab's socket death is
  // covered by the visibilitychange handler on the next unhide, and polling a
  // hidden tab would waste auth calls (and its timer is throttled by the browser
  // anyway). This independent timer is what catches a WKWebView that never fires
  // visibilitychange/online on wake: whenever JS resumes, the next tick runs.
  const poll = () => {
    if (document.visibilityState === 'visible') trigger()
  }
  const pollInterval = setInterval(poll, POLL_INTERVAL_MS)

  window.addEventListener('online', onOnline)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)

  const teardown = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    // Never leave a requestRecovery() caller awaiting a pass that will now never
    // run — an un-settled promise would strand its `.then` (and the caller's
    // hadFailure latch) forever. Only the not-yet-claimed window is settled
    // here: an in-flight pass owns runningBatch and still settles it with the
    // real outcome when it completes (teardown does not cancel it).
    const orphaned = pendingResolvers
    pendingResolvers = []
    settleBatch(orphaned, false)
    // Reset the shared throttle so a fresh watchdog start (StrictMode remount /
    // tests) isn't suppressed by a stale lastPassAt from the prior instance.
    lastPassAt = 0
    clearInterval(pollInterval)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibility)
    activeTeardown = null
  }
  activeTeardown = teardown
  return teardown
}
