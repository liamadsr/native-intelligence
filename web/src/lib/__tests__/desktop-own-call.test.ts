/**
 * The desktop's own-call watch (src/lib/desktop-own-call.ts) under fake
 * timers: it says `true` at once and every tick while the person is in one of
 * our calls (the desktop holds each word 150 s), `false` once when the call is
 * over, nothing on a failed read, re-reads on a change to his rows, and its
 * stop takes a held `true` back and leaves no timer behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OWN_CALL_CHANGE_DEBOUNCE_MS, OWN_CALL_TICK_MS, watchOwnCall } from '@/lib/desktop-own-call'

function harness(initial: boolean | null) {
  const world = { inCall: initial as boolean | null, fail: false }
  const sent: boolean[] = []
  let onChange: (() => void) | null = null
  const unsubscribe = vi.fn()
  const stop = watchOwnCall({
    readInCall: async () => {
      if (world.fail) throw new Error('offline')
      return world.inCall
    },
    send: async (active) => {
      sent.push(active)
    },
    subscribe: (cb) => {
      onChange = cb
      return unsubscribe
    },
  })
  return { world, sent, stop, unsubscribe, change: () => onChange?.() }
}

describe('watchOwnCall', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says true at once and re-says it every tick while in a call', async () => {
    const h = harness(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sent).toEqual([true])
    await vi.advanceTimersByTimeAsync(OWN_CALL_TICK_MS * 2)
    expect(h.sent).toEqual([true, true, true])
    h.stop()
  })

  it('says false once when the call is over', async () => {
    const h = harness(true)
    await vi.advanceTimersByTimeAsync(0)
    h.world.inCall = false
    await vi.advanceTimersByTimeAsync(OWN_CALL_TICK_MS * 3)
    expect(h.sent).toEqual([true, false])
    h.stop()
  })

  it('says false once at the start when not in a call (clears a hold left by a reloaded window)', async () => {
    const h = harness(false)
    await vi.advanceTimersByTimeAsync(OWN_CALL_TICK_MS * 2)
    expect(h.sent).toEqual([false])
    h.stop()
  })

  it('says nothing when the read fails or answers nothing', async () => {
    const h = harness(null)
    await vi.advanceTimersByTimeAsync(OWN_CALL_TICK_MS)
    h.world.fail = true
    await vi.advanceTimersByTimeAsync(OWN_CALL_TICK_MS)
    expect(h.sent).toEqual([])
    h.stop()
  })

  it('re-reads shortly after a change to his rows, once per burst', async () => {
    const h = harness(false)
    await vi.advanceTimersByTimeAsync(0)
    h.world.inCall = true
    h.change()
    h.change()
    await vi.advanceTimersByTimeAsync(OWN_CALL_CHANGE_DEBOUNCE_MS)
    expect(h.sent).toEqual([false, true])
    h.stop()
  })

  it('stop takes a held true back, unsubscribes and stops ticking', async () => {
    const h = harness(true)
    await vi.advanceTimersByTimeAsync(0)
    h.stop()
    expect(h.sent).toEqual([true, false])
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OWN_CALL_TICK_MS * 3)
    expect(h.sent).toEqual([true, false])
  })
})
