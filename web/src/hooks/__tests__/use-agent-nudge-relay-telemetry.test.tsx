// @vitest-environment jsdom
/**
 * useAgentNudgeRelay's HUD telemetry (lib/hud-telemetry.ts): the recording
 * window's half of "did the nudge show?". Pins:
 *   - opening the HUD reports live_hud_open_requested, with whether the
 *     desktop took the call (ipc_ok);
 *   - each broadcast nudge reports live_hud_nudge_received, with whether Rust
 *     took the push (ipc_ok) and its latency, unclamped, never its words;
 *   - the capture's end reports live_hud_close_requested.
 * Its channel-resilience contract: ./use-agent-nudge-relay.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const relay = vi.hoisted(() => ({
  broadcast: null as null | ((msg: { payload: unknown }) => void),
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
    pushAgentNudge: vi.fn(async () => {}),
    ensureAgentHud: vi.fn(async () => 'visible'),
    onMainFocusChanged: vi.fn(async () => () => {}),
  },
}))

import { useAgentNudgeRelay } from '../use-agent-nudge-relay'
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

const tracked = (event: string) => relay.track.mock.calls.filter((c) => c[0] === event).map((c) => c[1])

beforeEach(() => {
  relay.broadcast = null
  relay.track.mockReset()
  vi.mocked(tauriBridge.showAgentHud).mockReset().mockResolvedValue(undefined)
  vi.mocked(tauriBridge.pushAgentNudge).mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await act(async () => root?.unmount())
})

describe('useAgentNudgeRelay: HUD telemetry', () => {
  it('reports the open, with whether the desktop took the call', async () => {
    await mount()
    expect(tracked('live_hud_open_requested')).toEqual([{ capture_id: 'cap-1', ipc_ok: true }])
  })

  it('reports a failed open with its error', async () => {
    vi.mocked(tauriBridge.showAgentHud).mockRejectedValueOnce(new Error('no window'))
    await mount()
    expect(tracked('live_hud_open_requested')).toEqual([{ capture_id: 'cap-1', ipc_ok: false, error: 'Error: no window' }])
  })

  it('reports each nudge received, with whether Rust took it, never its words', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_500)
    await mount()
    await act(async () => relay.broadcast!({ payload: { id: 'n1', message: 'Ask about budget.', kind: 'suggestion', captureId: 'cap-1', ts: 10_000 } }))
    await settle()
    vi.mocked(tauriBridge.pushAgentNudge).mockRejectedValueOnce(new Error('hud gone'))
    await act(async () => relay.broadcast!({ payload: { id: 'n2', message: 'Pricing.', kind: 'insight', captureId: 'cap-1', ts: 11_000 } }))
    await settle()
    expect(tracked('live_hud_nudge_received')).toEqual([
      { capture_id: 'cap-1', nudge_id: 'n1', nudge_kind: 'suggestion', ipc_ok: true, latency_ms: 500 },
      // A clock behind the server's stamp shows as a negative: the skew, not hidden.
      { capture_id: 'cap-1', nudge_id: 'n2', nudge_kind: 'insight', ipc_ok: false, latency_ms: -500 },
    ])
    expect(JSON.stringify(relay.track.mock.calls)).not.toContain('budget')
  })

  it("reports the close at the capture's end", async () => {
    await mount()
    expect(tracked('live_hud_close_requested')).toEqual([])
    await act(async () => root.unmount())
    expect(tracked('live_hud_close_requested')).toEqual([{ capture_id: 'cap-1' }])
  })

  it('reports nothing without a capture', async () => {
    await mount(null)
    expect(relay.track).not.toHaveBeenCalled()
  })
})
