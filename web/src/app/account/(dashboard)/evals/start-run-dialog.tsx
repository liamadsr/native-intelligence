'use client'

/**
 * Confirm-and-quote before a metered run — the prospecting `FindDialog` shape.
 *
 * Spec §10 makes the estimate a control rather than an after-the-fact report:
 * the chat path is required to quote the figure and wait for a go, and the two
 * buttons on the suite header are the easier ones to press repeatedly. This is
 * where the figure is said and the go is taken.
 *
 * WHY THE SPEED PICKER LIVES HERE. It used to be a split-dropdown welded to the
 * Run live button — a shape users press twice by accident. It belongs on the
 * one screen that already exists to be read before a run starts. Only
 * `instant` runs today (the server driver); the other two are listed disabled
 * so the shape of the feature is visible without promising a button that 400s.
 */

import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EVAL_SPEEDS } from '@/lib/evals/types'
import type { EvalMode, EvalSpeed } from '@/lib/evals/types'
import { formatCost, MODE_LABELS, P0_SPEEDS, SPEED_LABELS, pluralize } from './ui-helpers'

const MODE_BLURB: Record<EvalMode, string> = {
  batch: 'One end-of-meeting call per case.',
  live: 'Each case replayed chunk by chunk, the way a real call arrives.',
}

export function StartRunDialog({
  open,
  onOpenChange,
  mode,
  caseCount,
  estimateUsd,
  speed,
  onSpeedChange,
  starting,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which button opened it. Null while closed, so the body never renders a
   *  half-built quote on the way out. */
  mode: EvalMode | null
  /** Cases this run will actually execute — a case that does not declare the
   *  mode is skipped server-side and is not billed for here either. */
  caseCount: number
  estimateUsd: number
  speed: EvalSpeed
  onSpeedChange: (speed: EvalSpeed) => void
  starting: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode ? `Run ${MODE_LABELS[mode].toLowerCase()}?` : 'Run'}</DialogTitle>
          <DialogDescription>
            {mode ? MODE_BLURB[mode] : ''} {pluralize(caseCount, 'case')} ·{' '}
            <span className="tabular-nums">about {formatCost(estimateUsd)}</span>.
          </DialogDescription>
        </DialogHeader>

        {mode === 'live' && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Replay speed</Label>
            <ToggleGroup
              type="single"
              size="sm"
              value={speed}
              onValueChange={(next) => {
                if (next) onSpeedChange(next as EvalSpeed)
              }}
              className="justify-start"
            >
              {EVAL_SPEEDS.map((option) => {
                const available = P0_SPEEDS.includes(option)
                return (
                  <ToggleGroupItem
                    key={option}
                    value={option}
                    disabled={!available}
                    aria-label={SPEED_LABELS[option]}
                    // Named, not hidden: the feature has three speeds and only
                    // one of them has a driver yet.
                    title={available ? undefined : 'Coming in a later release'}
                    className="text-xs"
                  >
                    {SPEED_LABELS[option]}
                  </ToggleGroupItem>
                )
              })}
            </ToggleGroup>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={starting}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={starting}>
            {starting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {starting ? 'Starting…' : mode ? `Run ${MODE_LABELS[mode].toLowerCase()}` : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
