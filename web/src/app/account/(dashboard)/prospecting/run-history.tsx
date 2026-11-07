'use client'

/**
 * "Runs" — the panel listing what this list has already run.
 *
 * The cheapest possible answer to the question a background feature makes
 * people ask: *did I already run this?* Every row is one run — when, which
 * round, how many new candidates, and how it ended — read straight off
 * `fetchRuns`.
 *
 * WHY A PANEL AND NOT A PAGE: run history is reference, not a workflow. It is
 * consulted before pressing Find and never again, and a page would need its own
 * route, its own empty state and its own place in the nav for something the
 * user looks at for four seconds. It used to be its own header popover
 * ("Runs"); since 2026-09-05 it is the second level of the list's settings
 * popover (list-detail.tsx), reached from a "Run history" item, which is why
 * it renders CONTENT only and takes an `onBack`.
 *
 * FETCHED ON MOUNT, EVERY MOUNT. The panel mounts when the user reaches it and
 * unmounts when they leave, so this is "fetched on open, every open": the list
 * changes whenever a run finishes, and a stale history is worse than a
 * spinner — the whole reason to open it is to check whether the run that was
 * going a minute ago has landed.
 */

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AngleStatsPayload, RunPayload } from './api'
import { errorMessage, fetchAngles, fetchRuns } from './api'
import { RUN_STATUS_LABELS, readProgress, relativeTimeShort } from './ui-helpers'

const HISTORY_LIMIT = 20

/**
 * "By angle" — which of the four search angles is actually earning its calls.
 *
 * Every discovery round fires four angles (§7) and bills for all four, but
 * they do not perform alike: on a narrow ICP two of them reliably return the
 * same handful of companies the other two already found, and the user pays for
 * that every round without any way to see it. `found → new → saved` is the
 * funnel that makes it visible — an angle with 40 found and 0 saved is noise
 * the ICP is inviting, and the fix is an ICP edit rather than another round.
 *
 * WHY IT LIVES UNDER RUN HISTORY and not on the list body: it is the same
 * question the history answers (what have my runs actually done for me),
 * consulted at the same moment (before pressing Find again), and it is
 * meaningless until there are at least a couple of runs to compare.
 *
 * IT DEGRADES TO NOTHING. The section renders only with rows: a list whose
 * candidates predate the `discovery_angle` column, or whose read failed, gets
 * a history popover with no angle section rather than an empty table or an
 * error inside a reference surface.
 */
function AngleTable({ angles }: { angles: AngleStatsPayload[] }) {
  if (angles.length === 0) return null
  return (
    <div className="border-t border-border px-3 py-2">
      <p className="text-[11px] font-medium">By angle</p>
      <table className="mt-1 w-full text-[11px]">
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="w-full text-left font-normal">
              Angle
            </th>
            <th scope="col" className="px-1.5 text-right font-normal">
              Found
            </th>
            <th scope="col" className="px-1.5 text-right font-normal">
              New
            </th>
            <th scope="col" className="pl-1.5 text-right font-normal">
              Saved
            </th>
          </tr>
        </thead>
        <tbody>
          {angles.map((row) => (
            <tr key={row.angle}>
              <th
                scope="row"
                className="max-w-0 truncate py-0.5 text-left font-normal text-foreground"
                title={row.angle}
              >
                {row.angle}
              </th>
              <td className="px-1.5 text-right tabular-nums text-muted-foreground">{row.found}</td>
              <td className="px-1.5 text-right tabular-nums text-muted-foreground">{row.new}</td>
              <td className="pl-1.5 text-right tabular-nums text-foreground">{row.saved}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RunHistoryPanel({
  listId,
  /** Bumped by the caller whenever a run settles, so a panel left open
   *  refreshes instead of showing the run as still going. */
  refreshKey = 0,
  onOpenRun,
  onBack,
}: {
  listId: string
  refreshKey?: number
  /** Attach the rail to a past run — how a user gets back to a finished run's
   *  outcome after dismissing its banner. */
  onOpenRun?: (run: RunPayload) => void
  /** Return to the settings menu this panel sits behind. Omitted = no arrow. */
  onBack?: () => void
}) {
  const [runs, setRuns] = useState<RunPayload[] | null>(null)
  const [angles, setAngles] = useState<AngleStatsPayload[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRuns(await fetchRuns(listId, HISTORY_LIMIT))
    } catch (err) {
      setError(errorMessage(err, 'Could not load run history'))
    } finally {
      setLoading(false)
    }
    // Angle telemetry is ADDITIVE and read separately: a failure here must not
    // take down the run list, which is the thing the popover exists for. It is
    // also why this is not in the try above — one aggregate query going wrong
    // should cost the section, not the surface.
    try {
      setAngles(await fetchAngles(listId))
    } catch {
      setAngles([])
    }
  }, [listId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  return (
    <div data-run-history-panel="">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              aria-label="Back to settings"
              onClick={onBack}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          )}
          <p className="px-1 text-xs font-medium">Runs</p>
        </div>
        <div className="max-h-72 overflow-y-auto px-1.5 py-1.5">
          {loading && (
            <p className="flex items-center gap-1.5 px-1.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </p>
          )}
          {error && !loading && (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">{error}</p>
          )}
          {!loading && !error && runs?.length === 0 && (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              This list hasn&apos;t been run yet.
            </p>
          )}
          {!loading &&
            !error &&
            runs?.map((run) => {
              const progress = readProgress(run.progress)
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onOpenRun?.(run)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate">
                      {relativeTimeShort(run.started_at ?? run.created_at) || 'just now'}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {RUN_STATUS_LABELS[run.status]}
                    </span>
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    Round {progress.round} · {progress.new} new
                  </span>
                </button>
              )
            })}
        </div>
        {!loading && !error && <AngleTable angles={angles} />}
    </div>
  )
}
