'use client'

/**
 * A canvas, open: loads it, draws the surface with its floating toolbar,
 * zoom bar and inspector, and saves what changes. Mounted by the Canvases
 * page card (components/chat-cards/pages/canvases-card.tsx).
 */
import * as React from 'react'
import { ArrowLeft, Download, Loader2, Lock, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { rowToItem, type CanvasItem, type CanvasItemRow, type CanvasRecord } from '@/lib/canvas/types'
import { THEME_COLORS } from '@/lib/canvas/engine/colors'
import { ordered } from '@/lib/canvas/engine/scene'
import { cn } from '@/lib/utils'
import { CanvasContextMenu } from './canvas-context-menu'
import { readPaste, writeCopy } from './clipboard'
import { CanvasInspector } from './inspector'
import { Interaction } from './interaction'
import { CanvasStore } from './store'
import { CanvasSurface, isTyping } from './surface'
import { CanvasSync, type SaveState } from './sync'
import { CanvasToolbar } from './toolbar'
import { CanvasContext, useCanvas } from './use-canvas'
import { ZoomBar } from './zoom-bar'

export interface CanvasEditorProps {
  canvasId: string
  onBack: () => void
  onTitle?: (title: string) => void
}

interface Loaded {
  canvas: CanvasRecord
  items: CanvasItem[]
  canEdit: boolean
}

/** The palette as CSS variables, light and dark, scoped to the editor. */
const THEME_CSS = `[data-canvas-root]{${THEME_COLORS.map((c) => `--cv-${c.id}:${c.light}`).join(';')}}.dark [data-canvas-root]{${THEME_COLORS.map((c) => `--cv-${c.id}:${c.dark}`).join(';')}}`

const camKey = (id: string) => `ni.canvas.camera.${id}`

function EmptyHint() {
  const empty = useCanvas((s) => Object.keys(s.scene.items).length === 0)
  const tool = useCanvas((s) => s.tool)
  const readOnly = useCanvas((s) => s.readOnly)
  if (!empty || tool !== 'select') return null
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div data-canvas-empty className={cn(FLOATING_CARD_CLASS, 'rounded-full px-4 py-2 text-sm text-muted-foreground')}>
        {readOnly ? 'Nothing on this canvas yet.' : 'Pick a tool below to draw, or double-click to type.'}
      </div>
    </div>
  )
}

const SAVE_TEXT: Record<SaveState, string> = { saved: 'Saved', unsaved: 'Editing…', saving: 'Saving…', error: 'Not saved. Trying again…' }

function Header({
  canvas,
  canEdit,
  sync,
  onBack,
  onRename,
  onVisibility,
  onDownload,
  onDelete,
}: {
  canvas: CanvasRecord
  canEdit: boolean
  sync: CanvasSync
  onBack: () => void
  onRename: (title: string) => void
  onVisibility: (v: 'workspace' | 'private') => void
  onDownload: () => void
  onDelete: () => void
}) {
  const save = React.useSyncExternalStore(sync.subscribe, sync.getState, sync.getState)
  const [title, setTitle] = React.useState(canvas.title)
  React.useEffect(() => setTitle(canvas.title), [canvas.title])
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <div data-canvas-chrome data-canvas-header className={cn(FLOATING_CARD_CLASS, 'absolute left-4 top-4 z-20 flex h-10 max-w-[calc(100%-2rem)] items-center gap-1 px-1.5 md:max-w-[calc(100%-18rem)]')} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" aria-label="Back to canvases" onClick={onBack} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
      </button>
      <input
        ref={inputRef}
        aria-label="Canvas title"
        value={title}
        readOnly={!canEdit}
        maxLength={200}
        size={Math.max(8, Math.min(40, title.length + 1))}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          const next = title.trim() || 'Untitled canvas'
          setTitle(next)
          if (next !== canvas.title) onRename(next)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setTitle(canvas.title)
            requestAnimationFrame(() => inputRef.current?.blur())
          }
        }}
        className="h-7 min-w-0 rounded-md bg-transparent px-1.5 text-sm font-medium text-foreground outline-none hover:bg-foreground/[0.04] focus:bg-foreground/[0.06]"
      />
      {canvas.visibility === 'private' ? (
        <span className="flex shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground" title="Only you can open this canvas">
          <Lock className="h-3 w-3" /> Private
        </span>
      ) : null}
      {canEdit ? (
        <span data-canvas-save={save} aria-live="polite" className={cn('shrink-0 px-1.5 text-[11px] text-muted-foreground', save === 'error' && 'text-red-500')}>
          {SAVE_TEXT[save]}
        </span>
      ) : (
        <span className="shrink-0 px-1.5 text-[11px] text-muted-foreground">View only</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Canvas menu" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={10} className="w-56">
          {canEdit ? (
            <DropdownMenuItem onSelect={() => requestAnimationFrame(() => inputRef.current?.focus())}>
              <Pencil className="mr-2 h-4 w-4" /> Rename
            </DropdownMenuItem>
          ) : null}
          {canEdit ? (
            canvas.visibility === 'private' ? (
              <DropdownMenuItem onSelect={() => onVisibility('workspace')}>
                <Users className="mr-2 h-4 w-4" /> Share with the workspace
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onVisibility('private')}>
                <Lock className="mr-2 h-4 w-4" /> Make private
              </DropdownMenuItem>
            )
          ) : null}
          <DropdownMenuItem onSelect={onDownload}>
            <Download className="mr-2 h-4 w-4" /> Download
          </DropdownMenuItem>
          {canEdit ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={onDelete}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default function CanvasEditor({ canvasId, onBack, onTitle }: CanvasEditorProps) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  React.useEffect(() => {
    let live = true
    setLoaded(null)
    setError(null)
    fetch(`/api/account/canvases/${canvasId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 || r.status === 403 ? 'This canvas is gone, or it is not shared with you.' : 'This canvas could not be opened.')
        return (await r.json()) as { canvas: CanvasRecord; items: CanvasItemRow[]; can_edit?: boolean }
      })
      .then((j) => {
        if (!live) return
        const items = (j.items ?? []).map(rowToItem).filter((it): it is CanvasItem => !!it)
        setLoaded({ canvas: j.canvas, items, canEdit: j.can_edit !== false })
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [canvasId])

  const onTitleRef = React.useRef(onTitle)
  onTitleRef.current = onTitle
  React.useEffect(() => {
    if (loaded) onTitleRef.current?.(loaded.canvas.title)
  }, [loaded])

  // The store, the pointer logic and the save queue live as long as this canvas is open.
  const session = React.useMemo(() => {
    if (!loaded) return null
    const store = new CanvasStore(canvasId, loaded.items, { readOnly: !loaded.canEdit, grid: loaded.canvas.settings?.grid !== false })
    const interaction = new Interaction(store)
    const sync = new CanvasSync(canvasId, async (body, { keepalive }) => {
      const r = await fetch(`/api/account/canvases/${canvasId}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: keepalive && JSON.stringify(body).length < 60_000,
      })
      return r.ok
    })
    return { store, interaction, sync }
    // A reload of the same canvas makes a new session on purpose.
  }, [canvasId, loaded])

  React.useEffect(() => {
    if (!session) return
    const { store, sync } = session
    const off = store.onChange((step) => sync.push(step))
    const warn = (e: BeforeUnloadEvent) => {
      if (sync.pending) {
        void sync.flush(true)
        e.preventDefault()
      }
    }
    const hide = () => void sync.flush(true)
    window.addEventListener('beforeunload', warn)
    window.addEventListener('pagehide', hide)
    return () => {
      off()
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener('pagehide', hide)
      sync.stop()
    }
  }, [session])

  // Where the view was last time; else everything in view.
  React.useEffect(() => {
    if (!session) return
    const { store } = session
    let placed = false
    const place = () => {
      if (placed || !store.viewport.w) return
      placed = true
      let saved: { x: number; y: number; scale: number } | null = null
      try {
        saved = JSON.parse(window.localStorage.getItem(camKey(canvasId)) ?? 'null')
      } catch {
        saved = null
      }
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.scale)) store.setCamera(saved, false)
      else store.zoomToFit(false, false)
    }
    place()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = store.subscribeCamera(() => {
      place()
      if (!store.cameraTouched) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          window.localStorage.setItem(camKey(canvasId), JSON.stringify(store.camera))
        } catch {
          // Private mode: the view just is not remembered.
        }
      }, 150)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [session, canvasId])

  // Copy, cut, paste: the browser's own events, while the canvas has the focus.
  const rootRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!session) return
    const { store } = session
    let shift = false
    const key = (e: KeyboardEvent) => void (shift = e.shiftKey)
    const mine = (e: Event) => {
      const root = rootRef.current
      if (!root || isTyping(e.target) || isTyping(document.activeElement)) return false
      const surface = root.querySelector('[data-canvas-surface]')
      return !!surface && (surface.contains(document.activeElement) || document.activeElement === document.body)
    }
    const copy = (e: ClipboardEvent) => {
      if (mine(e) && writeCopy(store, e.clipboardData)) e.preventDefault()
    }
    const cut = (e: ClipboardEvent) => {
      if (!mine(e) || store.getState().readOnly) return
      if (writeCopy(store, e.clipboardData)) {
        e.preventDefault()
        store.deleteSelection()
      }
    }
    const paste = (e: ClipboardEvent) => {
      if (!mine(e) || store.getState().readOnly) return
      if (readPaste(store, e.clipboardData, shift)) e.preventDefault()
    }
    document.addEventListener('copy', copy)
    document.addEventListener('cut', cut)
    document.addEventListener('paste', paste)
    window.addEventListener('keydown', key, true)
    window.addEventListener('keyup', key, true)
    return () => {
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', cut)
      document.removeEventListener('paste', paste)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('keyup', key, true)
    }
  }, [session])

  const patch = React.useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      const r = await fetch(`/api/account/canvases/${canvasId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null
        setNotice(j?.error ?? 'That did not save.')
        return false
      }
      const j = (await r.json().catch(() => null)) as { canvas?: CanvasRecord } | null
      if (j?.canvas) setLoadedCanvas(j.canvas)
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasId],
  )
  const setLoadedCanvas = (canvas: CanvasRecord) => {
    // Only the record changed: keep the session (the same items array) so the editor stays as it is.
    recordRef.current = canvas
    forceRecord((n) => n + 1)
  }
  const recordRef = React.useRef<CanvasRecord | null>(null)
  const [, forceRecord] = React.useState(0)
  React.useEffect(() => {
    recordRef.current = loaded?.canvas ?? null
  }, [loaded])

  React.useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{error}</p>
        <button type="button" onClick={onBack} className="rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-foreground/[0.04]">
          Back to canvases
        </button>
      </div>
    )
  }
  if (!loaded || !session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening the canvas…
      </div>
    )
  }

  const canvas = recordRef.current ?? loaded.canvas
  const { store, interaction, sync } = session

  const download = () => {
    const data = { format: 'ni-canvas', version: 1, title: canvas.title, items: ordered(store.getState().base) }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${canvas.title.replace(/[^\w\- ]+/g, '').trim() || 'canvas'}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <TooltipProvider delayDuration={300}>
      <CanvasContext.Provider value={store}>
        <style>{THEME_CSS}</style>
        <div ref={rootRef} data-canvas-root className="relative h-full min-h-0 w-full overflow-hidden bg-background/40">
          <CanvasContextMenu>
            <div className="h-full w-full">
              <CanvasSurface interaction={interaction}>
                <EmptyHint />
                <Header
                  canvas={canvas}
                  canEdit={loaded.canEdit}
                  sync={sync}
                  onBack={onBack}
                  onRename={(title) => {
                    void patch({ title }).then((ok) => ok && onTitleRef.current?.(title))
                  }}
                  onVisibility={(visibility) => void patch({ visibility })}
                  onDownload={download}
                  onDelete={() => {
                    if (!window.confirm(`Delete "${canvas.title}"? It moves to the archive.`)) return
                    void fetch(`/api/account/canvases/${canvasId}`, { method: 'DELETE' }).then((r) => {
                      if (r.ok) onBack()
                      else setNotice('That canvas could not be deleted.')
                    })
                  }}
                />
                <CanvasInspector />
                <ZoomBar />
                <CanvasToolbar />
                {notice ? (
                  <div data-canvas-chrome role="status" className={cn(FLOATING_CARD_CLASS, 'absolute left-1/2 top-4 z-30 -translate-x-1/2 px-3 py-2 text-xs text-foreground')}>
                    {notice}
                  </div>
                ) : null}
              </CanvasSurface>
            </div>
          </CanvasContextMenu>
        </div>
      </CanvasContext.Provider>
    </TooltipProvider>
  )
}
