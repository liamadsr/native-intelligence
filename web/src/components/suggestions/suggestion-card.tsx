'use client'

/**
 * One suggestion, anywhere: the capture page's ProposalCard (Accept, Dismiss,
 * the sliders button and its pills, Undo, the context popover) driven by the
 * suggestions store instead of a host's handlers. Hosts pass only the id.
 *
 * Beyond the capture card it shows the two states a suggestion staged outside
 * a meeting needs:
 *   • expired: "Already done" when the change was made another way, else a
 *     muted "Expired" line, so a brief read days later doesn't offer a stale
 *     Accept;
 *   • drift: someone changed the target since it was staged; Accept asks first
 *     ("Changed since: status now In Progress. Apply anyway?").
 */
import { memo, useCallback } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import { ProposalCard } from '@/components/capture/proposal-card'
import { useCurrentMemberId, useWorkspaces } from '@/app/account/workspace-switcher'
import { cn } from '@/lib/utils'
import {
  toastSettleFailure,
  useOpenSuggestionEntity,
  useSuggestion,
  useSuggestionDirectory,
  useSuggestionStore,
  useSuggestions,
  type Suggestion,
} from './suggestions-store'

function fieldLabel(field: string): string {
  return field === 'due_date' ? 'due date' : field
}

function driftLine(drift: NonNullable<Suggestion['drift']>): string {
  return drift
    .map((d) => `${fieldLabel(d.field)} is now ${d.now === null || d.now === '' ? 'empty' : String(d.now)}`)
    .join(', ')
}

export interface SuggestionCardProps {
  id: string
  /** compact: one line with Accept and Dismiss, for tight surfaces. */
  variant?: 'full' | 'compact'
  className?: string
  readOnly?: boolean
}

function SuggestionCardImpl({ id, variant = 'full', className, readOnly }: SuggestionCardProps) {
  const store = useSuggestionStore()
  const row = useSuggestion(id)
  const { currentId: currentWorkspaceId } = useWorkspaces()
  const currentMemberId = useCurrentMemberId()
  const directory = useSuggestionDirectory(row?.workspace_id, currentWorkspaceId)
  const openEntity = useOpenSuggestionEntity()

  const apply = useCallback(
    async (changeId: string): Promise<string | null> => {
      const outcome = await store.apply(changeId)
      if (outcome.ok) return outcome.entityId ?? null
      if (outcome.code === 'target_changed') {
        const fields = (outcome.details as { fields?: Suggestion['drift'] } | undefined)?.fields ?? []
        toast.warning('Changed since this was suggested', {
          description: fields.length ? `${driftLine(fields)}.` : undefined,
          action: {
            label: 'Apply anyway',
            onClick: () =>
              void store.apply(changeId, { force: true }).then((o) => {
                if (!o.ok) toastSettleFailure(o, 'accept')
              }),
          },
        })
        return null
      }
      toastSettleFailure(outcome, 'accept')
      return null
    },
    [store],
  )

  const dismiss = useCallback(
    async (changeId: string) => {
      const outcome = await store.dismiss(changeId)
      if (!outcome.ok) toastSettleFailure(outcome, 'dismiss')
    },
    [store],
  )

  const edit = useCallback(
    async (changeId: string, updates: Record<string, unknown>) => {
      const outcome = await store.edit(changeId, updates)
      if (!outcome.ok) toastSettleFailure(outcome, 'save that change')
    },
    [store],
  )

  const undo = useCallback(
    async (changeId: string) => {
      const outcome = await store.undo(changeId)
      if (!outcome.ok) toastSettleFailure(outcome, 'undo')
    },
    [store],
  )

  if (!row) {
    // Loading, or not visible to this person: reserve nothing, show nothing.
    return null
  }

  if (row.status === 'expired') {
    const done = row.expire_reason === 'already_true' || row.expire_reason === 'applied_elsewhere'
    return (
      <div
        className={cn(
          'my-1 flex items-center gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-muted-foreground',
          className,
        )}
        data-suggestion-id={row.id}
      >
        {done ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Clock className="size-3.5" />}
        <span className="truncate line-through decoration-muted-foreground/40">{row.display_text}</span>
        <span className="ml-auto shrink-0">{done ? 'Already done' : 'Expired'}</span>
      </div>
    )
  }

  if (row.status === 'dismissed') return null

  if (variant === 'compact') {
    const pending = row.status === 'pending'
    return (
      <div
        className={cn('my-1 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-sm', className)}
        data-suggestion-id={row.id}
      >
        <span className={cn('min-w-0 flex-1 truncate', !pending && 'text-muted-foreground')}>{row.display_text}</span>
        {pending && !readOnly ? (
          <>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => void dismiss(row.id)}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="shrink-0 rounded-md bg-primary px-2 py-0.5 text-xs text-primary-foreground hover:bg-primary/90"
              onClick={() => void apply(row.id)}
            >
              Accept
            </button>
          </>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">{row.status === 'applied' ? 'Accepted' : ''}</span>
        )}
      </div>
    )
  }

  return (
    <div className={cn('my-1', className)} data-suggestion-id={row.id}>
      {row.status === 'pending' && row.drift && row.drift.length > 0 && (
        <div className="mb-1 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="truncate">Changed since suggested: {driftLine(row.drift)}.</span>
        </div>
      )}
      <ProposalCard
        change={row}
        onApply={apply}
        onDismiss={dismiss}
        onEdit={edit}
        onUndo={undo}
        onOpenEntity={openEntity ? (type, entityId, title) => openEntity(type, entityId, title) : undefined}
        members={directory.members}
        aiMembers={directory.aiMembers}
        contacts={directory.contacts}
        projects={directory.projects}
        currentMemberId={row.workspace_id === currentWorkspaceId ? currentMemberId : null}
        readOnly={readOnly}
      />
    </div>
  )
}

export const SuggestionCard = memo(SuggestionCardImpl)

/**
 * The suggestions an answer or a document staged but didn't place with a
 * marker, plus Apply all / Dismiss all for everything pending in the group.
 */
export function SuggestionGroup({ ids, className }: { ids: string[]; className?: string }) {
  const store = useSuggestionStore()
  const rows = useSuggestions(ids)
  const pending = rows.filter((r) => r.status === 'pending').map((r) => r.id)

  const applyAll = async () => {
    const r = await store.applyMany(pending)
    if (r.applied) toast.success(`Applied ${r.applied}${r.skipped ? `, ${r.skipped} skipped` : ''}`)
    else if (r.skipped) toast.info(`${r.skipped} skipped: already done or changed since`)
    if (r.failed) toast.error(`${r.failed} could not be applied`)
  }
  const dismissAll = async () => {
    for (const id of pending) await store.dismiss(id)
  }

  if (ids.length === 0) return null
  return (
    <div className={cn('my-2 flex flex-col gap-1', className)}>
      {ids.map((id) => (
        <SuggestionCard key={id} id={id} />
      ))}
      {pending.length > 1 && (
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => void dismissAll()}
          >
            Dismiss all
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:bg-primary/90"
            onClick={() => void applyAll()}
          >
            Apply all {pending.length}
          </button>
        </div>
      )}
    </div>
  )
}
