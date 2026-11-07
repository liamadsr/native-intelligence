'use client'

/**
 * The monthly ceiling, said out loud (§9, decision 5).
 *
 * `$3.40 of $20 this month · resets Oct 1` — one quiet line on the Prospecting
 * index header and inside the Find dialog.
 *
 * WHY THE CEILING NEEDS A SURFACE AT ALL. The per-run cap is consented to on
 * every press, so it can never surprise anyone. The WORKSPACE ceiling is the
 * opposite: it is shared, it is spent by colleagues the user cannot see, and
 * it is enforced in preflight — so without this line the first time anyone
 * learns it exists is the moment a run they just approved refuses to start.
 * A budget that only appears as a refusal reads as a bug in the feature rather
 * than as the guardrail it is.
 *
 * QUIET BY DEFAULT, LOUD ONLY WHEN IT MATTERS. At $3.40 of $20 this is a
 * footnote in muted text; it takes on warning colour only once the remaining
 * room is under one default run, which is the point at which the number stops
 * being trivia and starts being a thing that will stop you.
 *
 * IT NEVER BLOCKS A RENDER. Every consumer treats a failed or in-flight read
 * as "no line": the meter is disclosure, and a header that will not paint
 * because a $20 counter would not load is a worse product than a header with
 * no counter.
 */

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { errorMessage, fetchSpend, type SpendPayload } from './api'
import { formatDollars } from './ui-helpers'

/**
 * "resets Oct 1" — month and day, no year and no time.
 *
 * The boundary is UTC (the ceiling is a workspace fact and cannot be scoped to
 * one member's timezone), and it is rendered in UTC too: formatting the
 * server's instant in the viewer's locale would show "Sep 30" to anyone west
 * of Greenwich and make a correct number look off by a day.
 */
export function formatResetDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d)
}

/**
 * The whole line: "$3.40 of $20 this month · resets Oct 1".
 *
 * The cap is rendered WITHOUT cents ("$20", not "$20.00") while the spend
 * keeps them. That asymmetry is deliberate: the spend is a measured amount
 * where cents are the unit the feature bills in, and the cap is a round policy
 * number where two zeroes only add noise.
 *
 * Exported so the copy is asserted once, from a fixture, instead of being
 * re-derived by every surface that shows it.
 */
export function spendMeterLabel(spend: SpendPayload): string {
  const cap = Number(spend.cap_dollars)
  const capLabel = Number.isFinite(cap) ? `$${Math.round(cap * 100) / 100}` : '$0'
  const resets = formatResetDate(spend.resets_at)
  const head = `${formatDollars(spend.month_spent_dollars)} of ${capLabel} this month`
  return resets ? `${head} · resets ${resets}` : head
}

/**
 * "$0.10 left of $20 this month · resets Oct 1".
 *
 * The same three facts as {@link spendMeterLabel}, led by the REMAINING room
 * rather than the amount spent. A surface that is refusing a run because the
 * room is short has to say how short — "$3.40 of $20" makes the reader do the
 * subtraction to find out whether they are $0.10 or $10 away, and the whole
 * value of the line is that it answers that.
 *
 * Shares `formatResetDate` and the cents-on-spend / no-cents-on-cap asymmetry
 * with `spendMeterLabel` so the two lines cannot drift into two house styles.
 */
export function spendRemainingLabel(spend: SpendPayload): string {
  const cap = Number(spend.cap_dollars)
  const capLabel = Number.isFinite(cap) ? `$${Math.round(cap * 100) / 100}` : '$0'
  const resets = formatResetDate(spend.resets_at)
  const head = `${formatDollars(remainingDollars(spend))} left of ${capLabel} this month`
  return resets ? `${head} · resets ${resets}` : head
}

/** Room left under the ceiling, never negative. The gate is the server's
 *  (`monthlyCapVerdict`); this is the same arithmetic for the copy. */
export function remainingDollars(spend: SpendPayload | null): number {
  if (!spend) return Number.POSITIVE_INFINITY
  const cap = Number(spend.cap_dollars)
  const spent = Number(spend.month_spent_dollars)
  if (!Number.isFinite(cap) || !Number.isFinite(spent)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.round((cap - spent) * 1e6) / 1e6)
}

/**
 * Read the ceiling once per mount.
 *
 * NOT polled. The number moves only when a run finishes, and every surface
 * that can start a run already re-reads it on the transition that matters —
 * the index remounts, the dialog reads on open. A 3s poll for a figure that
 * changes a few times a day would be a request loop in exchange for nothing.
 *
 * `refreshKey` is how a caller says "a run just settled, read it again".
 */
export function useSpend(refreshKey: number = 0): {
  spend: SpendPayload | null
  error: string | null
  reload: () => void
} {
  const [spend, setSpend] = useState<SpendPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    fetchSpend()
      .then((payload) => {
        if (cancelled) return
        setSpend(payload)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        // Kept, but only ever rendered as "no line" — see the module header.
        setError(errorMessage(err, 'Could not read this month’s spend'))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, tick])

  return { spend, error, reload }
}

export function SpendMeter({
  spend,
  /** Warn below this much remaining room — the caller passes the estimate of
   *  the run it is about to offer, so "nearly out" means "nearly out FOR THIS",
   *  not an arbitrary percentage. */
  warnBelow = 0,
  className,
}: {
  spend: SpendPayload | null
  warnBelow?: number
  className?: string
}) {
  // No number, no line. A skeleton here would reserve space in a header for a
  // footnote, which is a worse trade than the line appearing a beat late.
  if (!spend) return null

  const remaining = remainingDollars(spend)
  const low = remaining <= warnBelow

  return (
    <span
      className={cn(
        'text-[11px] tabular-nums',
        low ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground',
        className,
      )}
      title={
        low
          ? 'This workspace is close to its monthly prospecting ceiling'
          : 'Prospecting spend for this workspace, this calendar month'
      }
    >
      {spendMeterLabel(spend)}
    </span>
  )
}
