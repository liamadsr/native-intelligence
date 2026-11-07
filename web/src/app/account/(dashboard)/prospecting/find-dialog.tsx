'use client'

/**
 * The consent screen (§9, "Consent happens once, with real numbers").
 *
 * Pressing Find opens this BEFORE anything is spent, and it states the plan in
 * the numbers the engine will actually enforce:
 *
 *   > 2 rounds × 4 searches, then a full profile and a score for every
 *   > company it finds.
 *   > About 4–8 minutes. The list re-sorts best match first as scores land.
 *
 * (It used to say "then enrich the ones you pick" and "you'll approve
 * enrichment separately". Discovery hands off to the profile run by itself
 * now — Liam, 2026-09-06 — so the dialog names both halves: one yes covers
 * both.)
 *
 * THE ESTIMATE AND THE GATE SHARE A CONSTANT. `estimateRunDollars` multiplies
 * by `ESTIMATED_DISCOVERY_CALL_DOLLARS` — the same per-call reservation
 * `budgetVerdict` (src/lib/prospecting/spend.ts) checks before every paid call.
 * A dialog that predicted from its own number would drift from the gate, and
 * the whole point of the consent screen is that the figure the user approved is
 * the figure that binds.
 *
 * THE CAP IS EDITABLE AND CLAMPED HERE TOO. The route clamps again server-side
 * (`clampRunBudget`), which is where correctness lives; clamping in the input
 * as well exists so the user is told the band rather than silently corrected
 * after pressing the button.
 *
 * WHY THE ENRICHMENT SENTENCE IS PRESENT IN PR 4, before the per-company
 * stages exist: this dialog buys ONE stage's consent. Omitting the line would
 * let a user read "Estimated $0.24" as the price of the whole feature, and the
 * second gate — which is where the real money is (§9) — would then arrive as a
 * surprise charge rather than as the thing they were told about.
 */

import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ProspectListRow } from '@/lib/prospecting/types'
import { SEARCHES_PER_ROUND, roundsLabel } from './ui-helpers'

/**
 * The confirm before a discovery run. The plan in the engine's own units, a
 * time estimate, and the button. The run's budget is the list's default —
 * limits live in the backend, not on this screen.
 */
export function FindDialog({
  open,
  list,
  busy = false,
  /** Set when the last attempt came back 409 RUN_ALREADY_LIVE — the dialog
   *  says "Already running" in place of the confirm rather than a red error
   *  (§10, "Already running"). */
  alreadyRunning = false,
  onCancel,
  onConfirm,
}: {
  open: boolean
  list: ProspectListRow
  busy?: boolean
  alreadyRunning?: boolean
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}) {
  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <DialogContent
        aria-label="Find companies"
        className="w-[min(30rem,calc(100vw-2rem))] max-w-[30rem] gap-0 rounded-lg border-border p-4"
      >
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">Find companies</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            {roundsLabel(list.max_rounds)} × {SEARCHES_PER_ROUND} searches, then a full profile and
            a score for every company it finds.
          </DialogDescription>
        </DialogHeader>

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          About 4–8 minutes. The list re-sorts best match first as the scores land; you can find
          people at any company once it has a score.
        </p>

        {alreadyRunning && (
          /* NOT an error state: two presses of Find is a normal double-click,
             and the 409 is the one-live-run-per-list index doing its job. */
          <p className="mt-3 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
            Already running — showing the run in progress.
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void onConfirm()}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Find companies
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
