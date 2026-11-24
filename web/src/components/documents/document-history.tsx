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
 *
 * Editing sessions, the timeline and Fork (docs/plans/doc-editor-extras.md,
 * phase 4): the list groups one author's changes less than 30 minutes apart
 * into a session (lib/documents/revision-sessions.ts), the timeline under it
 * scrubs through every version oldest to newest (its full text), and "Fork into
 * a new document" copies a version into a new document in the original's
 * project, folder and visibility.
 */
import { pageTabClass } from '@/components/views/page-tabs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, GitFork, Globe, History, Loader2, RotateCcw, Undo2, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/work/presentation'
import { diffLines, diffStats, foldDiff } from '@/lib/documents/line-diff'
import { DiffFoldRow, DiffLineRow } from './diff-line-row'
import { describeRevisionAuthor, describeRevisionSources, type RevisionDetail, type RevisionSummary } from '@/lib/documents/revision-format'
import { changedSection } from '@/lib/documents/section-diff'
import { groupRevisionSessions } from '@/lib/documents/revision-sessions'
import { emitEntityCreated } from '@/lib/entity-events'
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

export interface ForkedDocument {
  id: string
  title: string
}

export function DocumentHistory({
  documentId,
  currentRevision,
  canRestore,
  onRestored,
  onForked,
}: {
  documentId: string
  /** The document's revision now; the list refreshes when it moves. */
  currentRevision: number | null
  canRestore: boolean
  onRestored: (doc: RestoredDocument) => void
  /** A version was forked into a new document (open it). Without it, Fork isn't offered. */
  onForked?: (doc: ForkedDocument) => void
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
  const [forking, setForking] = useState(false)
  // Sessions opened (or closed) by hand; the newest, and the selected one's, start open.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

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

  const sessions = useMemo(() => (revisions ? groupRevisionSessions(revisions) : []), [revisions])

  async function fork() {
    if (!detail || forking || !onForked) return
    setForking(true)
    setRestoreError(null)
    try {
      const res = await fetch(`/api/account/documents/${documentId}/revisions/${detail.revision.revision_number}/fork`, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.document?.id) throw new Error(json?.error || 'Couldn’t fork this version')
      emitEntityCreated({ entityType: 'document', id: json.document.id })
      onForked({ id: json.document.id, title: json.document.title ?? '' })
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : 'Couldn’t fork this version')
    } finally {
      setForking(false)
    }
  }

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

  function renderRow(r: RevisionSummary, nested: boolean) {
    const active = r.revision_number === selected
    const current = r.revision_number === (currentRevision ?? latest)
    const agent = r.author_kind === 'agent' || r.author_kind === 'system'
    return (
      <li key={r.revision_number} className={nested ? 'pl-3' : undefined}>
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
  }

  return (
    <div className="flex min-h-0 flex-col gap-4 py-4 sm:flex-row">
      <div className="flex shrink-0 flex-col gap-3 sm:w-64">
      <ol className="flex flex-col gap-0.5" aria-label="Versions">
        {sessions.map((session, si) => {
          if (session.revisions.length === 1) return renderRow(session.revisions[0], false)
          const holdsSelected = session.revisions.some((r) => r.revision_number === selected)
          const open = toggled[session.key] ?? (si === 0 || holdsSelected)
          const agent = session.author_kind === 'agent' || session.author_kind === 'system'
          return (
            <li key={`s:${session.key}`}>
              <button
                type="button"
                onClick={() => setToggled((t) => ({ ...t, [session.key]: !open }))}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
              >
                {open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                {agent ? <Bot className="h-3 w-3 shrink-0 text-muted-foreground" /> : <User className="h-3 w-3 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {describeRevisionAuthor(session)} · {session.revisions.length} changes
                </span>
                <span className="shrink-0 text-muted-foreground">{relativeTime(session.ended_at)}</span>
              </button>
              {open && <ol className="flex flex-col gap-0.5">{session.revisions.map((r) => renderRow(r, true))}</ol>}
            </li>
          )
        })}
      </ol>
      {revisions.length > 1 && (
        <label className="flex flex-col gap-1 px-2.5 text-xs text-muted-foreground">
          <span className="flex items-center justify-between">
            <span>Timeline</span>
            <span className="tabular-nums">{selected !== null ? `Version ${selected}` : ''}</span>
          </span>
          <input
            type="range"
            min={0}
            max={revisions.length - 1}
            step={1}
            value={Math.max(0, revisions.length - 1 - revisions.findIndex((r) => r.revision_number === selected))}
            onChange={(e) => {
              const r = revisions[revisions.length - 1 - Number(e.target.value)]
              if (!r) return
              setSelected(r.revision_number)
              setView('text')
            }}
            aria-label="Scrub through the versions, oldest to newest"
            aria-valuetext={selected !== null ? `Version ${selected}` : undefined}
            className="w-full accent-foreground"
          />
          <span className="flex justify-between text-[10px]">
            <span>Oldest</span>
            <span>Now</span>
          </span>
        </label>
      )}
      </div>

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
              {onForked && (
                <button
                  type="button"
                  onClick={fork}
                  disabled={forking}
                  title="A new document with this version’s text, in the same project, folder and visibility"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {forking ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitFork className="h-3 w-3" />}
                  Fork into a new document
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
                  aria-pressed={view === v}
                  className={pageTabClass(view === v)}
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
