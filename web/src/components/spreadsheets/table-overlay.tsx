'use client'

/**
 * A table's look, drawn over the grid without writing any cell formats into the
 * engine: the colored header row with its per-column menu arrow, banded rows and
 * columns, the outline and the total-row divider. `TableBackground` sits behind
 * the cell text (tints), `TableHeaders` over it (the opaque header and arrows).
 */
import { ChevronDown } from 'lucide-react'
import type { SheetLayout, WorkbookController } from '@/lib/spreadsheets/controller'
import { tableParts, type WorkbookTable } from '@/lib/spreadsheets/extras'

interface Window2D {
  r1: number
  r2: number
  c1: number
  c2: number
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(100,116,139,${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function rect(layout: SheetLayout, r1: number, c1: number, r2: number, c2: number) {
  const left = layout.columnStarts[Math.min(c1, layout.columns) - 1]
  const top = layout.rowStarts[Math.min(r1, layout.rows) - 1]
  return { left, top, width: layout.columnStarts[Math.min(c2, layout.columns)] - left, height: layout.rowStarts[Math.min(r2, layout.rows)] - top }
}

export function TableBackground({ workbook, sheet, layout, window: w }: { workbook: WorkbookController; sheet: number; layout: SheetLayout; window: Window2D }) {
  const tables = workbook.tables(sheet)
  if (!tables.length) return null
  const nodes: React.ReactNode[] = []
  for (const t of tables) {
    if (t.range.r1 > w.r2 || t.range.r2 < w.r1 || t.range.c1 > w.c2 || t.range.c2 < w.c1) continue
    const { dataR1, dataR2 } = tableParts(t)
    if (t.style.bandedRows) {
      for (let r = Math.max(dataR1, w.r1); r <= Math.min(dataR2, w.r2); r++) {
        if ((r - dataR1) % 2 === 1) {
          const box = rect(layout, r, t.range.c1, r, t.range.c2)
          if (box.height > 0) nodes.push(<div key={`br${t.id}-${r}`} aria-hidden className="pointer-events-none absolute" style={{ ...box, backgroundColor: hexToRgba(t.style.color, 0.08) }} />)
        }
      }
    }
    if (t.style.bandedColumns) {
      for (let c = Math.max(t.range.c1, w.c1); c <= Math.min(t.range.c2, w.c2); c++) {
        if ((c - t.range.c1) % 2 === 1) {
          const box = rect(layout, dataR1, c, dataR2, c)
          if (box.width > 0 && box.height > 0) nodes.push(<div key={`bc${t.id}-${c}`} aria-hidden className="pointer-events-none absolute" style={{ ...box, backgroundColor: hexToRgba(t.style.color, 0.06) }} />)
        }
      }
    }
    const outline = rect(layout, t.range.r1, t.range.c1, t.range.r2, t.range.c2)
    nodes.push(<div key={`ol${t.id}`} aria-hidden className="pointer-events-none absolute rounded-[2px]" style={{ ...outline, border: `1px solid ${hexToRgba(t.style.color, 0.5)}` }} />)
  }
  return <>{nodes}</>
}

export function TableHeaders({
  workbook,
  sheet,
  layout,
  window: w,
  onColumnMenu,
}: {
  workbook: WorkbookController
  sheet: number
  layout: SheetLayout
  window: Window2D
  onColumnMenu: (table: WorkbookTable, offset: number, at: { x: number; y: number }) => void
}) {
  const tables = workbook.tables(sheet)
  if (!tables.length) return null
  const nodes: React.ReactNode[] = []
  for (const t of tables) {
    const header = t.range.r1
    const { total } = tableParts(t)
    if (header >= w.r1 && header <= w.r2 && t.range.c1 <= w.c2 && t.range.c2 >= w.c1) {
      for (let c = Math.max(t.range.c1, w.c1); c <= Math.min(t.range.c2, w.c2); c++) {
        const offset = c - t.range.c1
        const box = rect(layout, header, c, header, c)
        if (box.width <= 0 || box.height <= 0) continue
        const filtered = Boolean(t.filters[offset])
        nodes.push(
          <div
            key={`th${t.id}-${c}`}
            aria-hidden
            className="pointer-events-none absolute flex items-center overflow-hidden px-1.5 text-[12px] font-semibold text-white"
            style={{ ...box, backgroundColor: t.style.color }}
          >
            <span className="min-w-0 flex-1 truncate">{t.columns[offset]?.name ?? ''}</span>
          </div>,
        )
        nodes.push(
          <button
            key={`ta${t.id}-${c}`}
            type="button"
            aria-label={`Column options for ${t.columns[offset]?.name ?? ''}`}
            data-table-column-menu={`${t.id}:${offset}`}
            className="absolute flex items-center justify-center rounded-sm text-white/90 hover:bg-black/15"
            style={{ left: box.left + box.width - 17, top: box.top + 2, width: 15, height: box.height - 4 }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onColumnMenu(t, offset, { x: event.clientX, y: event.clientY })
            }}
          >
            <ChevronDown className="h-3 w-3" />
            {filtered && <span aria-hidden className="absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full bg-white" />}
          </button>,
        )
      }
    }
    if (total !== null && total >= w.r1 && total <= w.r2 && t.range.c1 <= w.c2 && t.range.c2 >= w.c1) {
      const box = rect(layout, total, t.range.c1, total, t.range.c2)
      if (box.width > 0) nodes.push(<div key={`tt${t.id}`} aria-hidden className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: 0, borderTop: `2px solid ${t.style.color}` }} />)
    }
  }
  return <>{nodes}</>
}
