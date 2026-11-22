'use client'

/**
 * Canvases as a card (migration 676): with no canvas open, the list of the
 * workspace's canvases (title, when it changed, a private badge, a row menu to
 * rename or archive, and New canvas); with one open (`at.type === 'canvas'`),
 * the editor. The editor is another agent's component
 * (@/components/canvas/canvas-editor, default export); this card only opens it.
 *
 * Opening a canvas, and Back to the list, move the CARD the way a tab moves,
 * through usePagePlace — nothing navigates.
 */
import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Archive, MoreHorizontal, Pencil, Plus, Shapes } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { CardHeaderSlot } from '../card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '../card-header-button'
import { openCreateDialog } from '@/lib/create/open-create'
import { usePagePlace, type PageCardProps } from './page-card'

const CanvasEditor = React.lazy(() => import('@/components/canvas/canvas-editor'))

interface CanvasRow {
  id: string
  title: string
  visibility: 'workspace' | 'private'
  updated_at: string
}

export function CanvasesPageCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const openId = place.at?.type === 'canvas' ? place.at.id : null

  if (openId) {
    return (
      <div className="h-full min-h-0">
        <React.Suspense fallback={<Loading />}>
          <CanvasEditor
            canvasId={openId}
            onBack={() => place.go(null)}
            onTitle={(title) => place.go({ type: 'canvas', id: openId, label: title }, place.tab)}
          />
        </React.Suspense>
      </div>
    )
  }
  return <CanvasList onOpen={(id, title) => place.go({ type: 'canvas', id, ...(title ? { label: title } : {}) })} onCount={props.onCount} />
}

function Loading() {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
}

function CanvasList({ onOpen, onCount }: { onOpen: (id: string, title?: string) => void; onCount?: (count: number | null) => void }) {
  const [rows, setRows] = React.useState<CanvasRow[] | null>(null)
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/account/canvases')
      const json = (res.ok ? await res.json() : null) as { canvases?: CanvasRow[] } | null
      const list = json?.canvases ?? []
      setRows(list)
      onCount?.(list.length)
    } catch {
      setRows([])
      onCount?.(0)
    }
  }, [onCount])

  React.useEffect(() => {
    void load()
  }, [load])

  // New canvas opens the one Create composer on Canvas (docs/plans/create-everything.md);
  // the list takes in what is made there, and the composer opens it.
  const create = () => openCreateDialog({ type: 'canvas' })
  React.useEffect(() => {
    const onCreated = (e: Event) => {
      if ((e as CustomEvent<{ entityType?: string }>).detail?.entityType === 'canvas') void load()
    }
    window.addEventListener('ni:entity-created', onCreated)
    return () => window.removeEventListener('ni:entity-created', onCreated)
  }, [load])


  const archive = async (id: string) => {
    setMenuFor(null)
    await fetch(`/api/account/canvases/${id}`, { method: 'DELETE' }).catch(() => {})
    void load()
  }

  const rename = async (id: string, title: string) => {
    setRenaming(null)
    const next = title.trim()
    if (!next) return
    await fetch(`/api/account/canvases/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: next }) }).catch(() => {})
    void load()
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* The card's header names the page (Liam, 11-22: one title, its
          controls in the header); New canvas goes there. */}
      <CardHeaderSlot side="right">
        <button type="button" onClick={create} data-new-canvas="" className={CARD_HEADER_PILL_BUTTON}>
          <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
          New canvas
        </button>
      </CardHeaderSlot>

      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Shapes className="h-8 w-8 opacity-50" />
          <p>No canvases yet.</p>
          <button type="button" onClick={create} className="text-xs font-medium text-primary hover:underline">
            Make your first canvas
          </button>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {rows.map((c) => (
            <li key={c.id} className={`group flex items-center gap-2 px-3 py-2 ${FLOATING_CARD_CLASS}`}>
              {renaming === c.id ? (
                <input
                  autoFocus
                  defaultValue={c.title}
                  onBlur={(e) => void rename(c.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void rename(c.id, e.currentTarget.value)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
              ) : (
                <button type="button" onClick={() => onOpen(c.id, c.title)} className="flex flex-1 items-center gap-2 text-left">
                  <Shapes className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium text-foreground">{c.title}</span>
                  {c.visibility === 'private' && (
                    <span className="rounded border border-border/60 px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Private</span>
                  )}
                </button>
              )}
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{updatedLabel(c.updated_at)}</span>
              <div className="relative">
                <button
                  type="button"
                  aria-label="Canvas actions"
                  onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                  className="rounded-md p-1 text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuFor === c.id && (
                  <div className={`absolute right-0 top-8 z-10 flex w-36 flex-col py-1 ${FLOATING_CARD_CLASS}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuFor(null)
                        setRenaming(c.id)
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-background"
                    >
                      <Pencil className="h-3.5 w-3.5" /> Rename
                    </button>
                    <button type="button" onClick={() => void archive(c.id)} className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-background">
                      <Archive className="h-3.5 w-3.5" /> Archive
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function updatedLabel(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  try {
    return formatDistanceToNow(new Date(t), { addSuffix: true })
  } catch {
    return ''
  }
}

export default function CanvasesCard(props: PageCardProps) {
  return <CanvasesPageCard {...props} />
}
