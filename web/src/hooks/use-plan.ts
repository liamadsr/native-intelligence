'use client'

import { useEffect, useState } from 'react'

/**
 * Shared billing plan state. Fetches once per session and caches the result
 * so that multiple <PlanPill /> instances (dashboard + settings) don't each
 * flash on mount while refetching.
 */

export interface PlanInfo {
  name: string
  display_name?: string
}

export interface CreditsInfo {
  balance_usd: number
}

interface BillingCache {
  plan: PlanInfo | null
  credits: CreditsInfo | null
}

let cache: BillingCache = { plan: null, credits: null }
let cacheTimestamp = 0
let inFlight: Promise<void> | null = null
const listeners = new Set<(state: BillingCache) => void>()

// Refetch billing status if the cache is older than this. Without a TTL,
// useCredits/usePlan consumers outside the billing page would show stale
// values after a topup or subscription change for the rest of the session.
const CACHE_TTL_MS = 60_000

function notify() {
  listeners.forEach((fn) => fn(cache))
}

function ensureFetched() {
  if (inFlight) return
  const fresh = cache.plan && cache.credits && Date.now() - cacheTimestamp < CACHE_TTL_MS
  if (fresh) return
  inFlight = fetch('/api/billing/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return
      cache = {
        plan: data.plan ?? null,
        credits: data.credits
          ? { balance_usd: Number(data.credits.balance_usd ?? 0) }
          : { balance_usd: 0 },
      }
      cacheTimestamp = Date.now()
      notify()
    })
    .catch(() => {})
    .finally(() => {
      inFlight = null
    })
}

/** Force the next usePlan/useCredits fetch to bypass the cache. Call after
 * actions that change the user's plan or credit balance (upgrade, topup). */
export function invalidateBillingCache() {
  cacheTimestamp = 0
  ensureFetched()
}

export function usePlan(): PlanInfo | null {
  const [plan, setPlan] = useState<PlanInfo | null>(cache.plan)

  useEffect(() => {
    const handler = (state: BillingCache) => setPlan(state.plan)
    listeners.add(handler)
    ensureFetched()
    return () => {
      listeners.delete(handler)
    }
  }, [])

  return plan
}
