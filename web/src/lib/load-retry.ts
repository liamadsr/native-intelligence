/**
 * The schedule a client hook's failed load retries on (useAgentWork,
 * useAttentionItems): 2 s, 8 s, 30 s, then every 2 minutes, each failure in a
 * row waiting the next delay. Signed out (a 401 twice running), only the long
 * interval. A load that lands resets it.
 *
 * The hook keeps the rest: what counts as a failure, retrying at once when the
 * window comes back into view or focus (not while `signedOut`), and cancelling
 * with the mount.
 */

/** A failed load's retries: each failure in a row waits the next; the last repeats. */
export const RETRY_DELAYS_MS = [2_000, 8_000, 30_000, 120_000] as const
const RETRY_LONG_MS = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
/** 401s in a row that read as signed out: from then on only the long interval. */
const SIGNED_OUT_AFTER = 2

/** How a load ended: it landed, the network failed, or the HTTP status it failed with. */
export type LoadOutcome = 'ok' | 'network' | number

export interface LoadRetry {
  /** A 401 twice running: the window events leave the load be. */
  readonly signedOut: boolean
  /** A load failed: the retry runs after the next delay (a pending one is dropped). */
  failed: (outcome: Exclude<LoadOutcome, 'ok'>) => void
  /** Drop a pending retry; the streaks stand. */
  cancel: () => void
  /** Start over: the streaks reset and a pending retry is dropped. */
  reset: () => void
}

export function createLoadRetry(retry: () => void): LoadRetry {
  let failStreak = 0
  let unauthStreak = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    get signedOut() {
      return unauthStreak >= SIGNED_OUT_AFTER
    },
    failed: (outcome) => {
      failStreak += 1
      unauthStreak = outcome === 401 ? unauthStreak + 1 : 0
      const delay =
        unauthStreak >= SIGNED_OUT_AFTER
          ? RETRY_LONG_MS
          : RETRY_DELAYS_MS[Math.min(failStreak, RETRY_DELAYS_MS.length) - 1]
      cancel()
      timer = setTimeout(() => {
        timer = null
        retry()
      }, delay)
    },
    cancel,
    reset: () => {
      failStreak = 0
      unauthStreak = 0
      cancel()
    },
  }
}
