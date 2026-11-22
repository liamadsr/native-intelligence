'use client'

/**
 * Share a private record with people (docs/plans/record-sharing.md, Phase 3):
 * the people, teams and channels it is shared with, Can view or Can edit, and
 * Remove (EntityAccessSection, migrations 492, 512 and 688). For the kinds
 * with no public link or email share, opened from a record's own menu (a
 * canvas's ⋯, a spreadsheet's), so it is a controlled dialog with no trigger
 * of its own.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { GrantableType } from '@/lib/entity-access/model'
import { EntityAccessSection } from './entity-access-section'

const NOUN: Partial<Record<GrantableType, string>> = { canvas: 'canvas', spreadsheet: 'spreadsheet' }

export interface RecordShareDialogProps {
  type: GrantableType
  id: string
  /** The record's title, for the dialog's heading. */
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Told after the dialog closes, so the record can count its grants again. */
  onClosed?: () => void
}

export function RecordShareDialog({ type, id, title, open, onOpenChange, onClosed }: RecordShareDialogProps) {
  const noun = NOUN[type] ?? 'record'
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) onClosed?.()
      }}
    >
      <DialogContent className="sm:max-w-md" data-record-share-dialog={type}>
        <DialogHeader>
          <DialogTitle className="truncate text-base">Share {title.trim() ? `“${title.trim()}”` : `this ${noun}`}</DialogTitle>
        </DialogHeader>
        {open ? <EntityAccessSection type={type} id={id} standalone /> : null}
      </DialogContent>
    </Dialog>
  )
}
