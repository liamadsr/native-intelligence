'use client'

/**
 * The `#` menu: the tags that match what's typed after `#` (yours marked), and
 * a last row to make a new one. Making one asks two things: its color and
 * whether it is shared with the workspace or yours alone (shared unless you
 * say otherwise). Picking either puts the pill in the text (TagSuggestion).
 *
 * Mounted once per editor, beside it. Draws nothing while no `#` is open.
 * Keys: ↑ ↓ move, ↵ or tab pick, Esc close. An empty `#` takes ↵ only after an
 * arrow was used, so `#` then Enter is still just a new line.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import type { LabelScope, LabelWithScope } from '@/lib/labels/utils'
import { createTag } from '@/lib/tags/client'
import { tagColorStore } from '@/lib/tags/color-store'
import { normalizeTagName, sameTagName } from '@/lib/tags/names'
import { nextTagColor, TAG_COLORS } from '@/lib/tags/palette'
import type { PickedTag, TagSuggestionStore } from './tag-suggestion'

const MAX_ROWS = 8
const MENU_WIDTH = 260
const noState = () => null

export interface TagMenuRow {
  kind: 'tag' | 'create'
  tag?: LabelWithScope
  name: string
}

/** The rows for a query: tags whose name starts with it first, then ones containing it; then Create. */
export function tagMenuRows(tags: readonly LabelWithScope[], query: string): TagMenuRow[] {
  const q = query.trim().toLowerCase()
  const starts: LabelWithScope[] = []
  const contains: LabelWithScope[] = []
  for (const t of tags) {
    const n = t.name.toLowerCase()
    if (!q || n.startsWith(q)) starts.push(t)
    else if (n.includes(q)) contains.push(t)
  }
  const rows: TagMenuRow[] = [...starts, ...contains].slice(0, MAX_ROWS).map((tag) => ({ kind: 'tag', tag, name: tag.name }))
  const name = normalizeTagName(query)
  if (name && !tags.some((t) => sameTagName(t.name, name))) rows.push({ kind: 'create', name })
  return rows
}

export function TagMenu({ store, scope }: { store: TagSuggestionStore; scope?: LabelScope }) {
  const state = useSyncExternalStore(store.subscribe, store.get, noState)
  const { labels } = useScopedLabels(scope)
  const [active, setActive] = useState(0)
  const [moved, setMoved] = useState(false)
  const [creating, setCreating] = useState<{ name: string; color: string; personal: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const query = state?.query ?? ''

  useEffect(() => {
    tagColorStore.put(labels)
  }, [labels])

  const rows = useMemo(() => tagMenuRows(labels, query), [labels, query])

  // A new query starts at the top, out of the create step.
  useEffect(() => {
    setActive(0)
    setMoved(false)
    setCreating(null)
  }, [query, state === null])

  const pickRef = useRef<(row: TagMenuRow) => void>(() => {})
  const confirmRef = useRef<() => void>(() => {})

  pickRef.current = (row) => {
    if (!state) return
    if (row.kind === 'tag' && row.tag) {
      state.pick({ id: row.tag.id, name: row.tag.name, color: row.tag.color })
      return
    }
    setCreating({ name: row.name, color: nextTagColor(row.name, labels.map((l) => l.color)), personal: false })
  }

  confirmRef.current = () => {
    if (!state || !creating || busy) return
    const pick = state.pick
    setBusy(true)
    createTag(creating)
      .then((label) => pick({ id: label.id, name: label.name, color: label.color } satisfies PickedTag))
      .catch((err: Error) => toast.error(err.message || 'Could not create the tag'))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    store.setKeys((e) => {
      const current = store.get()
      if (!current) return false
      if (creating) {
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          confirmRef.current()
          return true
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const i = TAG_COLORS.indexOf(creating.color as (typeof TAG_COLORS)[number])
          const next = TAG_COLORS[(i + (e.key === 'ArrowRight' ? 1 : TAG_COLORS.length - 1)) % TAG_COLORS.length]
          setCreating({ ...creating, color: next })
          return true
        }
        return false
      }
      if (rows.length === 0) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setMoved(true)
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (!current.query && !moved) return false
        pickRef.current(rows[Math.min(active, rows.length - 1)])
        return true
      }
      return false
    })
    return () => store.setKeys(null)
  }, [store, rows, active, moved, creating])

  if (!state || (rows.length === 0 && !creating)) return null

  const left = Math.max(8, Math.min(state.rect.left, window.innerWidth - MENU_WIDTH - 8))
  const below = state.rect.bottom + 4
  const style: React.CSSProperties = { position: 'fixed', left, top: below, width: MENU_WIDTH, zIndex: 60 }

  return createPortal(
    <div
      role="listbox"
      aria-label="Tags"
      data-tag-menu=""
      style={style}
      className="rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      {creating ? (
        <div className="space-y-2 p-2">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: creating.color }} />
            <span className="truncate font-medium">#{creating.name}</span>
          </div>
          <div className="grid grid-cols-8 gap-1" role="radiogroup" aria-label="Color">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={creating.color === c}
                aria-label={c}
                onClick={() => setCreating({ ...creating, color: c })}
                className={cn('h-5 w-5 rounded-full border-2', creating.color === c ? 'border-foreground' : 'border-transparent')}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <div className="flex rounded-md border p-0.5 text-xs" role="radiogroup" aria-label="Who sees it">
            {[
              { personal: false, label: 'Workspace' },
              { personal: true, label: 'Only me' },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                role="radio"
                aria-checked={creating.personal === opt.personal}
                onClick={() => setCreating({ ...creating, personal: opt.personal })}
                className={cn(
                  'flex-1 rounded px-2 py-1',
                  creating.personal === opt.personal ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => confirmRef.current()}
            className="w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Create tag'}
          </button>
        </div>
      ) : (
        rows.map((row, i) => (
          <div
            key={row.kind === 'tag' ? row.tag!.id : `create:${row.name}`}
            role="option"
            aria-selected={i === active}
            data-tag-menu-row={row.kind}
            onMouseEnter={() => setActive(i)}
            onClick={() => pickRef.current(row)}
            className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5', i === active && 'bg-accent')}
          >
            {row.kind === 'tag' ? (
              <>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.tag!.color }} />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.tag!.personal && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Only you" />}
              </>
            ) : (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                Create <span className="text-foreground">#{row.name}</span>
              </span>
            )}
          </div>
        ))
      )}
    </div>,
    document.body,
  )
}
