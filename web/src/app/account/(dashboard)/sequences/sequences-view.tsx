'use client'

/**
 * Sequences — the tab root for the 'sequences' AccountView.
 *
 * The LIST is the shared views system (UnifiedViewLayout with
 * entityType="sequence"), so sequences get the same saved views, filters,
 * sort/order, display properties and list/board layouts as Actions, Projects
 * and Flows — this wrapper only contributes what views can't: the page header
 * with the "New sequence" action (opens the builder), and the no-mailbox
 * banner (sequences send from the user's own Gmail/Outlook — deep-link to
 * settings/connectors). Mirrors the FlowsView wrapper shape.
 *
 * Which page shows is driven by the tab location: a `{ kind: 'sequence', id }`
 * location renders the detail page, the bare view renders the list — so
 * opening a sequence is a real history step and Back returns to the list.
 */

import { useEffect, useState } from 'react'
import { Mail, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { useOptionalSettingsOverlay } from '../settings-overlay'
import { ViewHeader } from '../views/view-header'
import { SequenceBuilder } from './sequence-builder'
import { SequenceDetail } from './sequence-detail'
import { fetchEmailAccounts } from './api'

const NEW_SEQUENCE_LABEL = 'New sequence'

export function SequencesView({
  sequenceId,
  onOpenSequence,
  onSequenceNameLoaded,
  onCloseDetail,
}: {
  /** From the tab location — non-null renders the detail page. */
  sequenceId: string | null
  /** Push a detail history entry (recently-viewed label rides along). */
  onOpenSequence: (id: string, name: string) => void
  /** Deep links arrive with a placeholder name; called once the detail page
   *  knows the real one so the caller can refresh the history entry/label. */
  onSequenceNameLoaded?: (id: string, name: string) => void
  /** Return to the list as a history step. */
  onCloseDetail: () => void
}) {
  const [hasMailbox, setHasMailbox] = useState<boolean | null>(null)
  const [creating, setCreating] = useState(false)
  const settingsOverlay = useOptionalSettingsOverlay()

  useEffect(() => {
    let cancelled = false
    fetchEmailAccounts()
      .then((accounts) => {
        if (!cancelled) setHasMailbox(accounts.length > 0)
      })
      // Unknown on a network failure: no "connect a mailbox" prompt for it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Enrollment → headline-count bridge. The shared views list refreshes on
  // 'sequence' entity events, but the row's enrolled/replied numbers change
  // on sequence_ENROLLMENT rows, which never touch the sequence row itself.
  // Re-dispatch those as a sequence entity-created event — the exact seam
  // UnifiedViewLayout already listens on for list refreshes (same trick as
  // tab-content's handleCreateDocument), with its own 300ms coalescing, so a
  // bulk enroll of 50 contacts still costs one refetch.
  useEntityListSync(['sequence_enrollment'], () => {
    window.dispatchEvent(
      new CustomEvent('ni:entity-created', { detail: { entityType: 'sequence' } }),
    )
  })

  // ── Detail page ──
  if (sequenceId) {
    return (
      <SequenceDetail
        key={sequenceId}
        sequenceId={sequenceId}
        onBack={onCloseDetail}
        onNameLoaded={(name) => onSequenceNameLoaded?.(sequenceId, name)}
      />
    )
  }

  // ── Builder (create) ──
  if (creating) {
    return (
      <SequenceBuilder
        sequence={null}
        steps={null}
        onCancel={() => setCreating(false)}
        onSaved={(sequence) => {
          setCreating(false)
          onOpenSequence(sequence.id, sequence.name)
        }}
      />
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Page header — title + create. The views toolbar (search/filter/group/
          sort/layout) renders just below, inside UnifiedViewLayout. Matches the
          shared "+" icon button used on the other list pages (flows, docs). */}
      <ViewHeader
        title="Sequences"
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setCreating(true)}
            title={NEW_SEQUENCE_LABEL}
            aria-label={NEW_SEQUENCE_LABEL}
          >
            <Plus className="h-4 w-4" />
          </Button>
        }
      />

      {/* No connected mailbox — sequences send from the user's own account. */}
      {hasMailbox === false && (
        <div className="mx-3 mt-1 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">No connected mailbox.</span> Sequences send from your
            own Gmail or Outlook account — connect one to launch.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 border-amber-500/40 text-xs"
            onClick={() => settingsOverlay?.openSettings('connectors')}
          >
            Connect
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <UnifiedViewLayout
          entityType="sequence"
          onItemSelect={(id, title) => onOpenSequence(id, title)}
        />
      </div>
    </div>
  )
}
