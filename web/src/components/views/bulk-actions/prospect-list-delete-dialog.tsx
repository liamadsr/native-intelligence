'use client'

import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { emitEntityDeleted } from '@/lib/entity-events'
import { announceProspectListChanged } from '@/lib/prospecting/list-events'

export interface ProspectListDeleteResult {
  /** The ids that are gone. */
  deleted: string[]
  /** The ids that are not, with the server's reason — a list with a run in
   *  flight is refused (409 RUN_LIVE), for one. */
  failed: Array<{ id: string; error: string }>
}

interface ProspectListDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  listIds: string[]
  /** Shown in the title for the single-list case. */
  listName?: string
  /** How many candidates the single list holds — the sentence says what goes. */
  candidateCount?: number
  /** Called once anything was deleted, even when some ids were refused: the
   *  caller must refetch either way. */
  onDeleted: (result: ProspectListDeleteResult) => void
}

/**
 * Confirmation for deleting prospect lists — from the list's own settings
 * menu (one list) and from the index's bulk actions (several). Liam,
 * 2026-09-06: "add a way to delete a list from this settings button and also
 * from the main lists page with the bulk actions".
 *
 * ONE dialog for both doors, because the sentence is the point: what goes
 * (the list, its candidates, its runs) and what stays (companies and people
 * already published to the CRM — they only leave the list's group), and the
 * one thing the user gives up (a candidate dismissed here may be found
 * again, since the entries were the suppression record). The generic
 * "permanently delete N items" confirm cannot say any of that.
 *
 * Each list goes through its OWN DELETE route rather than the generic bulk
 * endpoint — that route refuses a list with a run in flight (409) and takes
 * the CRM group and scoped views with the list. Ids are deleted one by one
 * so one refusal does not abort the rest, and every deleted id is announced
 * (`ni:entity-deleted`, `ni:prospect-list-changed`) so the index rows
 * and the CRM's "From list" chips let go of it without a reload.
 *
 * Composes the same AlertDialog as every other delete flow — never
 * `window.confirm` (the desktop WebView patches it to an async dialog that
 * returns a truthy Promise, so the guarded action would run before the user
 * answers).
 */
export function ProspectListDeleteDialog({
  open,
  onOpenChange,
  listIds,
  listName,
  candidateCount,
  onDeleted,
}: ProspectListDeleteDialogProps) {
  const [deleting, setDeleting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) setError(null)
  }, [open])

  async function handleConfirm() {
    if (deleting || listIds.length === 0) return
    setDeleting(true)
    setError(null)
    const result: ProspectListDeleteResult = { deleted: [], failed: [] }
    for (const id of listIds) {
      try {
        const res = await fetch(`/api/account/prospecting/lists/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          result.failed.push({ id, error: body?.error || `HTTP ${res.status}` })
          continue
        }
        result.deleted.push(id)
        emitEntityDeleted({ entityType: 'prospect_list', id })
        announceProspectListChanged({ id, name: listName ?? '' })
      } catch (err) {
        result.failed.push({ id, error: err instanceof Error ? err.message : 'Failed to delete' })
      }
    }
    setDeleting(false)
    if (result.deleted.length > 0) onDeleted(result)
    if (result.failed.length === 0) {
      onOpenChange(false)
      return
    }
    // Something was refused: stay open and say so, with the server's own
    // reason for the first one. A partial batch has already been reported
    // through onDeleted, so the caller's rows are current.
    const first = result.failed[0]
    setError(
      listIds.length === 1
        ? first.error
        : `${result.failed.length} of ${listIds.length} could not be deleted — ${first.error}`,
    )
  }

  const single = listIds.length === 1
  const title = single
    ? `Delete “${listName || 'this list'}”?`
    : `Delete ${listIds.length} lists?`

  const candidates =
    single && typeof candidateCount === 'number'
      ? `its ${candidateCount} ${candidateCount === 1 ? 'candidate' : 'candidates'}`
      : single
        ? 'its candidates'
        : 'every candidate in them'
  const description = single
    ? `This deletes the list, ${candidates} and its run history. Companies and people already published to your CRM stay there — they just leave this list's group. Candidates dismissed here may turn up in later searches. This cannot be undone.`
    : `This deletes ${listIds.length} lists, ${candidates} and their run history. Companies and people already published to your CRM stay there — they just leave those lists' groups. Candidates dismissed in them may turn up in later searches. This cannot be undone.`

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!deleting) onOpenChange(next) }}>
      <AlertDialogContent data-prospect-list-delete-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-prospect-list-delete-confirm
            // preventDefault keeps the dialog open through the async delete
            // (Radix closes on Action click by default) — it must survive to
            // show a refusal, and must not close before the request lands.
            onClick={(e) => {
              e.preventDefault()
              void handleConfirm()
            }}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
