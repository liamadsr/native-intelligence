'use client'

/**
 * The live results' poll: a check still collecting its reads (partial or
 * collecting) is read again every 3 s, free, until it is complete. The Site
 * audit's poll's shape (../use-audit-poll.ts): a self-re-arming `setTimeout`,
 * a failed tick is a blip, a hidden tab reads nothing and checks again 3 s
 * later. A check that is complete with nothing found is kept and answers
 * `complete` like any other (the loop stops there). A 404 means the check
 * was dropped (every read failed): the loop stops and says so.
 */
import { useEffect, useRef } from 'react'
import type { SerpResult } from '@/lib/seo/keywords/view'
import { SeoRequestError } from '../api'
import { recheckSerp } from './api'

export const SERP_POLL_INTERVAL_MS = 3000

export function useSerpPoll(
  lookupId: string | null,
  live: boolean,
  onUpdate: (result: SerpResult) => void,
  onGone: () => void,
): void {
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onGoneRef = useRef(onGone)
  onGoneRef.current = onGone

  useEffect(() => {
    if (!lookupId || !live) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      let stillLive = true
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const result = await recheckSerp(lookupId)
          if (cancelled) return
          stillLive = result.status !== 'complete'
          onUpdateRef.current(result)
        } catch (err) {
          if (cancelled) return
          if (err instanceof SeoRequestError && err.apiError.status === 404) {
            onGoneRef.current()
            return
          }
          // A blip: keep polling.
        }
      }
      if (cancelled || !stillLive) return
      timer = setTimeout(tick, SERP_POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, SERP_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [lookupId, live])
}
