'use client'

/**
 * The run poll (§9, "Progress: durable first, streamed never").
 *
 * A self-re-arming `setTimeout` every 3s, gated on `is_live` — the identical
 * pattern as `cloud-run-view.tsx` (~113) and `useEnrichment`
 * (src/components/views/enrichment.tsx). No eve NDJSON, no realtime channel: a
 * four-stage pipeline with countable units gets a progress bar, and
 * `prospecting_run.progress` is written at every phase and round boundary, so
 * a reload mid-run rehydrates exactly.
 *
 * WHY `setTimeout` AND NOT `setInterval`: a slow tick must not stack behind the
 * next one. The timeout is armed only AFTER the previous fetch settles, so a
 * 5-second response produces one in-flight request, never a queue.
 *
 * WHY `is_live` COMES FROM THE SERVER: the `prospecting_run` status vocabulary
 * diverges from `AgentRunStatus` — no `pr_open`, plus `budget_exhausted` — and
 * a loop that recomputed liveness from a client-side status list would spin
 * forever on a budget-exhausted run (a terminal state whose name reads live).
 * `RunPayload.is_live` is the route's own answer and the only gate here.
 *
 * WHY IT ALSO NUDGES THE ENTRY LIST: §9's "what makes minutes tolerable" —
 * results stream into the list as each round's step commits, so there is no
 * empty screen for four minutes. `onTick` fires on every live poll and the
 * list-detail refetches; it is deliberately NOT fired on the terminal tick's
 * own... actually it IS, because the last round's entries commit just before
 * the run settles and a missed final refetch would leave the newest candidates
 * invisible until the next manual reload.
 *
 * RESUMPTION ON MOUNT: a run started in another tab (or before a reload) is
 * found by `fetchRuns(listId, 1)` — newest first — and adopted if live. That
 * is also how the "Find companies" button knows to disable itself without the
 * user having pressed it in this session.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, fetchRun, fetchRuns, type RunPayload } from './api'

export const RUN_POLL_INTERVAL_MS = 3000

export interface RunPollState {
  /** The live run, or the most recent terminal one — whatever the header and
   *  the rail should be describing right now. Null before the first load, and
   *  for a list that has never been run. */
  run: RunPayload | null
  /** True while the poll is armed. Mirrors `run.is_live` once loaded, and is
   *  what the Find button and the Cancel button gate on. */
  isLive: boolean
  /** The mount-time history probe is still in flight. The Find button stays
   *  enabled during it — a list with no live run is the common case, and
   *  disabling a primary action on speculation is worse than a 409. */
  loading: boolean
  /** Adopt a run the caller just started (or cancelled), arming the poll
   *  immediately rather than waiting up to 3s for the next tick. */
  adopt: (run: RunPayload) => void
  /**
   * Adopt a run the poll does NOT already know about, and do nothing if it
   * does. The idempotent sibling of `adopt`, for the workspace-wide active-run
   * feed (§B5b): a run Scout started in the chat strip appears in that feed
   * every 5s, and calling `adopt` on each sighting would overwrite the 3s
   * poll's fresher progress with the feed's staler copy for as long as the run
   * lasted — a rail that ticked backwards twice a minute.
   */
  track: (run: RunPayload) => void
  /** Forget the current run — the outcome banner's dismiss. Does NOT cancel
   *  anything server-side; a live run keeps running and is re-adopted on the
   *  next mount, which is exactly §9's "dismiss-while-running". */
  clear: () => void
  /** Re-probe the run history. Used after a Resume/Retry so the rail attaches
   *  to whatever the server now considers newest. */
  refresh: () => Promise<void>
}

export function useRunPoll({
  listId,
  onTick,
}: {
  listId: string
  /**
   * Called after every poll that returned a run while it was live, so the
   * caller can refetch its entry list. Kept in a ref: a caller that rebuilds
   * this closure each render must not re-arm the loop.
   */
  onTick?: () => void
}): RunPollState {
  const [run, setRun] = useState<RunPayload | null>(null)
  const [loading, setLoading] = useState(true)

  const onTickRef = useRef(onTick)
  onTickRef.current = onTick

  /**
   * Liveness as the LOOP sees it, not as React state sees it. The tick reads
   * this synchronously right after awaiting the fetch; reading `run` there
   * would read the value captured when the effect was created, which is null
   * on the first tick and would stop the loop before it started.
   */
  const liveRef = useRef(false)
  /** The run the loop is following. Written by `adopt` and by each tick. */
  const runIdRef = useRef<string | null>(null)

  const adopt = useCallback((next: RunPayload) => {
    runIdRef.current = next.id
    liveRef.current = next.is_live
    setRun(next)
  }, [])

  /**
   * Adopt only what we are not already following.
   *
   * `runIdRef` rather than `run` in the guard: the ref is written by `adopt`
   * synchronously, so two sightings arriving in the same tick (a start
   * followed immediately by a feed poll) cannot both pass a check made against
   * state React has not committed yet.
   */
  const track = useCallback(
    (next: RunPayload) => {
      if (runIdRef.current === next.id) return
      adopt(next)
    },
    [adopt],
  )

  const clear = useCallback(() => {
    runIdRef.current = null
    liveRef.current = false
    setRun(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const runs = await fetchRuns(listId, 1)
      const newest = runs[0] ?? null
      if (newest) adopt(newest)
      else clear()
    } catch {
      // A failed history probe is not worth a toast: the page is still usable,
      // the Find button still works, and the next successful start adopts a
      // run directly. Swallowing it here keeps a transient 500 from painting
      // an error over a list that loaded fine.
    }
  }, [listId, adopt, clear])

  // Mount-time resumption. Deliberately separate from the poll effect so that
  // switching lists re-probes exactly once, and so the poll effect's only job
  // is the timer.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    runIdRef.current = null
    liveRef.current = false
    setRun(null)
    void (async () => {
      await refresh()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // The loop. Re-created whenever the followed run changes identity or
  // liveness — never on an unrelated progress update, because the deps are the
  // id and the boolean, not the run object (which is a new reference on every
  // single tick and would tear the timer down and back up 20 times a minute).
  const followedId = run?.is_live ? run.id : null
  useEffect(() => {
    if (!followedId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      try {
        const next = await fetchRun(followedId)
        if (cancelled) return
        liveRef.current = next.is_live
        setRun((prev) => (prev && prev.id !== next.id ? prev : next))
        // Entries commit before the run settles, so the terminal tick refetches
        // too — otherwise the last round's candidates stay invisible.
        onTickRef.current?.()
      } catch (err) {
        // A single failed poll is a blip (a cold lambda, a dropped socket); the
        // run is still going. Keep polling rather than declaring the run dead,
        // and let the run's own `error` column report a real failure.
        if (cancelled) return
        void errorMessage(err)
      }
      if (cancelled || !liveRef.current) return
      timer = setTimeout(tick, RUN_POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, RUN_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [followedId])

  return {
    run,
    isLive: run?.is_live ?? false,
    loading,
    adopt,
    track,
    clear,
    refresh,
  }
}
