'use client'

/**
 * An artifact on the canvas, and artifacts presented one at a time.
 *
 * The page an artifact holds runs in a frame with no origin and no network
 * (engine/artifact.ts). On the canvas the frame takes no pointer until the
 * item is opened with a double-click, so a click still selects and a drag
 * still moves; Escape or a click elsewhere hands the pointer back.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { ArtifactItem } from '@/lib/canvas/types'
import { ARTIFACT_LIMITS, ARTIFACT_SANDBOX, artifactDocument } from '@/lib/canvas/engine/artifact'
import { cn } from '@/lib/utils'

/** Whether the app is in its dark theme, following the switch. */
export function useIsDark(): boolean {
  const subscribe = React.useCallback((cb: () => void) => {
    const o = new MutationObserver(cb)
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])
  return React.useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains('dark'),
    () => false,
  )
}

/**
 * The frame itself. A frame loads once for the document it is given; a second
 * load means the page sent itself somewhere else, and it is taken down.
 */
export function ArtifactFrame({ html, title, interactive, className, style }: { html: string; title?: string; interactive: boolean; className?: string; style?: React.CSSProperties }) {
  const dark = useIsDark()
  const doc = React.useMemo(() => artifactDocument(html, { dark }), [html, dark])
  const loads = React.useRef({ doc, n: 0 })
  const [left, setLeft] = React.useState<string | null>(null)
  if (loads.current.doc !== doc) loads.current = { doc, n: 0 }
  if (left !== null && left !== doc) setLeft(null)
  if (left === doc) {
    return (
      <div data-canvas-artifact-left className={cn('flex items-center justify-center p-3 text-center text-xs text-muted-foreground', className)} style={style}>
        This artifact tried to open another page, so it was stopped.
      </div>
    )
  }
  return (
    <iframe
      title={title ?? 'Artifact'}
      sandbox={ARTIFACT_SANDBOX}
      srcDoc={doc}
      referrerPolicy="no-referrer"
      loading="lazy"
      tabIndex={interactive ? 0 : -1}
      onLoad={() => {
        loads.current.n += 1
        if (loads.current.n > 1) setLeft(doc)
      }}
      className={className}
      style={{ border: 0, display: 'block', background: 'transparent', pointerEvents: interactive ? 'auto' : 'none', ...style }}
    />
  )
}

/** The item on the canvas: a titled card around the frame. */
export function ArtifactView({ item, frame, open }: { item: ArtifactItem; frame: React.CSSProperties; open: boolean }) {
  return (
    <div
      data-canvas-item={item.id}
      data-canvas-artifact={open ? 'open' : 'closed'}
      style={frame}
      className={cn('flex flex-col overflow-hidden rounded-lg border border-border/70 bg-background shadow-sm', open && 'ring-2 ring-[var(--cv-select,#2563eb)]')}
    >
      {item.title ? <div className="shrink-0 truncate border-b border-border/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{item.title}</div> : null}
      {item.html.trim() ? (
        <ArtifactFrame html={item.html} title={item.title} interactive={open} className="min-h-0 w-full flex-1" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">An empty artifact</div>
      )}
    </div>
  )
}

/** Artifacts full-screen, one at a time, in their present order. */
export function PresentArtifacts({ artifacts, start, onClose }: { artifacts: readonly ArtifactItem[]; start?: string | null; onClose: () => void }) {
  const [index, setIndex] = React.useState(() => Math.max(0, artifacts.findIndex((a) => a.id === start)))
  const [size, setSize] = React.useState({ w: 0, h: 0 })
  const root = React.useRef<HTMLDivElement>(null)
  const last = artifacts.length - 1
  const at = Math.min(index, Math.max(0, last))
  const go = React.useCallback((d: number) => setIndex((i) => Math.min(last, Math.max(0, Math.min(i, last) + d))), [last])

  React.useEffect(() => {
    const el = root.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const o = new ResizeObserver(measure)
    o.observe(el)
    el.focus()
    return () => o.disconnect()
  }, [])

  React.useEffect(() => {
    if (!artifacts.length) onClose()
  }, [artifacts.length, onClose])

  const current = artifacts[at]
  if (!current || typeof document === 'undefined') return null
  // The artifact keeps the size it has on the canvas and is scaled to the screen, so it lays out as it was made.
  const pad = 56
  const scale = size.w && size.h ? Math.min((size.w - pad * 2) / current.w, (size.h - pad * 2) / current.h) : 1
  const btn = 'flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-30'
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Presenting"
      data-canvas-present
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background outline-none"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'Enter') go(1)
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'Backspace') go(-1)
        else if (e.key === 'Home') setIndex(0)
        else if (e.key === 'End') setIndex(last)
        else return
        e.preventDefault()
      }}
    >
      <div style={{ width: current.w, height: current.h, transform: `scale(${scale})`, flex: 'none' }} className="overflow-hidden rounded-lg border border-border/60 bg-background shadow-xl">
        <ArtifactFrame key={current.id} html={current.html} title={current.title} interactive style={{ width: '100%', height: '100%' }} />
      </div>
      <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2">
        <button type="button" aria-label="Previous" disabled={at === 0} onClick={() => go(-1)} className={btn}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span data-canvas-present-count className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">
          {at + 1} / {artifacts.length}
        </span>
        <button type="button" aria-label="Next" disabled={at === last} onClick={() => go(1)} className={btn}>
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      {current.title ? <div className="absolute left-4 top-4 max-w-[60%] truncate text-sm font-medium text-foreground">{current.title}</div> : null}
      <button type="button" aria-label="Stop presenting" onClick={onClose} className={cn(btn, 'absolute right-3 top-3')}>
        <X className="h-5 w-5" />
      </button>
    </div>,
    document.body,
  )
}

/** Change an artifact's page and title: its markup as text, saved as one undo step. */
export function ArtifactEditor({ item, onSave, onClose }: { item: ArtifactItem; onSave: (next: { html: string; title: string }) => void; onClose: () => void }) {
  const [title, setTitle] = React.useState(item.title ?? '')
  const [html, setHtml] = React.useState(item.html)
  const tooLong = html.length > ARTIFACT_LIMITS.html
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit artifact"
      data-canvas-artifact-editor
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-xl">
        <input aria-label="Title" value={title} maxLength={ARTIFACT_LIMITS.title} placeholder="Title" onChange={(e) => setTitle(e.target.value)} className="h-9 rounded-md border border-border/60 bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-foreground/30" />
        <textarea
          aria-label="Page"
          value={html}
          autoFocus
          spellCheck={false}
          onChange={(e) => setHtml(e.target.value)}
          placeholder="<h1>Hello</h1>"
          className="min-h-64 flex-1 resize-none rounded-md border border-border/60 bg-transparent p-2.5 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-foreground/30"
        />
        <p className="text-[11px] text-muted-foreground">
          The page runs on its own: no network, and nothing of the app. Images and fonts go in as data: URLs.
          {tooLong ? <span className="text-red-500"> Too long by {html.length - ARTIFACT_LIMITS.html} characters.</span> : null}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            Cancel
          </button>
          <button type="button" disabled={tooLong} onClick={() => onSave({ html, title })} className="h-8 rounded-md bg-foreground px-3 text-xs font-medium text-background disabled:opacity-40">
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
