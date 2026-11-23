'use client'

/**
 * Settings › Snippets (docs/plans/snippets.md): the pieces of text a person
 * types in with `;` and a few letters, in any editor. Theirs and the
 * workspace's shared ones, in one list: search, New, edit in place, delete.
 *
 * `?new=1` (the Create menu's "Snippet") opens with a new one started.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Plus, TextQuote, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { NoteEditor } from '@/app/account/(dashboard)/views/note-editor-lazy'
import { refreshSnippets, setSnippets, useSnippets } from '@/components/snippets/use-snippets'
import { FILL_IN_LABELS, SNIPPET_FILL_INS } from '@/lib/snippets/fill-ins'
import { filterSnippets } from '@/lib/snippets/match'
import { normalizeShortcut, shortcutFromName, snippetPreview, type Snippet, type SnippetVisibility } from '@/lib/snippets/types'
import { cn } from '@/lib/utils'

/** The search box shows from this many. */
const SEARCH_FROM = 8

interface Draft {
  id: string | null
  name: string
  shortcut: string
  /** The shortcut was typed (not made from the name). */
  shortcutTouched: boolean
  body: string
  visibility: SnippetVisibility
}

const NEW_DRAFT: Draft = { id: null, name: '', shortcut: '', shortcutTouched: false, body: '', visibility: 'personal' }

function draftOf(s: Snippet): Draft {
  return { id: s.id, name: s.name, shortcut: s.shortcut, shortcutTouched: true, body: s.body, visibility: s.visibility }
}

async function send(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<{ ok: boolean; error?: string; snippet?: Snippet }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = (await res.json().catch(() => ({}))) as { error?: string; snippet?: Snippet }
    return res.ok ? { ok: true, snippet: json.snippet } : { ok: false, error: json.error ?? 'Something went wrong.' }
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
}

export function SnippetsSettingsView() {
  const { snippets, loaded } = useSnippets(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Snippet | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Fresh on arrival (another tab or teammate may have changed them).
  useEffect(() => {
    void refreshSnippets().then(() => setLoadFailed(false), () => setLoadFailed(true))
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1') setDraft(NEW_DRAFT)
  }, [])

  const shown = useMemo(() => {
    const list = query.trim() ? filterSnippets(snippets, query.trim().replace(/^;/, ''), 1000) : [...snippets]
    if (!query.trim()) list.sort((a, b) => Number(b.visibility === 'personal') - Number(a.visibility === 'personal') || a.name.localeCompare(b.name))
    return list
  }, [snippets, query])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    const payload = { name: draft.name, shortcut: draft.shortcut, body: draft.body, visibility: draft.visibility }
    const r = draft.id ? await send(`/api/account/snippets/${draft.id}`, 'PATCH', payload) : await send('/api/account/snippets', 'POST', payload)
    setSaving(false)
    if (!r.ok || !r.snippet) {
      toast.error(r.error ?? 'Could not save the snippet.')
      return
    }
    const saved = r.snippet
    setSnippets([...snippets.filter((s) => s.id !== saved.id), saved])
    setDraft(null)
    toast.success(draft.id ? 'Snippet saved' : `Snippet added. Type ;${saved.shortcut} to use it.`)
  }

  const remove = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    const r = await send(`/api/account/snippets/${confirmDelete.id}`, 'DELETE')
    setDeleting(false)
    if (!r.ok) {
      toast.error(r.error ?? 'Could not delete the snippet.')
      return
    }
    setSnippets(snippets.filter((s) => s.id !== confirmDelete.id))
    if (draft?.id === confirmDelete.id) setDraft(null)
    setConfirmDelete(null)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Snippets</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Text you write again and again. Type <kbd className="rounded border bg-muted px-1 font-mono text-xs">;</kbd> and a few letters of its shortcut in any editor to put one in.
            </p>
          </div>
          {draft === null && (
            <Button size="sm" onClick={() => setDraft(NEW_DRAFT)} data-snippet-new="">
              <Plus className="mr-1 size-4" />
              New snippet
            </Button>
          )}
        </div>

        {draft && draft.id === null && (
          <SnippetForm draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onSave={save} saving={saving} canShare />
        )}

        {loadFailed && !loaded && <p className="mt-8 text-sm text-destructive">Could not load your snippets.</p>}

        {!loaded && !loadFailed && (
          <div className="mt-8 space-y-2" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}

        {loaded && snippets.length === 0 && !draft && (
          <div className="mt-8 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            No snippets yet. Make one for a signature, a standard answer, or a message you send every week.
          </div>
        )}

        {loaded && snippets.length > 0 && (
          <section className="mt-8">
            {snippets.length >= SEARCH_FROM && (
              <Input aria-label="Search snippets" placeholder={`Search ${snippets.length} snippets`} className="mb-3 h-8" value={query} onChange={(e) => setQuery(e.target.value)} />
            )}
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No snippets match.</p>
            ) : (
              <ul className="divide-y rounded-md border" data-snippet-list="">
                {shown.map((s) =>
                  draft?.id === s.id ? (
                    <li key={s.id} className="p-3">
                      <SnippetForm draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onSave={save} saving={saving} canShare={s.mine} onDelete={() => setConfirmDelete(s)} />
                    </li>
                  ) : (
                    <li key={s.id}>
                      <SnippetRow snippet={s} onEdit={s.canEdit ? () => setDraft(draftOf(s)) : undefined} onDelete={s.canEdit ? () => setConfirmDelete(s) : undefined} />
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        )}
      </div>
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.name ?? ''}”?`}
        description={
          confirmDelete?.visibility === 'workspace'
            ? `It is shared: ;${confirmDelete.shortcut} goes for everyone in the workspace. Text already written with it stays.`
            : 'Text already written with it stays.'
        }
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

function SnippetRow({ snippet, onEdit, onDelete }: { snippet: Snippet; onEdit?: () => void; onDelete?: () => void }) {
  const Icon = snippet.visibility === 'workspace' ? Users : TextQuote
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5" data-snippet-row={snippet.shortcut}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <button type="button" className="min-w-0 flex-1 text-left disabled:cursor-default" onClick={onEdit} disabled={!onEdit}>
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{snippet.name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">;{snippet.shortcut}</span>
          {snippet.visibility === 'workspace' && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Shared</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{snippetPreview(snippet.body)}</span>
      </button>
      {onEdit && (
        <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onEdit}>
          Edit
        </Button>
      )}
      {onDelete && (
        <Button variant="ghost" size="sm" className="text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onDelete}>
          Delete
        </Button>
      )}
    </div>
  )
}

function SnippetForm({
  draft,
  onChange,
  onCancel,
  onSave,
  onDelete,
  saving,
  canShare,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  onCancel: () => void
  onSave: () => void
  onDelete?: () => void
  saving: boolean
  /** Only its maker changes who sees it. */
  canShare: boolean
}) {
  const editorRef = useRef<Editor | null>(null)
  const latest = useRef(draft)
  latest.current = draft
  const ready = !!draft.name.trim() && !!draft.shortcut && !!draft.body.trim()
  const onEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor
  }, [])
  const insertFillIn = (key: string) => {
    editorRef.current?.chain().focus().insertContent(`{{${key}}}`).run()
  }
  return (
    <div
      className={cn('rounded-md', draft.id === null && 'mt-6 border p-3')}
      data-snippet-form=""
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready && !saving) {
          e.preventDefault()
          onSave()
        } else if (e.key === 'Escape' && !e.defaultPrevented) {
          onCancel()
        }
      }}
    >
      <div className="grid grid-cols-[1fr_10rem] gap-2">
        <Input
          aria-label="Name"
          placeholder="Name, e.g. Meeting follow-up"
          value={draft.name}
          autoFocus
          maxLength={80}
          onChange={(e) => {
            const name = e.target.value
            onChange({ ...latest.current, name, shortcut: latest.current.shortcutTouched ? latest.current.shortcut : shortcutFromName(name) })
          }}
        />
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">;</span>
          <Input
            aria-label="Shortcut"
            placeholder="shortcut"
            className="pl-5 font-mono"
            value={draft.shortcut}
            maxLength={32}
            onChange={(e) => onChange({ ...latest.current, shortcut: normalizeShortcut(e.target.value), shortcutTouched: true })}
          />
        </div>
      </div>
      <div className="mt-2 min-h-28 rounded-md border px-3 py-2 text-sm" data-snippet-body="">
        <NoteEditor
          key={draft.id ?? 'new'}
          initialContent={draft.body}
          onUpdate={(markdown) => onChange({ ...latest.current, body: markdown })}
          onEditorReady={onEditorReady}
          placeholder="What it puts in…"
          snippets={false}
          readAloudSections={false}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="mr-1">Fill-ins:</span>
        {SNIPPET_FILL_INS.map((key) => (
          <button
            key={key}
            type="button"
            title={FILL_IN_LABELS[key]}
            className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertFillIn(key)}
          >
            {`{{${key}}}`}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Who can use it" className="flex rounded-md border p-0.5 text-xs">
          {(['personal', 'workspace'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={draft.visibility === v}
              disabled={!canShare && draft.visibility !== v}
              onClick={() => onChange({ ...latest.current, visibility: v })}
              className={cn('rounded px-2 py-1 disabled:opacity-50', draft.visibility === v ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground')}
            >
              {v === 'personal' ? 'Only me' : 'Everyone in the workspace'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {onDelete && (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
              Delete
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={!ready || saving} data-snippet-save="">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
