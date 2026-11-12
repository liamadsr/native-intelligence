'use client'

/**
 * The AI visibility check poll, in ../use-audit-poll.ts's shape: a live check
 * (queued or running) is read again until it ends, at the pace the route
 * asks for (`poll_after_seconds`), never faster than every 5 s. Answers come
 * from the assistants over minutes, so there is nothing to gain by asking
 * more often.
 *
 * A self-re-arming `setTimeout`: the next tick is armed only after the last
 * read settles. A failed tick is a blip and the loop keeps going; a hidden
 * tab reads nothing and checks again later. The loop stops on the first
 * answer that is no longer live and hands that answer over like any other.
 */
import * as React from 'react'
import { isLiveRun, type AiRunResults, type AiRunView } from '@/lib/seo/ai-visibility/view'
import { pollDelayMs } from './ai-helpers'
import { fetchRunResults } from './api'

export function useAiRunPoll(run: AiRunView | null, live: boolean, onUpdate: (results: AiRunResults) => void): void {
  const onUpdateRef = React.useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const delayRef = React.useRef(pollDelayMs(run))
  delayRef.current = pollDelayMs(run)
  const runId = run?.id ?? null

  React.useEffect(() => {
    if (!runId || !live) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      let stillLive = true
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const results = await fetchRunResults(runId)
          if (cancelled) return
          stillLive = isLiveRun(results.run.status)
          delayRef.current = pollDelayMs(results.run)
          onUpdateRef.current(results)
        } catch {
          // A blip: keep polling.
          if (cancelled) return
        }
      }
      if (cancelled || !stillLive) return
      timer = setTimeout(tick, delayRef.current)
    }

    timer = setTimeout(tick, delayRef.current)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, live])
}
