// @vitest-environment jsdom
/**
 * Tests for useAgentNudgeRelay's channel-resilience contract (Fix 2).
 *
 * The relay's Realtime subscription must survive a mid-meeting channel failure:
 * a single CHANNEL_ERROR / TIMED_OUT / CLOSED used to only LOG and then leave
 * the HUD dead for the rest of the call (chat kept working, masking it). These
 * lock in the fixed behavior:
 *   1. A CHANNEL_ERROR tears the failed channel down and resubscribes (after the
 *      backoff delay), creating a NEW channel — never two concurrent ones.
 *   2. A clean SUBSCRIBED resets the backoff so a later failure restarts at 1s.
 *   3. Effect cleanup cancels any pending retry timer (no resubscribe fires, and
 *      no channel leaks) after unmount.
 *
 * We exercise ONLY the hook's subscribe/retry lifecycle against a controllable
 * fake supabase channel + a stubbed tauri bridge — not the real Realtime stack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { createElement as h, act, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Controllable fake supabase channel ──────────────────────────
// Each .channel() call yields a fresh handle; we keep them all so a test can
// drive the subscribe-status callback and assert how many were created.
interface FakeChannel {
  id: number
  statusCb: ((status: string) => void) | null
  removed: boolean
}
let channels: FakeChannel[] = []
let removeChannelCalls: FakeChannel[] = []
// Ordered log of setAuth() and per-channel subscribe() calls, so a test can
// assert that a resubscribe RE-AUTHS (setAuth) BEFORE it subscribes the new
// channel — the fix that stops a stale-JWT CHANNEL_ERROR loop after an overnight
// sleep. Entries: 'setAuth' | `subscribe#<channelId>`.
let authSubscribeLog: string[] = []

function makeFakeSupabase() {
  let nextId = 1
  return {
    realtime: {
      setAuth: vi.fn(async () => {
        authSubscribeLog.push('setAuth')
      }),
    },
    channel: vi.fn(() => {
      const ch: FakeChannel = { id: nextId++, statusCb: null, removed: false }
      const handle = {
        _ch: ch,
        on: vi.fn(() => handle),
        subscribe: vi.fn((cb: (status: string) => void) => {
          ch.statusCb = cb
          authSubscribeLog.push(`subscribe#${ch.id}`)
          return handle
        }),
      }
      channels.push(ch)
      // Stash the handle so removeChannel can match it back to the fake.
      ;(ch as unknown as { handle: unknown }).handle = handle
      return handle
    }),
    removeChannel: vi.fn(async (handle: { _ch: FakeChannel }) => {
      handle._ch.removed = true
      removeChannelCalls.push(handle._ch)
      // Mirror realtime-js: RealtimeChannel.subscribe wires
      // `_onClose(() => callback('CLOSED'))` and unsubscribe triggers that close
      // event — so EVERY removal reports CLOSED to the removed channel's own
      // status callback. The hook's stale-channel guard exists precisely for
      // this; a fake that stays silent on removal would hide a churn regression
      // (it originally did).
      handle._ch.statusCb?.('CLOSED')
    }),
  }
}

let fakeSupabase: ReturnType<typeof makeFakeSupabase>

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => fakeSupabase,
}))
vi.mock('@/lib/platform', () => ({
  isDesktopApp: () => true,
}))
// tauri-bridge is lazily imported inside the hook; stub the whole module so
// getBridge()/onMainFocusChanged never touch real Tauri.
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    showAgentHud: vi.fn(async () => {}),
    hideAgentHud: vi.fn(async () => {}),
    hideAgentHudTransient: vi.fn(async () => {}),
    pushAgentNudge: vi.fn(async () => {}),
    ensureAgentHud: vi.fn(async () => 'visible'),
    onMainFocusChanged: vi.fn(async () => () => {}),
  },
}))

import { useAgentNudgeRelay } from '../use-agent-nudge-relay'
import { tauriBridge } from '@/lib/tauri-bridge'

// Drive the status callback of the most-recently-created channel.
function driveStatus(status: string) {
  const ch = channels[channels.length - 1]
  act(() => {
    ch.statusCb?.(status)
  })
}

// Mount the hook in a real (jsdom) React tree so its effect + cleanup run.
function mountRelay(captureId: string, live: boolean) {
  const container = document.createElement('div')
  const root = createRoot(container)
  function Harness() {
    useAgentNudgeRelay(captureId, live)
    useEffect(() => {}, [])
    return null
  }
  act(() => {
    root.render(h(Harness))
  })
  return root
}

beforeEach(() => {
  channels = []
  removeChannelCalls = []
  authSubscribeLog = []
  fakeSupabase = makeFakeSupabase()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useAgentNudgeRelay — channel resubscribe on failure', () => {
  it('resubscribes on CHANNEL_ERROR by removing the dead channel and creating a new one', async () => {
    const root = mountRelay('cap-1', true)
    // The subscribe runs after an awaited setAuth() microtask; flush it.
    await act(async () => {})
    expect(channels.length).toBe(1)

    // First channel fails.
    driveStatus('CHANNEL_ERROR')
    // Retry is scheduled behind the 1s backoff — nothing yet.
    expect(channels.length).toBe(1)
    expect(channels[0].removed).toBe(false)

    // Advance past the 1s backoff → the dead channel is removed and a NEW one
    // is created (never two concurrent subscriptions on the same topic).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(channels[0].removed).toBe(true)
    expect(channels.length).toBe(2)

    act(() => root.unmount())
  })

  it('(fix 8) re-auths (setAuth) BEFORE the new subscribe on a resubscribe retry', async () => {
    const root = mountRelay('cap-1', true)
    await act(async () => {})
    // Mount: one setAuth, then the first subscribe.
    expect(authSubscribeLog).toEqual(['setAuth', 'subscribe#1'])

    // Fail → after the backoff the retry must setAuth AGAIN before re-subscribing
    // (a bare resubscribe would carry the mount-time cached — now stale after an
    // overnight sleep — JWT and loop on CHANNEL_ERROR).
    driveStatus('CHANNEL_ERROR')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    // A SECOND setAuth precedes the SECOND channel's subscribe, in order.
    expect(authSubscribeLog).toEqual(['setAuth', 'subscribe#1', 'setAuth', 'subscribe#2'])
    const secondSetAuth = authSubscribeLog.lastIndexOf('setAuth')
    const secondSubscribe = authSubscribeLog.indexOf('subscribe#2')
    expect(secondSetAuth).toBeLessThan(secondSubscribe)
    // And setAuth was called at least twice (mount + retry).
    expect(fakeSupabase.realtime.setAuth).toHaveBeenCalledTimes(2)

    act(() => root.unmount())
  })

  it('caps the backoff with exponential growth (1s → 2s), not a fixed delay', async () => {
    const root = mountRelay('cap-1', true)
    await act(async () => {})

    // First failure → 1s retry.
    driveStatus('CHANNEL_ERROR')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(channels.length).toBe(2)

    // Second consecutive failure → should now wait ~2s. Advancing only 1s must
    // NOT yet create a third channel (proves the delay grew, not fixed 1s).
    driveStatus('CHANNEL_ERROR')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(channels.length).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(channels.length).toBe(3)

    act(() => root.unmount())
  })

  it('resets the backoff after a clean SUBSCRIBED so the next failure starts at 1s again', async () => {
    const root = mountRelay('cap-1', true)
    await act(async () => {})

    // Fail, grow backoff to 2s, then recover cleanly.
    driveStatus('CHANNEL_ERROR')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(channels.length).toBe(2)
    driveStatus('SUBSCRIBED')

    // A fresh failure should now retry at 1s again (backoff was reset).
    driveStatus('CHANNEL_ERROR')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(channels.length).toBe(3)

    act(() => root.unmount())
  })

  it('cancels a pending retry on cleanup — no resubscribe fires and no channel leaks after unmount', async () => {
    const root = mountRelay('cap-1', true)
    await act(async () => {})
    expect(channels.length).toBe(1)

    // Schedule a retry, then unmount before it fires.
    driveStatus('CHANNEL_ERROR')
    act(() => root.unmount())

    const channelsAtUnmount = channels.length
    // The pending retry timer must have been cleared: advancing time creates no
    // new channel.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(channels.length).toBe(channelsAtUnmount)
    // And the active channel was removed by cleanup (no leak).
    expect(removeChannelCalls.length).toBeGreaterThan(0)
    expect(channels[0].removed).toBe(true)
  })

  it("ignores a removed channel's CLOSED — the healthy replacement is never churned", async () => {
    // realtime-js reports CLOSED for closes WE cause (removeChannel) too, not
    // just genuine socket drops. Without the stale-channel guard, the retry
    // path's own removal would re-enter scheduleResubscribe: dead channel's
    // CLOSED → schedule → tear down the HEALTHY replacement → its CLOSED →
    // schedule … perpetual churn, dropping broadcasts in every rejoin window.
    // (The fake's removeChannel fires CLOSED like the real client — this test
    // fails against the unguarded implementation.)
    const root = mountRelay('cap-1', true)
    await act(async () => {})
    expect(channels.length).toBe(1)

    // Fail once → retry replaces the channel. The removal fires channel 1's
    // CLOSED (per the fake, mirroring realtime-js).
    driveStatus('CHANNEL_ERROR')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(channels.length).toBe(2)
    expect(channels[0].removed).toBe(true)

    // Replacement subscribes cleanly. From here on, NOTHING should churn it:
    // no pending retry may fire, no third channel may ever be created.
    driveStatus('SUBSCRIBED')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(channels.length).toBe(2)
    expect(channels[1].removed).toBe(false)

    act(() => root.unmount())
  })

  it('does nothing off-desktop or without a capture (no channel created)', async () => {
    const root = mountRelay(null as unknown as string, true)
    await act(async () => {})
    expect(channels.length).toBe(0)
    act(() => root.unmount())
  })
})

// The HUD holds Voice ID during a live capture (and the transcript and tool
// calls are to follow), so it is up for the WHOLE call, not only while Native Intelligence
// is in the background.
describe('useAgentNudgeRelay — the HUD is up for the whole live call', () => {
  it('opens the HUD as the capture starts, keeps it through focus changes, and closes it at the end', async () => {
    vi.mocked(tauriBridge.showAgentHud).mockClear()
    vi.mocked(tauriBridge.hideAgentHud).mockClear()
    vi.mocked(tauriBridge.hideAgentHudTransient).mockClear()
    const root = mountRelay('cap-1', true)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(tauriBridge.showAgentHud).toHaveBeenCalledTimes(1)

    // In and out of Native Intelligence: nothing hides it.
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(tauriBridge.hideAgentHudTransient).not.toHaveBeenCalled()
    expect(tauriBridge.hideAgentHud).not.toHaveBeenCalled()

    act(() => root.unmount())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(tauriBridge.hideAgentHud).toHaveBeenCalledTimes(1)
  })
})
