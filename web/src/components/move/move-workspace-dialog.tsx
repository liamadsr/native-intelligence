'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
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
import { useSwitchWorkspace, useWorkspaces } from '@/app/account/workspace-switcher'
import { emitEntityDeleted } from '@/lib/entity-events'
import { deleteActionCache } from '@/lib/action-cache'
import type { EntityTypeSubset } from '@/lib/knowledge/entity-registry'

export type MoveEntityType = EntityTypeSubset<'action' | 'project' | 'document' | 'initiative'>

interface MoveWorkspaceDialogProps {
  entityType: MoveEntityType
  /** Ids to move. Only `action` supports more than one (bulk selection). */
  entityIds: string[]
  /** Human name of the single entity, used in the dialog title. */
  entityLabel?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a successful move, once the delete events have been emitted. */
  onMoved?: (destinationWorkspaceId: string, destinationWorkspaceName: string) => void
}

// ── Preflight shapes (mirror the /move/preflight routes) ─────

interface ExternalTaskRef {
  action_id: string
  provider: string
  external_title: string | null
  external_url: string | null
}

interface ActionPreflight {
  actions: { id: string; identifier: string; title: string }[]
  external_tasks: ExternalTaskRef[]
  attachments: number
  agent_runs: number
  crossing_relations: number
}

interface ProjectPreflight {
  project_id: string
  actions: number
  documents: number
  milestones: number
  captures_to_unlink: number
  views_to_delete: number
  labels: number
  external_tasks: ExternalTaskRef[]
}

interface DocumentPreflight {
  document_id: string
  shares_active: number
  drafts_by_others: number
  comments: number
  claims: { sole_sourced: number; shared: number }
}

type Preflight = ActionPreflight | ProjectPreflight | DocumentPreflight

/** The move RPCs return a `counts` jsonb whose keys are a per-entity superset. */
type MoveCounts = Record<string, number | Record<string, string> | undefined>

const ENTITY_NOUN: Record<MoveEntityType, string> = {
  action: 'action',
  project: 'project',
  document: 'document',
  initiative: 'initiative',
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many
}

function countOf(counts: MoveCounts | undefined, key: string): number {
  const value = counts?.[key]
  return typeof value === 'number' ? value : 0
}

/**
 * One-line summary of what the engine did, shown as the success toast's
 * description. Only non-zero facts the user would care about make the cut —
 * the full `counts` object has ~20 keys and reads like a changelog.
 */
function summarizeCounts(entityType: MoveEntityType, counts: MoveCounts | undefined): string | null {
  const parts: string[] = []

  const movedActions = countOf(counts, 'moved_actions')
  if (entityType !== 'action' && movedActions > 0) {
    parts.push(`${movedActions} ${plural(movedActions, 'action', 'actions')} moved along`)
  }
  const movedDocuments = countOf(counts, 'moved_documents')
  if (movedDocuments > 0) {
    parts.push(`${movedDocuments} ${plural(movedDocuments, 'document', 'documents')} moved along`)
  }
  const unlinkedDocuments = countOf(counts, 'documents_unlinked')
  if (unlinkedDocuments > 0) {
    parts.push(
      `${unlinkedDocuments} ${plural(unlinkedDocuments, 'document stays', 'documents stay')} behind`,
    )
  }
  const movedClaims = countOf(counts, 'moved_claims')
  if (movedClaims > 0) {
    parts.push(`${movedClaims} knowledge ${plural(movedClaims, 'claim', 'claims')} moved`)
  }
  const renumbered = countOf(counts, 'renumbered')
  if (renumbered > 0) {
    parts.push(`${renumbered} ${plural(renumbered, 'identifier', 'identifiers')} renumbered`)
  }
  const assigneesDropped = countOf(counts, 'assignees_dropped')
  if (assigneesDropped > 0) {
    parts.push(`${assigneesDropped} ${plural(assigneesDropped, 'assignee', 'assignees')} cleared`)
  }
  const externalSevered = countOf(counts, 'external_tasks_severed')
  if (externalSevered > 0) {
    parts.push(`${externalSevered} external ${plural(externalSevered, 'link', 'links')} severed`)
  }
  const linksSevered = countOf(counts, 'links_severed')
  if (linksSevered > 0) {
    parts.push(`${linksSevered} cross-workspace ${plural(linksSevered, 'link', 'links')} removed`)
  }

  return parts.length > 0 ? `${parts.join('; ')}.` : null
}

/** Where the preflight for this entity lives, and how it's called. */
function preflightRequest(
  entityType: MoveEntityType,
  entityIds: string[],
): { url: string; init?: RequestInit } | null {
  switch (entityType) {
    case 'action':
      // POST, not GET — a bulk selection of 500 ids blows the URL length limit.
      return {
        url: '/api/account/actions/move/preflight',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_ids: entityIds }),
        },
      }
    case 'project':
      return { url: `/api/account/projects/${entityIds[0]}/move/preflight` }
    case 'document':
      return { url: `/api/account/documents/${entityIds[0]}/move/preflight` }
    case 'initiative':
      // No preflight — the disclosure below is fully static.
      return null
  }
}

/**
 * Shared "move to another workspace" dialog for actions, projects, documents,
 * and initiatives. Captures have their own copy inside capture-detail-panel.
 *
 * The preflight fetch is deliberately NON-GATING: the dialog renders and the
 * Move button works whether or not it resolves. A failed preflight only costs
 * the user the exact counts in the disclosure list — the server-side move is
 * the contract, and its response drives the success toast.
 */
export function MoveWorkspaceDialog({
  entityType,
  entityIds,
  entityLabel,
  open,
  onOpenChange,
  onMoved,
}: MoveWorkspaceDialogProps) {
  const { workspaces, currentId } = useWorkspaces()
  const switchWorkspace = useSwitchWorkspace()

  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-entity options. Both default ON — the engine's defaults match.
  const [moveDocuments, setMoveDocuments] = useState(true)
  const [moveClaims, setMoveClaims] = useState(true)

  const destinations = workspaces.filter((w) => w.id !== currentId)
  const count = entityIds.length
  const noun = ENTITY_NOUN[entityType]
  // The move endpoint (and the RPC behind it) hard-caps a batch at 500 ids;
  // surface that here instead of letting the confirm bounce off a 400.
  const overCap = entityType === 'action' && count > 500
  const title =
    count > 1
      ? `Move ${count} ${plural(count, noun, `${noun}s`)} to another workspace`
      : entityLabel
        ? `Move “${entityLabel}” to another workspace`
        : `Move ${noun} to another workspace`

  // Fetch the preflight silently on open. Same shape as the capture dialog:
  // no loading state, so the disclosure fills in without a layout-shift flash.
  useEffect(() => {
    if (!open) return
    const request = preflightRequest(entityType, entityIds)
    if (!request) return
    let cancelled = false
    fetch(request.url, request.init)
      .then(async (res) => {
        if (!res.ok) throw new Error(`preflight ${res.status}`)
        return res.json()
      })
      .then((data: Preflight) => {
        if (cancelled) return
        setPreflight(data)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[move preflight] failed:', err)
        // Non-fatal — the dialog still moves, just without counts.
      })
    return () => {
      cancelled = true
    }
    // entityIds is a fresh array on every parent render; key off its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entityType, entityIds.join(',')])

  function resetState() {
    setTargetWorkspaceId(null)
    setPreflight(null)
    setError(null)
    setMoveDocuments(true)
    setMoveClaims(true)
  }

  function moveRequest(destinationWorkspaceId: string): { url: string; body: unknown } {
    switch (entityType) {
      case 'action':
        return {
          url: '/api/account/actions/move',
          body: { action_ids: entityIds, destination_workspace_id: destinationWorkspaceId },
        }
      case 'project':
        return {
          url: `/api/account/projects/${entityIds[0]}/move`,
          body: {
            destination_workspace_id: destinationWorkspaceId,
            move_documents: moveDocuments,
          },
        }
      case 'document':
        return {
          url: `/api/account/documents/${entityIds[0]}/move`,
          body: { destination_workspace_id: destinationWorkspaceId, move_claims: moveClaims },
        }
      case 'initiative':
        return {
          url: `/api/account/initiatives/${entityIds[0]}/move`,
          body: { destination_workspace_id: destinationWorkspaceId },
        }
    }
  }

  async function handleMove() {
    if (moving || !targetWorkspaceId) return
    setMoving(true)
    setError(null)
    const destinationName =
      workspaces.find((w) => w.id === targetWorkspaceId)?.name ?? 'destination workspace'
    try {
      const { url, body } = moveRequest(targetWorkspaceId)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errorBody = (await res.json().catch(() => null)) as { error?: string } | null
        setError(errorBody?.error ?? `Move failed (${res.status})`)
        setMoving(false)
        return
      }
      const resultBody = (await res.json().catch(() => null)) as
        | { counts?: MoveCounts }
        | null
      const description = summarizeCounts(entityType, resultBody?.counts)
      toast.success(`Moved to ${destinationName}`, {
        ...(description ? { description } : {}),
        action: {
          label: 'Switch',
          onClick: () => switchWorkspace(targetWorkspaceId),
        },
      })

      // Reset before the emits — emitting a delete typically closes (and
      // unmounts) the host panel, so any state work after it is a no-op.
      setMoving(false)
      resetState()
      onOpenChange(false)

      // The entity is no longer in the active workspace, so from every surface
      // in this workspace it's indistinguishable from deleted.
      for (const id of entityIds) {
        emitEntityDeleted({ entityType, id })
        if (entityType === 'action') deleteActionCache(id)
      }
      onMoved?.(targetWorkspaceId, destinationName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed')
      setMoving(false)
    }
  }

  const actionPreflight = entityType === 'action' ? (preflight as ActionPreflight | null) : null
  const projectPreflight = entityType === 'project' ? (preflight as ProjectPreflight | null) : null
  const documentPreflight =
    entityType === 'document' ? (preflight as DocumentPreflight | null) : null
  const externalTasks =
    actionPreflight?.external_tasks ?? projectPreflight?.external_tasks ?? []

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetState()
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                Pick the destination workspace. Everything that belongs to the{' '}
                {noun} moves with it; anything tied to <em>this</em> workspace is
                translated where possible and dropped where not.
              </p>

              <ul className="ml-4 list-disc space-y-1 text-xs">
                {entityType === 'action' && (
                  <>
                    <li>
                      Identifiers are kept unless they collide in the destination — then
                      the {plural(count, 'action is', 'actions are')} renumbered.
                    </li>
                    <li>
                      Assignees translate when the person is a member of the destination,
                      otherwise the {plural(count, 'action lands', 'actions land')}{' '}
                      unassigned.
                    </li>
                    <li>
                      Labels remap by name where the destination has a match; the rest are
                      removed.
                    </li>
                    <li>Project, cycle, and package links are cleared.</li>
                    {(actionPreflight?.attachments ?? 0) > 0 && (
                      <li>
                        {actionPreflight!.attachments}{' '}
                        {plural(actionPreflight!.attachments, 'attachment moves', 'attachments move')}{' '}
                        along.
                      </li>
                    )}
                    {(actionPreflight?.crossing_relations ?? 0) > 0 && (
                      <li>
                        {actionPreflight!.crossing_relations}{' '}
                        {plural(actionPreflight!.crossing_relations, 'relation', 'relations')} to
                        actions you&rsquo;re leaving behind will be severed.
                      </li>
                    )}
                    {(actionPreflight?.agent_runs ?? 0) > 0 && (
                      <li>
                        {actionPreflight!.agent_runs} agent{' '}
                        {plural(actionPreflight!.agent_runs, 'run', 'runs')} and their logs are
                        discarded.
                      </li>
                    )}
                  </>
                )}

                {entityType === 'project' && (
                  <>
                    <li>
                      {projectPreflight
                        ? `${projectPreflight.actions} ${plural(projectPreflight.actions, 'action', 'actions')} and ${projectPreflight.milestones} ${plural(projectPreflight.milestones, 'milestone', 'milestones')} move with the project.`
                        : 'The project’s actions and milestones move with it.'}
                    </li>
                    <li>
                      Action identifiers are kept unless they collide in the destination —
                      then they&rsquo;re renumbered. Assignees translate only for people
                      who are members of the destination.
                    </li>
                    <li>
                      Labels remap by name where the destination has a match; the rest are
                      removed.
                    </li>
                    {(projectPreflight?.captures_to_unlink ?? 0) > 0 && (
                      <li>
                        {projectPreflight!.captures_to_unlink}{' '}
                        {plural(projectPreflight!.captures_to_unlink, 'capture', 'captures')} stay
                        here and lose their link to the project.
                      </li>
                    )}
                    {(projectPreflight?.views_to_delete ?? 0) > 0 && (
                      <li>
                        {projectPreflight!.views_to_delete} saved{' '}
                        {plural(projectPreflight!.views_to_delete, 'view', 'views')} scoped to
                        this project {plural(projectPreflight!.views_to_delete, 'is', 'are')}{' '}
                        deleted.
                      </li>
                    )}
                  </>
                )}

                {entityType === 'document' && (
                  <>
                    <li>
                      Comments move with the document; authors who aren&rsquo;t members of
                      the destination show as their name only.
                    </li>
                    <li>Project and folder links are cleared.</li>
                    {(documentPreflight?.shares_active ?? 0) > 0 && (
                      <li>
                        The public share link is deactivated — anyone holding the URL loses
                        access.
                      </li>
                    )}
                    {(documentPreflight?.drafts_by_others ?? 0) > 0 && (
                      <li>
                        {documentPreflight!.drafts_by_others} unpublished{' '}
                        {plural(documentPreflight!.drafts_by_others, 'draft', 'drafts')} by other
                        people {plural(documentPreflight!.drafts_by_others, 'is', 'are')}{' '}
                        discarded.
                      </li>
                    )}
                  </>
                )}

                {entityType === 'initiative' && (
                  <>
                    <li>
                      Projects under this initiative stay here and lose their link to it —
                      move them separately if you want them to follow.
                    </li>
                    <li>
                      The owner translates when they&rsquo;re a member of the destination,
                      otherwise the initiative lands unowned.
                    </li>
                    <li>
                      Labels remap by name where the destination has a match; the rest are
                      removed.
                    </li>
                    <li>Saved views scoped to this initiative are deleted.</li>
                  </>
                )}

                {externalTasks.length > 0 && (
                  <li>
                    {externalTasks.length}{' '}
                    {plural(externalTasks.length, 'action is', 'actions are')} synced to an
                    external tracker (
                    {[...new Set(externalTasks.map((t) => t.provider))].join(', ')}) — the
                    sync links are severed and the external{' '}
                    {plural(externalTasks.length, 'task', 'tasks')} stop updating.
                  </li>
                )}
              </ul>

              {entityType === 'project' && (
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <Checkbox
                    checked={moveDocuments}
                    onCheckedChange={(checked) => setMoveDocuments(checked === true)}
                    className="mt-0.5"
                  />
                  <span>
                    Also move the project&rsquo;s documents
                    {projectPreflight && projectPreflight.documents > 0 && (
                      <>
                        {' '}
                        ({projectPreflight.documents})
                      </>
                    )}
                    . Unchecked, they stay here and lose their project link.
                  </span>
                </label>
              )}

              {entityType === 'document' && (
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <Checkbox
                    checked={moveClaims}
                    onCheckedChange={(checked) => setMoveClaims(checked === true)}
                    className="mt-0.5"
                  />
                  <span>
                    Move knowledge claims evidenced only by this document
                    {documentPreflight && documentPreflight.claims.sole_sourced > 0 && (
                      <>
                        {' '}
                        ({documentPreflight.claims.sole_sourced})
                      </>
                    )}
                    {documentPreflight && documentPreflight.claims.shared > 0 && (
                      <>
                        {' '}
                        — {documentPreflight.claims.shared} with evidence from other sources{' '}
                        {plural(documentPreflight.claims.shared, 'stays', 'stay')} here
                      </>
                    )}
                    .
                  </span>
                </label>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-2">
          <Select
            value={targetWorkspaceId ?? undefined}
            onValueChange={(value) => {
              setTargetWorkspaceId(value)
              setError(null)
            }}
          >
            <SelectTrigger className="w-full" aria-label="Destination workspace">
              <span className="min-w-0 flex-1 truncate">
                {targetWorkspaceId
                  ? destinations.find((w) => w.id === targetWorkspaceId)?.name ??
                    'Select workspace…'
                  : 'Select workspace…'}
              </span>
            </SelectTrigger>
            <SelectContent>
              {destinations.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {overCap && (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Moves are capped at 500 actions at a time — narrow the selection
              and move in batches.
            </p>
          )}
          {error && (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={moving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Radix closes the dialog on action click; keep it open so the
              // inline error has somewhere to render when the move fails.
              e.preventDefault()
              void handleMove()
            }}
            disabled={moving || !targetWorkspaceId || overCap}
          >
            {moving ? 'Moving…' : count > 1 ? `Move ${count} ${noun}s` : `Move ${noun}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
