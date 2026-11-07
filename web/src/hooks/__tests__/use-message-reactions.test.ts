/**
 * The reactions store (use-message-reactions.ts), one reaction per bubble. Pinned:
 *   • a reaction shows at once, and the server's time stands once it answers;
 *   • a reply not saved yet (404) is tried again, then the reaction stays;
 *     one that fails for good is put back, with "Try again in a moment";
 *   • the conversation's read: a message it lists shows its reaction, one it
 *     doesn't shows none, and a click made meanwhile stands;
 *   • one store per conversation for the tab's life.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const toast = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast }))

import { REACTION_RETRY_MS, messageReactionsStoreFor, shownReaction } from '../use-message-reactions'

let n = 0
const conversation = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const AT = '2026-10-20T10:00:00.000Z'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('messageReactionsStoreFor', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    toast.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is one store per conversation, and none without one', () => {
    const id = conversation()
    expect(messageReactionsStoreFor(id)).toBe(messageReactionsStoreFor(id))
    expect(messageReactionsStoreFor(null)).toBeNull()
  })

  it('shows a reaction at once; the server’s time stands once it answers', async () => {
    fetchMock.mockResolvedValue(json({ reaction: { emoji: '👍', at: AT } }))
    const store = messageReactionsStoreFor(conversation())!
    const onChange = vi.fn()
    store.subscribe('m1', onChange)
    const done = store.react('m1', 0, '👍')
    expect(store.get('m1', 0)?.emoji).toBe('👍')
    await done
    expect(store.get('m1', 0)).toEqual({ emoji: '👍', at: AT })
    expect(onChange).toHaveBeenCalled()
  })

  it('a reply not saved yet is tried again, and the reaction stays', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(json({ error: 'Message not found' }, 404)).mockResolvedValueOnce(json({ reaction: { emoji: '🎉', at: AT } }))
    const store = messageReactionsStoreFor(conversation())!
    const done = store.react('m1', 0, '🎉')
    await vi.advanceTimersByTimeAsync(REACTION_RETRY_MS[0] + 10)
    await done
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.get('m1', 0)).toEqual({ emoji: '🎉', at: AT })
    expect(toast).not.toHaveBeenCalled()
  })

  it('one that fails for good is put back, and says so', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, 500))
    const store = messageReactionsStoreFor(conversation())!
    await store.react('m1', 0, '👍')
    expect(store.get('m1', 0)).toBeUndefined()
    expect(toast).toHaveBeenCalledWith('Try again in a moment')
  })

  it('the conversation’s read: listed messages show theirs, the rest none; a click made meanwhile stands', async () => {
    let answer!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    fetchMock.mockResolvedValue(json({ reaction: { emoji: '🚀', at: AT } }))
    const store = messageReactionsStoreFor(conversation())!
    const loading = store.load()
    expect(store.get('m1', 0)).toBeUndefined()
    await store.react('m3', 0, '🚀')
    answer(json({ reactions: { m1: { '0': { emoji: '❤️', at: AT }, '1': { emoji: '🎉', at: AT } }, m3: { '0': { emoji: '👎', at: AT } } } }))
    await loading
    expect(store.get('m1', 0)).toEqual({ emoji: '❤️', at: AT })
    // Each bubble its own.
    expect(store.get('m1', 1)).toEqual({ emoji: '🎉', at: AT })
    expect(store.get('m1', 2)).toBeNull()
    expect(store.get('m2', 0)).toBeNull()
    expect(store.get('m3', 0)?.emoji).toBe('🚀')
    // The metadata is what shows before the read, never after it.
    expect(shownReaction(store, { id: 'm2', metadata: { reactions: { '0': { emoji: '👍', at: AT } } } }, 0)).toBeNull()
  })
})
