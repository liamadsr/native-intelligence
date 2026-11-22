'use client'

/**
 * The roadmap layout: a view's rows on a time axis.
 *
 * One scroll box holds everything, scrolling both ways, so the axis, the left
 * list and the bars can never drift apart: the axis is `sticky top`, each row's
 * left cell `sticky left`, and the rows are windowed vertically with the same
 * virtualizer the list uses. A few hundred rows draw only the ones on screen.
 *
 * What a bar is comes from lib/views/roadmap.ts (`itemSpan`): a project spans
 * its start to its target; an action, which has a due date and no start, is a
 * marker on its due day; so is an initiative on its target. A drag on a bar
 * moves it, a drag on either end of a project's bar changes that date, and the
 * write goes through the layout's `onPatch` — the same PATCH, optimistic
 * update and rollback an inline edit uses — with an Undo on the toast.
 *
 * A row with no dates stays in the list with an empty timeline; hovering its
 * timeline shows the day under the pointer, and a click schedules it there.
 *
 * Zoom and the left panel's collapse are the viewer's own, kept in this
 * browser (a saved view keeps its layout, grouping, filters and sort).
 */

import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { ChevronRight, Circle, CheckCircle2, Flag, PanelLeftClose, PanelLeftOpen, Settings2, Target, XCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ProjectIcon } from '@/components/ui/emoji-icon-picker'
import { cn } from '@/lib/utils'
import type { GroupedResults, ViewEntityType } from '@/lib/views/types'
import { getPriorityOption, PROJECT_STATUS_OPTIONS, STATUS_DOT_COLORS } from '@/lib/views/property-options'
import type { GroupLoadState } from '@/lib/views/lazy-done-groups'
import {
  PX_PER_DAY, ROADMAP_DATE_FIELDS, ROADMAP_ZOOMS, ROADMAP_ZOOM_LABELS,
  axisTicks, dateToX, dragPatch, flattenRoadmapRows, isRoadmapZoom, itemSpan, previewSpan,
  pxToDays, schedulePatch, spanBox, timelineRange, undoPatch, xToDate,
  type RoadmapDragMode, type RoadmapRow, type RoadmapSpan, type RoadmapZoom,
} from '@/lib/views/roadmap'
import type { ViewConfig } from './hooks/use-view'
import { getTitle, type PatchItemFn } from './list/entity-row'

const ROW_HEIGHT = 36
const HEADER_HEIGHT = 52
const LEFT_WIDTH = 330
const LEFT_COLLAPSED_WIDTH = 44
/** Past this many pixels a press on a bar is a drag, not a click. */
const DRAG_THRESHOLD_PX = 3
/**
 * The sticky surfaces (axis, left list) over the scrolling bars: the window's
 * own glass, frosted enough that a bar sliding under the list reads as behind it.
 */
const GLASS = 'bg-background/75 backdrop-blur-xl dark:bg-background/70'
const ZOOM_STORAGE_KEY = 'ni:roadmap-zoom'
const PANEL_STORAGE_KEY = 'ni:roadmap-left-collapsed'

function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function writeStored(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* private window: a per-viewer nicety only */ }
}

interface ViewRoadmapProps {
  entityType: ViewEntityType
  data: Record<string, unknown>[] | GroupedResults[]
  loading: boolean
  loadingMore?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  config: ViewConfig
  selectedItemId: string | null
  onItemSelect: (id: string, title: string, event?: React.MouseEvent, item?: Record<string, unknown>) => void
  /** The layout's inline-edit write (optimistic, rolled back on failure). */
  onPatch?: PatchItemFn
  canEdit?: (item: Record<string, unknown>, field: string) => boolean
  onLoadGroup?: (groupKey: string) => void
  groupLoadState?: Record<string, GroupLoadState>
  /** Fixed "today" for tests and screenshots. */
  today?: Date
}

interface DragState {
  rowKey: string
  mode: RoadmapDragMode
  startX: number
  days: number
  moved: boolean
}

export function ViewRoadmap({
  entityType, data, loading, loadingMore, hasMore, onLoadMore,
  config, selectedItemId, onItemSelect, onPatch, canEdit,
  onLoadGroup, groupLoadState, today: todayProp,
}: ViewRoadmapProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const today = React.useMemo(() => {
    const d = todayProp ? new Date(todayProp) : new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [todayProp])

  const [zoom, setZoomState] = React.useState<RoadmapZoom>('month')
  const [leftCollapsed, setLeftCollapsed] = React.useState(false)
  React.useEffect(() => {
    const z = readStored(ZOOM_STORAGE_KEY)
    if (isRoadmapZoom(z)) setZoomState(z)
    if (readStored(PANEL_STORAGE_KEY) === '1') setLeftCollapsed(true)
  }, [])
  const leftWidth = leftCollapsed ? LEFT_COLLAPSED_WIDTH : LEFT_WIDTH

  // Groups the person opened or closed against their default (lazy finished
  // groups start closed, the rest open).
  const [toggled, setToggled] = React.useState<Set<string>>(() => new Set())
  const rows = React.useMemo(() => flattenRoadmapRows(data, toggled), [data, toggled])

  const spans = React.useMemo(() => {
    const m = new Map<string, RoadmapSpan>()
    for (const r of rows) if (r.type === 'item') m.set(r.key, itemSpan(entityType, r.item))
    return m
  }, [rows, entityType])
  const range = React.useMemo(() => timelineRange([...spans.values()], today), [spans, today])
  const origin = range.start
  const totalDays = Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000) + 1
  const timelineWidth = totalDays * PX_PER_DAY[zoom]
  const ticks = React.useMemo(() => axisTicks(range.start, range.end, zoom), [range.start, range.end, zoom])
  const todayX = dateToX(today, origin, zoom)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    paddingStart: HEADER_HEIGHT,
  })

  // ── Scrolling: open on today, keep the centre day across a zoom ──
  const scrollToDay = React.useCallback((day: Date, behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    const visible = el.clientWidth - leftWidth
    el.scrollTo({ left: Math.max(0, dateToX(day, origin, zoom) - visible / 3), behavior })
  }, [origin, zoom, leftWidth])
  // The day at the centre of the viewport, kept as the person scrolls: a
  // reload (a filter, a grouping) swaps the scroll box for a skeleton and back,
  // and a zoom changes every x, so both put this day back in the centre. Until
  // the person has scrolled, the view opens on today.
  const centreDayRef = React.useRef<Date | null>(null)
  const restoredForRef = React.useRef<HTMLDivElement | null>(null)
  // Read by the scroll listener, which must see the geometry the scroll position was drawn at.
  const geometryRef = React.useRef({ origin, zoom, leftWidth })
  geometryRef.current = { origin, zoom, leftWidth }
  const lastZoomRef = React.useRef(zoom)
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (loading || !el) return
    const zoomChanged = lastZoomRef.current !== zoom
    lastZoomRef.current = zoom
    if (restoredForRef.current === el && !zoomChanged) return
    restoredForRef.current = el
    const centre = centreDayRef.current
    if (centre) el.scrollLeft = Math.max(0, dateToX(centre, origin, zoom) - (el.clientWidth - leftWidth) / 2)
    else scrollToDay(today)
  }, [loading, zoom, scrollToDay, today, origin, leftWidth])

  const setZoom = (z: RoadmapZoom) => {
    setZoomState(z)
    writeStored(ZOOM_STORAGE_KEY, z)
  }
  const toggleLeft = () => {
    setLeftCollapsed(c => {
      writeStored(PANEL_STORAGE_KEY, c ? '0' : '1')
      return !c
    })
  }

  // Infinite scroll on an ungrouped view (50 rows a page).
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      if (restoredForRef.current === el) {
        const g = geometryRef.current
        centreDayRef.current = xToDate(el.scrollLeft + (el.clientWidth - g.leftWidth) / 2, g.origin, g.zoom)
      }
      if (!hasMore || loadingMore || !onLoadMore) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) onLoadMore()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [hasMore, loadingMore, onLoadMore, loading])

  // An opened lazy group loads its first page.
  React.useEffect(() => {
    if (!onLoadGroup) return
    for (const r of rows) {
      if (r.type !== 'group' || !r.lazy || r.collapsed) continue
      const st = groupLoadState?.[r.group.key]
      if (!st?.loaded && !st?.loading) onLoadGroup(r.group.key)
    }
  }, [rows, onLoadGroup, groupLoadState])

  // ── Writing dates ──
  const editable = React.useCallback((item: Record<string, unknown>) => {
    if (!onPatch) return false
    const f = ROADMAP_DATE_FIELDS[entityType]
    if (!f) return false
    return canEdit ? canEdit(item, f.end.field) : true
  }, [onPatch, canEdit, entityType])

  const commit = React.useCallback((item: Record<string, unknown>, patch: Record<string, unknown>, verb: string) => {
    if (!onPatch) return
    const id = item.id as string
    const prior = undoPatch(item, patch)
    onPatch(id, patch)
    const title = getTitle(entityType, item) || 'Item'
    toast(`${verb} “${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`, {
      action: { label: 'Undo', onClick: () => onPatch(id, prior) },
    })
  }, [onPatch, entityType])

  const [drag, setDrag] = React.useState<DragState | null>(null)
  const dragRef = React.useRef<DragState | null>(null)
  const startDrag = (e: React.PointerEvent, rowKey: string, mode: RoadmapDragMode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    const next = { rowKey, mode, startX: e.clientX, days: 0, moved: false }
    dragRef.current = next
    setDrag(next)
  }
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const moved = d.moved || Math.abs(dx) > DRAG_THRESHOLD_PX
    const days = moved ? pxToDays(dx, zoom) : 0
    if (days === d.days && moved === d.moved) return
    const next = { ...d, days, moved }
    dragRef.current = next
    setDrag(next)
  }
  const endDrag = (e: React.PointerEvent, item: Record<string, unknown>) => {
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!d) return
    if (!d.moved) {
      onItemSelect(item.id as string, getTitle(entityType, item), e as unknown as React.MouseEvent, item)
      return
    }
    const patch = dragPatch(entityType, item, d.mode, d.days)
    if (patch) commit(item, patch, d.mode === 'move' ? 'Moved' : 'Rescheduled')
  }
  const cancelDrag = () => { dragRef.current = null; setDrag(null) }

  const [hover, setHover] = React.useState<{ rowKey: string; x: number } | null>(null)

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
      </div>
    )
  }

  const groupingField = config.grouping?.field
  const totalHeight = virtualizer.getTotalSize()
  const contentWidth = leftWidth + timelineWidth

  return (
    <div className="relative h-full" data-roadmap="">
      <div ref={scrollRef} className="h-full overflow-auto overscroll-contain" data-roadmap-scroll="">
        <div className="relative" style={{ width: contentWidth, height: Math.max(totalHeight, HEADER_HEIGHT) + 112, minHeight: '100%' }}>
          {/* ── Header: panel toggle + axis ── */}
          <div
            className="sticky top-0 z-30 flex border-b border-border/60"
            style={{ height: HEADER_HEIGHT, width: contentWidth }}
          >
            <div
              className={cn('sticky left-0 z-10 flex items-end border-r border-border/60 px-2 pb-1.5', GLASS)}
              style={{ width: leftWidth, minWidth: leftWidth }}
            >
              <Button
                variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground"
                onClick={toggleLeft}
                aria-label={leftCollapsed ? 'Show list' : 'Hide list'}
                title={leftCollapsed ? 'Show list' : 'Hide list'}
                data-roadmap-panel-toggle=""
              >
                {leftCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              </Button>
            </div>
            <div className={cn('relative', GLASS)} style={{ width: timelineWidth }} aria-hidden>
              {ticks.major.map(t => (
                <div key={`M${t.x}`} className="absolute top-1.5 whitespace-nowrap pl-1.5 text-xs font-medium text-foreground" style={{ left: t.x }}>
                  {t.label}
                </div>
              ))}
              {ticks.minor.map(t => (
                <div
                  key={`m${t.x}`}
                  className="absolute bottom-0 h-5 border-l border-border/70 pl-1 text-[10px] leading-4 tabular-nums text-muted-foreground"
                  style={{ left: t.x }}
                >
                  {t.label}
                </div>
              ))}
              <div className="absolute bottom-0 h-2.5 w-px bg-primary" style={{ left: todayX + PX_PER_DAY[zoom] / 2 }} />
            </div>
          </div>

          {/* ── Grid: week lines and the today line, behind the rows ── */}
          <div
            className="pointer-events-none absolute"
            style={{ left: leftWidth, top: HEADER_HEIGHT, width: timelineWidth, bottom: 0 }}
            aria-hidden
          >
            {ticks.minor.map(t => (
              <div key={t.x} className="absolute inset-y-0 w-px bg-border/40 dark:bg-white/[0.06]" style={{ left: t.x }} />
            ))}
            <div className="absolute inset-y-0 w-px bg-primary/70" style={{ left: todayX + PX_PER_DAY[zoom] / 2 }} data-roadmap-today="" />
          </div>

          {/* ── Rows ── */}
          {virtualizer.getVirtualItems().map(vi => {
            const row = rows[vi.index]
            return (
              <div
                key={row.key}
                className="absolute left-0 flex"
                style={{ top: 0, height: vi.size, width: contentWidth, transform: `translateY(${vi.start}px)` }}
              >
                {row.type === 'group' ? (
                  <GroupBand
                    row={row}
                    leftWidth={leftWidth}
                    timelineWidth={timelineWidth}
                    collapsedPanel={leftCollapsed}
                    groupingField={groupingField}
                    onToggle={() => setToggled(prev => {
                      const next = new Set(prev)
                      if (next.has(row.key)) next.delete(row.key)
                      else next.add(row.key)
                      return next
                    })}
                  />
                ) : row.type === 'empty' ? (
                  <div className="sticky left-0 flex items-center pl-10 text-xs text-muted-foreground" style={{ width: leftWidth }}>
                    {groupLoadState?.[row.groupKey]?.loaded ? 'No items' : row.label}
                  </div>
                ) : (
                  <ItemRow
                    rowKey={row.key}
                    item={row.item}
                    entityType={entityType}
                    leftWidth={leftWidth}
                    collapsedPanel={leftCollapsed}
                    timelineWidth={timelineWidth}
                    origin={origin}
                    zoom={zoom}
                    span={spans.get(row.key) ?? { kind: 'none', start: null, end: null }}
                    drag={drag?.rowKey === row.key ? drag : null}
                    selected={selectedItemId === row.item.id}
                    editable={editable(row.item)}
                    hoverX={hover?.rowKey === row.key ? hover.x : null}
                    onHover={x => setHover(x === null ? null : { rowKey: row.key, x })}
                    onOpen={e => onItemSelect(row.item.id as string, getTitle(entityType, row.item), e, row.item)}
                    onStartDrag={(e, mode) => startDrag(e, row.key, mode)}
                    onMoveDrag={moveDrag}
                    onEndDrag={e => endDrag(e, row.item)}
                    onCancelDrag={cancelDrag}
                    onSchedule={day => {
                      const patch = schedulePatch(entityType, day)
                      if (patch) commit(row.item, patch, 'Scheduled')
                    }}
                  />
                )}
              </div>
            )
          })}
          {rows.length === 0 && (
            <div className="sticky left-0 py-16 text-center text-sm text-muted-foreground" style={{ top: HEADER_HEIGHT, width: 'min(100%, 100vw)' }}>
              No items match this view.
            </div>
          )}
        </div>
      </div>

      {/* ── Today + zoom, over the axis's right end ── */}
      <div className="absolute right-3 top-2.5 z-40 flex items-center gap-1 rounded-full border border-border/70 bg-background/90 p-0.5 shadow-sm backdrop-blur">
        <Button
          variant="ghost" size="sm" className="h-6 rounded-full px-2.5 text-xs"
          onClick={() => scrollToDay(today, 'smooth')}
          data-roadmap-today-button=""
        >
          Today
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full" aria-label="Roadmap settings" title="Roadmap settings" data-roadmap-settings="">
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60 p-3" align="end">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Zoom</div>
            <ToggleGroup
              type="single" value={zoom}
              onValueChange={v => { if (isRoadmapZoom(v)) setZoom(v) }}
              className="w-full"
            >
              {ROADMAP_ZOOMS.map(z => (
                <ToggleGroupItem key={z} value={z} className="h-7 flex-1 text-xs" data-roadmap-zoom={z}>
                  {ROADMAP_ZOOM_LABELS[z]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
              {entityType === 'project'
                ? 'Drag a bar to move it, or its ends to change the start and target dates.'
                : `Drag a marker to change its ${entityType === 'action' ? 'due' : 'target'} date.`}
              {' '}Click an empty row’s timeline to schedule it.
            </p>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

// ── A group's band ─────────────────────────────────────────

function GroupBand({ row, leftWidth, timelineWidth, collapsedPanel, groupingField, onToggle }: {
  row: Extract<RoadmapRow, { type: 'group' }>
  leftWidth: number
  timelineWidth: number
  collapsedPanel: boolean
  groupingField?: string
  onToggle: () => void
}) {
  return (
    <div className="flex h-full w-full items-center bg-muted/50 dark:bg-white/[0.05] border-y border-border/40" data-roadmap-group={row.key}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!row.collapsed}
        className="sticky left-0 z-10 flex h-full items-center gap-2 bg-muted/0 text-left"
        style={{ width: leftWidth, minWidth: leftWidth, paddingLeft: 12 + row.depth * 16 }}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150', !row.collapsed && 'rotate-90')} />
        <GroupIcon field={groupingField} group={row.group} />
        {!collapsedPanel && (
          <>
            <span className="truncate text-sm font-medium">
              {groupLabel(groupingField, row.group, row.label)}
            </span>
            <span className="rounded-full bg-background/80 px-1.5 text-[11px] tabular-nums text-muted-foreground ring-1 ring-border/60">
              {row.count}
            </span>
          </>
        )}
      </button>
      <div style={{ width: timelineWidth }} />
    </div>
  )
}

/** A group's name as the app writes it elsewhere (the engine hands priority and project status keys back raw). */
function groupLabel(field: string | undefined, group: GroupedResults, label: string): string {
  if (field === 'priority') return getPriorityOption(group.key).label
  if (field === 'status') return PROJECT_STATUS_OPTIONS.find(o => o.value === group.key)?.label ?? label
  return label
}

/** A group's own icon, in the colors the rest of the app gives it. */
function GroupIcon({ field, group }: { field?: string; group: GroupedResults }) {
  if (field === 'priority') {
    const opt = getPriorityOption(group.key)
    return <Flag className={cn('h-3.5 w-3.5 shrink-0', opt.color)} />
  }
  if (field === 'status_id' || field === 'status') {
    const first = (group.items ?? [])[0] as Record<string, unknown> | undefined
    const ws = first?.workflow_state as { color?: string; category?: string } | undefined
    const color = (group.metadata?.color as string | undefined) ?? ws?.color
    if (color) return <Circle className="h-3 w-3 shrink-0" style={{ color }} strokeWidth={2.5} />
    const projectDot = PROJECT_STATUS_OPTIONS.find(o => o.value === group.key)?.dot
    const category = (group.metadata?.category as string | undefined) ?? ws?.category
    const dot = projectDot ?? (category ? STATUS_DOT_COLORS[category] : undefined)
    if (dot) return <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
  }
  return null
}

// ── An item's icon (the status circle) ─────────────────────

function ItemIcon({ entityType, item }: { entityType: ViewEntityType; item: Record<string, unknown> }) {
  if (entityType === 'action') {
    const ws = item.workflow_state as { color?: string; category?: string } | undefined
    const color = ws?.color ?? undefined
    if (ws?.category === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: color ?? 'rgb(34 197 94)' }} />
    if (ws?.category === 'canceled') return <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    return (
      <Circle
        className={cn('h-3.5 w-3.5 shrink-0', !color && 'text-muted-foreground')}
        style={color ? { color } : undefined}
        strokeWidth={2.25}
        strokeDasharray={ws?.category === 'backlog' ? '3 2' : undefined}
      />
    )
  }
  if (entityType === 'project') return <ProjectIcon icon={item.icon as string | null} size="xs" className="shrink-0" />
  return <Target className="h-3.5 w-3.5 shrink-0" style={item.color ? { color: item.color as string } : undefined} />
}

// ── An item's row ──────────────────────────────────────────

function ItemRow({
  rowKey, item, entityType, leftWidth, collapsedPanel, timelineWidth, origin, zoom, span, drag,
  selected, editable, hoverX, onHover, onOpen, onStartDrag, onMoveDrag, onEndDrag, onCancelDrag, onSchedule,
}: {
  rowKey: string
  item: Record<string, unknown>
  entityType: ViewEntityType
  leftWidth: number
  collapsedPanel: boolean
  timelineWidth: number
  origin: Date
  zoom: RoadmapZoom
  span: RoadmapSpan
  drag: DragState | null
  selected: boolean
  editable: boolean
  hoverX: number | null
  onHover: (x: number | null) => void
  onOpen: (e: React.MouseEvent) => void
  onStartDrag: (e: React.PointerEvent, mode: RoadmapDragMode) => void
  onMoveDrag: (e: React.PointerEvent) => void
  onEndDrag: (e: React.PointerEvent) => void
  onCancelDrag: () => void
  onSchedule: (day: Date) => void
}) {
  const title = getTitle(entityType, item) || 'Untitled'
  const shown = drag && drag.moved ? previewSpan(span, span.kind === 'marker' ? 'move' : drag.mode, drag.days) : span
  const box = spanBox(shown, origin, zoom)
  const px = PX_PER_DAY[zoom]
  const identifier = entityType === 'action' ? (item.identifier as string | undefined) : undefined

  const handlers = (mode: RoadmapDragMode) => editable ? {
    onPointerDown: (e: React.PointerEvent) => onStartDrag(e, mode),
    onPointerMove: onMoveDrag,
    onPointerUp: onEndDrag,
    onPointerCancel: onCancelDrag,
  } : {}

  const dateLabel = shown.start && shown.end
    ? (shown.kind === 'marker' || shown.start.getTime() === shown.end.getTime()
      ? format(shown.end, 'MMM d')
      : `${format(shown.start, 'MMM d')} – ${format(shown.end, 'MMM d')}`)
    : ''

  return (
    <>
      {/* Left list cell */}
      <div
        className={cn('sticky left-0 z-20 flex h-full items-center border-r border-border/60 px-1.5', GLASS)}
        style={{ width: leftWidth, minWidth: leftWidth }}
      >
        <button
          type="button"
          onClick={onOpen}
          data-roadmap-item={item.id as string}
          className={cn(
            'flex h-[30px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted/60',
            selected && 'bg-accent text-accent-foreground',
            collapsedPanel && 'justify-center px-0',
          )}
          title={collapsedPanel ? title : undefined}
        >
          <ItemIcon entityType={entityType} item={item} />
          {!collapsedPanel && (
            <>
              {identifier && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{identifier}</span>}
              <span className="truncate">{title}</span>
              {span.kind === 'none' && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/80">No date</span>}
            </>
          )}
        </button>
      </div>

      {/* Timeline cell */}
      <div
        className="relative h-full"
        style={{ width: timelineWidth }}
        onMouseMove={span.kind === 'none' && editable ? (e => onHover(e.clientX - e.currentTarget.getBoundingClientRect().left)) : undefined}
        onMouseLeave={span.kind === 'none' && editable ? () => onHover(null) : undefined}
        onClick={span.kind === 'none' && editable ? (e => onSchedule(xToDate(e.clientX - e.currentTarget.getBoundingClientRect().left, origin, zoom))) : undefined}
        data-roadmap-timeline={rowKey}
      >
        {span.kind === 'none' && editable && hoverX !== null && (
          <div
            className="pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-dashed border-primary/50 bg-primary/5 px-2 py-0.5 text-[11px] text-primary"
            style={{ left: Math.floor(hoverX / px) * px }}
          >
            Schedule · {format(xToDate(hoverX, origin, zoom), 'MMM d')}
          </div>
        )}

        {box && shown.kind === 'marker' && (
          <div
            className={cn('absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 select-none', editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer')}
            style={{ left: box.left + px / 2 - 6 }}
            {...handlers('move')}
            onClick={editable ? undefined : onOpen}
            data-roadmap-marker={item.id as string}
            title={`${title} · ${dateLabel}`}
          >
            <span className={cn(
              'h-3 w-3 shrink-0 rotate-45 rounded-[3px] border-2 border-primary bg-background shadow-sm',
              selected && 'bg-primary',
              drag?.moved && 'ring-2 ring-primary/30',
            )} />
            <span className="flex max-w-[260px] items-center gap-1.5 rounded-md bg-muted/80 px-1.5 py-0.5 text-xs ring-1 ring-border/60 dark:bg-white/[0.09] dark:ring-white/[0.14]">
              <ItemIcon entityType={entityType} item={item} />
              <span className="truncate">{title}</span>
              {drag?.moved && <span className="shrink-0 tabular-nums text-muted-foreground">{dateLabel}</span>}
            </span>
          </div>
        )}

        {box && shown.kind !== 'marker' && (
          <div
            className={cn(
              'group/bar absolute top-1/2 flex h-[26px] -translate-y-1/2 items-center rounded-md text-xs shadow-sm ring-1 select-none',
              'bg-muted ring-border/70 dark:bg-white/[0.09] dark:ring-white/[0.14]',
              selected && 'ring-2 ring-primary/60',
              drag?.moved && 'ring-2 ring-primary/50 shadow-md',
              editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
              shown.kind === 'open-end' && '[mask-image:linear-gradient(to_right,black_70%,transparent)]',
              shown.kind === 'open-start' && '[mask-image:linear-gradient(to_left,black_70%,transparent)]',
            )}
            style={{ left: box.left, width: Math.max(box.width, px) }}
            {...handlers('move')}
            onClick={editable ? undefined : onOpen}
            data-roadmap-bar={item.id as string}
            title={`${title} · ${dateLabel}`}
          >
            {editable && (
              <span
                className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize rounded-l-md opacity-0 transition-opacity group-hover/bar:opacity-100 bg-primary/40"
                {...handlers('start')}
                data-roadmap-handle="start"
              />
            )}
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden px-2">
              <ItemIcon entityType={entityType} item={item} />
              <span className="truncate">{title}</span>
              {drag?.moved && <span className="shrink-0 tabular-nums text-muted-foreground">{dateLabel}</span>}
            </span>
            {editable && (
              <span
                className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize rounded-r-md opacity-0 transition-opacity group-hover/bar:opacity-100 bg-primary/40"
                {...handlers('end')}
                data-roadmap-handle="end"
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}
