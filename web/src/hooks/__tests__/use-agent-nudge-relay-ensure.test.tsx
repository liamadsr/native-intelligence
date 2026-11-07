// @vitest-environment jsdom
/**
 * useAgentNudgeRelay keeps the HUD up for the whole live call (the HUD
 * visibility fix: on the Owen call it vanished mid-call and only a restart
 * brought it back). Pins:
 *   - each nudge re-checks the HUD (ensure_agent_hud) BEFORE it is pushed;
 *   - the main window regaining focus re-checks it, losing focus doesn't;
 *   - a heartbeat re-checks it every HUD_HEARTBEAT_MS, and stops at the end;
 *   - live_hud_ensured is sent only when the desktop had to act or failed,
 *     never for a HUD that was up, and not for a build without the command.
 * Its channel-resilience contract: ./use-agent-nudge-relay.test.tsx; its
 * other telemetry: ./use-agent-nudge-relay-telemetry.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const relay = vi.hoisted(() => ({
  broadcast: null as null | ((msg: { payload: unknown }) => void),
  focus: null as null | ((focused: boolean) => void),
  unlistenFocus: vi.fn(),
  calls: [] as string[],
  track: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    realtime: { setAuth: async () => {} },
    channel: () => {
      const handle = {
        on: (_type: string, _filter: unknown, cb: (msg: { payload: unknown }) => void) => {
          relay.broadcast = cb
          return handle
        },
        subscribe: (cb: (status: string) => void) => {
          cb('SUBSCRIBED')
          return handle
        },
      }
      return handle
    },
    removeChannel: async () => {},
  }),
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/hud-telemetry', () => ({ trackHudEvent: relay.track }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    showAgentHud: vi.fn(async () => {}),
    hideAgentHud: vi.fn(async () => {}),
    pushAgentNudge: vi.fn(async (nudge: { id: string }) => {
      relay.calls.push(`push:${nudge.id}`)
    }),
    ensureAgentHud: vi.fn(async (reason: string) => {
      relay.calls.push(`ensure:${reason}`)
      return 'visible'
    }),
    onMainFocusChanged: vi.fn(async (cb: (focused: boolean) => void) => {
      relay.focus = cb
      return relay.unlistenFocus
    }),
  },
}))

import { HUD_HEARTBEAT_MS, useAgentNudgeRelay } from '../use-agent-nudge-relay'
import { tauriBridge } from '@/lib/tauri-bridge'

let root: Root

function Harness({ captureId }: { captureId: string | null }) {
  useAgentNudgeRelay(captureId, true)
  return null
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })

async function mount(captureId: string | null = 'cap-1') {
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(h(Harness, { captureId })))
  await settle()
}

async function nudge(id: string) {
  await act(async () => relay.broadcast!({ payload: { id, message: 'Ask about budget.', kind: 'suggestion', captureId: 'cap-1', ts: 1 } }))
  await settle()
}

const ensured = () => relay.track.mock.calls.filter((c) => c[0] === 'live_hud_ensured').map((c) => c[1])
const ensureReasons = () => vi.mocked(tauriBridge.ensureAgentHud).mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.useFakeTimers()
  relay.broadcast = null
  relay.focus = null
  relay.calls = []
  relay.track.mockReset()
  relay.unlistenFocus.mockReset()
  vi.mocked(tauriBridge.ensureAgentHud).mockClear()
  vi.mocked(tauriBridge.onMainFocusChanged).mockClear()
})
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.useRealTimers()
})

describe('useAgentNudgeRelay: the HUD is kept up', () => {
  it('re-checks the HUD before pushing each nudge, for this capture', async () => {
    await mount()
    await nudge('n1')
    await nudge('n2')
    expect(relay.calls).toEqual(['ensure:nudge', 'push:n1', 'ensure:nudge', 'push:n2'])
    expect(vi.mocked(tauriBridge.ensureAgentHud).mock.calls[0]).toEqual(['nudge', 'cap-1'])
  })

  it('re-checks it when the main window regains focus, not when it loses it', async () => {
    await mount()
    await act(async () => relay.focus!(false))
    await settle()
    expect(ensureReasons()).toEqual([])
    await act(async () => relay.focus!(true))
    await settle()
    expect(ensureReasons()).toEqual(['main-focus'])
  })

  it('re-checks it on a heartbeat, which stops with the capture', async () => {
    await mount()
    await act(async () => vi.advanceTimersByTime(HUD_HEARTBEAT_MS * 2))
    await settle()
    expect(ensureReasons()).toEqual(['heartbeat', 'heartbeat'])
    await act(async () => root.unmount())
    expect(relay.unlistenFocus).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(HUD_HEARTBEAT_MS * 3))
    await settle()
    expect(ensureReasons()).toEqual(['heartbeat', 'heartbeat'])
  })

  it('reports only a HUD it had to put back', async () => {
    await mount()
    await nudge('n1')
    expect(ensured()).toEqual([])
    vi.mocked(tauriBridge.ensureAgentHud).mockResolvedValueOnce('created')
    await nudge('n2')
    vi.mocked(tauriBridge.ensureAgentHud).mockResolvedValueOnce('restored')
    await act(async () => relay.focus!(true))
    await settle()
    expect(ensured()).toEqual([
      { capture_id: 'cap-1', reason: 'nudge', result: 'created' },
      { capture_id: 'cap-1', reason: 'main-focus', result: 'restored' },
    ])
    expect(JSON.stringify(relay.track.mock.calls)).not.toContain('budget')
  })

  it('reports a failed check, and keeps checking after one', async () => {
    await mount()
    vi.mocked(tauriBridge.ensureAgentHud).mockRejectedValueOnce(new Error('window build failed'))
    await nudge('n1')
    expect(ensured()).toEqual([
      { capture_id: 'cap-1', reason: 'nudge', result: 'error', error: 'Error: window build failed' },
    ])
    // The nudge is still pushed, and the next one is checked again.
    expect(relay.calls).toContain('push:n1')
    await nudge('n2')
    expect(ensureReasons()).toEqual(['nudge', 'nudge'])
  })

  it('asks a desktop build without the command once, silently, then stops', async () => {
    await mount()
    vi.mocked(tauriBridge.ensureAgentHud).mockRejectedValueOnce('Command ensure_agent_hud not found')
    await nudge('n1')
    await nudge('n2')
    await act(async () => vi.advanceTimersByTime(HUD_HEARTBEAT_MS * 2))
    await act(async () => relay.focus!(true))
    await settle()
    expect(ensureReasons()).toEqual(['nudge'])
    expect(ensured()).toEqual([])
    // Its nudges are still pushed.
    expect(relay.calls).toEqual(['push:n1', 'push:n2'])
  })

  it('does nothing without a capture', async () => {
    await mount(null)
    await act(async () => vi.advanceTimersByTime(HUD_HEARTBEAT_MS * 2))
    expect(tauriBridge.ensureAgentHud).not.toHaveBeenCalled()
    expect(tauriBridge.onMainFocusChanged).not.toHaveBeenCalled()
  })
})
