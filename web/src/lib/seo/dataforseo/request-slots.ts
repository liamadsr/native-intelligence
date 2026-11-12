/**
 * A cap on how many DataForSEO HTTP requests this server process has in
 * flight at once.
 *
 * What it bounds: every request core.ts sends (metered or free, live or
 * task_get), from the moment it is sent until its body has been read. A live
 * DataForSEO call holds its connection for as long as the task takes (30-60s
 * at peak, Lighthouse and LLM answers longer), and one person's action can
 * fan out into many of them at once (a rank grid, a batch of SERP reads, a
 * keyword list split into pages). Without a cap a burst opens that many
 * sockets together; DataForSEO rate-limits each account (calls per minute,
 * and simultaneous requests on some APIs) and answers over the limit with
 * HTTP 429 (RATE_LIMITED), failing calls that would have succeeded a few
 * seconds later. With the cap the extra calls queue here, in order, and run
 * as earlier ones finish.
 *
 * It is a plain in-process semaphore: one process, one queue. Several server
 * processes each get their own cap, so the account-wide total is the cap
 * times the number of processes.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */

/** In-flight DataForSEO requests per server process. */
export const MAX_CONCURRENT_DATAFORSEO_REQUESTS = 12

export interface Semaphore {
  /** Runs `fn` once fewer than the cap are running; frees the slot after. */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** Calls running now (for tests and diagnostics). */
  readonly active: number
  /** Calls waiting for a slot (for tests and diagnostics). */
  readonly waiting: number
}

export function createSemaphore(max: number): Semaphore {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(
      `Semaphore size must be a positive integer, got ${max}`,
    )
  }
  let active = 0
  const queue: Array<() => void> = []

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < max) {
        active++
      } else {
        // A finished call hands its slot straight to the next waiter, so
        // `active` never drops below the cap while anyone is queued.
        await new Promise<void>((resolve) => queue.push(resolve))
      }
      try {
        return await fn()
      } finally {
        const next = queue.shift()
        if (next) next()
        else active--
      }
    },
    get active() {
      return active
    },
    get waiting() {
      return queue.length
    },
  }
}

const dataforseoRequests = createSemaphore(MAX_CONCURRENT_DATAFORSEO_REQUESTS)

/** Runs one DataForSEO request once a process-wide slot is free. */
export function inDataforseoSlot<T>(fn: () => Promise<T>): Promise<T> {
  return dataforseoRequests.run(fn)
}
