// @vitest-environment jsdom
/**
 * useAttentionItems: a fetch that never landed retries by itself. The bots
 * wait on `loaded` (teammate-bots.ts `newKnown`), so a boot-time 401, a 5xx or
 * a network blip on wake used to leave them silent for the whole session.
 *
 *   • a failed first fetch (an HTTP error, or the network) retries after 2 s,
 *     8 s, 30 s, then every 2 minutes, until one lands; then no more;
 *   • and at once when the window comes back into view or focus;
 *   • signed out (401 twice running): only every 2 minutes, and the window
 *     leaves it be;
 *   • never after unmount, even for a fetch that settles after it;
 *   • once a fetch has landed, a failed refetch does not retry;
 *   • a retried fetch plays no sound (only a live INSERT does).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, (p: { new: unknown }) => void>,
  announce: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_evt: string, cfg: { event?: string }, cb: (p: { new: unknown }) => void) => {
      if (cfg?.event) hoisted.handlers[cfg.event] = cb
      return ch
    }
    ch.subscribe = () => ch
    return { channel: () => ch, removeChannel: () => {} }
  },
}))
vi.mock('@/lib/sounds/triggers', () => ({ announceAttentionItem: hoisted.announce }))

import { useAttentionItems } from '../use-attention-items'

function card(id: string) {
  return {
    id,
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'action_card',
    title: `card ${id}`,
    why: null,
    payload: {},
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
  }
}

function mkResponse(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

/** What the next GET answers: a status, a thrown network error, or the deck. */
let respond: () => Promise<Response>
const ok = () => Promise.resolve(mkResponse(200, { items: [card('card-1')] }))
const fetchMock = vi.fn((_url: string, _init?: RequestInit) => respond())

const holder: { api: ReturnType<typeof useAttentionItems> | null } = { api: null }
function Harness() {
  const api = useAttentionItems()
  useEffect(() => {
    holder.api = api
  }, [api])
  return null
}

let container: HTMLDivElement
let root: Root

const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PATCH').length

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}
async function mount() {
  await act(async () => root.render(h(Harness)))
  await flush()
}
async function after(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms))
  await flush()
}
async function returnToWindow() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  respond = ok
  hoisted.handlers = {}
  holder.api = null
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useAttentionItems — a fetch that never landed retries', () => {
  it('after 2 s, 8 s, 30 s, then every 2 minutes, until one lands; then no more', async () => {
    let down = true
    respond = () => (down ? Promise.resolve(mkResponse(503)) : ok())
    await mount()
    expect(gets()).toBe(1)
    expect(holder.api!.loaded).toBe(false)
    expect(holder.api!.isLoading).toBe(false)
    await after(1_999)
    expect(gets()).toBe(1)
    await after(1)
    expect(gets()).toBe(2)
    await after(7_999)
    expect(gets()).toBe(2)
    await after(1)
    expect(gets()).toBe(3)
    await after(30_000)
    expect(gets()).toBe(4)
    await after(120_000)
    expect(gets()).toBe(5)
    expect(holder.api!.loaded).toBe(false)
    down = false
    await after(120_000)
    expect(gets()).toBe(6)
    expect(holder.api!.loaded).toBe(true)
    expect([...holder.api!.items, ...holder.api!.asks].map((i) => i.id)).toEqual(['card-1'])
    await after(600_000)
    expect(gets()).toBe(6)
  })

  it('a network failure retries the same way', async () => {
    let down = true
    respond = () => (down ? Promise.reject(new TypeError('Failed to fetch')) : ok())
    await mount()
    expect(holder.api!.loaded).toBe(false)
    down = false
    await after(2_000)
    expect(gets()).toBe(2)
    expect(holder.api!.loaded).toBe(true)
  })

  it('retries at once when the window comes back, once for focus and visibility together', async () => {
    let down = true
    respond = () => (down ? Promise.resolve(mkResponse(500)) : ok())
    await mount()
    expect(gets()).toBe(1)
    await returnToWindow()
    expect(gets()).toBe(2)
    down = false
    await returnToWindow()
    expect(gets()).toBe(3)
    expect(holder.api!.loaded).toBe(true)
    // Loaded: coming back fetches nothing, and no retry is left pending.
    await returnToWindow()
    await after(600_000)
    expect(gets()).toBe(3)
  })

  it('a hidden window does not retry on visibilitychange', async () => {
    respond = () => Promise.resolve(mkResponse(500))
    await mount()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(gets()).toBe(1)
    visibility.mockRestore()
  })

  it('signed out (401 twice running): only every 2 minutes, and the window leaves it be', async () => {
    respond = () => Promise.resolve(mkResponse(401))
    await mount()
    await after(2_000)
    expect(gets()).toBe(2)
    await after(8_000)
    expect(gets()).toBe(2)
    await returnToWindow()
    expect(gets()).toBe(2)
    await after(111_999)
    expect(gets()).toBe(2)
    await after(1)
    expect(gets()).toBe(3)
    await after(120_000)
    expect(gets()).toBe(4)
    expect(holder.api!.loaded).toBe(false)
  })

  it('stops with the mount, even for a fetch that settles after it', async () => {
    respond = () => Promise.resolve(mkResponse(500))
    await mount()
    await after(2_000)
    expect(gets()).toBe(2)
    act(() => root.unmount())
    await returnToWindow()
    await after(600_000)
    expect(gets()).toBe(2)

    // A fetch in flight at unmount schedules nothing when it fails.
    fetchMock.mockClear()
    let fail: (r: Response) => void = () => {}
    respond = () => new Promise<Response>((resolve) => (fail = resolve))
    root = createRoot(container)
    await mount()
    expect(gets()).toBe(1)
    act(() => root.unmount())
    await act(async () => fail(mkResponse(500)))
    await flush()
    await after(600_000)
    expect(gets()).toBe(1)
  })

  it('once a fetch has landed, a failed refetch does not retry', async () => {
    await mount()
    expect(holder.api!.loaded).toBe(true)
    respond = () => Promise.resolve(mkResponse(500))
    await act(async () => {
      await holder.api!.refetch()
    })
    expect(gets()).toBe(2)
    await returnToWindow()
    await after(600_000)
    expect(gets()).toBe(2)
    expect(holder.api!.loaded).toBe(true)
    expect([...holder.api!.items, ...holder.api!.asks].map((i) => i.id)).toEqual(['card-1'])
  })

  it('a retried fetch plays no sound; a live card after it still does', async () => {
    let down = true
    respond = () => (down ? Promise.resolve(mkResponse(503)) : ok())
    await mount()
    down = false
    await after(2_000)
    expect(holder.api!.loaded).toBe(true)
    expect([...holder.api!.items, ...holder.api!.asks].map((i) => i.id)).toEqual(['card-1'])
    expect(hoisted.announce).not.toHaveBeenCalled()
    // The fetched card arriving again over realtime is already held: silent.
    await act(async () => hoisted.handlers.INSERT({ new: card('card-1') }))
    expect(hoisted.announce).not.toHaveBeenCalled()
    await act(async () => hoisted.handlers.INSERT({ new: card('live-1') }))
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
  })
})
