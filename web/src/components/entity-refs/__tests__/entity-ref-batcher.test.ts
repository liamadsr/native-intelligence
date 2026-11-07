import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  requestEntityRef,
  getEntityRefState,
  refreshEntityRef,
  subscribeEntityRefs,
  __setEntityRefFetcher,
  __resetEntityRefCache,
} from '../entity-ref-batcher'
import type { EntityRefData } from '../types'

function fakeAction(identifier: string): EntityRefData {
  return {
    id: `id-${identifier}`,
    workspace_id: 'ws-1',
    team_id: 'team-1',
    identifier,
    title: `Title ${identifier}`,
    status: null,
    assignee: null,
    priority: null,
    due_date: null,
    project: null,
  }
}

describe('entity-ref batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetEntityRefCache()
  })
  afterEach(() => {
    __setEntityRefFetcher(null)
    __resetEntityRefCache()
    vi.useRealTimers()
  })

  it('coalesces requests made within the window into a single fetch', async () => {
    const fetcher = vi.fn(async (refs: string[]) => {
      const out: Record<string, EntityRefData> = {}
      for (const r of refs) if (r === 'GEN-1') out[r] = fakeAction(r)
      return out
    })
    __setEntityRefFetcher(fetcher)

    requestEntityRef('GEN-1')
    requestEntityRef('GEN-1') // duplicate — must not re-queue
    requestEntityRef('GEN-2')

    // Nothing fetched until the window elapses.
    expect(fetcher).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0].sort()).toEqual(['GEN-1', 'GEN-2'])

    // Found vs. missing are both cached.
    expect(getEntityRefState('GEN-1')).toEqual({ status: 'found', data: fakeAction('GEN-1') })
    expect(getEntityRefState('GEN-2')).toEqual({ status: 'missing' })
  })

  it('does not re-fetch an already-cached identifier', async () => {
    const fetcher = vi.fn(async (refs: string[]) => {
      const out: Record<string, EntityRefData> = {}
      for (const r of refs) out[r] = fakeAction(r)
      return out
    })
    __setEntityRefFetcher(fetcher)

    requestEntityRef('GEN-1')
    await vi.advanceTimersByTimeAsync(30)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Requesting again is a no-op — it's cached.
    requestEntityRef('GEN-1')
    await vi.advanceTimersByTimeAsync(30)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('normalises identifiers to uppercase before batching', async () => {
    const fetcher = vi.fn(async (_refs: string[]) => ({ 'GEN-9': fakeAction('GEN-9') }))
    __setEntityRefFetcher(fetcher)

    requestEntityRef('gen-9')
    await vi.advanceTimersByTimeAsync(30)

    expect(fetcher.mock.calls[0][0]).toEqual(['GEN-9'])
    expect(getEntityRefState('GEN-9').status).toBe('found')
    expect(getEntityRefState('gen-9').status).toBe('found')
  })

  it('refreshEntityRef re-resolves one identifier and notifies subscribers', async () => {
    let title = 'before'
    const fetcher = vi.fn(async (refs: string[]) => ({
      [refs[0]]: { ...fakeAction(refs[0]), title },
    }))
    __setEntityRefFetcher(fetcher)

    requestEntityRef('GEN-1')
    await vi.advanceTimersByTimeAsync(30)
    expect(getEntityRefState('GEN-1')).toMatchObject({ status: 'found', data: { title: 'before' } })

    const onChange = vi.fn()
    const unsub = subscribeEntityRefs(onChange)

    title = 'after'
    await refreshEntityRef('GEN-1')

    expect(onChange).toHaveBeenCalled()
    expect(getEntityRefState('GEN-1')).toMatchObject({ status: 'found', data: { title: 'after' } })
    unsub()
  })

  it('caches a failed lookup as missing so the chip falls back to plain text', async () => {
    __setEntityRefFetcher(async () => {
      throw new Error('network down')
    })
    requestEntityRef('GEN-1')
    await vi.advanceTimersByTimeAsync(30)
    expect(getEntityRefState('GEN-1')).toEqual({ status: 'missing' })
  })
})
