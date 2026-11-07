'use client'

/**
 * The run rail — one line while a run is live.
 *
 *   ◉ Finding companies · round 1 of 2 · 18 found, 11 new · 6 already known   [Cancel]
 *   ◉ Building profiles · 7 of 18                                             [Cancel]
 *   ◉ Finding people · 2 of 4 companies · 3 found                             [Cancel]
 *
 * The list page draws it for discovery and profile runs only. A PEOPLE run
 * has rows to draw on — each targeted row swaps Find people for the orb and
 * the filter strip carries the stop button (Liam, 2026-09-06: "show that icon
 * on each of the lines until it resolves, so we don't need that top header
 * thing") — so the page skips the rail for it. The chat run card, having no
 * rows, still prints all three lines.
 *
 * WHY ONE KIND-AWARE SENTENCE (Liam, 2026-09-05): the earlier three-segment
 * stepper (`Companies 24 · Fit 12 · People later`) was built for discovery and
 * read as noise on the other two kinds — "Companies 0" lit green, "Fit 0",
 * "Round 1 of 1 · 0 already known" — while the one number that actually moved
 * sat on a second line. The verb names the kind, the clauses are the numbers
 * that change on that kind, and nothing else is printed.
 *
 * WHY NO PERCENTAGE: the denominator is unknowable. Discovery does not know
 * how many companies exist, and a bar that crawls 0→90% and sits there for two
 * minutes is a lie a countable sentence does not have to tell. A stalled run
 * is visible as a number that stopped moving.
 *
 * WHY THE ORB: it is the only "still going" signal while the numbers are not
 * moving — a discovery round can spend 40 seconds inside one search. Same
 * `thinking-orbs` treatment the enrichment sparkle uses, so "the machine is
 * working on this" reads identically across the app.
 *
 * "ALREADY KNOWN" stays on the discovery line because it is the cheapest place
 * in the UI to make dedup legible: 18 found and 11 new is a question, and
 * "6 already known" is the answer.
 */

import { Loader2 } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import type { ProspectingRunKind, ProspectingRunProgress } from '@/lib/prospecting/types'

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/**
 * The sentence, as a verb and its clauses. Pure and exported: the chat run
 * card prints the same line, and the tests pin the words.
 *
 * Every clause is dropped when its number is zero, so a run that has just
 * started reads "Finding companies · round 1 of 2" rather than "0 found, 0
 * new" — a count of nothing is not progress, it is a stage that has not
 * reported yet.
 */
export function runRailLine(
  kind: ProspectingRunKind,
  progress: ProspectingRunProgress,
): { verb: string; clauses: string[] } {
  if (kind === 'account_card') {
    const clauses =
      progress.accounts_total > 0 ? [`${progress.accounts_done} of ${progress.accounts_total}`] : []
    return { verb: 'Building profiles', clauses }
  }
  if (kind === 'people') {
    const clauses: string[] = []
    if (progress.accounts_total > 0) {
      clauses.push(
        `${progress.accounts_done} of ${progress.accounts_total} ${plural(progress.accounts_total, 'company', 'companies')}`,
      )
    }
    if (progress.people_found > 0) clauses.push(`${progress.people_found} found`)
    return { verb: 'Finding people', clauses }
  }
  const clauses: string[] = []
  // "round 1 of 1" is not information.
  if (progress.max_rounds > 1) clauses.push(`round ${progress.round} of ${progress.max_rounds}`)
  if (progress.found > 0) clauses.push(`${progress.found} found, ${progress.new} new`)
  if (progress.suppressed > 0) clauses.push(`${progress.suppressed} already known`)
  return {
    verb: progress.stage === 'score' ? 'Scoring companies' : 'Finding companies',
    clauses,
  }
}

export function RunRail({
  kind,
  progress,
  /** False for a terminal run whose rail is still shown as a summary — the orb
   *  and the Cancel button both come down. */
  live,
  canceling = false,
  onCancel,
}: {
  kind: ProspectingRunKind
  progress: ProspectingRunProgress
  live: boolean
  canceling?: boolean
  onCancel?: () => void
}) {
  const { verb, clauses } = runRailLine(kind, progress)

  return (
    <div className="mx-5 mb-2 flex items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
      {live && (
        <ThinkingOrb state="searching" size={20} theme="auto" className="-my-1 shrink-0" aria-hidden />
      )}
      <p className="min-w-0 flex-1 truncate text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{verb}</span>
        {clauses.map((clause, index) => (
          <span key={index}>
            <span aria-hidden className="text-muted-foreground/40">
              {' · '}
            </span>
            <span className="tabular-nums">{clause}</span>
          </span>
        ))}
      </p>

      {live && onCancel && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          disabled={canceling}
          onClick={onCancel}
        >
          {canceling && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {canceling ? 'Cancelling…' : 'Cancel'}
        </Button>
      )}
    </div>
  )
}
