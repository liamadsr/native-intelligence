'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** Past the opening by this much, so the server (whose clock decides) sees the link open. */
export const OPEN_SLACK_MS = 2_000
/** setTimeout's longest wait (about 24.8 days); a later opening waits in steps. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** How long to wait before asking the server again, or null when there is nothing to wait for. */
export function refreshDelay(inMs: number): number | null {
  if (!Number.isFinite(inMs)) return null
  return Math.min(Math.max(inMs, 0) + OPEN_SLACK_MS, MAX_TIMEOUT_MS)
}

/**
 * A meeting link opened before its time (src/app/m/[token]/page.tsx's
 * "opens at" card): one timer to the opening, then the page asks the server
 * again and moves on by itself (the entry page, once the server says the
 * link works). `inMs` is the server's own count to the opening, so a wrong
 * clock on the guest's device moves nothing; asked too early (a long wait
 * taken in steps), the server's answer brings a new count and a new timer.
 * Nothing else runs while it waits.
 */
export function RefreshWhenOpen({ inMs }: { inMs: number }) {
  const router = useRouter()
  useEffect(() => {
    const wait = refreshDelay(inMs)
    if (wait === null) return
    const timer = setTimeout(() => router.refresh(), wait)
    return () => clearTimeout(timer)
  }, [inMs, router])
  return null
}
