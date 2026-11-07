/**
 * Global store for the "usage limit exceeded" dialog.
 *
 * Uses useSyncExternalStore so any component tree can subscribe without
 * pulling in Zustand. The dialog component subscribes in the shell; the
 * fetch wrappers write via openUsageLimit() from anywhere (including
 * non-React code paths like hooks and service classes).
 */

export interface UsageLimitInfo {
  /** Why the request was blocked (cost / token / daily request limit). */
  reason?: string
  /** Is the user on a paid plan? Determines whether we show "upgrade" vs "wait for reset". */
  isPaidPlan?: boolean
  /** ISO timestamp of when the user's counters reset. Used on paid plans. */
  usageResetDate?: string | null
  /** Available credit balance in USD (Stripe-backed top-up credits). */
  creditBalanceUsd?: number
}

type Listener = () => void

let current: UsageLimitInfo | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l()
}

export function openUsageLimit(info: UsageLimitInfo) {
  current = info
  emit()
}

export function closeUsageLimit() {
  if (current === null) return
  current = null
  emit()
}

export function subscribeUsageLimit(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getUsageLimitSnapshot(): UsageLimitInfo | null {
  return current
}

/**
 * Attempts to extract usage-limit info from a 429 Response body. Returns
 * null if the body shape doesn't match. Consumes the response body, so
 * callers must clone first if they still need the original.
 */
export async function parseUsageLimitResponse(
  res: Response,
): Promise<UsageLimitInfo | null> {
  if (res.status !== 429) return null
  try {
    const body = (await res.clone().json()) as {
      error?: string
      reason?: string
      isPaidPlan?: boolean
      usageResetDate?: string | null
      creditBalanceUsd?: number
    }
    if (body?.error !== 'Usage limit exceeded') return null
    return {
      reason: body.reason,
      isPaidPlan: body.isPaidPlan,
      usageResetDate: body.usageResetDate ?? null,
      creditBalanceUsd: body.creditBalanceUsd,
    }
  } catch {
    return null
  }
}
