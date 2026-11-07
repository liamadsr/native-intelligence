/**
 * Row hover-prefetch waits for the pointer to REST on a row.
 *
 * `prefetchDetailOnHover` fired on every row mouseenter, so sweeping the cursor
 * down a 50-row list could fire dozens of GET /api/account/actions/:id in under
 * a second — each deduped per id by action-cache, but still one per row swept.
 * Rows now go through `prefetchDetailOnHoverIntent` / `cancelHoverPrefetch`:
 * the prefetch fires once the pointer has stayed HOVER_PREFETCH_DELAY_MS, and
 * leaving the row first cancels it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const prefetchActionDetail = vi.fn((..._args: unknown[]) => Promise.resolve(null))
const seedActionCacheFromListItem = vi.fn()

vi.mock('@/lib/action-cache', () => ({
  prefetchActionDetail: (...args: unknown[]) => prefetchActionDetail(...args),
  seedActionCacheFromListItem: (...args: unknown[]) => seedActionCacheFromListItem(...args),
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => null }))

import {
  HOVER_PREFETCH_DELAY_MS,
  cancelHoverPrefetch,
  prefetchDetailOnHoverIntent,
} from '../detail-prefetch'

const row = (id: string) => ({ id, title: `Action ${id}` })
const prefetchedIds = () => prefetchActionDetail.mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.useFakeTimers()
  prefetchActionDetail.mockClear()
  seedActionCacheFromListItem.mockClear()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('prefetchDetailOnHoverIntent', () => {
  it('fires once the pointer has rested on the row for the delay', () => {
    const a = row('a')
    prefetchDetailOnHoverIntent('action', a)
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY_MS - 1)
    expect(prefetchActionDetail).not.toHaveBeenCalled()
    expect(seedActionCacheFromListItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(prefetchedIds()).toEqual(['a'])
    expect(seedActionCacheFromListItem).toHaveBeenCalledWith(a)
  })

  it('a sweep down the list prefetches only the row the cursor stops on', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const r = row(id)
      prefetchDetailOnHoverIntent('action', r)
      vi.advanceTimersByTime(30)
      cancelHoverPrefetch(r)
    }
    prefetchDetailOnHoverIntent('action', row('f'))
    vi.advanceTimersByTime(500)
    expect(prefetchedIds()).toEqual(['f'])
  })

  it('entering the next row supersedes the last, even without a leave', () => {
    prefetchDetailOnHoverIntent('action', row('a'))
    vi.advanceTimersByTime(50)
    prefetchDetailOnHoverIntent('action', row('b'))
    vi.advanceTimersByTime(500)
    expect(prefetchedIds()).toEqual(['b'])
  })

  it('leaving the row before the delay cancels it', () => {
    const a = row('a')
    prefetchDetailOnHoverIntent('action', a)
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY_MS / 2)
    cancelHoverPrefetch(a)
    vi.advanceTimersByTime(1000)
    expect(prefetchActionDetail).not.toHaveBeenCalled()
  })

  it("a late leave from ANOTHER row leaves this row's prefetch alone", () => {
    const a = row('a')
    prefetchDetailOnHoverIntent('action', row('b'))
    cancelHoverPrefetch(a)
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY_MS)
    expect(prefetchedIds()).toEqual(['b'])
  })

  it('a leave cancels by id when the row re-rendered with a fresh object', () => {
    prefetchDetailOnHoverIntent('action', row('a'))
    cancelHoverPrefetch(row('a'))
    vi.advanceTimersByTime(1000)
    expect(prefetchActionDetail).not.toHaveBeenCalled()
  })

  it('a leave after the prefetch fired is a no-op', () => {
    const a = row('a')
    prefetchDetailOnHoverIntent('action', a)
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY_MS)
    cancelHoverPrefetch(a)
    expect(prefetchedIds()).toEqual(['a'])
  })

  it('non-action rows still prefetch nothing', () => {
    prefetchDetailOnHoverIntent('capture', row('c'))
    vi.advanceTimersByTime(1000)
    expect(prefetchActionDetail).not.toHaveBeenCalled()
    expect(seedActionCacheFromListItem).not.toHaveBeenCalled()
  })
})
