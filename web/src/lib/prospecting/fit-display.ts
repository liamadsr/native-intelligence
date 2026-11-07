/**
 * How a match score LOOKS — one definition, three readers.
 *
 * The list row (`src/components/views/list/entity-row.tsx`, part of the shared
 * views system), the entry panel and the agent's summaries all show the same
 * number and must say the same words for it. The views system may not import
 * from the prospecting page folder, so the colours and the tooltip live here
 * in `src/lib/prospecting/` where every surface is allowed to reach.
 *
 * The scale is a VERDICT, not a status, which is why a strong and a good match
 * get a saturated colour rather than the muted neutral every other enum chip
 * in the app uses: a 92 has to be findable by eye while scanning thirty rows,
 * and a 15 has to read as "we do not think so" without anyone reading the
 * number.
 *
 * THE WORD IS "MATCH SCORE", NEVER A TEMPERATURE (Liam, 2026-09-06): the CRM's
 * relationship strength already says hot/warm/cold about a contact, and a
 * "95 Hot" list row beside a "cold" contact was two scales wearing one word.
 * The chip reads "95 match score"; the bands (strong / good / partial / weak)
 * live in the tooltip.
 *
 * Client-safe: imports only the pure `fit.ts`.
 */
import { FIT_LABEL_TEXT, fitLabel } from './fit'
import type { ProspectFitLabel } from './types'

export const FIT_LABEL_CLASSES: Record<ProspectFitLabel, string> = {
  strong: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  good: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  partial: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  weak: 'border-border/60 bg-muted/50 text-muted-foreground',
}

/** What the number is, printed beside it on every chip: "95 match score". */
export const FIT_SCORE_UNIT = 'match score'

/** The chip for a row nobody has profiled — grey, the same footprint as a
 *  scored chip so a mixed list still aligns. */
export const FIT_UNSCORED_CLASS = 'border-border/60 bg-muted/30 text-muted-foreground/70'

/** What an unscored entry says, everywhere. */
export const FIT_UNSCORED_TITLE = 'No match score yet — enrich to get the full profile and a score'

/** The class for a score, or the unscored class. */
export function fitScoreClass(score: number | null | undefined): string {
  const label = fitLabel(score)
  return label ? FIT_LABEL_CLASSES[label] : FIT_UNSCORED_CLASS
}

/** The band as words ("Strong match"), or null when unscored. */
export function fitScoreWord(score: number | null | undefined): string | null {
  const label = fitLabel(score)
  return label ? FIT_LABEL_TEXT[label].short : null
}

/** The tooltip and the screen-reader label: "Match score 92 of 100 · Strong match". */
export function fitScoreTitle(score: number | null | undefined): string {
  const label = fitLabel(score)
  return label ? `Match score ${score} of 100 · ${FIT_LABEL_TEXT[label].long}` : FIT_UNSCORED_TITLE
}
