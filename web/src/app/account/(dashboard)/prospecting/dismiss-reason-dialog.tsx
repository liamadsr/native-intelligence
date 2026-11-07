'use client'

/**
 * The dismissed-reason picker (§8).
 *
 * Dismiss never touches the CRM: `stage='dismissed'` and the entry PERSISTS,
 * because the entry IS the suppression record. Two of the reasons —
 * `competitor` and `already_customer` — suppress WORKSPACE-WIDE rather than
 * just in this list (decision 3), which is a real, invisible consequence, so
 * those options say so on the option itself instead of in a footnote.
 *
 * The same picker serves three gestures, which is why it is a component rather
 * than inline markup: the row's hover ×, the selection bar's bulk Dismiss, and
 * (PR 7) the board's drag-to-Dismissed column, which must open this rather
 * than silently writing the stage.
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  PROSPECT_DISMISSED_REASONS,
  PROSPECT_GLOBAL_DISMISS_REASONS,
  type ProspectDismissedReason,
} from '@/lib/prospecting/types'

/** The reason, in words — shared with the entry panel, which says why a
 *  dismissed candidate was dismissed. */
export const DISMISS_REASON_LABELS: Record<ProspectDismissedReason, string> = {
  not_icp: 'Not a fit',
  too_small: 'Too small',
  too_big: 'Too big',
  competitor: 'Competitor',
  already_customer: 'Already a customer',
  no_contact: 'No one to contact',
  other: 'Other',
}

const GLOBAL: ReadonlySet<string> = new Set<string>(PROSPECT_GLOBAL_DISMISS_REASONS)

/** True when dismissing for this reason hides the candidate in EVERY list. */
export function suppressesWorkspaceWide(reason: ProspectDismissedReason): boolean {
  return GLOBAL.has(reason)
}

export function DismissReasonDialog({
  open,
  count,
  onCancel,
  onConfirm,
}: {
  open: boolean
  /** How many entries this dismissal covers — 1 for a row ×, N for the bar. */
  count: number
  onCancel: () => void
  onConfirm: (reason: ProspectDismissedReason) => Promise<void> | void
}) {
  const [reason, setReason] = useState<ProspectDismissedReason>('not_icp')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setReason('not_icp')
      setBusy(false)
    }
  }, [open])

  if (!open) return null

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm(reason)
    } finally {
      setBusy(false)
    }
  }

  return (
    /* PORTALED via the shared Dialog. This picker opens from INSIDE the ICP
       sheet's stacking context as well as from the list body, so an in-tree
       `fixed` node would be trapped under whichever sibling column paints
       last — the exact bug the sheets had. Radix also gives it Escape and a
       focus trap, which a destructive confirmation should never lack. */
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <DialogContent
        aria-label="Dismiss candidates"
        className="w-[min(28rem,calc(100vw-2rem))] max-w-[28rem] gap-0 rounded-lg border-border p-4"
      >
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">
            Dismiss {count === 1 ? 'this candidate' : `${count} candidates`}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            Nothing is deleted — the entry stays so this candidate is not found again.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-0.5">
          {PROSPECT_DISMISSED_REASONS.map((value) => {
            const global = suppressesWorkspaceWide(value)
            return (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                  reason === value ? 'bg-muted/60' : 'hover:bg-muted/40',
                )}
              >
                <input
                  type="radio"
                  name="dismiss-reason"
                  value={value}
                  checked={reason === value}
                  onChange={() => setReason(value)}
                  className="mt-1 h-3 w-3 shrink-0 accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="block leading-tight">{DISMISS_REASON_LABELS[value]}</span>
                  {global && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      Also skipped in every other list
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={confirm} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Dismiss
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
