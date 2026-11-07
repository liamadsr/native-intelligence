'use client'

/**
 * "Add to sequence" picker — the shared dialog behind the contact bulk
 * action, the contact row's context-menu item, and the contact panel's
 * empty-state CTA. Lists the workspace's draft + active sequences, enrolls
 * the given contacts into the chosen one, and toasts the per-reason skip
 * summary from the enroll response ('14 enrolled, 2 skipped (already in a
 * sequence), …').
 *
 * Mirrors the MoveWorkspaceDialog pattern: the caller owns WHICH contacts
 * (ids snapshotted before opening) and this dialog owns the destination
 * picker + the request.
 */

import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  enrollContacts,
  fetchSequences,
  type SequenceListItem,
} from '@/app/account/(dashboard)/sequences/api'
import {
  SEQUENCE_STATUS_META,
  summarizeEnrollResult,
} from '@/lib/sequences/ui-helpers'

/** Event name the contact row's context menu dispatches; a mounted contact
 *  list (unified-view-layout) listens and opens this dialog. */
export const ADD_TO_SEQUENCE_EVENT = 'dial8:add-to-sequence'

export interface AddToSequenceEventDetail {
  contactIds: string[]
}

export function emitAddToSequence(contactIds: string[]) {
  window.dispatchEvent(
    new CustomEvent<AddToSequenceEventDetail>(ADD_TO_SEQUENCE_EVENT, {
      detail: { contactIds },
    }),
  )
}

/**
 * What one successful enroll did, handed to `onEnrolled`.
 *
 * ADDITIVE, and every field is one the dialog already had in hand — the chosen
 * sequence and the route's own result. It exists because the caller may need to
 * SAY what happened somewhere more durable than this dialog's toast (the
 * prospect list's save/sequence banner does exactly that), and re-deriving the
 * sequence's name from an id afterwards would mean a second fetch for a string
 * that was on screen when the user clicked it.
 */
export interface EnrolledInfo {
  sequenceId: string
  sequenceName: string
  /** Contacts the route accepted. */
  enrolledCount: number
  /** Contacts it refused — already enrolled, no email, suppressed. */
  skippedCount: number
}

export function AddToSequenceDialog({
  contactIds,
  open,
  onOpenChange,
  onEnrolled,
}: {
  contactIds: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Called after a successful enroll (refresh whatever list is showing).
   *
   * The argument is OPTIONAL TO READ, not optional to pass: every existing
   * caller is a zero-arity closure and stays correct untouched, while a caller
   * that wants to report the outcome can name the parameter and get it.
   */
  onEnrolled?: (info: EnrolledInfo) => void
}) {
  const [sequences, setSequences] = useState<SequenceListItem[] | null>(null)
  const [enrolling, setEnrolling] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSequences(null)
    fetchSequences()
      .then((rows) => {
        if (cancelled) return
        // Enrolling into an archived sequence is refused by the API; paused
        // ones are hidden too — staging into a paused run is a foot-gun.
        setSequences(rows.filter((s) => s.status === 'draft' || s.status === 'active'))
      })
      .catch(() => {
        if (!cancelled) setSequences([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const handleSelect = async (sequence: SequenceListItem) => {
    if (enrolling || contactIds.length === 0) return
    setEnrolling(true)
    try {
      const result = await enrollContacts(sequence.id, contactIds)
      // Enrolling into an already-launched sequence only STAGES the contacts —
      // they stay inert until Review & launch runs again; say so instead of a
      // bare "N enrolled" that reads as "they're in the wave".
      toast.success(
        `${sequence.name}: ${summarizeEnrollResult(result, {
          requiresLaunch: sequence.status === 'active' || sequence.status === 'paused',
        })}`,
      )
      onEnrolled?.({
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        enrolledCount: result.enrolled.length,
        skippedCount: result.skipped.length,
      })
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to enroll contacts')
    } finally {
      setEnrolling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[400px]">
        <DialogHeader className="px-4 pb-2 pt-4">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <Send className="h-3.5 w-3.5 text-muted-foreground" />
            Add {contactIds.length} contact{contactIds.length === 1 ? '' : 's'} to sequence
          </DialogTitle>
        </DialogHeader>
        <Command className="border-0">
          <CommandInput placeholder="Search sequences…" className="h-9" />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {sequences === null
                ? 'Loading…'
                : 'No draft or active sequences. Create one first (/sequences in the chat).'}
            </CommandEmpty>
            {(sequences ?? []).map((sequence) => {
              const meta = SEQUENCE_STATUS_META[sequence.status]
              return (
                <CommandItem
                  key={sequence.id}
                  value={sequence.name}
                  disabled={enrolling}
                  onSelect={() => handleSelect(sequence)}
                  className="gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">{sequence.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {sequence.enrollment_counts.total} enrolled
                  </span>
                  {meta && (
                    <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${meta.className}`}>
                      {meta.label}
                    </Badge>
                  )}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
