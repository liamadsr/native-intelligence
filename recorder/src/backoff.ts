/**
 * How long to wait before trying again: doubling from `baseMs` to `maxMs`,
 * with up to a quarter of jitter so that many streams that dropped together
 * do not come back together. Pure (the random is passed in for tests).
 */
export function backoffMs(attempt: number, opts: { baseMs: number; maxMs: number }, random: () => number = Math.random): number {
  const n = Math.max(0, Math.floor(attempt))
  const raw = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.min(n, 20))
  return Math.round(raw * (0.75 + 0.25 * random()))
}

/** A promise that resolves after `ms`, early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
