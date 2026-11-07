'use client'

/**
 * The match score chip — "95 match score", the band ("Strong match") in the
 * tooltip. Used by the entry panel; the list row in the shared views system
 * renders its own structural twin from the same `fit-display` definitions,
 * because the views system may not import from a feature folder. Never a
 * temperature word: the CRM's relationship strength owns hot/warm/cold.
 *
 * An UNSCORED entry renders a grey "Not scored" chip rather than nothing: an
 * omitted chip silently reads as a bad score and un-aligns the rows beneath
 * it. The row has a better answer for that state — an Enrich button — and the
 * panel puts the same button beside this chip.
 */

import { cn } from '@/lib/utils'
import { fitLabel } from '@/lib/prospecting/fit'
import { FIT_SCORE_UNIT, fitScoreClass, fitScoreTitle } from '@/lib/prospecting/fit-display'

export function FitScore({
  score,
  className,
}: {
  score: number | null | undefined
  className?: string
}) {
  const label = fitLabel(score)
  const title = fitScoreTitle(score)
  return (
    <span
      title={title}
      aria-label={title}
      data-fit-score={label ? score : 'none'}
      data-fit-label={label ?? 'none'}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium tabular-nums',
        fitScoreClass(score),
        className,
      )}
    >
      {label ? (
        <>
          <span>{score}</span>
          <span className="font-normal">{FIT_SCORE_UNIT}</span>
        </>
      ) : (
        <span className="font-normal">Not scored</span>
      )}
    </span>
  )
}
