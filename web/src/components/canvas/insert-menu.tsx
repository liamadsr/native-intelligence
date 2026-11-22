'use client'

/**
 * The insert menu (I, or the paperclip): three buttons around the pointer.
 * Move toward one, or use the arrows, and press Enter or click. Media opens a
 * drop zone; Upload media goes straight to the file picker; Reference finds a
 * record to place as a card.
 */
import * as React from 'react'
import { FileSearch, ImagePlus, Images, Loader2, Upload, X, type LucideIcon } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { EntityIcon } from '@/components/entities/entity-icon'
import { CANVAS_MEDIA_ACCEPT, CANVAS_MEDIA_MAX_LABEL } from '@/lib/canvas/media'
import { menuRowId, menuRowTarget, type MenuSearchResponse, type MenuSearchRow } from '@/lib/search/menu-search'
import { cn } from '@/lib/utils'

export type InsertChoice = 'media' | 'upload' | 'reference'

const CHOICES: ReadonlyArray<{ id: InsertChoice; label: string; icon: LucideIcon; dx: number; dy: number }> = [
  { id: 'media', label: 'Media', icon: Images, dx: 0, dy: -70 },
  { id: 'upload', label: 'Upload media', icon: Upload, dx: -92, dy: 34 },
  { id: 'reference', label: 'Reference', icon: FileSearch, dx: 92, dy: 34 },
]

export function InsertMenu({ at, bounds, onPick, onClose }: { at: { x: number; y: number }; bounds: { w: number; h: number }; onPick: (choice: InsertChoice) => void; onClose: () => void }) {
  const [active, setActive] = React.useState(0)
  // Keep the whole ring on screen.
  const cx = Math.min(Math.max(at.x, 150), Math.max(150, bounds.w - 150))
  const cy = Math.min(Math.max(at.y, 110), Math.max(110, bounds.h - 90))
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => ref.current?.focus({ preventScroll: true }), [])
  return (
    <div
      ref={ref}
      data-canvas-chrome
      data-canvas-insert
      role="menu"
      aria-label="Insert"
      tabIndex={-1}
      className="absolute inset-0 z-30 outline-none"
      onPointerDown={(e) => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onClose()
      }}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const dx = e.clientX - rect.left - cx
        const dy = e.clientY - rect.top - cy
        if (Math.hypot(dx, dy) < 14) return
        // The button whose direction is nearest the pointer's.
        let best = 0
        let bestDot = -Infinity
        CHOICES.forEach((c, i) => {
          const dot = (dx * c.dx + dy * c.dy) / (Math.hypot(dx, dy) * Math.hypot(c.dx, c.dy))
          if (dot > bestDot) {
            bestDot = dot
            best = i
          }
        })
        setActive(best)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        const n = CHOICES.length
        if (e.key === 'Escape') onClose()
        else if (e.key === 'Enter' || e.key === ' ') onPick(CHOICES[active].id)
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'j')) setActive((a) => (a + 1) % n)
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'k')) setActive((a) => (a + n - 1) % n)
        else return
        e.preventDefault()
      }}
      onKeyUp={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {CHOICES.map((c, i) => {
        const Icon = c.icon
        return (
          <button
            key={c.id}
            type="button"
            role="menuitem"
            data-canvas-insert-choice={c.id}
            aria-current={i === active}
            onClick={() => onPick(c.id)}
            onPointerEnter={() => setActive(i)}
            className={cn(
              FLOATING_CARD_CLASS,
              'absolute flex h-9 -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-sm text-muted-foreground transition-colors',
              i === active && 'border-primary/50 text-foreground ring-2 ring-primary/30',
            )}
            style={{ left: cx + c.dx, top: cy + c.dy }}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div data-canvas-chrome className="absolute inset-0 z-30 flex items-center justify-center bg-background/20 p-4" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose() }} onKeyUp={(e) => e.stopPropagation()}>
      <div role="dialog" aria-label={title} className={cn(FLOATING_CARD_CLASS, 'w-full max-w-sm p-3')}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** A drop zone and a button: files dragged here or picked go on the canvas. */
export function MediaPicker({ onFiles, onClose }: { onFiles: (files: File[]) => void; onClose: () => void }) {
  const input = React.useRef<HTMLInputElement>(null)
  const [over, setOver] = React.useState(false)
  return (
    <Panel title="Add media" onClose={onClose}>
      <div
        data-canvas-dropzone
        className={cn('flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground', over && 'border-primary bg-primary/5')}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          const files = [...e.dataTransfer.files]
          if (files.length) onFiles(files)
        }}
      >
        <ImagePlus className="h-6 w-6" strokeWidth={1.5} />
        <p>Drop images or video here</p>
        <button type="button" onClick={() => input.current?.click()} className="rounded-md border border-border bg-background px-3 py-1.5 text-foreground hover:bg-foreground/[0.04]">
          Add files
        </button>
        <p className="text-xs">PNG, JPEG, GIF, WebP, MP4, WebM or MOV, up to {CANVAS_MEDIA_MAX_LABEL} each</p>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept={CANVAS_MEDIA_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </Panel>
  )
}

const REFERENCE_KINDS = ['document', 'action', 'project', 'initiative', 'capture', 'contact', 'company', 'data_table', 'spreadsheet', 'canvas'] as const

/** Find a record by name and place its card. */
export function ReferencePicker({ canvasId, onPick, onClose }: { canvasId: string; onPick: (ref: { type: string; id: string; label?: string }) => void; onClose: () => void }) {
  const [q, setQ] = React.useState('')
  const [rows, setRows] = React.useState<MenuSearchRow[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [active, setActive] = React.useState(0)
  React.useEffect(() => {
    let live = true
    setBusy(true)
    const t = setTimeout(() => {
      void fetch(`/api/account/search?q=${encodeURIComponent(q)}&types=${REFERENCE_KINDS.join(',')}&limit=5`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: MenuSearchResponse | null) => {
          if (!live) return
          const all: MenuSearchRow[] = []
          for (const kind of REFERENCE_KINDS) for (const row of j?.results?.[kind] ?? []) if (!(row.kind === 'canvas' && menuRowId(row) === canvasId)) all.push(row)
          setRows(all.slice(0, 12))
          setActive(0)
          setBusy(false)
        })
        .catch(() => live && setBusy(false))
    }, 180)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, canvasId])
  const pick = (row: MenuSearchRow) => {
    const target = menuRowTarget(row) as { title?: string | null }
    onPick({ type: row.kind, id: menuRowId(row), ...(target.title ? { label: target.title } : {}) })
  }
  return (
    <Panel title="Add a reference" onClose={onClose}>
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2">
        <input
          autoFocus
          aria-label="Find a record"
          placeholder="Find a doc, an action, a project…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (!rows?.length) return
            if (e.key === 'ArrowDown') setActive((a) => Math.min(rows.length - 1, a + 1))
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
            else if (e.key === 'Enter') pick(rows[active])
            else return
            e.preventDefault()
          }}
          className="h-8 w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
      <ul role="listbox" aria-label="Records" className="mt-2 max-h-64 overflow-y-auto">
        {rows?.map((row, i) => {
          const target = menuRowTarget(row) as { title?: string | null }
          return (
            <li key={`${row.kind}:${menuRowId(row)}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                data-canvas-reference={row.kind}
                onClick={() => pick(row)}
                onPointerEnter={() => setActive(i)}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground', i === active && 'bg-foreground/[0.06]')}
              >
                <EntityIcon kind={row.kind} size="sm" />
                <span className="min-w-0 flex-1 truncate">{target.title || 'Untitled'}</span>
                <span className="shrink-0 text-xs capitalize text-muted-foreground">{row.kind.replace(/_/g, ' ')}</span>
              </button>
            </li>
          )
        })}
        {rows && !rows.length && !busy ? <li className="px-2 py-3 text-sm text-muted-foreground">Nothing by that name.</li> : null}
      </ul>
    </Panel>
  )
}
