import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))

import {
  requestMention,
  getMentionState,
  subscribeMention,
  __setMentionFetcher,
  __resetMentionCache,
} from '../mention-batcher'
import type { MentionResolved } from '../types'

const found = (type: string, id: string, label: string, status: string | null = null): MentionResolved => ({ type, id, label, status })

describe('mention batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetMentionCache()
  })
  afterEach(() => {
    __setMentionFetcher(null)
    __resetMentionCache()
    vi.useRealTimers()
  })

  it('coalesces requests into one fetch; found and hidden are both cached', async () => {
    const fetcher = vi.fn(async (refs: Array<{ type: string; id: string }>) => {
      const out: Record<string, MentionResolved> = {}
      for (const r of refs) if (r.id === 'a-1') out[`${r.type}:${r.id}`] = found('action', 'a-1', 'GEN-1', 'Todo')
      return out
    })
    __setMentionFetcher(fetcher)

    requestMention('action', 'a-1')
    requestMention('action', 'a-1') // duplicate — must not re-queue
    requestMention('document', 'd-2')
    expect(fetcher).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // Found carries the data; a key absent from the answer is "hidden" (not visible).
    expect(getMentionState('action', 'a-1')).toEqual({ status: 'found', data: found('action', 'a-1', 'GEN-1', 'Todo') })
    expect(getMentionState('document', 'd-2')).toEqual({ status: 'hidden' })
  })

  it('normalises the id to lower case', async () => {
    __setMentionFetcher(async () => ({ 'action:a-9': found('action', 'a-9', 'GEN-9') }))
    requestMention('action', 'A-9')
    await vi.advanceTimersByTimeAsync(30)
    expect(getMentionState('action', 'a-9').status).toBe('found')
    expect(getMentionState('action', 'A-9').status).toBe('found')
  })

  it('caches a failed lookup as error — the chip keeps its stored words, never a false lock', async () => {
    __setMentionFetcher(async () => {
      throw new Error('network down')
    })
    requestMention('action', 'a-1')
    await vi.advanceTimersByTimeAsync(30)
    expect(getMentionState('action', 'a-1')).toEqual({ status: 'error' })
  })

  it('notifies a subscriber when its mention resolves', async () => {
    __setMentionFetcher(async () => ({ 'action:a-1': found('action', 'a-1', 'GEN-1') }))
    const cb = vi.fn()
    const unsub = subscribeMention('action', 'a-1', cb)
    requestMention('action', 'a-1')
    await vi.advanceTimersByTimeAsync(30)
    expect(cb).toHaveBeenCalled()
    unsub()
  })
})
