/**
 * Pacing and 429 handling (../crawl-throttle.ts). Cases ported from OpenSEO's
 * crawl-throttle tests (MIT); our throttle takes the Retry-After header's
 * text, and caps the audit's total waiting at one hour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCrawlThrottle,
  createRateLimitWait,
  parseRetryAfterMs,
} from '../crawl-throttle'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.useRealTimers()
})

const URL_A = 'https://example.com/a'
const URL_B = 'https://example.com/b'
const URL_C = 'https://example.com/c'
const URL_D = 'https://example.com/d'

describe('parseRetryAfterMs', () => {
  it('reads delay-seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('5')).toBe(5_000)
    expect(parseRetryAfterMs(' 0 ')).toBe(0)
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:01:00 GMT')).toBe(60_000)
  })

  it('reads a date in the past as no wait, and nonsense or nothing as unknown', () => {
    vi.setSystemTime(120_000)
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:01:00 GMT')).toBe(0)
    expect(parseRetryAfterMs('soon')).toBeNull()
    expect(parseRetryAfterMs('')).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
  })

  // Once a bug: V8's lenient Date.parse read "1.5" as 2001-01-05 and "-5" as
  // 2001-05-01, both past, so a malformed header meant "no wait at all".
  it('reads a malformed delay as unknown, not as a date in 2001', () => {
    vi.setSystemTime(new Date('2026-11-12T09:00:00Z'))
    for (const value of ['1.5', '-5', '120.0', '1e3', '3,5']) {
      expect(parseRetryAfterMs(value), value).toBeNull()
    }
    // A real HTTP date still reads as one.
    expect(parseRetryAfterMs('Thu, 12 Nov 2026 09:00:30 GMT')).toBe(30_000)
  })

  it('makes a malformed Retry-After fall back to the default pause, not to none', async () => {
    const throttle = createCrawlThrottle(90_000)
    await throttle.backoff(URL_A, '1.5')
    expect(throttle.state.pausedUntil).toBe(30_000)
  })

  it('keeps a huge value finite, just over the audit’s whole waiting budget', () => {
    expect(parseRetryAfterMs('9'.repeat(310))).toBe(60 * 60_000 + 1)
  })
})

describe('createCrawlThrottle', () => {
  it('keeps oversized Retry-After values finite even with overlapping refusals', async () => {
    const throttle = createCrawlThrottle(90_000)
    await Promise.all([
      throttle.backoff(URL_A, '9'.repeat(310)),
      throttle.backoff(URL_B, '60'),
    ])
    expect(throttle.stopped).toBe(true)
    expect(
      Object.values(throttle.state)
        .filter((value): value is number => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true)
    expect(await throttle.ready()).toBe(false)
  })

  it('waits for the pause to be saved before allowing another request', async () => {
    let save: () => void = vi.fn()
    const throttle = createCrawlThrottle(
      90_000,
      undefined,
      () =>
        new Promise<void>((resolve) => {
          save = resolve
        }),
    )
    const backoff = throttle.backoff(URL_A, '1')
    await vi.advanceTimersByTimeAsync(0)
    let started = false
    const request = throttle.ready().then(() => {
      started = true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(started).toBe(false)
    save()
    await backoff
    await request
    expect(started).toBe(true)
  })

  it('stops for good when saving the pause fails', async () => {
    const throttle = createCrawlThrottle(90_000, undefined, () =>
      Promise.reject(new Error('database down')),
    )
    await expect(throttle.backoff(URL_A, '1')).rejects.toThrow('database down')
    expect(throttle.checkpointFailed).toBe(true)
    expect(throttle.stopped).toBe(true)
    expect(await throttle.ready()).toBe(false)
  })

  it('spaces simultaneous request starts a second apart instead of releasing a burst', async () => {
    const throttle = createCrawlThrottle(90_000)
    const starts: number[] = []
    const requests = Promise.all(
      Array.from({ length: 5 }, async () => {
        if (await throttle.ready()) starts.push(Date.now())
      }),
    )
    await vi.runAllTimersAsync()
    await requests
    expect(starts).toEqual([0, 1_000, 2_000, 3_000, 4_000])
  })

  it('pauses for thirty seconds on the first 429 without a Retry-After, and spaces requests wider', async () => {
    const throttle = createCrawlThrottle(90_000)
    expect(await throttle.ready()).toBe(true)
    expect(await throttle.backoff(URL_A, null)).toBe(true)
    const starts: number[] = []
    const requests = Promise.all(
      Array.from({ length: 3 }, async () => {
        if (await throttle.ready()) starts.push(Date.now())
      }),
    )
    await vi.advanceTimersByTimeAsync(29_999)
    expect(starts).toEqual([])
    await vi.runAllTimersAsync()
    await requests
    expect(starts).toEqual([30_000, 32_000, 34_000])
  })

  it('rechecks a pause extended while requests are waiting', async () => {
    const throttle = createCrawlThrottle(90_000)
    await throttle.backoff(URL_A, '5')
    const starts: number[] = []
    const request = throttle.ready().then(() => starts.push(Date.now()))
    await vi.advanceTimersByTimeAsync(4_000)
    await throttle.backoff(URL_B, '10')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(starts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await request
    expect(starts).toEqual([14_000])
  })

  it.each(['60', 'Thu, 01 Jan 1970 00:01:00 GMT'])(
    'honors Retry-After: %s',
    async (header) => {
      const throttle = createCrawlThrottle(90_000)
      await throttle.backoff(URL_A, header)
      let started = false
      const request = throttle.ready().then(() => {
        started = true
      })
      await vi.advanceTimersByTimeAsync(59_999)
      expect(started).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await request
      expect(started).toBe(true)
    },
  )

  it('gives a URL one retry across chunks and served pages, then gives it up', async () => {
    let throttle = createCrawlThrottle(90_000)
    expect(await throttle.backoff(URL_A, '60')).toBe(true)
    expect(throttle.state.refusals).toEqual({ [URL_A]: 1 })
    await vi.advanceTimersByTimeAsync(60_000)
    throttle = createCrawlThrottle(Date.now() + 90_000, throttle.state)
    await throttle.recovered(URL_B)
    expect(await throttle.backoff(URL_A, '60')).toBe(false)
    expect(throttle.state.refusals).toEqual({})
    expect(throttle.state.givenUpRun).toBe(1)
    expect(throttle.stopped).toBe(false)
  })

  it('stops after three URLs are given up on with nothing served between', async () => {
    const throttle = createCrawlThrottle(90_000)
    for (const url of [URL_A, URL_B]) {
      await throttle.refuse(url, '1')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await throttle.recovered(URL_C)
    for (const url of [URL_C, URL_D]) {
      await throttle.refuse(url, '1')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(throttle.stopped).toBe(false)
    await throttle.refuse(URL_A, '1')
    expect(throttle.stopped).toBe(true)
  })

  it('returns to normal pacing after twenty served pages, counted across chunks', async () => {
    let throttle = createCrawlThrottle(90_000)
    for (const url of [URL_A, URL_B, URL_C, URL_D]) {
      await throttle.backoff(url, '1')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(throttle.state.intervalMs).toBe(10_000)
    for (let i = 0; i < 9; i++) await throttle.recovered(URL_A)
    throttle = createCrawlThrottle(Date.now() + 90_000, throttle.state)
    for (let i = 0; i < 11; i++) await throttle.recovered(URL_A)
    expect(throttle.state.intervalMs).toBe(1_000)
  })

  it('a URL’s second refusal does not slow the crawl further', async () => {
    const throttle = createCrawlThrottle(90_000)
    await throttle.backoff(URL_A, '1')
    expect(throttle.state.intervalMs).toBe(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await throttle.backoff(URL_A, '1')
    expect(throttle.state.intervalMs).toBe(2_000)
  })

  it('defers a ten-minute wait to a later chunk without marking the audit stopped', async () => {
    const throttle = createCrawlThrottle(90_000)
    expect(await throttle.backoff(URL_A, '600')).toBe(true)
    expect(await throttle.ready()).toBe(false)
    expect(throttle.stopped).toBe(false)
    expect(throttle.state.pausedUntil).toBe(600_000)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    const resumed = createCrawlThrottle(690_000, throttle.state)
    expect(await resumed.ready()).toBe(true)
  })

  it('keeps request spacing across a chunk boundary', async () => {
    const first = createCrawlThrottle(90_000)
    await first.ready()
    const second = createCrawlThrottle(90_000, first.state)
    let startedAt = -1
    const request = second.ready().then(() => {
      startedAt = Date.now()
    })
    await vi.runAllTimersAsync()
    await request
    expect(startedAt).toBe(1_000)
  })

  it('does not label an ordinary chunk deadline as a rate-limit stop', async () => {
    const throttle = createCrawlThrottle(90_000)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await throttle.ready()).toBe(false)
    expect(throttle.stopped).toBe(false)
  })

  it('stops once an hour of waiting has accrued, served pages included, without retrying early', async () => {
    let throttle = createCrawlThrottle(90_000)
    expect(await throttle.backoff(URL_A, '3000')).toBe(true)
    await vi.advanceTimersByTimeAsync(3_000_000)
    await throttle.recovered(URL_A)
    throttle = createCrawlThrottle(Date.now() + 90_000, throttle.state)
    expect(await throttle.backoff(URL_B, '3000')).toBe(false)
    expect(throttle.stopped).toBe(true)
    expect(await throttle.ready()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('createRateLimitWait', () => {
  it('waits out the Retry-After, then says go', async () => {
    const wait = createRateLimitWait()
    let done: boolean | null = null
    void wait('5').then((ok) => {
      done = ok
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(done).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('waits a minute when the server names no time, and never longer than a minute', async () => {
    for (const header of [null, '3600']) {
      vi.setSystemTime(0)
      const wait = createRateLimitWait()
      let done = false
      void wait(header).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(59_999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
    }
  })

  it('shares one pause between refusals that arrive together', async () => {
    const wait = createRateLimitWait()
    const ends: number[] = []
    const both = Promise.all([
      wait('5').then(() => ends.push(Date.now())),
      wait('5').then(() => ends.push(Date.now())),
    ])
    await vi.advanceTimersByTimeAsync(5_000)
    await both
    expect(ends).toEqual([5_000, 5_000])
  })

  it('waits at most two minutes in all, then answers no at once', async () => {
    const wait = createRateLimitWait()
    const first = wait('60')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await first).toBe(true)
    const second = wait('60')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await second).toBe(true)
    expect(await wait('1')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
