'use client'

/**
 * The eval-run poll — the prospecting `use-run-poll` contract, applied to
 * `eval_run` (spec §8.3: "the prospecting use-run-poll contract").
 *
 * A self-re-arming `setTimeout` every 3s, gated on `is_live`. Four properties
 * are load-bearing and each one is there because the naive version is wrong:
 *
 * WHY `setTimeout` AND NOT `setInterval`: a slow tick must not stack behind the
 * next one. The timeout is armed only AFTER the previous fetch settles, so a
 * 5-second response produces one in-flight request, never a queue.
 *
 * WHY `is_live` COMES FROM THE SERVER: it is a GENERATED column on `eval_run`
 * (`status in ('queued','running')`, migration 252). A loop that recomputed
 * liveness from a client-side status list would have to keep its own copy of a
 * five-value CHECK constraint in step with the migration — and `cancelled` is
 * a terminal state that a hand-rolled predicate reaches for last, so the bug
 * shape is "polls a cancelled run forever".
 *
 * WHY IT CARRIES THE TRIALS TOO: `GET /runs/[id]` answers `{ run, trials }` in
 * one trip, so the poll that keeps the progress bar honest is the same request
 * that streams each trial's outcome into the run detail as it completes. A
 * second endpoint would double the request rate to show one screen.
 *
 * RESUMPTION ON MOUNT: a run started in another tab (or by the chat tool, or
 * before a reload) is found by `fetchRuns(suiteId, 1)` — newest first — and
 * adopted if live. That is also how the Run buttons know to disable themselves
 * for a run the user never pressed in this session.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EvalRunRow } from '@/lib/evals/types'
import { errorMessage, fetchRun, fetchRuns, type TrialWithChecks } from './api'

/** 3s — the prospecting cadence, and the same one `useEnrichment` and the
 *  cloud-run view use. Exported so the tests advance by exactly one interval. */
export const RUN_POLL_INTERVAL_MS = 3000

export interface EvalRunPollState {
  /** The run being followed: the newest one for this suite, or whatever the
   *  caller adopted. Null before the mount probe settles, and on a suite that
   *  has never been run. */
  run: EvalRunRow | null
  /** The followed run's trials, refreshed on every tick. Empty until the first
   *  successful `fetchRun` — the mount probe reads the run list, which carries
   *  no trials. */
  trials: TrialWithChecks[]
  /** True while the poll is armed. Mirrors `run.is_live`, and is what the Run
   *  buttons and the Stop button gate on. */
  isLive: boolean
  /** The mount-time history probe is still in flight. The Run buttons stay
   *  ENABLED during it — a suite with no live run is the common case, and
   *  disabling a primary action on speculation is worse than a 409. */
  loading: boolean
  /** Adopt a run the caller just started (or cancelled), arming the poll
   *  immediately rather than waiting up to 3s for the next tick. */
  adopt: (run: EvalRunRow) => void
  /** Forget the current run — the outcome banner's dismiss. Does NOT cancel
   *  anything server-side; a live run keeps running and is re-adopted on the
   *  next mount. */
  clear: () => void
  /** Re-probe the run history, so the poll attaches to whatever the server now
   *  considers newest. */
  refresh: () => Promise<void>
}

export function useEvalRunPoll({
  suiteId,
  onTick,
}: {
  suiteId: string
  /**
   * Called after every poll that returned a run, so the caller can refresh
   * anything the run touches (the suite's runs strip, a case's last outcome).
   * Kept in a ref: a caller that rebuilds this closure each render must not
   * re-arm the loop.
   */
  onTick?: () => void
}): EvalRunPollState {
  const [run, setRun] = useState<EvalRunRow | null>(null)
  const [trials, setTrials] = useState<TrialWithChecks[]>([])
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

  const adopt = useCallback((next: EvalRunRow) => {
    liveRef.current = next.is_live
    setRun(next)
  }, [])

  const clear = useCallback(() => {
    liveRef.current = false
    setRun(null)
    setTrials([])
  }, [])

  const refresh = useCallback(async () => {
    try {
      const runs = await fetchRuns(suiteId, 1)
      const newest = runs[0] ?? null
      if (newest) adopt(newest)
      else clear()
    } catch {
      // A failed history probe is not worth a toast: the page is still usable,
      // the Run buttons still work, and the next successful start adopts a run
      // directly. Swallowing it keeps a transient 500 from painting an error
      // over a suite that loaded fine.
    }
  }, [suiteId, adopt, clear])

  // Mount-time resumption. Deliberately separate from the poll effect so that
  // switching suites re-probes exactly once, and so the poll effect's only job
  // is the timer.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    liveRef.current = false
    setRun(null)
    setTrials([])
    void (async () => {
      await refresh()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // The loop. Re-created only when the followed run changes identity or
  // liveness — never on an unrelated progress update, because the dep is the
  // id-while-live and not the run object (a new reference on every tick, which
  // would tear the timer down and back up 20 times a minute).
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
        liveRef.current = next.run.is_live
        // Guard against a race with `adopt`: if the caller switched to a
        // different run mid-flight, this response is about the old one.
        setRun((prev) => (prev && prev.id !== next.run.id ? prev : next.run))
        setTrials(next.trials)
        // Trials commit before the run settles, so the TERMINAL tick refreshes
        // too — otherwise the last case's outcome stays invisible until a
        // manual reload.
        onTickRef.current?.()
      } catch (err) {
        // A single failed poll is a blip (a cold lambda, a dropped socket); the
        // run is still going. Keep polling rather than declaring it dead, and
        // let the run's own `error_code` column report a real failure.
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
    trials,
    isLive: run?.is_live ?? false,
    loading,
    adopt,
    clear,
    refresh,
  }
}
