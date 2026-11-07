// @vitest-environment jsdom
/**
 * Tests for the global Realtime recovery watchdog (realtime-recovery.ts).
 *
 * INCIDENT: the desktop WKWebView's Realtime websocket dies on overnight sleep
 * and is never re-established. The watchdog, on any wake signal, forces the
 * recovery the SDK won't do on its own — refresh session, setAuth(fresh token),
 * connect() — while staying thrash-proof (burst triggers → one pass, healthy
 * socket → no-op, hidden-tab poll → nothing).
 *
 * We drive a controllable fake supabase client (realtime + auth) so we assert
 * the EXACT recovery sequence and its guards, not the real Realtime stack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Controllable fake supabase client ───────────────────────────
// connected: what realtime.isConnected() reports. state: connectionState().
// Tests flip these to simulate a healthy vs dead socket.
type ChannelState = 'closed' | 'errored' | 'joined' | 'joining' | 'leaving'
interface FakeChannel {
  state: ChannelState
  triggered: string[] // events fired at this channel via _trigger
}

let fakeSocket: {
  connected: boolean
  state: 'connecting' | 'open' | 'closing' | 'closed'
  connectCalls: number
  setAuthCalls: Array<string | null | undefined>
  getSessionCalls: number
  sessionToken: string | undefined
  // Ordered log of major recovery ops, so a test can assert the knock lands
  // BEFORE connect() (channels must be knocked before the socket is woken).
  opLog: string[]
  channels: FakeChannel[]
  triggerChanErrorCalls: number
}

function makeFakeSupabase() {
  return {
    realtime: {
      isConnected: vi.fn(() => fakeSocket.connected),
      connectionState: vi.fn(() => fakeSocket.state),
      connect: vi.fn(() => {
        fakeSocket.connectCalls++
        fakeSocket.opLog.push('connect')
      }),
      setAuth: vi.fn(async (token?: string | null) => {
        fakeSocket.setAuthCalls.push(token)
      }),
      getChannels: vi.fn(() => fakeSocket.channels),
      // NOTE: no `_triggerChanError` on this fake — so the recovery code takes
      // its getChannels()+per-channel _trigger('phx_error') FALLBACK path, which
      // is where the joined/joining-only guard lives (the thing we want to test).
    },
    auth: {
      getSession: vi.fn(async () => {
        fakeSocket.getSessionCalls++
        return { data: { session: fakeSocket.sessionToken ? { access_token: fakeSocket.sessionToken } : null } }
      }),
    },
  }
}

// Wire a per-channel _trigger fake onto each channel so the recovery code's
// getChannels()+_trigger('phx_error') fallback path exercises real channel state
// filtering. (We test the fallback path — not the client-level _triggerChanError
// shortcut — because it's where the joined/joining-only guard lives.)
function makeChannels(states: ChannelState[]): FakeChannel[] {
  return states.map((state) => {
    const ch: FakeChannel = { state, triggered: [] }
    ;(ch as unknown as { _trigger: (e: string) => void })._trigger = (event: string) => {
      ch.triggered.push(event)
      fakeSocket.opLog.push('knock')
    }
    return ch
  })
}

let fakeSupabase: ReturnType<typeof makeFakeSupabase>

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => fakeSupabase,
}))

import {
  startRealtimeWatchdog,
  requestRecovery,
  getLastRepairId,
  markSelfRefetched,
  wasSelfRefetchedRecently,
  repairIdFromRecoveredEvent,
  __resetSelfRefetchMarks,
} from '../realtime-recovery'

// Flush the 150ms debounce + settle the async recovery pass (getSession →
// setAuth → connect are all awaited microtasks after the debounce fires).
async function settle() {
  await vi.advanceTimersByTimeAsync(200)
  // Let any trailing microtasks (the .finally that clears `running`) drain.
  await Promise.resolve()
}

function setVisible(visible: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  })
}

let teardown: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fakeSocket = {
    connected: true,
    state: 'open',
    connectCalls: 0,
    setAuthCalls: [],
    getSessionCalls: 0,
    sessionToken: 'fresh-token',
    opLog: [],
    channels: [],
    triggerChanErrorCalls: 0,
  }
  fakeSupabase = makeFakeSupabase()
  setVisible(true)
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startRealtimeWatchdog', () => {
  it('(a) healthy socket => no recovery actions on wake', async () => {
    teardown = startRealtimeWatchdog()
    // Hide long enough to be "suspect", then reveal.
    setVisible(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(31_000)
    setVisible(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(fakeSupabase.auth.getSession).not.toHaveBeenCalled()
    expect(fakeSocket.setAuthCalls).toHaveLength(0)
    expect(fakeSocket.connectCalls).toBe(0)
  })

  it('(b) dead socket + wake => exact recovery sequence runs ONCE despite burst triggers', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    teardown = startRealtimeWatchdog()

    // Hide >30s then fire a burst: visibilitychange (visible) + focus + online
    // all at once (exactly what a real wake does).
    setVisible(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(31_000)
    setVisible(true)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await settle()

    // Exactly one pass: getSession once, setAuth with the fresh token once,
    // connect once. The throttle + debounce collapse the burst.
    expect(fakeSocket.getSessionCalls).toBe(1)
    expect(fakeSocket.setAuthCalls).toEqual(['fresh-token'])
    expect(fakeSocket.connectCalls).toBe(1)
    // One ops breadcrumb on an actual repair.
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('recovery order is getSession → setAuth → connect', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    const order: string[] = []
    fakeSupabase.auth.getSession.mockImplementation(async () => {
      order.push('getSession')
      return { data: { session: { access_token: 'fresh-token' } } }
    })
    fakeSupabase.realtime.setAuth.mockImplementation(async () => {
      order.push('setAuth')
    })
    fakeSupabase.realtime.connect.mockImplementation(() => {
      order.push('connect')
    })
    teardown = startRealtimeWatchdog()

    window.dispatchEvent(new Event('online'))
    await settle()

    expect(order).toEqual(['getSession', 'setAuth', 'connect'])
  })

  it('(c) periodic poll while HIDDEN does nothing even with a dead socket', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    teardown = startRealtimeWatchdog()

    setVisible(false)
    // Advance across several 30s poll intervals.
    await vi.advanceTimersByTimeAsync(120_000)

    expect(fakeSocket.getSessionCalls).toBe(0)
    expect(fakeSocket.connectCalls).toBe(0)
  })

  it('periodic poll while VISIBLE recovers a dead socket', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    teardown = startRealtimeWatchdog()

    setVisible(true)
    // First 30s poll tick fires trigger → debounce → pass.
    await vi.advanceTimersByTimeAsync(30_500)
    await settle()

    expect(fakeSocket.getSessionCalls).toBe(1)
    expect(fakeSocket.connectCalls).toBe(1)
  })

  it('(d) teardown removes listeners + interval (mutation-resistant: events after teardown do nothing)', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    teardown = startRealtimeWatchdog()
    teardown()
    teardown = null

    // Fire every trigger AND advance past poll intervals AFTER teardown.
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    setVisible(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(31_000)
    setVisible(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()

    expect(fakeSocket.getSessionCalls).toBe(0)
    expect(fakeSocket.connectCalls).toBe(0)
  })

  it('throttles: a second dead-socket wake within 5s does not run a second pass', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    teardown = startRealtimeWatchdog()

    window.dispatchEvent(new Event('online'))
    await settle()
    expect(fakeSocket.connectCalls).toBe(1)

    // Immediately fire again — inside the 5s min-pass window → suppressed.
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(fakeSocket.connectCalls).toBe(1)
  })

  it('a connecting socket is left alone (no pass — would race the in-flight connect)', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'connecting'
    teardown = startRealtimeWatchdog()

    window.dispatchEvent(new Event('online'))
    await settle()

    expect(fakeSocket.getSessionCalls).toBe(0)
    expect(fakeSocket.connectCalls).toBe(0)
  })

  // ── Fix 1: zombie-channel knock ────────────────────────────────
  it('(fix 1) repair pass knocks ONLY joined/joining channels — and BEFORE connect()', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    // A realistic mix: two live channels (deaf after a swallowed close), plus
    // ones that must be left alone (errored already has a rejoinTimer; closed /
    // leaving must not be re-armed).
    fakeSocket.channels = makeChannels(['joined', 'joining', 'errored', 'closed', 'leaving'])
    teardown = startRealtimeWatchdog()

    window.dispatchEvent(new Event('online'))
    await settle()

    // Exactly the joined + joining channels got the phx_error knock.
    expect(fakeSocket.channels[0].triggered).toEqual(['phx_error']) // joined
    expect(fakeSocket.channels[1].triggered).toEqual(['phx_error']) // joining
    expect(fakeSocket.channels[2].triggered).toEqual([]) // errored — left alone
    expect(fakeSocket.channels[3].triggered).toEqual([]) // closed — left alone
    expect(fakeSocket.channels[4].triggered).toEqual([]) // leaving — left alone

    // Ordering: every knock must precede connect(), or the fresh socket opens
    // before the channels are armed to rejoin on it.
    const firstConnect = fakeSocket.opLog.indexOf('connect')
    const lastKnock = fakeSocket.opLog.lastIndexOf('knock')
    expect(lastKnock).toBeGreaterThanOrEqual(0)
    expect(firstConnect).toBeGreaterThan(lastKnock)
  })

  it('(fix 1) HEALTHY pass never touches channels', async () => {
    // Socket healthy; channels are joined. A wake must be a pure no-op — no knock.
    fakeSocket.channels = makeChannels(['joined', 'joined'])
    teardown = startRealtimeWatchdog()

    window.dispatchEvent(new Event('online'))
    await settle()

    expect(fakeSocket.channels[0].triggered).toEqual([])
    expect(fakeSocket.channels[1].triggered).toEqual([])
    expect(fakeSocket.connectCalls).toBe(0)
  })

  // ── Fix 2: requestRecovery delegates to the same routine + budget ──
  it('(fix 2) requestRecovery runs the SAME repair (knock + connect) as the watchdog, and resolves true', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    fakeSocket.channels = makeChannels(['joined'])
    // Watchdog must be running so the shared throttle state is initialised, but
    // we drive recovery through the external entry point.
    teardown = startRealtimeWatchdog()

    let repaired: boolean | null = null
    void requestRecovery().then((r) => {
      repaired = r
    })
    await settle()

    expect(fakeSocket.channels[0].triggered).toEqual(['phx_error'])
    expect(fakeSocket.connectCalls).toBe(1)
    // The promise reports the pass's ACTUAL outcome — this is what
    // use-realtime-entities' forceReconnect latches hadFailure on.
    expect(repaired).toBe(true)
  })

  // ── Repair-id truth: the signal forceReconnect latches on ──
  it('a HEALTHY requestRecovery resolves false and leaves the repair id unchanged', async () => {
    // Healthy socket: the pass is a fast no-op, so nothing was missed and
    // use-realtime-entities must NOT arm hadFailure (the old unconditional latch
    // is what manufactured spontaneous app-wide fan-outs after a healthy wake).
    fakeSocket.connected = true
    fakeSocket.state = 'open'
    teardown = startRealtimeWatchdog()
    const before = getLastRepairId()

    let repaired: boolean | null = null
    void requestRecovery().then((r) => {
      repaired = r
    })
    await settle()

    expect(repaired).toBe(false)
    expect(getLastRepairId()).toBe(before)
    expect(fakeSocket.connectCalls).toBe(0)
  })

  it('a dead-socket repair advances the repair id EXACTLY once across a burst, and every waiter sees true', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    teardown = startRealtimeWatchdog()
    const before = getLastRepairId()

    // Three concurrent callers inside one debounce window — exactly what a wake
    // does (visibilitychange + online + the entities hook's forceReconnect).
    const results: boolean[] = []
    void requestRecovery().then((r) => results.push(r))
    void requestRecovery().then((r) => results.push(r))
    void requestRecovery().then((r) => results.push(r))
    await settle()

    // One pass, one id bump — not three.
    expect(getLastRepairId()).toBe(before + 1)
    expect(fakeSocket.connectCalls).toBe(1)
    // All three waiters get the same truthful answer.
    expect(results).toEqual([true, true, true])
  })

  // ── Resolver ownership: a mid-pass trigger must not steal the in-flight
  //     pass's waiters (the broken flat-array case) ──
  it('(ownership) a requestRecovery arriving MID-PASS joins it: both callers see true, one repair', async () => {
    // A real repair with a SLOW auth round-trip (the realistic wake case: an
    // expired token means a network refresh_token call).
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    fakeSupabase.auth.getSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          fakeSocket.getSessionCalls++
          setTimeout(() => resolve({ data: { session: { access_token: 'fresh-token' } } }), 400)
        }),
    )
    teardown = startRealtimeWatchdog()
    const before = getLastRepairId()

    // Caller 1 rides the watchdog's own 'focus' trigger.
    let first: boolean | null = null
    void requestRecovery().then((r) => {
      first = r
    })
    window.dispatchEvent(new Event('focus'))
    // Let the debounce fire and the pass START (it is now blocked on getSession).
    await vi.advanceTimersByTimeAsync(200)

    // Caller 2 arrives WHILE the pass is in flight. Its own debounce window
    // lands in the running branch — which previously drained caller 1's
    // resolver with `false` while the real repair was still running.
    let second: boolean | null = null
    void requestRecovery().then((r) => {
      second = r
    })
    await vi.advanceTimersByTimeAsync(200)

    // Finish the slow getSession and let the pass settle.
    await vi.advanceTimersByTimeAsync(500)
    await settle()

    expect(getLastRepairId()).toBe(before + 1)
    expect(fakeSocket.connectCalls).toBe(1)
    // BOTH callers must learn the repair happened — this is what latches
    // hadFailure and drives the catch-up refetch.
    expect(first).toBe(true)
    expect(second).toBe(true)
  })

  it('(ownership) a bare window focus MID-PASS does not resolve the in-flight caller false', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    fakeSupabase.auth.getSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          fakeSocket.getSessionCalls++
          setTimeout(() => resolve({ data: { session: { access_token: 'fresh-token' } } }), 400)
        }),
    )
    teardown = startRealtimeWatchdog()
    const before = getLastRepairId()

    let repaired: boolean | null = null
    void requestRecovery().then((r) => {
      repaired = r
    })
    // Start the pass.
    await vi.advanceTimersByTimeAsync(200)
    // A plain 'focus' (no promise of its own) lands mid-pass; its debounce
    // window must not settle the caller that owns the running pass.
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(200)
    expect(repaired).toBeNull()

    await vi.advanceTimersByTimeAsync(500)
    await settle()

    expect(repaired).toBe(true)
    expect(getLastRepairId()).toBe(before + 1)
    expect(fakeSocket.connectCalls).toBe(1)
  })

  it('a throttled requestRecovery resolves false rather than hanging', async () => {
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    teardown = startRealtimeWatchdog()

    void requestRecovery()
    await settle()
    expect(fakeSocket.connectCalls).toBe(1)

    // Second call lands inside MIN_PASS_INTERVAL_MS — suppressed. It must still
    // settle (an un-settled promise would strand the caller's latch forever).
    let repaired: boolean | null = null
    void requestRecovery().then((r) => {
      repaired = r
    })
    await settle()
    expect(repaired).toBe(false)
    expect(fakeSocket.connectCalls).toBe(1)
  })
})

// ── Self-refetch dedup helper (pure; module-level map) ─────────────
describe('self-refetch dedup', () => {
  beforeEach(() => {
    __resetSelfRefetchMarks()
  })

  it('an unmarked key is never suppressed', () => {
    expect(wasSelfRefetchedRecently('attention-rail')).toBe(false)
  })

  it('a freshly marked key is suppressed inside the window', () => {
    markSelfRefetched('attention-rail')
    expect(wasSelfRefetchedRecently('attention-rail')).toBe(true)
  })

  it('the mark expires — a LATER, genuinely separate repair still refetches', () => {
    markSelfRefetched('attention-rail')
    // Past the 3s window (and past MIN_PASS_INTERVAL_MS, so this represents a
    // second real repair, not an echo of the first).
    vi.advanceTimersByTime(3_001)
    expect(wasSelfRefetchedRecently('attention-rail')).toBe(false)
  })

  it('keys are independent — one channel\'s mark never suppresses another', () => {
    // notification-context keys by `notifications:${memberId}`: a workspace
    // switch must not let the old member's mark suppress the new member's
    // catch-up.
    markSelfRefetched('notifications:member-a')
    expect(wasSelfRefetchedRecently('notifications:member-b')).toBe(false)
    expect(wasSelfRefetchedRecently('notifications:member-a')).toBe(true)
  })

  // ── Exact dedup: match the repair id, not merely the time window ──
  it('suppresses only the echo of the repair the mark accounted for', async () => {
    // Mark at the CURRENT repair id.
    markSelfRefetched('attention-rail')
    const marked = getLastRepairId()
    // The event for that same repair is the duplicate we want to swallow.
    expect(wasSelfRefetchedRecently('attention-rail', marked)).toBe(true)

    // A SECOND real repair inside the same 3s window is a DIFFERENT gap: its
    // fan-out must still refetch. The purely temporal check swallowed it.
    expect(wasSelfRefetchedRecently('attention-rail', marked + 1)).toBe(false)
  })

  it('an omitted / non-numeric repair id degrades to the time window, never to wrong', () => {
    markSelfRefetched('attention-rail')
    // No id (a hand-rolled dispatch, or an older bundle) — window behaviour.
    expect(wasSelfRefetchedRecently('attention-rail')).toBe(true)
    expect(repairIdFromRecoveredEvent(new Event('dial8:realtime-recovered'))).toBeUndefined()
    expect(
      repairIdFromRecoveredEvent(
        new CustomEvent('dial8:realtime-recovered', { detail: { repairId: 'nope' } }),
      ),
    ).toBeUndefined()
    // And an expired mark still stops suppressing even with a matching id.
    const marked = getLastRepairId()
    vi.advanceTimersByTime(3_001)
    expect(wasSelfRefetchedRecently('attention-rail', marked)).toBe(false)
  })

  it('reads the repair id off a real recovered event', () => {
    expect(
      repairIdFromRecoveredEvent(
        new CustomEvent('dial8:realtime-recovered', { detail: { repairId: 7 } }),
      ),
    ).toBe(7)
  })

  // ── Fix 9: a healthy trigger must not consume the throttle budget ──
  it('(fix 9) a healthy trigger does NOT spend the throttle — a real death seconds later recovers immediately', async () => {
    // Healthy at t=0.
    fakeSocket.connected = true
    fakeSocket.state = 'open'
    teardown = startRealtimeWatchdog()

    // Healthy trigger — no-op, must NOT record a pass timestamp.
    window.dispatchEvent(new Event('online'))
    await settle()
    expect(fakeSocket.connectCalls).toBe(0)

    // Socket dies ~1s later — well inside MIN_PASS_INTERVAL (5s) had the healthy
    // trigger spent the budget. It must still recover on the very next trigger.
    await vi.advanceTimersByTimeAsync(1000)
    fakeSocket.connected = false
    fakeSocket.state = 'closed'
    window.dispatchEvent(new Event('online'))
    await settle()

    expect(fakeSocket.connectCalls).toBe(1)
  })
})
