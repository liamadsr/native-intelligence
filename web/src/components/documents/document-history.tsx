'use client'

/**
 * A document's version history (documents phase 1, item 2): every change to
 * its title or body, newest first, with who it was for (a person, Native Intelligence for a
 * person, or the system) and what it did. Pick one to see what that change
 * did (a line diff against the version before it) or its full text, and put
 * it back with Restore: the restore is a new version, so it can be undone the
 * same way. History rows are written by the database (migration 364); this
 * only reads them and calls the restore route.
 *
 * "Revert just this edit" (canon D2, decision 16): an edit that touched one
 * section (the one it recorded, migration 376, or the one its diff shows) can
 * be undone alone: that section goes back to how it was before it, and every
 * later edit to other sections stays. It is a new version too.
 *
 * An agent's edit applies at once (decision 16: no approval card), so this is
 * where it is checked: each shows what it came from (a kind and a domain,
 * never an address), and one that rested on untrusted outside text carries a
 * quiet "from a web page" label on its row, so it is easy to spot and undo.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Globe, History, Loader2, RotateCcw, Undo2, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/work/presentation'
import { diffLines, diffStats, foldDiff } from '@/lib/documents/line-diff'
import { DiffFoldRow, DiffLineRow } from './diff-line-row'
import { describeRevisionAuthor, describeRevisionSources, type RevisionDetail, type RevisionSummary } from '@/lib/documents/revision-format'
import { changedSection } from '@/lib/documents/section-diff'
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

export interface RestoredDocument {
  title: string | null
  content: string | null
  revision: number
}

export function DocumentHistory({
  documentId,
  currentRevision,
  canRestore,
  onRestored,
}: {
  documentId: string
  /** The document's revision now; the list refreshes when it moves. */
  currentRevision: number | null
  canRestore: boolean
  onRestored: (doc: RestoredDocument) => void
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ revision: RevisionDetail; previous: RevisionDetail | null } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [view, setView] = useState<'changes' | 'text'>('changes')
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)

  const loadList = useCallback(() => {
    fetch(`/api/account/documents/${documentId}/revisions?limit=50`)
      .then(async (r) => {
        const json = await r.json().catch(() => null)
        if (!r.ok) throw new Error(json?.error || 'Couldn’t load the history')
        setRevisions(json?.revisions ?? [])
        setListError(null)
      })
      .catch((e) => setListError(e instanceof Error ? e.message : 'Couldn’t load the history'))
  }, [documentId])

  // Reload whenever the document moves on (a save, an agent's edit, a restore).
  useEffect(() => {
    loadList()
  }, [loadList, currentRevision])

  // Open the newest entry by default.
  useEffect(() => {
    if (selected === null && revisions && revisions.length > 0) setSelected(revisions[0].revision_number)
  }, [revisions, selected])

  useEffect(() => {
    if (selected === null) return
    let cancelled = false
    setDetailLoading(true)
    setRestoreError(null)
    fetch(`/api/account/documents/${documentId}/revisions/${selected}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled) return
        setDetail(json?.revision ? { revision: json.revision, previous: json.previous ?? null } : null)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, selected])

  const diff = useMemo(() => {
    if (!detail?.previous) return null
    const lines = diffLines(detail.previous.content ?? '', detail.revision.content ?? '')
    return { stats: diffStats(lines), rows: foldDiff(lines, 3) }
  }, [detail])

  // The one section this change touched, when it touched just one: what
  // "Revert just this edit" puts back (the server applies the same rule).
  const revertSection = useMemo(() => {
    if (!detail?.previous || !detail.revision.author_kind) return null
    return detail.revision.section ?? changedSection(detail.previous.content ?? '', detail.revision.content ?? '')
  }, [detail])

  const detailSources = detail ? describeRevisionSources(detail.revision.sources) : null

  async function revertEdit() {
    if (!detail || reverting) return
    setReverting(true)
    setRestoreError(null)
    try {
      const res = await fetch(`/api/account/documents/${documentId}/revisions/${detail.revision.revision_number}/revert-section`, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Couldn’t revert this edit')
      setSelected(null)
      onRestored(json.document as RestoredDocument)
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : 'Couldn’t revert this edit')
    } finally {
      setReverting(false)
    }
  }

  async function restore() {
    if (!detail || restoring) return
    setRestoring(true)
    setRestoreError(null)
    try {
      const res = await fetch(`/api/account/documents/${documentId}/revisions/${detail.revision.revision_number}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentRevision ? { base_revision: currentRevision } : {}),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Couldn’t restore this version')
      setConfirming(false)
      setSelected(null)
      onRestored(json.document as RestoredDocument)
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : 'Couldn’t restore this version')
    } finally {
      setRestoring(false)
    }
  }

  if (listError) return <p className="py-8 text-center text-sm text-muted-foreground">{listError}</p>
  if (!revisions) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (revisions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <History className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No changes yet. Every edit from here on, yours or Native Intelligence’s, shows up here.</p>
      </div>
    )
  }

  const latest = revisions[0].revision_number
  const isCurrent = detail ? detail.revision.revision_number === (currentRevision ?? latest) : false

  return (
    <div className="flex min-h-0 flex-col gap-4 py-4 sm:flex-row">
      <ol className="flex shrink-0 flex-col gap-0.5 sm:w-64" aria-label="Versions">
        {revisions.map((r) => {
          const active = r.revision_number === selected
          const current = r.revision_number === (currentRevision ?? latest)
          const agent = r.author_kind === 'agent' || r.author_kind === 'system'
          return (
            <li key={r.revision_number}>
              <button
                type="button"
                onClick={() => setSelected(r.revision_number)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
                  active ? 'bg-muted' : 'hover:bg-muted/50',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs">
                  {agent ? <Bot className="h-3 w-3 shrink-0 text-muted-foreground" /> : <User className="h-3 w-3 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{describeRevisionAuthor(r)}</span>
                  <span className="shrink-0 text-muted-foreground">{relativeTime(r.updated_at)}</span>
                </span>
                <span className="flex items-center gap-1.5 pl-[18px] text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{r.change_summary || (r.author_kind ? 'Edited' : 'Before history began')}</span>
                  {current && <span className="shrink-0 rounded bg-foreground/10 px-1 text-[10px] font-medium text-foreground">Current</span>}
                </span>
                {r.outside && (
                  <span className="flex items-center gap-1 pl-[18px] text-[11px] text-muted-foreground" data-testid="revision-outside">
                    <Globe className="h-2.5 w-2.5 shrink-0" />
                    <span className="min-w-0 truncate">from {r.outside}</span>
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>

      <div className="min-w-0 flex-1">
        {detailLoading && !detail ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : detail ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium text-foreground">
                  Version {detail.revision.revision_number}
                  <span className="font-normal text-muted-foreground">
                    {' · '}
                    {describeRevisionAuthor(detail.revision)} ·{' '}
                    {new Date(detail.revision.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                </p>
                {detail.revision.change_summary && <p className="text-xs text-muted-foreground">{detail.revision.change_summary}</p>}
                {detail.revision.reason && <p className="text-xs text-muted-foreground">Why: {detail.revision.reason}</p>}
                {detailSources && <p className="text-xs text-muted-foreground">From {detailSources}</p>}
                {detail.revision.outside && (
                  <p className="text-xs text-muted-foreground" data-testid="revision-outside-detail">
                    {detailSources?.includes(detail.revision.outside) ? 'It rests on outside text' : `It rests on ${detail.revision.outside}`}: revert it if it’s wrong.
                  </p>
                )}
              </div>
              {canRestore && revertSection && (
                <button
                  type="button"
                  onClick={revertEdit}
                  disabled={reverting}
                  title={`Puts ${revertSection} back as it was before this edit; other sections stay as they are`}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {reverting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                  Revert just this edit
                </button>
              )}
              {canRestore && !isCurrent && (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  <RotateCcw className="h-3 w-3" />
                  Restore this version
                </button>
              )}
            </div>
            {restoreError && (
              <p role="alert" className="text-xs text-destructive">
                {restoreError}
              </p>
            )}

            <div className="flex items-center gap-1 text-xs">
              {(['changes', 'text'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 transition-colors',
                    view === v ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {v === 'changes' ? 'Changes' : 'Full text'}
                </button>
              ))}
              {view === 'changes' && diff && (
                <span className="ml-2 text-muted-foreground">
                  <span className="text-emerald-600 dark:text-emerald-400">+{diff.stats.added}</span>{' '}
                  <span className="text-rose-600 dark:text-rose-400">−{diff.stats.removed}</span> lines
                </span>
              )}
            </div>

            {view === 'changes' && diff ? (
              <div className="overflow-x-auto rounded-md border border-border font-mono text-xs leading-5">
                {diff.rows.length === 0 || (diff.stats.added === 0 && diff.stats.removed === 0) ? (
                  <p className="px-3 py-2 font-sans text-muted-foreground">Only the title changed.</p>
                ) : (
                  diff.rows.map((row, i) =>
                    row.kind === 'fold' ? (
                      <DiffFoldRow key={i}>
                        {row.count} unchanged line{row.count === 1 ? '' : 's'}
                      </DiffFoldRow>
                    ) : (
                      <DiffLineRow key={i} kind={row.kind} text={row.text} />
                    ),
                  )
                )}
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-sm leading-6">
                {view === 'changes' && <p className="mb-2 text-xs text-muted-foreground">The first version in the history: nothing to compare it with.</p>}
                {detail.revision.content || <span className="text-muted-foreground">(empty)</span>}
              </div>
            )}
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">That version is no longer in the history.</p>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore version {detail?.revision.revision_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              The document goes back to this version. That is saved as a new version, so the current text stays in the history and you can
              restore it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={restore} disabled={restoring}>
              {restoring ? 'Restoring…' : 'Restore'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
