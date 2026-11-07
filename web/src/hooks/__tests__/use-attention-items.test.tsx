// @vitest-environment jsdom
/**
 * Tests for useAttentionItems' accept-result mapping + optimistic-removal
 * semantics — the client half of the WS-1c/2a accept contract (the server half
 * lives in /api/account/attention-items and outreach-draft-generator).
 *
 * We exercise ONLY the hook's resolve() logic against a controllable fetch:
 *   1. A successful accept maps status/entity_kind/identifier/draft_id off the
 *      response and drops the card from the rail.
 *   2. A 502 DRAFT_GENERATION_FAILED is NOT a hard failure — the card is re-added
 *      PENDING (with the shell's draft_id merged, so a retry re-fills it) and the
 *      result carries draftGenerationFailed.
 *   3. A 409 (already resolved) keeps the card removed and reports ok:false.
 *
 * Supabase realtime + sonner are mocked to no-ops so the test touches neither.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

// Tell React this is an act()-aware environment (mirrors recording-start.test).
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

// A channel stub whose every builder returns itself, so the hook's realtime
// subscription is an inert no-op in the test — EXCEPT it records each registered
// postgres_changes handler by event, so a test can drive an INSERT/UPDATE through
// the real hook code path (cross-device realtime).
const realtimeHandlers: {
  INSERT?: (payload: { new: unknown }) => void
  UPDATE?: (payload: { new: unknown }) => void
  // The channel's own subscribe status callback — the hook's catch-up path
  // after a socket drop. Captured (not dropped) so the dedup against the
  // app-wide `dial8:realtime-recovered` event can actually be exercised.
  status?: (status: string) => void
} = {}
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_evt: string, cfg: { event?: string }, cb: (p: { new: unknown }) => void) => {
      if (cfg?.event === 'INSERT') realtimeHandlers.INSERT = cb
      if (cfg?.event === 'UPDATE') realtimeHandlers.UPDATE = cb
      return ch
    }
    ch.subscribe = (cb?: (status: string) => void) => {
      if (cb) realtimeHandlers.status = cb
      return ch
    }
    return { channel: () => ch, removeChannel: () => {} }
  },
}))

import {
  __resetSelfRefetchMarks,
  getLastRepairId,
} from '@/lib/supabase/realtime-recovery'
import {
  useAttentionItems,
  type AttentionItem,
  type AcceptResult,
} from '../use-attention-items'

// Latest hook value, published from an effect (not during render) so the capture
// is a side effect that runs outside render — mirrors recording-start.test.
const holder: { api: ReturnType<typeof useAttentionItems> | null } = { api: null }
function Harness() {
  const api = useAttentionItems()
  useEffect(() => {
    holder.api = api
  }, [api])
  return null
}

function mkResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Every card the hook holds, For you's and the chat's (P13 splits them; most tests here are about the store). */
function cardsOf(api: { items: AttentionItem[]; asks: AttentionItem[] }): AttentionItem[] {
  return [...api.items, ...api.asks]
}

function seedItem(): AttentionItem {
  return {
    id: 'card-1',
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'draft_email',
    title: 'Draft email to Vijay',
    why: 'You committed to reach out',
    payload: { change_type: 'send_email', entity_type: 'external' },
    proposal_id: 'prop-1',
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let seed: AttentionItem
let patchNext: Response
const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
  if (opts?.method === 'PATCH') return patchNext
  // Initial GET — hand the rail one seeded pending card.
  return mkResponse(200, { items: [seed] })
})

async function mountAndLoad() {
  await act(async () => {
    root.render(h(Harness))
  })
  // Flush the initial GET + its setState.
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useAttentionItems accept mapping', () => {
  beforeEach(() => {
    seed = seedItem()
    patchNext = mkResponse(200, { ok: true })
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    holder.api = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('maps the receipt fields on a successful accept and drops the card', async () => {
    await mountAndLoad()
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(true)

    patchNext = mkResponse(200, {
      ok: true,
      status: 'draft_ready',
      entity_id: 'draft-9',
      entity_kind: 'email_draft',
      draft_id: 'draft-9',
    })
    let result: AcceptResult | undefined
    await act(async () => {
      result = await holder.api!.accept('card-1')
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'draft_ready',
      entity_id: 'draft-9',
      entity_kind: 'email_draft',
      draft_id: 'draft-9',
    })
    // Optimistically removed and confirmed gone.
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)
  })

  it('re-adds the card (with draft_id) on a 502 DRAFT_GENERATION_FAILED', async () => {
    await mountAndLoad()

    patchNext = mkResponse(502, {
      error: 'generation failed',
      code: 'DRAFT_GENERATION_FAILED',
      draft_id: 'shell-7',
    })
    let result: AcceptResult | undefined
    await act(async () => {
      result = await holder.api!.accept('card-1')
    })

    expect(result).toMatchObject({ ok: false, draftGenerationFailed: true, draft_id: 'shell-7' })
    // Still pending server-side → re-added, with the shell id merged so a retry
    // re-fills the SAME draft.
    const readded = cardsOf(holder.api!).find((i) => i.id === 'card-1')
    expect(readded?.payload.draft_id).toBe('shell-7')
    expect(toastError).toHaveBeenCalled()
  })

  it('keeps the card removed and reports ok:false on a 409', async () => {
    await mountAndLoad()

    patchNext = mkResponse(409, { error: 'already resolved', code: 'ALREADY_RESOLVED' })
    let result: AcceptResult | undefined
    await act(async () => {
      result = await holder.api!.accept('card-1')
    })

    expect(result).toEqual({ ok: false })
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)
    // A 409 is a clean "it's gone" — no error toast.
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('useAttentionItems start (work_proposal)', () => {
  beforeEach(() => {
    seed = seedItem()
    patchNext = mkResponse(200, { ok: true })
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    holder.api = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('optimistically removes the card and maps status/agent_run_id/identifier on a started run', async () => {
    await mountAndLoad()
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(true)

    patchNext = mkResponse(200, {
      ok: true,
      status: 'started',
      agent_run_id: 'run-9',
      entity_id: 'act-9',
      entity_kind: 'action',
      identifier: 'GEN-42',
    })
    let result: AcceptResult | undefined
    await act(async () => {
      result = await holder.api!.start('card-1')
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'started',
      agent_run_id: 'run-9',
      entity_id: 'act-9',
      entity_kind: 'action',
      identifier: 'GEN-42',
    })
    // Optimistically removed and confirmed gone.
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('restores the card and toasts on a hard start failure', async () => {
    await mountAndLoad()

    patchNext = mkResponse(500, { error: 'dispatch failed' })
    let result: AcceptResult | undefined
    await act(async () => {
      result = await holder.api!.start('card-1')
    })

    expect(result).toEqual({ ok: false })
    // A hard failure re-adds the card (nothing was dispatched) and toasts.
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(true)
    expect(toastError).toHaveBeenCalled()
  })

  it('keeps the card removed on a 409 (already resolved/expired)', async () => {
    await mountAndLoad()

    patchNext = mkResponse(409, { error: 'already resolved', code: 'ALREADY_RESOLVED' })
    let result: AcceptResult | undefined
    await act(async () => {
      result = await holder.api!.start('card-1')
    })

    expect(result).toEqual({ ok: false })
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('a Start in a picked place sends it; a refusal there (409, its own code) shows the card again, with the reason', async () => {
    await mountAndLoad()

    patchNext = mkResponse(409, { error: 'Liam’s MacBook is offline, so nothing started in notes.', code: 'MAC_OFFLINE' })
    const place = { kind: 'mac' as const, folder_id: '88888888-8888-4888-8888-888888888881' }
    let result: AcceptResult | undefined
    await act(async () => {
      result = await holder.api!.start('card-1', place)
    })

    const patch = fetchMock.mock.calls.find(([, o]) => o?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ id: 'card-1', action: 'start', run_in: place })
    expect(result).toEqual({ ok: false })
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(true)
    expect(toastError).toHaveBeenCalledWith('Could not start', { description: 'Liam’s MacBook is offline, so nothing started in notes.' })
  })

  it('a picked place’s Start on a card already resolved elsewhere stays a clean 409', async () => {
    await mountAndLoad()

    patchNext = mkResponse(409, { error: 'Card already resolved', code: 'ALREADY_RESOLVED' })
    await act(async () => {
      await holder.api!.start('card-1', { kind: 'mac', folder_id: '88888888-8888-4888-8888-888888888881' })
    })

    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('useAttentionItems realtime UPDATE (cross-device revert)', () => {
  beforeEach(() => {
    seed = seedItem()
    patchNext = mkResponse(200, { ok: true })
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    holder.api = null
    delete realtimeHandlers.INSERT
    delete realtimeHandlers.UPDATE
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('drops a card on an UPDATE that lands non-pending (resolved elsewhere)', async () => {
    await mountAndLoad()
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(true)
    await act(async () => {
      realtimeHandlers.UPDATE?.({ new: { ...seed, status: 'accepted' } })
    })
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)
  })

  it('drops a card at its expiry while it is on screen (an approval\'s wait running out), not at the next fetch', async () => {
    seed = { ...seedItem(), kind: 'approval', expires_at: new Date(Date.now() + 150).toISOString() }
    const later = { ...seedItem(), id: 'card-2', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
    fetchMock.mockImplementationOnce(async () => mkResponse(200, { items: [seed, later] }))
    await mountAndLoad()
    // Both are the chat's (P13: `asks`, never For you's `items`); each leaves at its own expiry.
    expect(holder.api!.asks.map((i) => i.id).sort()).toEqual(['card-1', 'card-2'])
    expect(holder.api!.items).toEqual([])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(holder.api!.asks.some((i) => i.id === 'card-1')).toBe(false)
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-2')).toBe(true)
  })

  it('splits the cards by where they live: only a post draft is For you\'s, every other card the chat\'s (P13)', async () => {
    const approval = { ...seedItem(), id: 'ap-1', kind: 'approval' }
    const question = { ...seedItem(), id: 'q-1', kind: 'question', payload: {} }
    const post = { ...seedItem(), id: 'post-1', kind: 'question', payload: { post_draft: { text: 'Exports are faster.', surface: 'x' } } }
    fetchMock.mockImplementationOnce(async () => mkResponse(200, { items: [seed, post], asks: [approval, question] }))
    await mountAndLoad()
    expect(holder.api!.items.map((i) => i.id).sort()).toEqual(['post-1'])
    expect(holder.api!.asks.map((i) => i.id).sort()).toEqual(['ap-1', 'card-1', 'q-1'])
    // A live INSERT of an approval lands in the chat's half, not For you's.
    await act(async () => {
      realtimeHandlers.INSERT?.({ new: { ...seedItem(), id: 'ap-2', kind: 'approval', created_at: new Date().toISOString() } })
    })
    expect(holder.api!.asks.some((i) => i.id === 'ap-2')).toBe(true)
    expect(holder.api!.items.some((i) => i.id === 'ap-2')).toBe(false)
  })

  it('RE-ADDS a card on an UPDATE that lands back on pending (server-side revert)', async () => {
    await mountAndLoad()
    // Remove the card first (as an optimistic Start would), then a revert UPDATE
    // lands: status is pending again → the rail must re-show it. This is what makes
    // a server-side Start-compensation revert visible (and fixes cross-device revert).
    await act(async () => {
      realtimeHandlers.UPDATE?.({ new: { ...seed, status: 'accepted' } })
    })
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)

    await act(async () => {
      realtimeHandlers.UPDATE?.({ new: { ...seed, status: 'pending', title: 'Reverted card' } })
    })
    const readded = cardsOf(holder.api!).find((i) => i.id === 'card-1')
    expect(readded).toBeTruthy()
    expect(readded?.title).toBe('Reverted card')
  })

  it('does NOT re-add a pending UPDATE that is already expired', async () => {
    await mountAndLoad()
    await act(async () => {
      realtimeHandlers.UPDATE?.({ new: { ...seed, status: 'accepted' } })
    })
    const expired = new Date(Date.now() - 60_000).toISOString()
    await act(async () => {
      realtimeHandlers.UPDATE?.({ new: { ...seed, status: 'pending', expires_at: expired } })
    })
    expect(cardsOf(holder.api!).some((i) => i.id === 'card-1')).toBe(false)
  })
})

// ── Recovery catch-up: one repair, one refetch ────────────────────────────
//
// A real socket repair knocks EVERY channel, so this rail used to refetch
// twice: once from its own SUBSCRIBED-after-failure and again when the entities
// channel dispatched `dial8:realtime-recovered`. Across the shell singletons
// that doubling was a measurable share of the 21-request wake storm.
describe('useAttentionItems recovery refetch dedup', () => {
  beforeEach(() => {
    seed = seedItem()
    patchNext = mkResponse(200, { ok: true })
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    holder.api = null
    realtimeHandlers.status = undefined
    __resetSelfRefetchMarks()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** GET calls only — PATCHes are accept/dismiss traffic, not refetches. */
  function getCalls(): number {
    return fetchMock.mock.calls.filter(([, opts]) => (opts as RequestInit | undefined)?.method !== 'PATCH').length
  }

  async function dropAndResubscribe() {
    await act(async () => {
      realtimeHandlers.status!('CHANNEL_ERROR')
      realtimeHandlers.status!('SUBSCRIBED')
      await Promise.resolve()
    })
  }

  async function fireRecovered() {
    await act(async () => {
      // Mirror the real dispatch (use-realtime-entities.ts): the event carries the
      // watchdog's CURRENT repair id, which is what a self-refetch mark stamps.
      window.dispatchEvent(
        new CustomEvent('dial8:realtime-recovered', { detail: { repairId: getLastRepairId() } }),
      )
      await Promise.resolve()
    })
  }

  it('refetches on its own re-SUBSCRIBE after a failure', async () => {
    await mountAndLoad()
    const before = getCalls()
    await dropAndResubscribe()
    expect(getCalls()).toBe(before + 1)
  })

  it('suppresses the app-wide recovered refetch that follows its own catch-up', async () => {
    await mountAndLoad()
    await dropAndResubscribe()
    const afterSelf = getCalls()
    await fireRecovered()
    // Same gap, already caught up — no second GET.
    expect(getCalls()).toBe(afterSelf)
  })

  it('still refetches on a recovered event with no recent self-catch-up (the guarantee)', async () => {
    // The entities socket can die while ours stays up: nothing marked this
    // channel, so the fan-out MUST be honoured or the rail silently goes stale.
    await mountAndLoad()
    const before = getCalls()
    await fireRecovered()
    expect(getCalls()).toBe(before + 1)
  })

  it('honours a SECOND, genuinely separate repair once the dedup window lapses', async () => {
    await mountAndLoad()
    await dropAndResubscribe()
    const afterSelf = getCalls()
    // The window is 3s; MIN_PASS_INTERVAL_MS (5s) means a second real repair
    // can only land after it, so this is a distinct gap, not an echo.
    vi.setSystemTime(Date.now() + 5_000)
    await fireRecovered()
    expect(getCalls()).toBe(afterSelf + 1)
  })
})

describe('useAttentionItems loaded (only a fetch that landed)', () => {
  beforeEach(() => {
    seed = seedItem()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    holder.api = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('is loaded once a fetch lands, and stays so through a later failed refetch', async () => {
    let fail = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (fail ? mkResponse(500, {}) : mkResponse(200, { items: [seed] }))),
    )
    await mountAndLoad()
    expect(holder.api!.loaded).toBe(true)
    expect(cardsOf(holder.api!).map((i) => i.id)).toEqual(['card-1'])
    fail = true
    await act(async () => {
      await holder.api!.refetch()
    })
    expect(holder.api!.loaded).toBe(true)
    expect(cardsOf(holder.api!).map((i) => i.id)).toEqual(['card-1'])
  })

  it('is not loaded after a failed fetch (an HTTP error, or the network), though it’s no longer loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse(502, {})))
    await mountAndLoad()
    expect(holder.api!.isLoading).toBe(false)
    expect(holder.api!.loaded).toBe(false)

    act(() => root.unmount())
    root = createRoot(container)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await mountAndLoad()
    expect(holder.api!.isLoading).toBe(false)
    expect(holder.api!.loaded).toBe(false)
  })
})
