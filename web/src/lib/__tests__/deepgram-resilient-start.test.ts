// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DeepgramConnection, DeepgramStreamingService } from '../deepgram-stream'
import { listen } from '@tauri-apps/api/event'

/**
 * Tests for the resilient-start fixes (the 386s zero-transcript incident):
 *
 *   A.1  Degraded dual-mode start — one leg fails, the session still starts and
 *        the failed leg is handed to the reconnect machinery; both legs fail →
 *        start() rejects.
 *   A.2  Socket-leak fix — a connect timeout closes the in-flight WebSocket so a
 *        LATE onopen can never fire keep-alives / the status callback; both-legs-
 *        fail cleans up every socket and timer.
 *   A.3  Retryable initial connect — an initial timeout feeds the bounded
 *        scheduleReconnect path (a fresh socket is created after backoff).
 *
 * The Tauri event import in service.start('tauri') is mocked so jsdom needs no
 * real @tauri-apps runtime.
 */

// ── Controllable mock WebSocket ─────────────────────────────────
// Each socket decides WHEN (or whether) it opens, so a test can hold a leg in
// CONNECTING to force the 10s connect timeout, or open it late to prove a timed-
// out socket can't fire callbacks.

let liveSockets: MockWebSocket[] = []
/** Sockets constructed at index i take openBehavior[i] — 'auto' (open on next
 *  microtask), 'never' (stay CONNECTING → hits the timeout), or a number of ms
 *  to open after (used to open a socket AFTER its connect timeout fired). */
let openBehavior: Array<'auto' | 'never' | number> = []
/** Behavior for sockets beyond openBehavior's length (e.g. an unbounded chain of
 *  reconnect sockets in the give-up test). Defaults to 'auto'. */
let defaultOpen: 'auto' | 'never' | number = 'auto'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  sent: unknown[] = []
  closed = false

  constructor(public url: string, public protocols?: string[]) {
    const idx = liveSockets.length
    liveSockets.push(this)
    const behavior = openBehavior[idx] ?? defaultOpen
    if (behavior === 'auto') {
      queueMicrotask(() => this.forceOpen())
    } else if (typeof behavior === 'number') {
      setTimeout(() => this.forceOpen(), behavior)
    }
    // 'never' → stays CONNECTING until its connect timeout fires.
  }

  forceOpen() {
    // A socket the connection already cleaned up has its handlers nulled — a
    // late open must then be a no-op (this is exactly the leak we guard against).
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  /**
   * Test-only: force the socket OPEN and invoke whatever `onopen` handler is
   * CURRENTLY stored, WITHOUT the readyState short-circuit. This is what proves
   * the handler-nulling in cleanupSocket() actually happened: if cleanupSocket
   * stopped nulling onopen, this would run the connection's real onopen on a
   * dead/late socket and fire the status callback + keep-alives — the leak. With
   * nulling intact, this.onopen is null and this is a genuine no-op.
   */
  fireStoredOnopen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
  }

  keepAliveCount() {
    return this.sent.filter((s) => typeof s === 'string' && (s as string).includes('KeepAlive')).length
  }
}

// Deterministic Tauri event mock so service.start('tauri') can wire audio
// listeners without a real runtime. Returns an unlisten no-op.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

function socketAt(i: number): MockWebSocket {
  return liveSockets[i]
}

async function microtasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  liveSockets = []
  openBehavior = []
  defaultOpen = 'auto'
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  // Worker isn't available under fake timers — force the fallback keep-alive
  // path so keep-alive frames are observable (matches the zombie-socket suite).
  vi.stubGlobal('Worker', class { constructor() { throw new Error('no worker in test') } })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DeepgramConnection connect-timeout socket-leak fix', () => {
  it('closes the in-flight socket on connect timeout; a late onopen cannot fire callbacks', async () => {
    // Both the initial socket AND its reconnect stay CONNECTING, so the ONLY way
    // a 'connected' status or a keep-alive could appear is the leak we're testing
    // (a timed-out socket opening late). No legit connect can muddy the signal.
    openBehavior = ['never', 'never', 'never']
    const connectedStatuses: string[] = []
    const conn = new DeepgramConnection('mic', () => {}, undefined, undefined, (s) => {
      if (s === 'connected') connectedStatuses.push(s)
    })

    const connectPromise = conn.connect('key-1')
    // Prevent an unhandled-rejection warning; we assert on it below.
    const settled = connectPromise.then(() => 'ok').catch(() => 'rejected')

    // Advance past the 10s connect timeout. The connection must close the
    // still-CONNECTING socket AND arm a reconnect (retryable initial connect).
    await vi.advanceTimersByTimeAsync(10_001)
    await microtasks()

    expect(await settled).toBe('rejected')
    const first = socketAt(0)
    expect(first.closed).toBe(true)

    // The socket now tries to open LATE (the real leak: a timed-out socket that
    // opens ~20s in and starts keep-alives). fireStoredOnopen() invokes whatever
    // onopen is CURRENTLY stored, with NO readyState short-circuit — so if
    // cleanupSocket() ever stopped nulling handlers, the connection's real onopen
    // would run here and this assertion would fail. With nulling intact it's a
    // no-op: no 'connected' status, no keep-alive.
    first.fireStoredOnopen()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connectedStatuses.length).toBe(0) // no 'connected' from the zombie
    expect(first.keepAliveCount()).toBe(0) // never armed keep-alive

    conn.close()
  })

  it('retries the initial connect via the bounded reconnect path (a fresh socket is made after backoff)', async () => {
    openBehavior = ['never', 'auto'] // first attempt times out, the retry opens
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    const settled = connectPromise.then(() => 'ok').catch(() => 'rejected')

    await vi.advanceTimersByTimeAsync(10_001) // first attempt times out
    await microtasks()
    expect(await settled).toBe('rejected') // caller's promise still rejects (bounded contract)

    // scheduleReconnect armed a 500ms backoff; advance past it → a NEW socket.
    await vi.advanceTimersByTimeAsync(600)
    await microtasks()
    expect(liveSockets.length).toBeGreaterThan(1)
    expect(socketAt(1).readyState).toBe(MockWebSocket.OPEN)

    conn.close()
  })

  it('keeps the reconnect chain alive when a SCHEDULED reconnect also times out (Finding 1)', async () => {
    // The regression the verifier reproduced: initial attempt times out → reconnect
    // #1 armed; reconnect #1 ALSO times out. The timeout cleanup nulls onclose, so
    // WITHOUT re-entering the reconnect machinery the chain would die here. It must
    // instead schedule reconnect #2 → a THIRD socket, which finally opens.
    openBehavior = ['never', 'never', 'auto']
    const statuses: string[] = []
    const conn = new DeepgramConnection('mic', () => {}, undefined, undefined, (s) => statuses.push(s))
    const connectPromise = conn.connect('key-1')
    const settled = connectPromise.then(() => 'ok').catch(() => 'rejected')

    // Attempt 0 (initial) times out → rejects the caller + arms reconnect #1 (500ms).
    await vi.advanceTimersByTimeAsync(10_001)
    await microtasks()
    expect(await settled).toBe('rejected')
    expect(liveSockets.length).toBe(1)

    // Backoff #1 (500ms) fires → socket 1 (reconnect #1) created; it also times out.
    await vi.advanceTimersByTimeAsync(600)
    await microtasks()
    expect(liveSockets.length).toBe(2)
    await vi.advanceTimersByTimeAsync(10_001) // reconnect #1's connect timeout
    await microtasks()

    // The chain must NOT be dead: reconnect #2 is armed (backoff #2 = 1000ms).
    await vi.advanceTimersByTimeAsync(1_100)
    await microtasks()
    expect(liveSockets.length).toBe(3)
    expect(socketAt(2).readyState).toBe(MockWebSocket.OPEN) // third socket finally opened
    // Never reported 'disconnected' (give-up) — it recovered well before MAX.
    expect(statuses).not.toContain('disconnected')

    conn.close()
  })

  it('terminates the reconnect chain at MAX_RECONNECT_ATTEMPTS (give-up → disconnected)', async () => {
    // Every attempt times out forever. The chain must bounded-retry exactly
    // MAX_RECONNECT_ATTEMPTS times, then give up (status 'disconnected') and
    // create no further sockets — it must not loop unbounded. Every socket (the
    // initial one and every reconnect) stays CONNECTING via defaultOpen.
    defaultOpen = 'never'
    const statuses: string[] = []
    const conn = new DeepgramConnection('mic', () => {}, undefined, undefined, (s) => statuses.push(s))
    const connectPromise = conn.connect('key-1')
    connectPromise.catch(() => {}) // swallow the initial rejection

    // Initial connect times out.
    await vi.advanceTimersByTimeAsync(10_001)
    await microtasks()

    // Drive all reconnect attempts: each is (backoff ≤30s) + (10s connect timeout).
    // Advancing generously per cycle covers the growing capped backoff.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(41_000)
      await microtasks()
    }

    // 1 initial + MAX_RECONNECT_ATTEMPTS reconnect sockets, then it stops.
    // (MAX_RECONNECT_ATTEMPTS is 10 — assert we created a bounded number and gave up.)
    expect(statuses).toContain('disconnected')
    const socketsAtGiveUp = liveSockets.length
    // No further sockets after give-up, even with more time.
    await vi.advanceTimersByTimeAsync(120_000)
    await microtasks()
    expect(liveSockets.length).toBe(socketsAtGiveUp)
    expect(socketsAtGiveUp).toBeLessThanOrEqual(1 + 10) // initial + MAX

    conn.close()
  })

  it('close() during a pending reconnect cancels it (no socket after close)', async () => {
    openBehavior = ['never', 'never'] // initial times out, reconnect armed but not yet fired
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    connectPromise.catch(() => {})

    await vi.advanceTimersByTimeAsync(10_001) // initial times out → reconnect #1 armed (500ms)
    await microtasks()
    expect(liveSockets.length).toBe(1)

    // Close BEFORE the 500ms backoff elapses — the pending reconnect must be cancelled.
    conn.close()
    const countAtClose = liveSockets.length
    await vi.advanceTimersByTimeAsync(60_000)
    await microtasks()
    expect(liveSockets.length).toBe(countAtClose) // no reconnect socket was ever created
  })

  it('close() while a reconnect awaits its key refresh opens no socket afterwards', async () => {
    openBehavior = ['never']
    let releaseKey: (k: string) => void = () => {}
    const refresh = vi.fn(() => new Promise<string>((r) => { releaseKey = r }))
    const conn = new DeepgramConnection('mic', () => {})
    conn.connect('key-1', refresh).catch(() => {})

    await vi.advanceTimersByTimeAsync(10_001) // initial times out → reconnect armed
    await vi.advanceTimersByTimeAsync(1_000) // backoff fires → awaiting refresh
    expect(refresh).toHaveBeenCalledTimes(1)
    const countAtClose = liveSockets.length

    conn.close()
    releaseKey('key-2')
    await microtasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(liveSockets.length).toBe(countAtClose)
  })

  it('a second reconnect firing while the first awaits its key refresh opens no second socket', async () => {
    openBehavior = ['never']
    const releases: Array<(k: string) => void> = []
    const refresh = vi.fn(() => new Promise<string>((r) => { releases.push(r) }))
    const conn = new DeepgramConnection('mic', () => {})
    conn.connect('key-1', refresh).catch(() => {})

    await vi.advanceTimersByTimeAsync(10_001) // initial times out → reconnect armed
    await vi.advanceTimersByTimeAsync(1_000) // backoff fires → awaiting refresh
    expect(refresh).toHaveBeenCalledTimes(1)
    const countBefore = liveSockets.length

    // Network back online: a second reconnect is armed and fires while the
    // first is still refreshing its key.
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(1_000)

    for (const release of releases) release('key-2')
    await microtasks()
    expect(liveSockets.length).toBe(countBefore + 1)
    conn.close()
  })
})

describe('DeepgramStreamingService degraded dual-mode start', () => {
  it('starts when ONE leg connects and hands the failed leg to reconnect', async () => {
    // Socket 0 (mic) opens; socket 1 (system) never opens → its leg times out.
    openBehavior = ['auto', 'never']
    const svc = new DeepgramStreamingService(() => {})
    const startPromise = svc.start('key-1', 'tauri')

    await microtasks() // let the mic leg open
    await vi.advanceTimersByTimeAsync(10_001) // system leg times out
    await microtasks()

    // start() resolved (single-leg success) — NOT rejected.
    await expect(startPromise).resolves.toBeUndefined()

    // The failed system leg armed a reconnect: advancing backoff makes a fresh
    // system socket (proof it wasn't abandoned).
    const socketsAfterStart = liveSockets.length
    await vi.advanceTimersByTimeAsync(600)
    await microtasks()
    expect(liveSockets.length).toBeGreaterThan(socketsAfterStart)

    svc.stop()
  })

  it('rejects when BOTH legs fail, and cleans up every socket + timer (no leak)', async () => {
    openBehavior = ['never', 'never'] // both legs time out
    const svc = new DeepgramStreamingService(() => {})
    const startPromise = svc.start('key-1', 'tauri')
    const settled = startPromise.then(() => 'ok').catch(() => 'rejected')

    await vi.advanceTimersByTimeAsync(10_001) // both connect timeouts fire
    await microtasks()

    expect(await settled).toBe('rejected')

    // Every socket created so far must be closed — none may open later and leak.
    for (const s of liveSockets) expect(s.closed).toBe(true)
    const countAfterReject = liveSockets.length

    // Both legs were close()d (intentionallyClosed) so NO further reconnect
    // sockets get created, and forcing any late open is a no-op.
    for (const s of liveSockets) s.forceOpen()
    await vi.advanceTimersByTimeAsync(60_000)
    await microtasks()
    expect(liveSockets.length).toBe(countAfterReject)
    // No keep-alives anywhere (no socket ever truly opened into a live stream).
    for (const s of liveSockets) expect(s.keepAliveCount()).toBe(0)
  })
})

describe('DeepgramStreamingService web (mic-only) start failure (Finding 3)', () => {
  it('closes the failed mic leg (cancels its reconnect) and rethrows to the caller', async () => {
    // Web has ONE leg. It never opens → its connect times out and connect()
    // rejects. start('web') must close() that leg (so its armed reconnect is
    // cancelled and the socket won't open late) and rethrow so the hook's
    // setup-retry loop can retry the whole setup with a fresh token.
    openBehavior = ['never']
    const svc = new DeepgramStreamingService(() => {})
    const startPromise = svc.start('key-1', 'web')
    const settled = startPromise.then(() => 'ok').catch((e) => (e instanceof Error ? e.message : 'rejected'))

    await vi.advanceTimersByTimeAsync(10_001) // the mic leg times out
    await microtasks()

    // The error propagated to the caller (not swallowed).
    expect(await settled).not.toBe('ok')

    // The single mic socket was closed (leg.close() ran) — no leaked socket.
    expect(liveSockets.length).toBe(1)
    expect(socketAt(0).closed).toBe(true)

    // close() marked the leg intentionallyClosed, so NO reconnect socket is ever
    // created, and forcing a late open is a no-op (no keep-alive, no new socket).
    socketAt(0).forceOpen()
    await vi.advanceTimersByTimeAsync(60_000)
    await microtasks()
    expect(liveSockets.length).toBe(1)
    expect(socketAt(0).keepAliveCount()).toBe(0)

    // The service must not retain a mic connection to a dead leg: a subsequent
    // stop() is a clean no-op (the ref was nulled). Proven by it not throwing.
    expect(() => svc.stop()).not.toThrow()
  })
})

describe('DeepgramStreamingService stop() while an audio listen is pending', () => {
  it('unlistens the late listener, keeps its handler silent and skips the rest', async () => {
    vi.mocked(listen).mockClear()
    let resolveMic: ((fn: () => void) => void) | null = null
    let micHandler: ((e: { payload: number[] }) => void) | null = null
    vi.mocked(listen).mockImplementationOnce(((_event: string, handler: (e: { payload: number[] }) => void) => {
      micHandler = handler
      return new Promise<() => void>((r) => {
        resolveMic = r
      })
    }) as unknown as typeof listen)

    const svc = new DeepgramStreamingService(() => {})
    const onAudio = vi.fn()
    svc.onAudioData = onAudio
    const startPromise = svc.start('key-1', 'tauri')

    // Both legs open, then start() reaches the (held) mic listen.
    for (let i = 0; i < 20 && !resolveMic; i++) await vi.advanceTimersByTimeAsync(0)
    expect(resolveMic).not.toBeNull()

    // The service stops before the listen resolves.
    svc.stop()
    const unlisten = vi.fn()
    resolveMic!(unlisten)
    await expect(startPromise).resolves.toBeUndefined()

    // The late listener is torn down, its handler stays silent, and start()
    // never subscribes the system leg for the stopped service.
    expect(unlisten).toHaveBeenCalledTimes(1)
    micHandler!({ payload: [1, 2, 3] })
    expect(onAudio).not.toHaveBeenCalled()
    expect(listen).toHaveBeenCalledTimes(1)
  })
})
