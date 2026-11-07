// @vitest-environment jsdom
/**
 * Earlier messages, a page at a time (A3, earlier-messages.tsx). Pins:
 *   - unarmed (the open read said nothing older remains, or a short restored
 *     thread) it reads nothing and draws nothing;
 *   - armed, a load reads the page before the live thread's oldest message,
 *     then the page before that one's oldest, prepending each;
 *   - a page with no more after it ends it;
 *   - arming is keyed by conversation, so arming a conversation the panel
 *     binds to a render later still holds; another conversation starts over;
 *   - a restored thread a whole page long is armed without asking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { fetchEarlierPage, useEarlierMessages, type EarlierMessagesState } from '../earlier-messages'
import { HISTORY_PAGE_SIZE } from '@/lib/chat/history-page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: id }] }) as UIMessage
const answer = (messages: UIMessage[], hasMore: boolean) => ({ ok: true, json: async () => ({ messages, hasMore }) })

function mount(initial: { conversationId: string | null; firstMessageId: string | null; liveCount: number; live?: UIMessage[] }) {
  const root = createRoot(document.createElement('div'))
  let props = initial
  let result: EarlierMessagesState | null = null
  function Harness() {
    result = useEarlierMessages(props)
    return null
  }
  const render = () => act(() => root.render(h(Harness)))
  render()
  return {
    set(next: Partial<typeof props>) {
      props = { ...props, ...next }
      render()
    },
    get: () => result!,
  }
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

beforeEach(() => fetchMock.mockReset())

describe('useEarlierMessages', () => {
  it('unarmed, it reads nothing', async () => {
    const m = mount({ conversationId: 'c1', firstMessageId: 'm50', liveCount: 10 })
    expect(m.get().canLoad).toBe(false)
    act(() => m.get().load())
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('armed, it reads the page before the oldest live message, then before that page, prepending each', async () => {
    const m = mount({ conversationId: 'c1', firstMessageId: 'm50', liveCount: 10 })
    act(() => m.get().arm('c1', true))
    expect(m.get().canLoad).toBe(true)
    fetchMock.mockResolvedValueOnce(answer([msg('m48'), msg('m49')], true))
    act(() => m.get().load())
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/account/chat-history/c1?limit=${HISTORY_PAGE_SIZE}&before=m50`)
    expect(m.get().older.map((x) => x.id)).toEqual(['m48', 'm49'])
    fetchMock.mockResolvedValueOnce(answer([msg('m46'), msg('m47')], false))
    act(() => m.get().load())
    await flush()
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/account/chat-history/c1?limit=${HISTORY_PAGE_SIZE}&before=m48`)
    expect(m.get().older.map((x) => x.id)).toEqual(['m46', 'm47', 'm48', 'm49'])
    // No more after it: done.
    expect(m.get().canLoad).toBe(false)
  })

  it('arming a conversation the panel binds to a render later holds; another conversation starts over', async () => {
    const m = mount({ conversationId: 'c1', firstMessageId: 'a1', liveCount: 3 })
    act(() => m.get().arm('c2', true))
    m.set({ conversationId: 'c2', firstMessageId: 'b9' })
    expect(m.get().canLoad).toBe(true)
    fetchMock.mockResolvedValueOnce(answer([msg('b8')], true))
    act(() => m.get().load())
    await flush()
    expect(m.get().older.map((x) => x.id)).toEqual(['b8'])
    m.set({ conversationId: 'c3', firstMessageId: 'z1' })
    expect(m.get().older).toEqual([])
    expect(m.get().canLoad).toBe(false)
  })

  it('a restored thread a whole page long is armed without asking', () => {
    const m = mount({ conversationId: 'c1', firstMessageId: 'm1', liveCount: HISTORY_PAGE_SIZE })
    expect(m.get().canLoad).toBe(true)
  })

  it('a failed read keeps it armed; an empty page ends it', async () => {
    const m = mount({ conversationId: 'c1', firstMessageId: 'm50', liveCount: 10 })
    act(() => m.get().arm('c1', true))
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    act(() => m.get().load())
    await flush()
    expect(m.get().canLoad).toBe(true)
    fetchMock.mockResolvedValueOnce(answer([], true))
    act(() => m.get().load())
    await flush()
    expect(m.get().canLoad).toBe(false)
  })
})

describe('useEarlierMessages — retention trims the live thread (A3 review)', () => {
  it('keeps the trimmed messages after the earlier pages, so no gap opens', async () => {
    const live = ['m50', 'm51', 'm52', 'm53'].map(msg)
    const m = mount({ conversationId: 'c1', firstMessageId: 'm50', liveCount: live.length, live })
    act(() => m.get().arm('c1', true))
    fetchMock.mockResolvedValueOnce(answer([msg('m48'), msg('m49')], true))
    act(() => m.get().load())
    await flush()
    const trimmed = ['m52', 'm53', 'm54'].map(msg)
    m.set({ firstMessageId: 'm52', liveCount: trimmed.length, live: trimmed })
    await flush()
    expect(m.get().older.map((x) => x.id)).toEqual(['m48', 'm49', 'm50', 'm51'])
    // The next page is still read before the oldest one held.
    fetchMock.mockResolvedValueOnce(answer([msg('m47')], false))
    act(() => m.get().load())
    await flush()
    expect(fetchMock.mock.calls[1][0]).toContain('before=m48')
  })

  it('with no earlier page showing, a trim adds nothing (the next page reads before the new first)', async () => {
    const live = ['m50', 'm51'].map(msg)
    const m = mount({ conversationId: 'c1', firstMessageId: 'm50', liveCount: 2, live })
    m.set({ firstMessageId: 'm51', liveCount: 1, live: [msg('m51')] })
    await flush()
    expect(m.get().older).toEqual([])
  })
})

describe('fetchEarlierPage', () => {
  it('keeps only well-formed messages and reads hasMore', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [msg('a'), { nope: 1 }], hasMore: true }) })
    expect(await fetchEarlierPage('c 1', 'x/y', 5)).toEqual({ messages: [msg('a')], hasMore: true })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/chat-history/c%201?limit=5&before=x%2Fy')
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await fetchEarlierPage('c', 'x')).toBeNull()
  })
})
