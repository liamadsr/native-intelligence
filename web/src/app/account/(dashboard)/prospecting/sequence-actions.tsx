'use client'

/**
 * Add-to-sequence, for people who are not in the CRM yet (§8).
 *
 * THE ORDERING PROBLEM THIS FILE EXISTS TO SOLVE. `AddToSequenceDialog` takes
 * `contactIds`, and a prospect person HAS NO CONTACT ID until Save promotes
 * them. So "Add to sequence" on the People tab is two steps, not one:
 *
 *   1. Save the selection through the save route, which returns PER-ENTRY
 *      outcomes (never a count) — that shape exists precisely so this step
 *      cannot silently hand the dialog a shorter list than the user picked.
 *   2. Reconcile: keep the ids that actually came back, drop the ones the
 *      route refused, and open the dialog with what is left.
 *
 * AND THE THIRD THING, which is the one the spec calls out by name: of the
 * people who WERE saved, the ones with no email address cannot be enrolled at
 * all. `enrollContacts` skips them with `no_email` — inside a toast, beside a
 * success count. That is exactly the swallow §8 forbids, so this flow filters
 * them out BEFORE the dialog opens and reports them INLINE next to the control
 * the user pressed. Never a toast alone.
 *
 * Nothing here can launch a sequence: `AddToSequenceDialog` stages an
 * enrollment and the boundary documented in `src/lib/ai/tools/sequences.ts`
 * applies to this surface like every other.
 *
 * WHY A HOOK AND NOT A COMPONENT with the buttons inside it: the two entry
 * points (the selection bar and a row's own control) sit in completely
 * different layouts and share only the *flow*. The hook owns the flow and the
 * state; the page renders the buttons where they belong and mounts
 * {@link SequenceFlowSurface} once for the dialog and the note.
 */

import { useCallback, useState } from 'react'
import {
  AddToSequenceDialog,
  type EnrolledInfo,
} from '@/components/sequences/add-to-sequence-dialog'
import { errorMessage, publishEntries, type SaveResult } from './api'
import { noEmailNote, saveSkipDetail } from './ui-helpers'

/** What one attempt produced, in the words the surface renders. */
export interface SequenceFlowNote {
  /** Contacts that reached the dialog. */
  enrollable: number
  /** Saved, but with no email — named explicitly (§8, `no_email`). */
  noEmail: number
  /** Entries the SAVE route refused, grouped by their DISPLAY text (already
   *  labelled, server `message` preferred), so the renderer prints `reason`
   *  verbatim rather than looking it up again. */
  refused: Array<{ reason: string; count: number }>
}

export interface SequenceFlow {
  /** True while the save half is in flight. */
  busy: boolean
  /** Save the given entries, then open the dialog with the ids that can
   *  actually be enrolled. `onSaved` runs after the save half lands, so the
   *  page can refetch before the dialog reports. */
  start: (entryIds: string[]) => Promise<void>
  /** The last attempt's outcome, or null. Cleared by `dismissNote`. */
  note: SequenceFlowNote | null
  dismissNote: () => void
  // ── wiring for SequenceFlowSurface; the page does not read these ──
  contactIds: string[]
  dialogOpen: boolean
  setDialogOpen: (open: boolean) => void
}

/**
 * Does this saved person have an email address we can send to?
 *
 * READ OFF THE SAVE RESPONSE, not off the entry's `candidate` blob. The route
 * is the authority: a person promoted through `findOrCreateContact` may match
 * an EXISTING contact that already had an email even though the discovered
 * candidate carried none, and the reverse (a candidate email the route
 * rejected) is equally possible. Guessing from the pre-save blob would
 * routinely exclude people who are perfectly enrollable.
 */
function hasEmail(saved: { email?: string | null }): boolean {
  return typeof saved.email === 'string' && saved.email.trim() !== ''
}

export function useSequenceFlow({
  onSaved,
}: {
  /** Called once the save half has committed — refetch the list here. */
  onSaved?: () => void
} = {}): SequenceFlow {
  const [busy, setBusy] = useState(false)
  const [contactIds, setContactIds] = useState<string[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [note, setNote] = useState<SequenceFlowNote | null>(null)

  const start = useCallback(
    async (entryIds: string[]) => {
      if (entryIds.length === 0) return
      setBusy(true)
      setNote(null)
      try {
        // PUBLISH these entries — not merely save them to the list: the
        // dialog needs contact ids, and a person who is only on the list has
        // none (migration 259). Publishing is fast (a handful of upserts, no
        // external calls) and the dialog cannot open without its output — so
        // it is awaited, not raced.
        //
        // `false` EXPLICITLY: this is the bulk path, and it must never waive
        // the identity gate. A `needs_review` person comes back in `skipped`
        // and is named in the note; the only route past that gate is the
        // per-row confirm, which sends its one id on its own.
        const result: SaveResult = await publishEntries(entryIds, false)
        onSaved?.()

        // RECONCILE against the request, which is the whole point of per-entry
        // outcomes: only people (a company has no contact to enroll) that came
        // back with a contact id, and of those only the ones with an email.
        const people = result.saved.filter(
          (s) => s.kind === 'person' && typeof s.contact_id === 'string' && s.contact_id,
        )
        const enrollable = people.filter(hasEmail)
        const ids = Array.from(new Set(enrollable.map((s) => s.contact_id as string)))

        // Refusals are grouped and LABELLED here rather than in the renderer,
        // so the note is one plain data shape a test can read.
        //
        // Grouped by the RENDERED detail: five distinct save failures share
        // reason 'error' and are told apart only by the server's `message`,
        // so grouping on the reason alone would merge them into one number
        // that says nothing about what broke.
        const byDetail = new Map<string, number>()
        for (const s of result.skipped) {
          const detail = saveSkipDetail(s)
          byDetail.set(detail, (byDetail.get(detail) ?? 0) + 1)
        }
        setNote({
          enrollable: ids.length,
          noEmail: people.length - enrollable.length,
          refused: Array.from(byDetail, ([reason, count]) => ({ reason, count })),
        })

        setContactIds(ids)
        // A dialog that opens with zero contacts is a dead end — the note
        // above already says why nobody is going.
        if (ids.length > 0) setDialogOpen(true)
      } catch (err) {
        setNote({
          enrollable: 0,
          noEmail: 0,
          refused: [{ reason: errorMessage(err, 'Could not publish to your CRM'), count: 0 }],
        })
      } finally {
        setBusy(false)
      }
    },
    [onSaved],
  )

  const dismissNote = useCallback(() => setNote(null), [])

  return { busy, start, note, dismissNote, contactIds, dialogOpen, setDialogOpen }
}

/**
 * The dialog and the inline note, mounted once by the page.
 *
 * The note is rendered as text in the flow of the page — not a toast — because
 * §8 is explicit that `no_email` must be reported per-row or inline and never
 * only in a toast. A toast is the one place a user can miss a fact that
 * changes what their list is worth.
 */
export function SequenceFlowSurface({
  flow,
  onEnrolled,
}: {
  flow: SequenceFlow
  /**
   * Called once the enroll lands. The info argument is passed straight through
   * from the dialog so the page can say WHICH sequence they went into — the
   * flow itself never picks the destination and has nothing else to tell.
   */
  onEnrolled?: (info: EnrolledInfo) => void
}) {
  const note = flow.note
  return (
    <>
      {note && (
        <div
          role="status"
          data-sequence-note
          className="mx-5 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span className="text-foreground">
            {note.enrollable === 0
              ? 'Nobody could be added to a sequence'
              : `${note.enrollable} ready to sequence`}
          </span>
          {note.noEmail > 0 && <span>· {noEmailNote(note.noEmail)}</span>}
          {note.refused.map((r) => (
            <span key={r.reason}>
              {/* `reason` already holds display text — labelled at grouping
                  time, where the server's `message` was still in hand. */}
              · {r.count > 0 ? `${r.count} skipped (${r.reason})` : r.reason}
            </span>
          ))}
          <button
            type="button"
            onClick={flow.dismissNote}
            className="ml-auto shrink-0 rounded px-1 text-muted-foreground/70 hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
      <AddToSequenceDialog
        contactIds={flow.contactIds}
        open={flow.dialogOpen}
        onOpenChange={flow.setDialogOpen}
        onEnrolled={onEnrolled}
      />
    </>
  )
}
