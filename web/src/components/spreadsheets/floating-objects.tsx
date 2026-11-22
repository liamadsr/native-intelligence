'use client'

/**
 * Charts and images floating over the grid. Each is anchored to a cell, so it
 * scrolls with the sheet (it lives in the scroller's own content space). One
 * can be selected, dragged to move, resized by its bottom-right corner, and
 * deleted; every one of those is an undo step through the controller.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { indexAt, type SheetLayout, type WorkbookController } from '@/lib/spreadsheets/controller'
import { prepareChartData } from '@/lib/spreadsheets/charts'
import type { Anchor, WorkbookChart, WorkbookImage } from '@/lib/spreadsheets/extras'
import { ChartView } from './charts/chart-view'
import { useWorkbook } from './use-workbook'

interface Props {
  workbook: WorkbookController
  sheet: number
  layout: SheetLayout
  selectedId: string | null
  onSelect: (id: string | null) => void
  onEditChart: (id: string) => void
  onMessage?: (message: string) => void
}

function anchorLeft(layout: SheetLayout, anchor: Anchor): number {
  return layout.columnStarts[Math.min(anchor.column, layout.columns) - 1] + anchor.dx
}
function anchorTop(layout: SheetLayout, anchor: Anchor): number {
  return layout.rowStarts[Math.min(anchor.row, layout.rows) - 1] + anchor.dy
}
function toAnchor(layout: SheetLayout, left: number, top: number): Anchor {
  const column = indexAt(layout.columnStarts, Math.max(0, left)) + 1
  const row = indexAt(layout.rowStarts, Math.max(0, top)) + 1
  return { row, column, dx: left - layout.columnStarts[column - 1], dy: top - layout.rowStarts[row - 1] }
}

export function FloatingObjects({ workbook, sheet, layout, selectedId, onSelect, onEditChart, onMessage }: Props) {
  useWorkbook(workbook)
  const charts = workbook.charts(sheet)
  const images = workbook.images(sheet)
  if (!charts.length && !images.length) return null
  const say = (result: { ok: boolean; message?: string }) => {
    if (!result.ok && result.message) onMessage?.(result.message)
  }
  return (
    <>
      {charts.map((chart) => (
        <FloatingBox
          key={chart.id}
          id={chart.id}
          left={anchorLeft(layout, chart.anchor)}
          top={anchorTop(layout, chart.anchor)}
          width={chart.width}
          height={chart.height}
          selected={selectedId === chart.id}
          readOnly={workbook.readOnly}
          label={`Chart${chart.title ? `: ${chart.title}` : ''}`}
          onSelect={() => onSelect(chart.id)}
          onDoubleClick={() => onEditChart(chart.id)}
          onMove={(left, top) => say(workbook.moveChart(chart.id, toAnchor(layout, left, top)))}
          onResize={(w, h) => say(workbook.resizeChart(chart.id, w, h))}
          onDelete={() => {
            say(workbook.deleteChart(chart.id))
            onSelect(null)
          }}
        >
          <ChartContents workbook={workbook} chart={chart} />
        </FloatingBox>
      ))}
      {images.map((image) => (
        <FloatingBox
          key={image.id}
          id={image.id}
          left={anchorLeft(layout, image.anchor)}
          top={anchorTop(layout, image.anchor)}
          width={image.width}
          height={image.height}
          selected={selectedId === image.id}
          readOnly={workbook.readOnly}
          aspect={image.width / image.height}
          label="Image"
          onSelect={() => onSelect(image.id)}
          onMove={(left, top) => say(workbook.moveImage(image.id, toAnchor(layout, left, top)))}
          onResize={(w, h) => say(workbook.resizeImage(image.id, w, h))}
          onDelete={() => {
            say(workbook.deleteImage(image.id))
            onSelect(null)
          }}
        >
          <img src={workbook.imageUrl(image.hash)} alt="" draggable={false} className="pointer-events-none h-full w-full select-none object-contain" />
        </FloatingBox>
      ))}
    </>
  )
}

function ChartContents({ workbook, chart }: { workbook: WorkbookController; chart: WorkbookChart }) {
  // Re-read on every data change so the chart follows its range.
  const grid = workbook.chartGrid(chart)
  const prepared = prepareChartData(grid, chart.type)
  return <ChartView type={chart.type} title={chart.title} legend={chart.legend} prepared={prepared} width={chart.width} height={chart.height} />
}

interface BoxProps {
  id: string
  left: number
  top: number
  width: number
  height: number
  selected: boolean
  readOnly: boolean
  label: string
  aspect?: number
  onSelect: () => void
  onDoubleClick?: () => void
  onMove: (left: number, top: number) => void
  onResize: (width: number, height: number) => void
  onDelete: () => void
  children: React.ReactNode
}

function FloatingBox({ left, top, width, height, selected, readOnly, label, aspect, onSelect, onDoubleClick, onMove, onResize, onDelete, children }: BoxProps) {
  const [drag, setDrag] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const start = useRef<{ x: number; y: number; left: number; top: number; width: number; height: number; mode: 'move' | 'resize' } | null>(null)
  const box = drag ?? { left, top, width, height }

  const onPointerDown = (event: ReactPointerEvent, mode: 'move' | 'resize') => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    onSelect()
    if (readOnly) return
    start.current = { x: event.clientX, y: event.clientY, left, top, width, height, mode }
    setDrag({ left, top, width, height })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent) => {
    const s = start.current
    if (!s) return
    const dx = event.clientX - s.x
    const dy = event.clientY - s.y
    if (s.mode === 'move') setDrag({ left: Math.max(0, s.left + dx), top: Math.max(0, s.top + dy), width: s.width, height: s.height })
    else {
      let w = Math.max(120, s.width + dx)
      let h = Math.max(90, s.height + dy)
      if (aspect) h = Math.round(w / aspect)
      setDrag({ left: s.left, top: s.top, width: w, height: h })
    }
  }
  const onPointerUp = (event: ReactPointerEvent) => {
    const s = start.current
    start.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!s || !drag) return
    if (s.mode === 'move') onMove(drag.left, drag.top)
    else onResize(drag.width, drag.height)
    setDrag(null)
  }

  return (
    <div
      role="group"
      aria-label={label}
      data-floating-object
      tabIndex={0}
      className={cn(
        'absolute overflow-hidden rounded-lg border bg-background/90 shadow-sm backdrop-blur-sm outline-none',
        selected ? 'z-20 border-primary ring-1 ring-primary' : 'z-[15] border-border/60',
      )}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick?.()
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
          e.preventDefault()
          e.stopPropagation()
          onDelete()
        }
      }}
    >
      <div className="pointer-events-none h-full w-full">{children}</div>
      {selected && !readOnly && (
        <>
          <button
            type="button"
            aria-label={`Delete ${label}`}
            className="absolute right-1 top-1 z-10 rounded bg-background/80 p-0.5 text-muted-foreground hover:text-destructive"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <div
            role="presentation"
            data-resize-handle
            className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize rounded-tl border-l border-t border-primary bg-primary/20"
            onPointerDown={(e) => onPointerDown(e, 'resize')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </>
      )}
    </div>
  )
}
