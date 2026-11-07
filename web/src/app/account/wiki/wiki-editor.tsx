'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Markdown } from '@/components/ui/markdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface RenderedBlock {
  raw: string
  kind: 'claims' | 'captures' | 'links'
  data: unknown
  error?: string
}

interface Props {
  documentId: string
  publishedTitle: string
  publishedBody: string
  initialDraftBody: string | null
  draftUpdatedAt: string | null
  renderedBlocks: RenderedBlock[]
  /** Who may change it (migration 359): false = view only. */
  canEdit?: boolean
  /** The revision the page was rendered at: a new draft is based on it (migration 364). */
  publishedRevision?: number | null
}

type Mode = 'view' | 'edit' | 'diff'

/**
 * Inlines a [{...resolved data}] preview directly under each {{...}} block in
 * the markdown so the user can see what the embedded query is currently
 * resolving to. Cheap: just text replacement before handing to Markdown.
 */
function inlineRenderedBlocks(body: string, blocks: RenderedBlock[]): string {
  if (blocks.length === 0) return body
  let out = body
  for (const block of blocks) {
    const summary = summariseBlock(block)
    // Replace first occurrence only — duplicate raw tokens are rare.
    out = out.replace(
      block.raw,
      `${block.raw}\n\n> ${summary}\n`,
    )
  }
  return out
}

function summariseBlock(block: RenderedBlock): string {
  if (block.error) return `**${block.kind}** error: ${block.error}`
  const arr = Array.isArray(block.data) ? block.data : []
  if (arr.length === 0) return `**${block.kind}**: no results`
  return `**${block.kind}**: ${arr.length} result${arr.length === 1 ? '' : 's'}`
}

export function WikiEditor({
  documentId,
  publishedTitle,
  publishedBody,
  initialDraftBody,
  draftUpdatedAt,
  renderedBlocks,
  canEdit = true,
  publishedRevision = null,
}: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(canEdit && initialDraftBody !== null ? 'edit' : 'view')
  const [draftBody, setDraftBody] = useState<string>(
    initialDraftBody ?? publishedBody,
  )
  const [draftTitle, setDraftTitle] = useState<string>(publishedTitle)
  const [savingDraft, setSavingDraft] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(draftUpdatedAt)
  const [publishing, setPublishing] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasDraft = initialDraftBody !== null || draftBody !== publishedBody

  // Debounced autosave to the draft endpoint.
  const saveTimer = useRef<NodeJS.Timeout | null>(null)
  const scheduleSave = useCallback(
    (body: string, title: string, opts?: { keepError?: boolean }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        setSavingDraft(true)
        if (!opts?.keepError) setError(null)
        try {
          const res = await fetch(`/api/account/documents/${documentId}/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: body, title, ...(publishedRevision ? { base_revision: publishedRevision } : {}) }),
          })
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            throw new Error(j.error || `Save failed (${res.status})`)
          }
          const j = await res.json()
          setSavedAt(j.draft?.updated_at ?? new Date().toISOString())
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Save failed')
        } finally {
          setSavingDraft(false)
        }
      }, 600)
    },
    [documentId, publishedRevision],
  )

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const onBodyChange = (next: string) => {
    setDraftBody(next)
    scheduleSave(next, draftTitle)
  }
  const onTitleChange = (next: string) => {
    setDraftTitle(next)
    scheduleSave(draftBody, next)
  }

  const publish = async () => {
    setPublishing(true)
    setError(null)
    try {
      const post = (overwrite: boolean) =>
        fetch(`/api/account/documents/${documentId}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(overwrite ? { overwrite: true } : {}),
        })
      let res = await post(false)
      if (res.status === 409) {
        // The document changed since this draft was made (migration 364):
        // publishing would undo the newer edits, so ask first.
        const j = await res.json().catch(() => ({}))
        if (j.code !== 'STALE_DRAFT') throw new Error(j.error || 'The document changed. Try again.')
        if (!confirm(`${j.error || 'The document changed since this draft was made.'}\n\nPublish anyway? The newer edits stay in the version history.`)) return
        res = await post(true)
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Publish failed (${res.status})`)
      }
      router.refresh()
      setMode('view')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  const discard = async () => {
    if (!confirm('Discard your unpublished draft?')) return
    // A pending autosave would fire after the DELETE and bring the draft back,
    // so it is held while the DELETE runs, and re-armed if the DELETE fails
    // (the unsaved edits are still the draft).
    const hadPendingSave = saveTimer.current !== null
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    setDiscarding(true)
    setError(null)
    try {
      const res = await fetch(`/api/account/documents/${documentId}/draft`, { method: 'DELETE' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Discard failed (${res.status})`)
      }
      setDraftBody(publishedBody)
      setDraftTitle(publishedTitle)
      setSavedAt(null)
      setMode('view')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Discard failed')
      // Keep the discard error on screen when the re-armed save runs. Skip it
      // when an edit made during the DELETE already armed a newer save: this
      // closure's draftBody/draftTitle are older and would replace it.
      if (hadPendingSave && saveTimer.current === null) {
        scheduleSave(draftBody, draftTitle, { keepError: true })
      }
    } finally {
      setDiscarding(false)
    }
  }

  const inlinedBody = useMemo(
    () => inlineRenderedBlocks(publishedBody, renderedBlocks),
    [publishedBody, renderedBlocks],
  )

  if (!canEdit) {
    return (
      <div>
        <p className="mb-4 text-xs text-muted-foreground">Only the creator or an admin can edit this</p>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{inlinedBody}</Markdown>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
          <button
            onClick={() => setMode('view')}
            className={cn(
              'rounded px-2 py-1',
              mode === 'view' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            View
          </button>
          <button
            onClick={() => setMode('edit')}
            className={cn(
              'rounded px-2 py-1',
              mode === 'edit' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Edit
          </button>
          {hasDraft && (
            <button
              onClick={() => setMode('diff')}
              className={cn(
                'rounded px-2 py-1',
                mode === 'diff' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Diff
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {savingDraft && <span>Saving…</span>}
          {!savingDraft && savedAt && hasDraft && (
            <span>Draft saved {new Date(savedAt).toLocaleTimeString()}</span>
          )}
          {hasDraft && (
            <>
              <Button size="sm" variant="ghost" onClick={discard} disabled={discarding}>
                {discarding ? 'Discarding…' : 'Discard'}
              </Button>
              <Button size="sm" onClick={publish} disabled={publishing}>
                {publishing ? 'Publishing…' : 'Publish'}
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {mode === 'view' && (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <Markdown>{inlinedBody}</Markdown>
        </div>
      )}

      {mode === 'edit' && (
        <div className="space-y-3">
          <input
            value={draftTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Title"
            className="w-full border-b border-border bg-transparent pb-2 text-xl font-semibold outline-none focus:border-foreground"
          />
          <Textarea
            value={draftBody}
            onChange={(e) => onBodyChange(e.target.value)}
            rows={24}
            className="font-mono text-sm"
            placeholder="# Heading

Body in markdown. Use [[slug]] for wikilinks and {{claims: about=contact:abc}} for embedded queries."
          />
          <div className="text-xs text-muted-foreground">
            Wikilink syntax: <code>[[slug]]</code> or <code>[[slug|display]]</code>. Embedded queries:{' '}
            <code>{'{{claims: about=contact:id type=fact}}'}</code>,{' '}
            <code>{'{{captures: contact=id}}'}</code>,{' '}
            <code>{'{{links: to=project:id}}'}</code>.
          </div>
        </div>
      )}

      {mode === 'diff' && (
        <DiffView publishedBody={publishedBody} draftBody={draftBody} />
      )}
    </div>
  )
}

/**
 * Tiny diff view — line-level red/green. Good enough for v1; we can swap in a
 * real diff lib later if users ask for it.
 */
function DiffView({ publishedBody, draftBody }: { publishedBody: string; draftBody: string }) {
  const pub = publishedBody.split('\n')
  const draft = draftBody.split('\n')
  const max = Math.max(pub.length, draft.length)
  const rows: { kind: 'same' | 'remove' | 'add'; text: string }[] = []
  for (let i = 0; i < max; i++) {
    const a = pub[i]
    const b = draft[i]
    if (a === b) {
      rows.push({ kind: 'same', text: a ?? '' })
    } else {
      if (a !== undefined) rows.push({ kind: 'remove', text: a })
      if (b !== undefined) rows.push({ kind: 'add', text: b })
    }
  }
  return (
    <pre className="overflow-x-auto rounded border border-border bg-muted/30 p-3 text-xs leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap font-mono',
            r.kind === 'remove' && 'bg-red-500/10 text-red-700 dark:text-red-300',
            r.kind === 'add' && 'bg-green-500/10 text-green-700 dark:text-green-300',
          )}
        >
          <span className="select-none pr-2 text-muted-foreground">
            {r.kind === 'remove' ? '-' : r.kind === 'add' ? '+' : ' '}
          </span>
          {r.text || ' '}
        </div>
      ))}
    </pre>
  )
}
