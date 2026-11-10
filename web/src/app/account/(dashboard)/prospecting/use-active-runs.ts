'use client'

/**
 * The workspace-wide active-run poll (§B5).
 *
 * WHY THIS EXISTS AT ALL. Before Scout, a prospecting run could only start
 * from the page that was already watching it: `useRunPoll` adopts a run at
 * MOUNT and then follows it, and the index fetched each list's newest run
 * exactly once, on mount, and never again. Both were correct when the only way
 * to start a run was to press a button on the very surface that would then
 * poll it.
 *
 * That is no longer true. Scout starts runs from the chat strip — the same tab,
 * a different component — and the user's other tab can start one too. So there
 * has to be ONE read that answers "is anything running in this workspace right
 * now", cheap enough to poll from three places at once and shaped so a nav rail
 * that has never loaded a list can still render a dot.
 *
 * WHY ONE ROUTE AND NOT N PROBES: the index used to learn liveness by asking
 * each list for its newest run. Polling that would be N requests per tick on a
 * workspace with twenty lists, to answer a question whose answer is almost
 * always "nothing". `/runs/active` returns only what is live, capped at 50, so
 * the common case is a single request returning an empty array.
 *
 * ── The cadence, and why it is two speeds ──
 *
 * 5s while anything is live, 20s when nothing is. The fast lane exists because
 * a run's progress is what the user is watching; the slow lane exists because
 * the question "did the agent just start something?" only needs answering at
 * human speed, and an idle workspace should not pay 12 requests a minute
 * forever on every mounted nav rail.
 *
 * WHY `setTimeout` AND NOT `setInterval`, for the third time in this codebase
 * (see use-run-poll.ts, and `useEnrichment`): the next tick is armed only after
 * the previous fetch SETTLES. A slow response cannot stack a queue behind
 * itself, and — the part that matters here — the interval is re-read from the
 * fresh result every time, so the transition from idle to live speeds the loop
 * up on the very next arm rather than at some interval boundary.
 *
 * ── Pausing ──
 *
 * One gate (there are no Native Intelligence tabs to background any more: one chat,
 * docs/plans/one-chat.md):
 *   • `document.hidden` — the BROWSER tab/window is hidden. The browser already
 *     throttles timers here, but an un-gated loop still fires a burst on
 *     return; gating means the return itself is the trigger, via
 *     `visibilitychange`.
 * Plus `enabled`, which is the caller's own "is this surface even showing the
 * thing this data feeds".
 *
 * Coming BACK from any of those three fires an immediate poll rather than
 * waiting out the interval — a user returning to the tab is exactly the moment
 * a stale answer is most visible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, fetchActiveRuns, type ActiveRunPayload } from './api'

/** Poll cadence while at least one run is live. */
export const ACTIVE_RUNS_LIVE_INTERVAL_MS = 5000
/** Poll cadence while nothing is running — "did the agent start something?" */
export const ACTIVE_RUNS_IDLE_INTERVAL_MS = 20000

export interface ActiveRunsState {
  /** Every live run in the workspace, newest first. Empty until the first
   *  successful read — a failed read leaves the last good answer standing
   *  rather than blanking a live dot on one dropped request. */
  runs: ActiveRunPayload[]
  /** list_id → that list's live run. At most one per list is possible
   *  (`prospecting_run_one_live_per_list`), so this is a total view, not a
   *  lossy one. */
  byListId: Map<string, ActiveRunPayload>
  /** True until the first read settles, successfully or not. Consumers use it
   *  to avoid flashing "nothing is running" before they know. */
  loading: boolean
  /** Force a read now — used after starting a run, so the index's dot lights
   *  without waiting out an interval. */
  reload: () => void
}

export function useActiveRuns({ enabled }: { enabled: boolean }): ActiveRunsState {
  const [runs, setRuns] = useState<ActiveRunPayload[]>([])
  const [loading, setLoading] = useState(true)

  /**
   * Liveness as the LOOP sees it. The tick reads this synchronously right
   * after awaiting the fetch to pick the next interval; reading `runs` there
   * would read the value captured when the effect was created, which is empty
   * on the first tick and would keep the loop at the idle cadence for as long
   * as the effect lived.
   */
  const liveRef = useRef(false)
  /** One in-flight request at a time. A manual `reload` landing on top of an
   *  armed tick must not produce two overlapping reads whose responses can
   *  settle out of order. */
  const inFlightRef = useRef(false)
  /** Bumped to re-create the loop effect on demand (`reload`). */
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const arm = () => {
      if (cancelled) return
      timer = setTimeout(
        run,
        liveRef.current ? ACTIVE_RUNS_LIVE_INTERVAL_MS : ACTIVE_RUNS_IDLE_INTERVAL_MS,
      )
    }

    const run = async () => {
      if (cancelled) return
      // The browser tab is hidden: skip the WORK, keep the LOOP. Tearing the
      // timer down here would mean nothing re-arms it when the page comes back
      // except the visibilitychange handler, and this way that handler only has
      // to hurry the next poll along rather than own restarting the whole loop.
      if (typeof document !== 'undefined' && document.hidden) {
        arm()
        return
      }
      if (inFlightRef.current) {
        arm()
        return
      }
      inFlightRef.current = true
      try {
        const next = await fetchActiveRuns()
        if (cancelled) return
        liveRef.current = next.length > 0
        setRuns(next)
      } catch (err) {
        // A dropped read is a blip. Keep the LAST GOOD answer: blanking the
        // list here would drop the index's live dot for one tick and put it
        // back on the next, which reads as the run having ended.
        if (cancelled) return
        void errorMessage(err)
      } finally {
        inFlightRef.current = false
      }
      if (cancelled) return
      setLoading(false)
      arm()
    }

    // Poll IMMEDIATELY on mount / on becoming active / on `reload`, not after
    // an interval: arriving at a surface is the moment its answer is most
    // likely to be stale, and a 20-second wait for the first dot is the same
    // as no dot at all.
    void run()

    const onVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (timer) clearTimeout(timer)
      void run()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
    }

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [enabled, nonce])

  const byListId = useMemo(() => {
    const map = new Map<string, ActiveRunPayload>()
    // Newest first, and at most one live run per list is possible, so the first
    // writer wins — the guard is belt-and-braces against a stale row rather
    // than a real case.
    for (const r of runs) if (!map.has(r.list_id)) map.set(r.list_id, r)
    return map
  }, [runs])

  return { runs, byListId, loading, reload }
}
