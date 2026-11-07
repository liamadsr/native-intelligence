/**
 * Wiring test for the browser client's realtime heartbeatCallback (Fix 6).
 *
 * The desktop WKWebView's websocket can die silently; the SDK reports it via the
 * heartbeat callback as 'timeout' (a heartbeat went unanswered) or 'disconnected'
 * (the socket is already down). Both must accelerate a reconnect by poking
 * connect(). The subtlety: on 'timeout' the SDK fires the callback SYNCHRONOUSLY
 * *before* it closes the socket, so a synchronous connect() would early-return
 * (isConnected() still true). We defer by a macrotask so the poke lands after the
 * close.
 *
 * This test captures the realtime options passed to createBrowserClient and
 * asserts both statuses end in a connect() call (timeout only after a timer
 * flush) — pinning the option name + status strings against a silent SDK upgrade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type HeartbeatStatus = 'sent' | 'ok' | 'error' | 'timeout' | 'disconnected'

let capturedHeartbeatCallback: ((status: HeartbeatStatus) => void) | undefined
const connect = vi.fn()

// Mock createBrowserClient so we can (a) capture the realtime options it's
// constructed with and (b) return a client whose realtime.connect we can spy on.
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: vi.fn(
    (_url: string, _key: string, opts?: { realtime?: { heartbeatCallback?: (s: HeartbeatStatus) => void } }) => {
      capturedHeartbeatCallback = opts?.realtime?.heartbeatCallback
      return { realtime: { connect } }
    },
  ),
}))

import { createClient } from '../client'

beforeEach(() => {
  vi.useFakeTimers()
  connect.mockClear()
  capturedHeartbeatCallback = undefined
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createClient realtime heartbeatCallback', () => {
  it('wires a heartbeatCallback into the realtime options', () => {
    createClient()
    expect(typeof capturedHeartbeatCallback).toBe('function')
  })

  it("'disconnected' pokes connect() (after a macrotask)", () => {
    createClient()
    capturedHeartbeatCallback!('disconnected')
    // Deferred by setTimeout(0): nothing yet.
    expect(connect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("'timeout' pokes connect() AFTER the timer flush (deferred past the SDK's own close)", () => {
    createClient()
    capturedHeartbeatCallback!('timeout')
    // Must NOT fire synchronously — a sync connect() would early-return while
    // the socket is still open (isConnected() true before the SDK closes it).
    expect(connect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("healthy statuses ('sent'/'ok'/'error') never poke connect()", () => {
    createClient()
    capturedHeartbeatCallback!('sent')
    capturedHeartbeatCallback!('ok')
    capturedHeartbeatCallback!('error')
    vi.advanceTimersByTime(10)
    expect(connect).not.toHaveBeenCalled()
  })
})
