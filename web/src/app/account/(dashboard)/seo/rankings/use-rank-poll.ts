'use client'

/**
 * The rank check poll, in ../use-audit-poll.ts's shape: a live check (queued
 * or running) is read again every 3 s until it ends.
 *
 * A self-re-arming `setTimeout`: the next tick is armed only after the last
 * read settles. A failed tick is a blip and the loop keeps going; a hidden
 * tab reads nothing and checks again 3 s later. The loop stops on the first
 * answer that is no longer live and hands that answer over like any other.
 *
 * Also here: the markets (countries and languages), read once for the page.
 */
import * as React from 'react'
import type { SeoMarketOptions } from '@/lib/seo/keywords/view'
import { isLiveRankRun, type RankRunView } from '@/lib/seo/rank/view'
import { fetchMarkets, fetchRun } from './api'

export const RANK_POLL_INTERVAL_MS = 3000

export function useRankRunPoll(runId: string | null, live: boolean, onUpdate: (run: RankRunView) => void): void {
  const onUpdateRef = React.useRef(onUpdate)
  onUpdateRef.current = onUpdate

  React.useEffect(() => {
    if (!runId || !live) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      let stillLive = true
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const run = await fetchRun(runId)
          if (cancelled) return
          stillLive = isLiveRankRun(run.status)
          onUpdateRef.current(run)
        } catch {
          // A blip: keep polling.
          if (cancelled) return
        }
      }
      if (cancelled || !stillLive) return
      timer = setTimeout(tick, RANK_POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, RANK_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, live])
}

/** The countries and languages; null until read (and on a failed read: labels drop, nothing breaks). */
export function useMarkets(): SeoMarketOptions | null {
  const [markets, setMarkets] = React.useState<SeoMarketOptions | null>(null)
  React.useEffect(() => {
    let alive = true
    fetchMarkets()
      .then((m) => {
        if (alive) setMarkets(m)
      })
      .catch(() => {
        /* labels drop; the page works without them */
      })
    return () => {
      alive = false
    }
  }, [])
  return markets
}
