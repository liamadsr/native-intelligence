/**
 * The in-process cap on concurrent DataForSEO requests.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  createSemaphore,
  inDataforseoSlot,
  MAX_CONCURRENT_DATAFORSEO_REQUESTS,
} from '@/lib/seo/dataforseo/request-slots'
import { describe, expect, it } from 'vitest'

function tracked() {
  let running = 0
  let peak = 0
  const call = async (value: number) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running--
    return value
  }
  return { call, peak: () => peak }
}

describe('createSemaphore', () => {
  it('runs at most its size at once and finishes the rest, in order', async () => {
    const semaphore = createSemaphore(4)
    const { call, peak } = tracked()

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7].map((n) => semaphore.run(() => call(n))),
    )

    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(peak()).toBe(4)
    expect(semaphore.active).toBe(0)
    expect(semaphore.waiting).toBe(0)
  })

  it('frees the slot when a call fails', async () => {
    const semaphore = createSemaphore(1)
    await expect(
      semaphore.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    await expect(semaphore.run(async () => 'next')).resolves.toBe('next')
    expect(semaphore.active).toBe(0)
  })

  it('rejects a size that is not a positive integer', () => {
    expect(() => createSemaphore(0)).toThrow(RangeError)
    expect(() => createSemaphore(1.5)).toThrow(RangeError)
  })
})

describe('inDataforseoSlot', () => {
  it('caps the whole process at MAX_CONCURRENT_DATAFORSEO_REQUESTS', async () => {
    const { call, peak } = tracked()
    const count = MAX_CONCURRENT_DATAFORSEO_REQUESTS + 5

    await Promise.all(
      Array.from({ length: count }, (_, n) => inDataforseoSlot(() => call(n))),
    )

    expect(peak()).toBe(MAX_CONCURRENT_DATAFORSEO_REQUESTS)
  })
})
