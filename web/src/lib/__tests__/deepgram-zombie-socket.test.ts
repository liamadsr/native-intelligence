// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DeepgramConnection } from '../deepgram-stream'

/**
 * Tests for the zombie-socket detection added to DeepgramConnection.
 *
 * Background: after a long app-background / system sleep, the WKWebView's JS is
 * suspended. On wake a Deepgram WebSocket can survive as a ZOMBIE — readyState
 * still reads OPEN, so sendAudio() keeps forwarding PCM, but the connection is
 * actually dead and `onclose` never fires. Audio "records" (native Rust thread)
 * while transcription is silently dead. These tests prove the watchdog + wake
 * handler force a reconnect in that exact scenario, and DON'T false-positive on
 * a healthy or legitimately-idle (paused) stream.
 */

// ── Mock WebSocket ──────────────────────────────────────────────
// A controllable fake that lets each test decide whether the socket "responds"
// (delivers a message after audio) or behaves like a zombie (stays silent).

const OPEN = 1
let liveSockets: MockWebSocket[] = []

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

  constructor(public url: string, public protocols?: string[]) {
    liveSockets.push(this)
    // Open synchronously on the next microtask so connect()'s promise resolves.
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  /** Simulate Deepgram delivering a frame back (proves liveness). */
  deliver(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }
}

function newestSocket(): MockWebSocket {
  return liveSockets[liveSockets.length - 1]
}

/** Drive a connect()'s pending microtask + onopen to completion. */
async function flushOpen() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  liveSockets = []
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DeepgramConnection zombie-socket detection', () => {
  it('forces a reconnect when a fed socket goes silent past the threshold', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    const first = newestSocket()
    expect(first.readyState).toBe(OPEN)

    // Real zombie scenario: audio keeps flowing (native Rust thread is alive)
    // but Deepgram delivers NOTHING back. Feed audio every second so the
    // watchdog's audio-recency gate stays satisfied, while never calling
    // deliver(). Advance ~18s so a watchdog tick lands past the 12s message-
    // silence threshold and the 500ms reconnect timer then fires.
    for (let i = 0; i < 18; i++) {
      conn.sendAudio(new Uint8Array([i]))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await flushOpen()

    // A brand-new socket was created for the reconnect.
    expect(liveSockets.length).toBeGreaterThan(1)
    expect(newestSocket()).not.toBe(first)

    conn.close()
  })

  it('does NOT reconnect a healthy stream that keeps receiving frames', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    const sock = newestSocket()

    // Simulate ongoing healthy traffic: send audio + receive a frame each tick.
    for (let i = 0; i < 5; i++) {
      conn.sendAudio(new Uint8Array([i]))
      sock.deliver({ type: 'Results', channel: { alternatives: [{ transcript: '' }] } })
      await vi.advanceTimersByTimeAsync(5_000)
    }

    // No reconnect: still the same single socket.
    expect(liveSockets.length).toBe(1)
    expect(newestSocket()).toBe(sock)

    conn.close()
  })

  it('does NOT reconnect when no audio is being sent (paused / idle stream)', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    const sock = newestSocket()

    // Never call sendAudio — mirrors a paused recording where the native layer
    // stops emitting PCM. Silence here is expected, not a fault.
    await vi.advanceTimersByTimeAsync(30_000)

    expect(liveSockets.length).toBe(1)
    expect(newestSocket()).toBe(sock)

    conn.close()
  })

  it('health-checks immediately on app-wake (visibilitychange) without waiting for the watchdog', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    const first = newestSocket()

    // Precisely model a suspend: the WALL CLOCK jumps forward (Date.now moves)
    // but interval timers DON'T fire (JS was frozen). vi.setSystemTime advances
    // Date.now without running pending timers — exactly the watchdog's blind
    // spot. Send audio right after the jump so checkHealth's audio gate passes
    // while message-silence (seeded at open, pre-jump) is now far past stale.
    vi.setSystemTime(Date.now() + 60_000)
    conn.sendAudio(new Uint8Array([1])) // fresh audio at the new wall-clock time

    const before = liveSockets.length

    // Fire the wake handler — checkHealth() runs synchronously and schedules a
    // reconnect (500ms backoff). Advance past that timer to create the socket.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(600)
    await flushOpen()

    expect(liveSockets.length).toBeGreaterThan(before)
    expect(newestSocket()).not.toBe(first)

    conn.close()
  })

  it('sends KeepAlive frames on a cadence (fallback timer path)', async () => {
    // Force the throttle-proof worker path to be unavailable so the connection
    // falls back to the main-thread keep-alive timer, which we can drive with
    // fake timers. (The worker path can't tick under fake timers anyway.)
    vi.stubGlobal('Worker', class { constructor() { throw new Error('no worker in test') } })

    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    const sock = newestSocket()
    const keepAlives = () =>
      sock.sent.filter((s) => typeof s === 'string' && (s as string).includes('KeepAlive')).length

    expect(keepAlives()).toBe(0)

    // Each 5s tick should emit exactly one KeepAlive.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(keepAlives()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(keepAlives()).toBe(3)

    conn.close()
  })

  it('stops the keep-alive after close (no further KeepAlive frames)', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('no worker in test') } })

    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    const sock = newestSocket()
    await vi.advanceTimersByTimeAsync(5_000)
    const before = sock.sent.filter((s) => typeof s === 'string' && (s as string).includes('KeepAlive')).length
    expect(before).toBeGreaterThan(0)

    conn.close()
    await vi.advanceTimersByTimeAsync(30_000)
    const after = sock.sent.filter((s) => typeof s === 'string' && (s as string).includes('KeepAlive')).length
    // close() sends one CloseStream but no further KeepAlives.
    expect(after).toBe(before)
  })

  it('cleans up wake/online listeners on close (no reconnect after close)', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    conn.sendAudio(new Uint8Array([1]))
    conn.close()

    const countAfterClose = liveSockets.length

    // Any wake event after close must be a no-op.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(20_000)
    await flushOpen()

    expect(liveSockets.length).toBe(countAfterClose)
  })
})

describe('DeepgramConnection.hasReceivedAudio (first-frame signal)', () => {
  it('is false on a fresh connection before any PCM is forwarded', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    // Connected, but no sendAudio() yet — mirrors the CoreAudio device-release
    // race where the stream opens but its IO proc never fires.
    expect(conn.hasReceivedAudio()).toBe(false)

    conn.close()
  })

  it('flips to true once a PCM frame is forwarded to the open socket', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    expect(conn.hasReceivedAudio()).toBe(false)
    conn.sendAudio(new Uint8Array([1, 2, 3]))
    expect(conn.hasReceivedAudio()).toBe(true)

    conn.close()
  })

  it('getLastAudioAt is 0 before any PCM and tracks the latest forwarded frame', async () => {
    const conn = new DeepgramConnection('mic', () => {})
    const connectPromise = conn.connect('key-1')
    await flushOpen()
    await connectPromise

    // Never fed → 0. This is what lets the mic-recovery coordinator treat a
    // never-fed stream as "no audio since the last rebuild".
    expect(conn.getLastAudioAt()).toBe(0)

    conn.sendAudio(new Uint8Array([1]))
    const first = conn.getLastAudioAt()
    expect(first).toBeGreaterThan(0)

    // A later frame advances the timestamp — the coordinator compares this
    // against its last recover_mic time to detect that a rebuild worked.
    await vi.advanceTimersByTimeAsync(2_000)
    conn.sendAudio(new Uint8Array([2]))
    expect(conn.getLastAudioAt()).toBeGreaterThan(first)

    conn.close()
  })
})
