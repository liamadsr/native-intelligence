'use client'

/**
 * Share a private record with people (docs/plans/record-sharing.md, Phase 3):
 * the people, teams and channels it is shared with, Can view or Can edit, and
 * Remove (EntityAccessSection, migrations 492, 512 and 688). For the kinds
 * with no public link or email share, opened from a record's own menu (a
 * canvas's ⋯, a spreadsheet's), so it is a controlled dialog with no trigger
 * of its own.
 */
import { Share2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { GrantableType } from '@/lib/entity-access/model'
import type { RecordSharing } from '@/lib/entity-access/store'
import { cn } from '@/lib/utils'
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

/** Whether a record's menu offers Share: to whoever may share it, once the app shares this kind (GRANTING_HELD_TYPES). */
export function canShareFromMenu(sharing: RecordSharing | null): boolean {
  return !!sharing && sharing.can_share && !sharing.held
}

/**
 * A record header's word on sharing: for its owner, how many it is shared
 * with; for someone it was shared with, that it was. Nothing otherwise.
 */
export function SharingChip({ sharing, noun, compact = false }: { sharing: RecordSharing | null; noun: string; compact?: boolean }) {
  if (!sharing) return null
  const text = sharing.can_share && sharing.grant_count > 0 ? `Shared · ${sharing.grant_count}` : sharing.shared_with_me ? 'Shared with you' : null
  if (!text) return null
  const title = sharing.can_share ? `Who this ${noun} is shared with: Share in its menu` : `Someone shared this ${noun} with you`
  return (
    <span data-record-sharing="" title={title} className={cn('flex shrink-0 items-center gap-1 rounded-md text-[11px] text-muted-foreground', compact ? 'px-1' : 'px-1.5')}>
      <Share2 className="h-3 w-3" /> {text}
    </span>
  )
}
