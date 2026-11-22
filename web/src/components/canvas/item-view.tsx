'use client'

/**
 * One item on the canvas, drawn in world units inside the camera's layer.
 * Memoized on the item itself: a drag re-renders only what it moves.
 */
import * as React from 'react'
import type { CanvasItem, CanvasTextStyle, ConnectorItem, FontFamily, StrokeStyle } from '@/lib/canvas/types'
import { cssColor } from '@/lib/canvas/engine/colors'
import { headShape, routePath } from '@/lib/canvas/engine/connectors'
import { DEFAULT_LABEL_STYLE, DEFAULT_TEXT_STYLE } from '@/lib/canvas/engine/defaults'
import { inkPath } from '@/lib/canvas/engine/ink'
import { sceneFromItems } from '@/lib/canvas/engine/scene'
import { canvasMediaUrl } from '@/lib/canvas/media'
import { EntityIcon } from '@/components/entities/entity-icon'
import { CanvasContext } from './use-canvas'

export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'inherit',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

function dash(style: StrokeStyle | undefined, width: number): { strokeDasharray?: string; strokeLinecap?: 'round' | 'butt' } {
  if (style === 'dashed') return { strokeDasharray: `${width * 3} ${width * 2.5}`, strokeLinecap: 'butt' }
  if (style === 'dotted') return { strokeDasharray: `0 ${width * 2.2}`, strokeLinecap: 'round' }
  return {}
}

export function textCss(text: CanvasTextStyle | undefined, fallback: CanvasTextStyle): React.CSSProperties {
  const t = { ...fallback, ...text }
  return {
    fontFamily: FONT_STACKS[t.fontFamily ?? 'sans'],
    fontSize: t.fontSize,
    lineHeight: 1.4,
    color: cssColor(t.color, 'var(--cv-ink)'),
    textAlign: t.align,
  }
}

export interface ItemViewProps {
  item: CanvasItem
  /** The shapes a connector is tied to (so it re-draws when they turn). */
  startTarget?: CanvasItem
  endTarget?: CanvasItem
  /** Marked by the eraser. */
  dim?: boolean
  /** Its text is open for typing: the words are drawn by the editor instead. */
  editing?: boolean
  /** Zoomed far out: leave the words out. */
  far?: boolean
  /** Report a text box's real size after layout. */
  onMeasure?: (id: string, w: number, h: number) => void
}

function frameStyle(item: CanvasItem, dim?: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    width: item.w,
    height: item.h,
    transform: `translate(${item.x}px, ${item.y}px)${item.rotation ? ` rotate(${item.rotation}rad)` : ''}`,
    transformOrigin: 'center',
    opacity: (item.style.opacity ?? 1) * (dim ? 0.25 : 1),
  }
}

const SVG_STYLE: React.CSSProperties = { position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }

function Label({ item, editing }: { item: Extract<CanvasItem, { kind: 'rectangle' | 'ellipse' }>; editing?: boolean }) {
  if (!item.label?.plain || editing) return null
  // An ellipse holds text in the box inscribed in it.
  const inset = item.kind === 'ellipse' ? { left: '14.6%', right: '14.6%', top: '14.6%', bottom: '14.6%' } : { left: 8, right: 8, top: 4, bottom: 4 }
  return (
    <div
      data-canvas-label
      style={{
        position: 'absolute',
        ...inset,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        ...textCss(item.text, DEFAULT_LABEL_STYLE),
      }}
    >
      <span style={{ maxWidth: '100%' }}>{item.label.plain}</span>
    </div>
  )
}

function ConnectorView({ item, startTarget, endTarget, dim, editing, far }: ItemViewProps & { item: ConnectorItem }) {
  const path = React.useMemo(() => {
    const targets = [startTarget, endTarget].filter((t): t is CanvasItem => !!t)
    return routePath(sceneFromItems([item, ...targets]), item)
  }, [item, startTarget, endTarget])
  const width = item.style.strokeWidth ?? 2
  const color = cssColor(item.style.stroke, 'var(--cv-ink)')
  const first = path.poly[0]
  const last = path.poly[path.poly.length - 1]
  const heads = [headShape(item.startHead, first, path.startAngle, width), headShape(item.endHead, last, path.endAngle, width)]
  return (
    <div data-canvas-item={item.id} style={{ position: 'absolute', left: 0, top: 0, opacity: (item.style.opacity ?? 1) * (dim ? 0.25 : 1) }}>
      <svg width={1} height={1} style={SVG_STYLE}>
        <path d={path.d} fill="none" stroke={color} strokeWidth={width} strokeLinejoin="round" strokeLinecap="round" {...dash(item.style.strokeStyle, width)} />
        {heads.map((h, i) =>
          h.kind === 'none' ? null : h.kind === 'dot' ? (
            <circle key={i} cx={h.center.x} cy={h.center.y} r={h.r} fill={color} />
          ) : (
            <polyline
              key={i}
              points={h.points.map((p) => `${p.x},${p.y}`).join(' ')}
              fill={h.kind === 'filled' ? color : 'none'}
              stroke={color}
              strokeWidth={width}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ),
        )}
      </svg>
      {item.label?.plain && !editing && !far ? (
        <div
          data-canvas-label
          className="bg-background"
          style={{
            position: 'absolute',
            left: path.mid.x,
            top: path.mid.y,
            transform: 'translate(-50%, -50%)',
            padding: '0 6px',
            borderRadius: 4,
            whiteSpace: 'pre',
            ...textCss(item.text, { ...DEFAULT_LABEL_STYLE, fontSize: 14 }),
          }}
        >
          {item.label.plain}
        </div>
      ) : null}
    </div>
  )
}

function TextView({ item, dim, editing, onMeasure, far }: ItemViewProps & { item: Extract<CanvasItem, { kind: 'text' }> }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el || editing || !onMeasure) return
    const w = item.autoWidth ? Math.ceil(el.offsetWidth) : item.w
    const h = Math.ceil(el.offsetHeight)
    if (w > 0 && h > 0 && (Math.abs(w - item.w) > 0.75 || Math.abs(h - item.h) > 0.75)) onMeasure(item.id, w, h)
  })
  // Too small to read: a faint bar where the words are, at the size already measured.
  if (far && !editing) return <div data-canvas-item={item.id} style={{ ...frameStyle(item, dim), opacity: 0.25 * (item.style.opacity ?? 1), background: cssColor(item.text.color, 'var(--cv-ink)'), borderRadius: 2 }} />
  return (
    <div data-canvas-item={item.id} style={{ ...frameStyle(item, dim), height: undefined, width: item.autoWidth ? undefined : item.w }}>
      <div
        ref={ref}
        style={{
          width: item.autoWidth ? 'max-content' : item.w,
          whiteSpace: item.autoWidth ? 'pre' : 'pre-wrap',
          overflowWrap: item.autoWidth ? undefined : 'anywhere',
          visibility: editing ? 'hidden' : undefined,
          ...textCss(item.text, DEFAULT_TEXT_STYLE),
        }}
      >
        {item.content.plain || ' '}
      </div>
    </div>
  )
}

function ItemViewInner(props: ItemViewProps) {
  const { item, dim, editing, far } = props
  if (item.kind === 'group') return null
  if (item.kind === 'connector') return <ConnectorView {...props} item={item} />
  if (item.kind === 'text') return <TextView {...props} item={item} />

  const width = item.style.strokeWidth ?? 0
  const stroke = cssColor(item.style.stroke)
  if (item.kind === 'rectangle' || item.kind === 'ellipse') {
    const fill = cssColor(item.style.fill)
    return (
      <div data-canvas-item={item.id} style={frameStyle(item, dim)}>
        <svg width={item.w} height={item.h} style={SVG_STYLE}>
          {item.kind === 'rectangle' ? (
            <rect x={0} y={0} width={item.w} height={item.h} rx={Math.min(item.style.radius ?? 0, item.w / 2, item.h / 2)} fill={fill} stroke={stroke} strokeWidth={width} {...dash(item.style.strokeStyle, width)} />
          ) : (
            <ellipse cx={item.w / 2} cy={item.h / 2} rx={item.w / 2} ry={item.h / 2} fill={fill} stroke={stroke} strokeWidth={width} {...dash(item.style.strokeStyle, width)} />
          )}
        </svg>
        {far ? null : <Label item={item} editing={editing} />}
      </div>
    )
  }
  if (item.kind === 'pencil') {
    return (
      <div data-canvas-item={item.id} style={frameStyle(item, dim)}>
        <svg width={item.w} height={item.h} style={SVG_STYLE}>
          <path d={inkPath(item, item.style.strokeWidth ?? 4)} fill={cssColor(item.style.stroke, 'var(--cv-ink)')} />
        </svg>
      </div>
    )
  }
  if (item.kind === 'image' || item.kind === 'video') return <MediaView item={item} dim={dim} />
  if (item.kind === 'record') return <RecordView item={item} dim={dim} />
  return (
    <div data-canvas-item={item.id} style={frameStyle(item, dim)} className="flex items-center justify-center rounded-lg border border-dashed border-border bg-background/60 text-xs text-muted-foreground">
      {item.kind === 'artifact' ? (item.title ?? 'Artifact') : null}
    </div>
  )
}

function MediaView({ item, dim }: { item: Extract<CanvasItem, { kind: 'image' | 'video' }>; dim?: boolean }) {
  const store = React.useContext(CanvasContext)
  // The local preview while it uploads; then the stored file, through the canvas's own route.
  const src = item.src ?? (item.path && store ? canvasMediaUrl(store.canvasId, item.path) : undefined)
  const flip = `scale(${item.flipX ? -1 : 1}, ${item.flipY ? -1 : 1})`
  return (
    <div data-canvas-item={item.id} data-canvas-media={item.path ? 'stored' : item.src ? 'uploading' : 'missing'} style={frameStyle(item, dim)} className="overflow-hidden rounded-[2px] bg-muted/40">
      {src ? (
        item.kind === 'image' ? (
          <img src={src} alt={item.name ?? ''} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'fill', transform: flip, userSelect: 'none', pointerEvents: 'none' }} />
        ) : (
          <video src={src} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'fill', transform: flip, pointerEvents: 'none' }} />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">{item.name ?? (item.kind === 'image' ? 'Image' : 'Video')}</div>
      )}
      {!item.path && item.src ? <div className="absolute inset-x-0 bottom-0 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">Uploading…</div> : null}
    </div>
  )
}

/** Live names for record cards, asked for together and remembered for the page's life. */
const labelCache = new Map<string, string>()
const labelWaiters = new Map<string, Set<(label: string) => void>>()
let labelTimer: ReturnType<typeof setTimeout> | null = null
function askLabel(key: string, done: (label: string) => void): () => void {
  const set = labelWaiters.get(key) ?? new Set()
  set.add(done)
  labelWaiters.set(key, set)
  if (!labelTimer) {
    labelTimer = setTimeout(() => {
      labelTimer = null
      const keys = [...labelWaiters.keys()].slice(0, 50)
      const waiting = new Map(keys.map((k) => [k, labelWaiters.get(k)!]))
      for (const k of keys) labelWaiters.delete(k)
      void fetch(`/api/account/entities/resolve?mentions=${encodeURIComponent(keys.join(','))}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { mentions?: Record<string, { label?: string }> } | null) => {
          for (const [k, fns] of waiting) {
            const label = j?.mentions?.[k]?.label
            if (!label) continue
            labelCache.set(k, label)
            for (const fn of fns) fn(label)
          }
        })
        .catch(() => undefined)
    }, 60)
  }
  return () => void set.delete(done)
}

function RecordView({ item, dim }: { item: Extract<CanvasItem, { kind: 'record' }>; dim?: boolean }) {
  const key = `${item.ref.type}:${item.ref.id}`
  const [label, setLabel] = React.useState<string | undefined>(() => labelCache.get(key))
  React.useEffect(() => {
    const known = labelCache.get(key)
    if (known) {
      setLabel(known)
      return
    }
    return askLabel(key, setLabel)
  }, [key])
  return (
    <div
      data-canvas-item={item.id}
      data-canvas-record={key}
      style={frameStyle(item, dim)}
      className="flex items-center gap-3 overflow-hidden rounded-xl border border-border/60 bg-background/90 px-4 shadow-sm shadow-black/[0.05] dark:border-white/10"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05]">
        <EntityIcon kind={item.ref.type} size="md" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{label ?? item.ref.label ?? 'Untitled'}</span>
        <span className="block truncate text-xs text-muted-foreground"><span className="capitalize">{item.ref.type.replace(/_/g, ' ')}</span> · double-click to open</span>
      </span>
    </div>
  )
}

export const ItemView = React.memo(ItemViewInner)
