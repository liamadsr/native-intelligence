'use client'

/**
 * A canvas, open: loads it, draws the surface with its floating toolbar,
 * zoom bar and inspector, and saves what changes. Mounted by the Canvases
 * page card (components/chat-cards/pages/canvases-card.tsx).
 */
import * as React from 'react'
import { ArrowLeft, CopyPlus, Download, SlidersHorizontal, Link2, Loader2, Lock, MoreHorizontal, Paperclip, Pencil, Trash2, Users } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CardHeaderSlot, CardHeaderTrail, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { CARD_HEADER_ICON_BUTTON } from '@/components/chat-cards/card-header-button'
import { EntityIcon } from '@/components/entities/entity-icon'
import { rowToItem, type CanvasItem, type CanvasItemRow, type CanvasRecord } from '@/lib/canvas/types'
import { THEME_COLORS } from '@/lib/canvas/engine/colors'
import { ordered } from '@/lib/canvas/engine/scene'
import { cn } from '@/lib/utils'
import { CanvasContextMenu } from './canvas-context-menu'
import { insertRecord, mediaFiles, readPaste, writeCopy } from './clipboard'
import { InsertMenu, MediaPicker, ReferencePicker, type InsertChoice } from './insert-menu'
import { insertMediaFiles, uploadTo } from './media-client'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { openTarget } from '@/lib/chat-cards/open-card'
import { toWorld } from '@/lib/canvas/engine/camera'
import { CANVAS_MEDIA_ACCEPT } from '@/lib/canvas/media'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CanvasInspector } from './inspector'
import { Interaction } from './interaction'
import { CanvasStore } from './store'
import { CanvasSurface, isTyping } from './surface'
import { CanvasSync } from './sync'
import { PeerList, PresenceRoom, PresenceSender, RemoteChanges, peerColor, type RoomClient } from './live'
import { PeerFaces, PresenceLayer, usePeers } from './presence-layer'
import { CommentPins, CommentsButton, CommentsPanel, useCanvasComments } from './comments-panel'
import { createClient } from '@/lib/supabase/client'
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

/** Narrow screens: what to do with the selection, in a row over the toolbar. */
function SelectionActions({ styleOpen, onStyle }: { styleOpen: boolean; onStyle: () => void }) {
  const store = React.useContext(CanvasContext)!
  const has = useCanvas((s) => s.selection.length > 0)
  const readOnly = useCanvas((s) => s.readOnly)
  if (!has || readOnly) return null
  const btn = 'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
  return (
    <div data-canvas-chrome data-canvas-selection-actions className="pointer-events-none absolute inset-x-0 bottom-[7.25rem] z-20 flex justify-center px-3 md:hidden">
      <div className={cn(FLOATING_CARD_CLASS, 'pointer-events-auto flex h-10 items-center gap-0.5 px-1')}>
        <button type="button" aria-pressed={styleOpen} onClick={onStyle} className={cn(btn, styleOpen && 'bg-foreground/10 text-foreground')}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> Style
        </button>
        <button type="button" onClick={store.duplicateSelection} className={btn}>
          <CopyPlus className="h-3.5 w-3.5" /> Duplicate
        </button>
        <button type="button" onClick={store.deleteSelection} className={btn}>
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
    </div>
  )
}

/**
 * What the save says: only when it went wrong. Saving runs on its own, so
 * Saved, Saving… and Editing… are not shown (Liam, 11-22: "we don't need to
 * see the save button as long as it's still happening in the background").
 */
const SAVE_ERROR_TEXT = 'Not saved. Trying again…'

function Header({
  canvas,
  canEdit,
  sync,
  onBack,
  onRename,
  onVisibility,
  onDownload,
  onCopyLink,
  onDelete,
  peers,
}: {
  canvas: CanvasRecord
  canEdit: boolean
  sync: CanvasSync
  onBack: () => void
  onRename: (title: string) => void
  onVisibility: (v: 'workspace' | 'private') => void
  onDownload: () => void
  onCopyLink: () => void
  onDelete: () => void
  peers: React.ReactNode
}) {
  const save = React.useSyncExternalStore(sync.subscribe, sync.getState, sync.getState)
  const [title, setTitle] = React.useState(canvas.title)
  React.useEffect(() => setTitle(canvas.title), [canvas.title])
  const inputRef = React.useRef<HTMLInputElement>(null)
  // In a card the title and the menu are in its header, after the page's
  // name, which is the way back to the list (Liam, 11-22: "you need to do
  // the same for canvass"): no floating header over the canvas.
  const inCard = useCardHeaderSlots() !== null
  const titleProps = {
    ref: inputRef,
    'aria-label': 'Canvas title',
    value: title,
    readOnly: !canEdit,
    maxLength: 200,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value),
    onBlur: () => {
      const next = title.trim() || 'Untitled canvas'
      setTitle(next)
      if (next !== canvas.title) onRename(next)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation()
      if (e.key === 'Enter') e.currentTarget.blur()
      if (e.key === 'Escape') {
        setTitle(canvas.title)
        requestAnimationFrame(() => inputRef.current?.blur())
      }
    },
  }
  const note = !canEdit ? (
    <span className="shrink-0 px-1.5 text-[11px] text-muted-foreground">View only</span>
  ) : save === 'error' ? (
    <span data-canvas-save={save} role="alert" className="shrink-0 px-1.5 text-[11px] text-red-500">
      {SAVE_ERROR_TEXT}
    </span>
  ) : null
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Canvas menu"
          className={inCard ? cn('grid size-7 shrink-0 place-items-center', CARD_HEADER_ICON_BUTTON) : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'}
        >
          <MoreHorizontal className={inCard ? 'size-4' : 'h-4 w-4'} strokeWidth={inCard ? 1.75 : undefined} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={inCard ? 'end' : 'start'} sideOffset={10} className="w-56">
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
        <DropdownMenuItem onSelect={onCopyLink}>
          <Link2 className="mr-2 h-4 w-4" /> Copy link to this view
        </DropdownMenuItem>
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
  )

  if (inCard) {
    return (
      <>
        <CardHeaderTrail onBack={onBack} backLabel="Back to canvases">
          <HeaderFence>
          <EntityIcon kind="canvas" size="sm" />
          {/* As wide as the title (an invisible copy sizes it), renamed in place. */}
          <span className="inline-grid min-w-0 grid-cols-[minmax(0,auto)]">
            <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre px-1 font-medium">{title || ' '}</span>
            <input
              {...titleProps}
              data-canvas-title=""
              className="col-start-1 row-start-1 w-full min-w-0 truncate rounded bg-transparent px-1 font-medium text-foreground outline-none hover:bg-foreground/[0.06] focus:bg-foreground/[0.06]"
            />
          </span>
          {canvas.visibility === 'private' && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />}
          </HeaderFence>
        </CardHeaderTrail>
        <CardHeaderSlot side="right">
          <HeaderFence>
            <div data-canvas-header-controls="" className="flex items-center gap-1">
              {peers}
              {note}
              {menu}
            </div>
          </HeaderFence>
        </CardHeaderSlot>
      </>
    )
  }

  return (
    <div data-canvas-chrome data-canvas-header className={cn(FLOATING_CARD_CLASS, 'absolute left-4 top-4 z-20 flex h-10 max-w-[calc(100%-2rem)] items-center gap-1 px-1.5 md:max-w-[calc(100%-18rem)]')} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" aria-label="Back to canvases" onClick={onBack} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
      </button>
      <input
        {...titleProps}
        size={Math.max(8, Math.min(40, title.length + 1))}
        className="h-7 min-w-0 rounded-md bg-transparent px-1.5 text-sm font-medium text-foreground outline-none hover:bg-foreground/[0.04] focus:bg-foreground/[0.06]"
      />
      {canvas.visibility === 'private' ? (
        <span className="flex shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground" title="Only you can open this canvas">
          <Lock className="h-3 w-3" /> Private
        </span>
      ) : null}
      {peers}
      {note}
      {menu}
    </div>
  )
}

/**
 * What the canvas puts in its card's header, fenced off from the canvas: a
 * portal's events bubble to its React parents, and the header's parent here is
 * the surface, whose presses draw, select and type (surface.tsx skips only
 * targets inside `[data-canvas-chrome]` in the DOM, which the header is not).
 * So a press on the title or the menu stops here, as the floating header's do.
 */
export function HeaderFence({ children }: { children: React.ReactNode }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <span data-canvas-header-fence="" className="contents" onPointerDown={stop} onPointerUp={stop} onDoubleClick={stop} onContextMenu={stop}>
      {children}
    </span>
  )
}

export default function CanvasEditor({ canvasId, onBack, onTitle }: CanvasEditorProps) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  /** The record as last saved from here (a rename, a change of who sees it). */
  const [record, setRecord] = React.useState<CanvasRecord | null>(null)

  React.useEffect(() => {
    let live = true
    setLoaded(null)
    setRecord(null)
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

  // Other people on the same canvas: their saved changes, and where they are.
  const [peerList, setPeerList] = React.useState<PeerList | null>(null)
  const presence = React.useRef<PresenceSender | null>(null)
  React.useEffect(() => {
    if (!session) return
    const { store, interaction, sync } = session
    const supabase = createClient()
    const remote = new RemoteChanges(canvasId, {
      busy: () => interaction.active || store.getState().scene !== store.getState().base,
      pending: sync.isPending,
      apply: (put, remove) => store.applyRemote(put, remove),
    })
    sync.setOnSent((rows, removed) => remote.noteSent(rows, removed))
    type Change = { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: Record<string, unknown> | null; old: Record<string, unknown> | null }
    const rows = supabase
      .channel(`canvas-items:${canvasId}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'canvas_item', filter: `canvas_id=eq.${canvasId}` }, (p: Change) => remote.onRow('INSERT', p.new, null))
      .on('postgres_changes' as any, { event: 'UPDATE', schema: 'public', table: 'canvas_item', filter: `canvas_id=eq.${canvasId}` }, (p: Change) => remote.onRow('UPDATE', p.new, p.old))
      // A delete cannot be filtered by the server; RemoteChanges checks it is this canvas's.
      .on('postgres_changes' as any, { event: 'DELETE', schema: 'public', table: 'canvas_item' }, (p: Change) => remote.onRow('DELETE', null, p.old))
      .subscribe()

    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const peers = new PeerList(key)
    setPeerList(peers)
    // Who else is here. A private room: the server lets in only whoever may
    // open this canvas (migration 682). If it refuses, nobody else is shown.
    let sender: PresenceSender | null = null
    let live = true
    let me: { key: string; userId: string; name: string; color: string } | null = null
    const room = new PresenceRoom(supabase as unknown as RoomClient, canvasId, {
      hear: (payload) => peers.hear(payload, Date.now()),
      open: () => {
        if (!live || !me || sender) return
        sender = new PresenceSender(me, (payload) => room.send(payload))
        presence.current = sender
        sender.start()
        sender.update({ selection: [...store.getState().selection] })
      },
      closed: () => {
        sender?.stop()
        sender = null
        presence.current = null
      },
    })
    void supabase.auth.getUser().then(({ data }) => {
      const user = data.user
      if (!live || !user) return
      const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string }
      const name = (meta.full_name || meta.name || user.email?.split('@')[0] || 'Someone').slice(0, 60)
      me = { key, userId: user.id, name, color: peerColor(user.id) }
      room.start()
    })
    let lastSelection = store.getState().selection
    const offSelection = store.subscribe(() => {
      const sel = store.getState().selection
      if (sel !== lastSelection) {
        lastSelection = sel
        presence.current?.update({ selection: [...sel] })
      }
    })
    const prune = setInterval(() => peers.prune(Date.now()), 2000)
    return () => {
      live = false
      clearInterval(prune)
      offSelection()
      sync.setOnSent(null)
      remote.stop()
      sender?.stop()
      presence.current = null
      setPeerList(null)
      room.stop()
      void supabase.removeChannel(rows)
    }
  }, [session, canvasId])
  const peers = usePeers(peerList)
  const comments = useCanvasComments(canvasId)
  const [commentsOpen, setCommentsOpen] = React.useState(false)
  const [commentFocus, setCommentFocus] = React.useState<string | null>(null)

  // Where the view was last time; else everything in view.
  React.useEffect(() => {
    if (!session) return
    const { store } = session
    let placed = false
    const place = () => {
      if (placed || !store.viewport.w) return
      placed = true
      let saved: { x: number; y: number; scale: number } | null = null
      // A shared link carries the view it was copied at: the canvas point in the middle, and the zoom.
      // The app has already taken `canvas=<id>` off the address by now; these three are ours to
      // read once and take off, so they never land on another canvas opened later.
      const params = new URLSearchParams(window.location.search)
      if (params.has('cx') && params.has('cy') && params.has('cz')) {
        const cx = Number(params.get('cx'))
        const cy = Number(params.get('cy'))
        const cz = Number(params.get('cz'))
        if ([cx, cy, cz].every(Number.isFinite) && cz > 0) saved = { scale: cz, x: store.viewport.w / 2 - cx * cz, y: store.viewport.h / 2 - cy * cz }
        for (const k of ['cx', 'cy', 'cz']) params.delete(k)
        const rest = params.toString()
        window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash)
      }
      try {
        saved = saved ?? JSON.parse(window.localStorage.getItem(camKey(canvasId)) ?? 'null')
      } catch {
        saved = saved ?? null
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

  // Files onto the canvas, from a paste, a drop or the picker.
  const addFiles = React.useCallback(
    async (files: File[], at: { x: number; y: number }) => {
      if (!session) return
      const refused = await insertMediaFiles(session.store, files, at, uploadTo(canvasId))
      if (refused.length) setNotice(refused[0])
    },
    [session, canvasId],
  )
  const [insertAt, setInsertAt] = React.useState<{ x: number; y: number } | null>(null)
  const [panel, setPanel] = React.useState<'media' | 'reference' | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const [styleSheet, setStyleSheet] = React.useState(false)
  /** Where the next inserted thing goes: where the menu was opened. */
  const insertWorld = React.useRef<{ x: number; y: number } | null>(null)

  React.useEffect(() => {
    if (!session) return
    const { store } = session
    store.setHooks({
      notify: setNotice,
      openRecord: (ref) => {
        const target = entityOpenTarget(ref.type, ref.id, ref.label ?? null)
        if (!target || !openTarget(target, { from: 'canvas' })) setNotice('That record cannot be opened from here.')
      },
      openInsert: (at) => {
        insertWorld.current = toWorld(store.camera, at)
        setInsertAt(at)
      },
    })
    return () => store.setHooks({ notify: null, openRecord: null, openInsert: null })
  }, [session])

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
      const files = mediaFiles(e.clipboardData)
      if (files.length) {
        e.preventDefault()
        void addFiles(files, store.viewCenter())
        return
      }
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
  }, [session, addFiles])

  const patch = React.useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      const r = await fetch(`/api/account/canvases/${canvasId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null
        setNotice(j?.error ?? 'That did not save.')
        return false
      }
      const j = (await r.json().catch(() => null)) as { canvas?: CanvasRecord } | null
      // Only the record changed: the session (and so the editor) stays as it is.
      if (j?.canvas) setRecord(j.canvas)
      return true
    },
    [canvasId],
  )

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

  const canvas = record ?? loaded.canvas
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

  const refocus = () => rootRef.current?.querySelector<HTMLElement>('[data-canvas-surface]')?.focus({ preventScroll: true })
  const pickInsert = (choice: InsertChoice) => {
    setInsertAt(null)
    if (choice === 'upload') fileInput.current?.click()
    else setPanel(choice)
  }
  const copyLink = () => {
    const c = store.viewCenter()
    const url = `${window.location.origin}/account?canvas=${canvasId}&cx=${Math.round(c.x)}&cy=${Math.round(c.y)}&cz=${Number(store.camera.scale.toFixed(3))}`
    void navigator.clipboard.writeText(url).then(
      () => setNotice('Link copied. It opens on this view.'),
      () => setNotice(url),
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <CanvasContext.Provider value={store}>
        <style>{THEME_CSS}</style>
        <div
          ref={rootRef}
          data-canvas-root
          className="relative h-full min-h-0 w-full overflow-hidden bg-background/40"
          onPointerMoveCapture={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            presence.current?.update({ cursor: toWorld(store.camera, { x: e.clientX - rect.left, y: e.clientY - rect.top }) })
          }}
          onPointerLeave={() => presence.current?.update({ cursor: null })}
          onDragOver={(e) => {
            if (loaded.canEdit && [...e.dataTransfer.types].includes('Files')) e.preventDefault()
          }}
          onDrop={(e) => {
            if (!loaded.canEdit) return
            const files = mediaFiles(e.dataTransfer)
            if (!files.length) return
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            void addFiles(files, toWorld(store.camera, { x: e.clientX - rect.left, y: e.clientY - rect.top }))
          }}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={CANVAS_MEDIA_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length) void addFiles(files, insertWorld.current ?? store.viewCenter())
              refocus()
            }}
          />
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
                  onCopyLink={copyLink}
                  peers={
                    <>
                      <PeerFaces peers={peers} />
                      <CommentsButton comments={comments} pressed={commentsOpen} onClick={() => setCommentsOpen((v) => !v)} />
                    </>
                  }
                  onDelete={() => {
                    if (!window.confirm(`Delete "${canvas.title}"? It moves to the archive.`)) return
                    void fetch(`/api/account/canvases/${canvasId}`, { method: 'DELETE' }).then((r) => {
                      if (r.ok) onBack()
                      else setNotice('That canvas could not be deleted.')
                    })
                  }}
                />
                <PresenceLayer peers={peers} />
                <CommentPins
                  comments={comments}
                  onOpen={(id) => {
                    setCommentFocus(id)
                    setCommentsOpen(true)
                  }}
                />
                {commentsOpen ? <CommentsPanel comments={comments} focus={commentFocus} onFocus={setCommentFocus} onClose={() => setCommentsOpen(false)} /> : <CanvasInspector sheet={styleSheet} />}
                <SelectionActions styleOpen={styleSheet} onStyle={() => setStyleSheet((v) => !v)} />
                <ZoomBar />
                <CanvasToolbar
                  extra={
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Attach"
                          data-canvas-attach
                          onClick={(e) => {
                            const root = rootRef.current!.getBoundingClientRect()
                            const b = e.currentTarget.getBoundingClientRect()
                            store.openInsert?.({ x: b.left + b.width / 2 - root.left, y: b.top - root.top - 60 })
                            insertWorld.current = store.viewCenter()
                          }}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                        >
                          <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={8}>
                        Attach<span className="ml-2 text-muted-foreground">I</span>
                      </TooltipContent>
                    </Tooltip>
                  }
                />
                {insertAt ? (
                  <InsertMenu
                    at={insertAt}
                    bounds={store.viewport}
                    onPick={pickInsert}
                    onClose={() => {
                      setInsertAt(null)
                      refocus()
                    }}
                  />
                ) : null}
                {panel === 'media' ? (
                  <MediaPicker
                    onClose={() => {
                      setPanel(null)
                      refocus()
                    }}
                    onFiles={(files) => {
                      setPanel(null)
                      void addFiles(files, insertWorld.current ?? store.viewCenter())
                      refocus()
                    }}
                  />
                ) : null}
                {panel === 'reference' ? (
                  <ReferencePicker
                    canvasId={canvasId}
                    onClose={() => {
                      setPanel(null)
                      refocus()
                    }}
                    onPick={(ref) => {
                      setPanel(null)
                      insertRecord(store, ref, insertWorld.current ?? store.viewCenter())
                      refocus()
                    }}
                  />
                ) : null}
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
