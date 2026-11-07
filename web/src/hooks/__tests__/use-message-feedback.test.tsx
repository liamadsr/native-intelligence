// @vitest-environment jsdom
/**
 * The chat's thumbs store (use-message-feedback.ts):
 *  - one GET per conversation, however many times the chat mounts;
 *  - a click shows at once (optimistic), before the POST answers;
 *  - a 404 (the reply isn't saved yet) puts the rating back and says "Try
 *    again in a moment"; a 409 (already reviewed) keeps the stored rating and
 *    says "Already reviewed";
 *  - an older POST's failure never undoes a newer click;
 *  - a rating change re-renders that message's subscriber only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toast = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast }))

import {
  __resetMessageFeedbackForTests,
  createMessageFeedbackStore,
  useMessageFeedback,
  useMessageRating,
  type MessageFeedbackStore,
} from '../use-message-feedback'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch whose answers the test releases one at a time. */
function deferredFetch() {
  const pending: Array<{ url: string; init?: RequestInit; resolve: (r: Response) => void }> = []
  const fn = vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => pending.push({ url, init, resolve })))
  return { fn, pending }
}

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  __resetMessageFeedbackForTests()
  toast.mockReset()
  fetchMock = vi.fn(async (url: string) =>
    String(url).includes('?conversationId=') ? json(200, { ratings: { m1: 'up' } }) : json(200, { rating: null }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useMessageFeedback: one read per conversation', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function Probe({ conversationId, messageId }: { conversationId: string | null; messageId: string }) {
    const store = useMessageFeedback(conversationId)
    const rating = useMessageRating(store, messageId)
    return h('span', { 'data-rating': rating ?? 'none' })
  }

  it('reads once, across remounts and several readers', async () => {
    act(() => root.render(h('div', null, h(Probe, { conversationId: 'c1', messageId: 'm1' }), h(Probe, { conversationId: 'c1', messageId: 'm2' }))))
    await flush()
    act(() => root.render(h('div')))
    act(() => root.render(h(Probe, { conversationId: 'c1', messageId: 'm1' })))
    await flush()
    const gets = fetchMock.mock.calls.filter(([url]) => String(url).includes('?conversationId='))
    expect(gets).toHaveLength(1)
    expect(gets[0][0]).toBe('/api/account/chat/feedback?conversationId=c1')
    expect(container.querySelector('[data-rating]')?.getAttribute('data-rating')).toBe('up')
  })

  it('reads nothing with no conversation yet, and again for a new one', async () => {
    act(() => root.render(h(Probe, { conversationId: null, messageId: 'm1' })))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => root.render(h(Probe, { conversationId: 'c2', messageId: 'm1' })))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a rating change re-renders only that message', async () => {
    const renders: Record<string, number> = { a: 0, b: 0 }
    let store: MessageFeedbackStore | null = null
    function Counted({ id }: { id: string }) {
      const s = useMessageFeedback('c3')
      store = s
      useMessageRating(s, id)
      renders[id]++
      return null
    }
    act(() => root.render(h('div', null, h(Counted, { id: 'a' }), h(Counted, { id: 'b' }))))
    await flush()
    const before = { ...renders }
    await act(async () => {
      await store!.rate('a', 'up')
    })
    expect(renders.a).toBeGreaterThan(before.a)
    expect(renders.b).toBe(before.b)
  })
})

describe('createMessageFeedbackStore: rating', () => {
  it('shows a click at once, then keeps what the route stored', async () => {
    const d = deferredFetch()
    vi.stubGlobal('fetch', d.fn)
    const store = createMessageFeedbackStore('c1')
    const done = store.rate('m1', 'down', '  wrong contact  ')
    expect(store.get('m1')).toBe('down')
    expect(JSON.parse(String(d.pending[0].init?.body))).toEqual({ conversationId: 'c1', messageId: 'm1', rating: 'down', reason: 'wrong contact' })
    d.pending[0].resolve(json(200, { rating: 'down' }))
    await done
    expect(store.get('m1')).toBe('down')
    expect(toast).not.toHaveBeenCalled()
  })

  it('a 404 puts the rating back and says try again', async () => {
    fetchMock.mockImplementation(async () => json(404, { error: 'Not found', code: 'NOT_FOUND' }))
    const store = createMessageFeedbackStore('c1')
    await store.rate('m1', 'up')
    expect(store.get('m1')).toBeNull()
    expect(toast).toHaveBeenCalledWith('Try again in a moment')
  })

  it('a 404 on a change goes back to the stored rating, not to none', async () => {
    const store = createMessageFeedbackStore('c1')
    await store.load()
    expect(store.get('m1')).toBe('up')
    fetchMock.mockImplementation(async () => json(404, { error: 'Not found' }))
    await store.rate('m1', 'down')
    expect(store.get('m1')).toBe('up')
  })

  it('a 409 keeps the reviewed rating and says so', async () => {
    const store = createMessageFeedbackStore('c1')
    await store.load()
    fetchMock.mockImplementation(async () => json(409, { error: 'Locked', code: 'LOCKED', details: { rating: 'up' } }))
    await store.rate('m1', null)
    expect(store.get('m1')).toBe('up')
    expect(toast).toHaveBeenCalledWith('Already reviewed')
  })

  it('a 409 shows the rating the route says it kept', async () => {
    const store = createMessageFeedbackStore('c1')
    fetchMock.mockImplementation(async () => json(409, { error: 'Locked', code: 'LOCKED', details: { rating: 'down' } }))
    await store.rate('m1', 'up')
    expect(store.get('m1')).toBe('down')
  })

  it('a network failure puts the rating back', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('offline')
    })
    const store = createMessageFeedbackStore('c1')
    await store.rate('m1', 'up')
    expect(store.get('m1')).toBeNull()
    expect(toast).toHaveBeenCalledWith('Try again in a moment')
  })

  it("an older POST's failure never undoes a newer click", async () => {
    const d = deferredFetch()
    vi.stubGlobal('fetch', d.fn)
    const store = createMessageFeedbackStore('c1')
    const first = store.rate('m1', 'up')
    const second = store.rate('m1', 'down')
    d.pending[0].resolve(json(404, { error: 'Not found' }))
    await first
    expect(store.get('m1')).toBe('down')
    d.pending[1].resolve(json(200, { rating: 'down' }))
    await second
    expect(store.get('m1')).toBe('down')
  })

  it('a click made while the read is in flight wins over the read', async () => {
    const d = deferredFetch()
    vi.stubGlobal('fetch', d.fn)
    const store = createMessageFeedbackStore('c1')
    const loading = store.load()
    void store.rate('m1', 'down')
    d.pending[0].resolve(json(200, { ratings: { m1: 'up' } }))
    await loading
    expect(store.get('m1')).toBe('down')
  })
})
