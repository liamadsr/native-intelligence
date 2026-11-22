'use client'

/**
 * The grid of one sheet: column letters across the top, row numbers down the
 * side, the cells between, and over them the selection, the fill handle and
 * the editor for the cell being typed in.
 *
 * Cost stays flat however large the sheet is. Only the rows and columns in
 * view are drawn (plus a few around them), and only the cells that have
 * something to show get an element: an empty sheet of 100,000 rows is a few
 * dozen header cells and grid lines. A cell is read from the engine once per
 * change of the workbook, not once per frame. Nothing animates while idle.
 *
 * It owns no data: every read and every change goes through the workbook's
 * controller (src/lib/spreadsheets/controller.ts).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { columnName, type CellRange, type CellRef } from '@/lib/spreadsheets/a1'
import { readCellView, type CellBorder, type CellView } from '@/lib/spreadsheets/cell-view'
import { parseTableHtml, sameClipboardText, tableHtml } from '@/lib/spreadsheets/clipboard'
import { indexAt, type InternalClipboard, type SheetLayout, type WorkbookController } from '@/lib/spreadsheets/controller'
import type { WorkbookTable } from '@/lib/spreadsheets/extras'
import { expectsReference, insertReference, isFormula, referenceText } from '@/lib/spreadsheets/formula-edit'
import { parseTsv, toTsv } from '@/components/grid/tsv'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { CfGlyph } from './cf-glyph'
import { FloatingObjects } from './floating-objects'
import { TableBackground, TableHeaders } from './table-overlay'
import { useWorkbook } from './use-workbook'

export const ROW_HEADER_WIDTH = 46
export const COLUMN_HEADER_HEIGHT = 26
const OVERSCAN_ROWS = 6
const OVERSCAN_COLUMNS = 3
/** How close to an edge of a header a press must be to resize instead of select. */
const RESIZE_GRIP = 5

/** The glass the headers wear, a step stronger than a card's so cells sliding under them are hidden (components/grid/cell-grid.tsx's rule). */
const HEADER_GLASS = 'bg-background/75 backdrop-blur-xl dark:bg-background/40'

/** This app's last copy: what a paste uses to keep formats and shift formulas, when the clipboard still holds its text. */
let internalClipboard: (InternalClipboard & { cut: boolean; from: WorkbookController }) | null = null

/**
 * Paste what the clipboard holds at the active cell. This app's own last
 * copy (when the clipboard still holds its text) keeps formats and shifts
 * formulas; anything else is pasted as typed values. `valuesOnly` pastes
 * even this app's copy as plain values.
 */
export function pasteInto(workbook: WorkbookController, text: string, html = '', options: { valuesOnly?: boolean } = {}): { ok: boolean; message?: string } {
  const mine = internalClipboard
  if (!options.valuesOnly && mine && mine.from === workbook && sameClipboardText(mine.text, text)) {
    const result = workbook.pasteInternal(mine, { cut: mine.cut })
    // What was cut has moved; a second paste is a plain copy of where it now is.
    if (mine.cut) internalClipboard = null
    return result
  }
  const block = text ? parseTsv(text) : []
  const rows = block.length ? block : ((html && parseTableHtml(html)) || [])
  return rows.length ? workbook.pasteValues(rows) : { ok: true }
}

export interface CaretState {
  /** Where the caret is in the draft (both ends of a selection). */
  start: number
  end: number
  /** The reference the last click on the grid put in, so the next click replaces it. */
  pointed: { start: number; end: number } | null
}

export interface SheetGridProps {
  workbook: WorkbookController
  /** The draft's caret, shared with the formula bar. */
  caret: React.MutableRefObject<CaretState>
  showGridlines?: boolean
  /** Show what was typed (formulas) instead of what it calculates to. */
  showFormulas?: boolean
  onMessage?: (message: string) => void
  /** A right-click: on a cell, a row header or a column header. */
  onContextMenu?: (target: GridMenuTarget, at: { x: number; y: number }) => void
  /** A key in the cell's editor, before the grid acts on it: true when something else (the suggestions list) took it. */
  onEditorKey?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** A click on a table column's header menu arrow. */
  onTableColumnMenu?: (table: WorkbookTable, offset: number, at: { x: number; y: number }) => void
  /** A double-click on a chart: open its Edit dialog. */
  onEditChart?: (id: string) => void
  /** Ctrl/Cmd+Alt+T: convert the selection to a table, or open the options when the cell is already in one. */
  onTableShortcut?: () => void
  /** An overlay drawn in the sheet's content space (scrolls with the cells): comment markers and an open thread. */
  renderOverlay?: (ctx: { sheet: number; layout: SheetLayout }) => React.ReactNode
  className?: string
  ariaLabel: string
}

export type GridMenuTarget = { kind: 'cell' } | { kind: 'row'; row: number } | { kind: 'column'; column: number }

interface Window2D {
  r1: number
  r2: number
  c1: number
  c2: number
}

function borderCss(b: CellBorder | null): string | undefined {
  return b ? `${b.width}px ${b.style} ${b.color}` : undefined
}

/** Where a conditional-formatting data bar sits in a cell: left and width in px, from the axis. */
function dataBarStyle(bar: NonNullable<CellView['dataBar']>, width: number): CSSProperties {
  const inner = Math.max(0, width - 4)
  const axisPx = bar.axis * inner
  const barWidth = Math.max(1, Math.round(bar.fraction * inner))
  const left = bar.negative ? Math.max(0, axisPx - barWidth) : axisPx
  return { left: left + 2, width: Math.min(barWidth, inner - (left)), backgroundColor: bar.color, opacity: 0.55 }
}

function cellStyle(view: CellView, left: number, top: number, width: number, height: number, overflowTo: number | null): CSSProperties {
  const style: CSSProperties = {
    position: 'absolute',
    left,
    top,
    width: overflowTo ?? width,
    height,
    fontSize: view.fontPx,
    lineHeight: view.wrap ? 1.25 : `${Math.max(1, height - 2)}px`,
    justifyContent: view.align === 'right' ? 'flex-end' : view.align === 'center' ? 'center' : 'flex-start',
    alignItems: view.wrap ? (view.valign === 'top' ? 'flex-start' : view.valign === 'middle' ? 'center' : 'flex-end') : 'center',
    textAlign: view.align,
  }
  if (view.bold) style.fontWeight = 600
  if (view.italic) style.fontStyle = 'italic'
  if (view.underline || view.strike) style.textDecoration = [view.underline && 'underline', view.strike && 'line-through'].filter(Boolean).join(' ')
  if (view.color) style.color = view.color
  if (view.fontFamily) style.fontFamily = `"${view.fontFamily}", var(--font-sans, inherit)`
  if (view.fill) {
    style.backgroundColor = view.fill
    style.width = width
  }
  const top_ = borderCss(view.borderTop)
  const right = borderCss(view.borderRight)
  const bottom = borderCss(view.borderBottom)
  const left_ = borderCss(view.borderLeft)
  if (top_) style.borderTop = top_
  if (right) style.borderRight = right
  if (bottom) style.borderBottom = bottom
  if (left_) style.borderLeft = left_
  return style
}

interface CellsProps {
  workbook: WorkbookController
  sheet: number
  layout: SheetLayout
  window: Window2D
  dataVersion: number
  showGridlines: boolean
  showFormulas: boolean
  /** The cell being edited in place is not drawn under its editor. */
  hide: string | null
}

/** The cells in view. Redrawn when the workbook's data or the window changes, not when the selection moves. */
const Cells = memo(function Cells({ workbook, sheet, layout, window: w, dataVersion, showGridlines, showFormulas, hide }: CellsProps) {
  const cache = useRef<{ key: string; views: Map<number, CellView> }>({ key: '', views: new Map() })
  const key = `${sheet}:${dataVersion}:${showFormulas ? 1 : 0}`
  if (cache.current.key !== key) cache.current = { key, views: new Map() }
  const views = cache.current.views
  const { rowStarts, columnStarts } = layout
  const model = workbook.model

  const nodes: React.ReactNode[] = []
  if (showGridlines) {
    const width = columnStarts[w.c2] - columnStarts[w.c1 - 1]
    const height = rowStarts[w.r2] - rowStarts[w.r1 - 1]
    for (let r = w.r1; r <= w.r2; r++) {
      if (rowStarts[r] === rowStarts[r - 1]) continue
      nodes.push(<div key={`h${r}`} aria-hidden className="pointer-events-none absolute h-px bg-border/60" style={{ left: columnStarts[w.c1 - 1], top: rowStarts[r] - 1, width }} />)
    }
    for (let c = w.c1; c <= w.c2; c++) {
      if (columnStarts[c] === columnStarts[c - 1]) continue
      nodes.push(<div key={`v${c}`} aria-hidden className="pointer-events-none absolute w-px bg-border/60" style={{ left: columnStarts[c] - 1, top: rowStarts[w.r1 - 1], height }} />)
    }
  }
  for (let r = w.r1; r <= w.r2; r++) {
    const top = rowStarts[r - 1]
    const height = rowStarts[r] - top
    if (height <= 0) continue
    // The engine says which columns of the row hold anything; a row with none costs one call.
    const filled = model.getColumnsWithData(sheet, r)
    if (!filled.length) continue
    for (let i = 0; i < filled.length; i++) {
      const c = filled[i]
      if (c > w.c2) break
      const id = r * 16385 + c
      if (c < w.c1) {
        // A cell left of the window still shows when its text runs into view.
        if (i + 1 < filled.length && filled[i + 1] <= w.c1) continue
      }
      let view = views.get(id)
      if (!view) {
        view = readCellView(model, sheet, r, c)
        if (showFormulas) {
          const input = model.getCellContent(sheet, r, c)
          if (input.startsWith('=')) view = { ...view, text: input, align: 'left' }
        }
        views.set(id, view)
      }
      if (view.blank) continue
      const left = columnStarts[c - 1]
      const width = columnStarts[c] - left
      if (width <= 0) continue
      if (c < w.c1 && (view.align !== 'left' || view.wrap || view.fill)) continue
      if (hide === `${r}:${c}`) continue
      // A checkbox cell draws its box through the controls overlay, not its TRUE/FALSE text here.
      const checkbox = workbook.isCheckboxCell(r, c, sheet)
      // Text that does not fit runs over the empty cells to its right, up to the next filled one.
      let overflowTo: number | null = null
      if (view.text && view.align === 'left' && !view.wrap && !view.fill && !view.dataBar && !view.icon) {
        const next = i + 1 < filled.length ? filled[i + 1] : layout.columns + 1
        const limit = Math.min(next, c + 40, layout.columns + 1)
        if (limit > c + 1) overflowTo = columnStarts[limit - 1] - left
      }
      // A rule's data bar or icon can hide the value (show_value false).
      const hideText = checkbox || (view.dataBar !== null && !view.dataBar.showValue) || (view.icon !== null && !view.icon.showValue)
      nodes.push(
        <div
          key={id}
          role="gridcell"
          aria-rowindex={r}
          aria-colindex={c}
          data-cell={`${columnName(c)}${r}`}
          className={cn(
            'pointer-events-none box-border flex overflow-hidden px-1.5 text-foreground',
            view.wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
            view.error && !view.color && 'text-destructive',
            (view.dataBar || view.icon) && 'relative',
          )}
          style={cellStyle(view, left, top, width, height, overflowTo)}
        >
          {view.dataBar && <span aria-hidden data-data-bar className="pointer-events-none absolute bottom-0.5 top-0.5 rounded-sm" style={dataBarStyle(view.dataBar, width)} />}
          {view.icon && (
            <span aria-hidden data-cf-icon className="pointer-events-none relative z-[1] mr-1 inline-flex shrink-0 items-center">
              <CfGlyph kind={view.icon.kind} color={view.icon.color} />
            </span>
          )}
          {!hideText && (view.wrap ? <span className="relative z-[1]">{view.text}</span> : <span className="relative z-[1] min-w-0 overflow-hidden text-clip">{view.text}</span>)}
        </div>,
      )
    }
  }
  return <>{nodes}</>
})

interface ControlsProps {
  workbook: WorkbookController
  sheet: number
  layout: SheetLayout
  window: Window2D
  dataVersion: number
  onToggle: (row: number, column: number) => void
  onOpenList: (row: number, column: number) => void
}

/**
 * The interactive marks over the cells that data holds but the engine's style
 * does not: a checkbox, a dropdown arrow, a choice's color chip, a warning
 * corner. Drawn for the validated and checkbox cells in view (nothing when the
 * sheet has none), so an empty cell under a rule still shows its arrow.
 */
const GridControls = memo(function GridControls({ workbook, sheet, layout, window: w, onToggle, onOpenList }: ControlsProps) {
  const sheetId = workbook.sheetIdAt(sheet)
  const extras = workbook.extras
  const hasValidations = extras.validations.some((v) => v.sheetId === sheetId)
  const hasCheckboxes = extras.checkboxes.some((b) => b.sheetId === sheetId)
  if (!hasValidations && !hasCheckboxes) return null
  const { rowStarts, columnStarts } = layout
  const nodes: React.ReactNode[] = []
  for (let r = w.r1; r <= w.r2; r++) {
    const top = rowStarts[r - 1]
    const height = rowStarts[r] - top
    if (height <= 0) continue
    for (let c = w.c1; c <= w.c2; c++) {
      const left = columnStarts[c - 1]
      const width = columnStarts[c] - left
      if (width <= 0) continue
      if (hasCheckboxes && workbook.isCheckboxCell(r, c, sheet)) {
        const checked = workbook.checkboxChecked(r, c, sheet)
        nodes.push(
          <button
            key={`cb${r}:${c}`}
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={`${columnName(c)}${r} checkbox`}
            data-checkbox={`${columnName(c)}${r}`}
            className="absolute flex items-center justify-center bg-background"
            style={{ left, top, width, height }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onToggle(r, c)
            }}
          >
            <span className={cn('flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/60')}>
              {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
            </span>
          </button>,
        )
        continue
      }
      if (!hasValidations) continue
      const vv = workbook.validationView(r, c, sheet)
      if (!vv) continue
      if (vv.chipColor) {
        nodes.push(<span key={`chip${r}:${c}`} aria-hidden className="pointer-events-none absolute z-[2] rounded-full" style={{ left: left + 3, top: top + height / 2 - 4, width: 8, height: 8, backgroundColor: vv.chipColor }} />)
      }
      if (vv.warn) {
        nodes.push(
          <span key={`warn${r}:${c}`} aria-hidden data-validation-warning={`${columnName(c)}${r}`} title="This value is not one the rule allows." className="pointer-events-none absolute z-[2] text-amber-500" style={{ left: left + width - 12, top: top + 1 }}>
            <AlertTriangle className="h-2.5 w-2.5" fill="currentColor" />
          </span>,
        )
      }
      if (vv.isList) {
        nodes.push(
          <button
            key={`dd${r}:${c}`}
            type="button"
            aria-label={`Open the list for ${columnName(c)}${r}`}
            data-dropdown-arrow={`${columnName(c)}${r}`}
            className="absolute flex items-center justify-center rounded-l-sm bg-background/80 text-muted-foreground hover:text-foreground"
            style={{ left: left + width - 16, top: top + 1, width: 15, height: height - 2 }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onOpenList(r, c)
            }}
          >
            <ChevronDown className="h-3 w-3" />
          </button>,
        )
      }
    }
  }
  return <>{nodes}</>
})

/**
 * The list a dropdown cell opens: its choices under the cell, moved through
 * with the arrows, chosen with Enter, closed with Escape, narrowed by typing.
 */
function DropdownListbox({
  workbook,
  cell,
  layout,
  onClose,
  onMessage,
}: {
  workbook: WorkbookController
  cell: CellRef
  layout: SheetLayout
  onClose: () => void
  onMessage?: (message: string) => void
}) {
  const choices = workbook.listChoicesAt(cell.row, cell.column)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const visible = filter ? choices.filter((c) => c.value.toLowerCase().includes(filter.toLowerCase())) : choices
  const at = Math.min(active, Math.max(0, visible.length - 1))
  const rect = rectOf(layout, { r1: cell.row, c1: cell.column, r2: cell.row, c2: cell.column })
  const choose = (value: string) => {
    const result = workbook.chooseValue(cell.row, cell.column, value)
    if (!result.ok && result.message) onMessage?.(result.message)
    onClose()
  }
  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={0}
      aria-label="Choices"
      data-dropdown-list
      className="absolute z-30 max-h-56 min-w-[120px] overflow-y-auto rounded-md border border-border/70 bg-background py-1 shadow-lg outline-none"
      style={{ left: rect.left, top: rect.top + rect.height, maxWidth: 240, minWidth: Math.max(120, rect.width) }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((a) => Math.min(visible.length - 1, a + 1))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((a) => Math.max(0, a - 1))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (visible[at]) choose(visible[at].value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        } else if (event.key === 'Backspace') {
          event.preventDefault()
          setFilter((f) => f.slice(0, -1))
          setActive(0)
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
          event.preventDefault()
          setFilter((f) => f + event.key)
          setActive(0)
        }
      }}
    >
      {visible.length === 0 ? (
        <div className="px-2 py-1 text-[12px] text-muted-foreground">No matches</div>
      ) : (
        visible.map((choice, i) => (
          <div
            key={`${choice.value}:${i}`}
            role="option"
            aria-selected={i === at}
            className={cn('flex cursor-pointer items-center gap-1.5 px-2 py-1 text-[12.5px] text-foreground', i === at && 'bg-accent')}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => choose(choice.value)}
            onMouseEnter={() => setActive(i)}
          >
            {choice.color && <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: choice.color }} />}
            <span className="truncate">{choice.value}</span>
          </div>
        ))
      )}
    </div>
  )
}

function rectOf(layout: SheetLayout, range: CellRange): { left: number; top: number; width: number; height: number } {
  const r1 = Math.min(range.r1, layout.rows)
  const r2 = Math.min(range.r2, layout.rows)
  const c1 = Math.min(range.c1, layout.columns)
  const c2 = Math.min(range.c2, layout.columns)
  const left = layout.columnStarts[c1 - 1]
  const top = layout.rowStarts[r1 - 1]
  return { left, top, width: layout.columnStarts[c2] - left, height: layout.rowStarts[r2] - top }
}

export function SheetGrid({ workbook, caret, showGridlines = true, showFormulas = false, onMessage, onContextMenu, onEditorKey, onTableColumnMenu, onEditChart, onTableShortcut, renderOverlay, className, ariaLabel }: SheetGridProps) {
  useWorkbook(workbook)
  const sheet = workbook.sheet
  const layout = workbook.layout(sheet)
  const selection = workbook.selection()
  const editing = workbook.editing
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const columnStrip = useRef<HTMLDivElement>(null)
  const rowStrip = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const [scroll, setScroll] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [fillPreview, setFillPreview] = useState<CellRange | null>(null)
  // The dashed rectangle while a range is dragged by its border, and a confirm
  // held until the person agrees to overwrite the cells it would land on.
  const [movePreview, setMovePreview] = useState<CellRange | null>(null)
  const [moveConfirm, setMoveConfirm] = useState<{ row: number; column: number } | null>(null)
  const [pointing, setPointing] = useState<{ sheet: number; range: CellRange } | null>(null)
  const [listCell, setListCell] = useState<CellRef | null>(null)
  const [selectedObject, setSelectedObject] = useState<string | null>(null)
  const drag = useRef<null | { kind: 'select' | 'rows' | 'columns' | 'fill' | 'point' | 'move' | 'extend' | 'resize-column' | 'resize-row'; from: CellRef; index?: number; start?: number; size?: number; delta?: { row: number; column: number }; corner?: 'tl' | 'br'; origin?: CellRange }>(null)
  const frame = useRef(0)
  const say = useCallback((result: { ok: boolean; message?: string }) => {
    if (!result.ok && result.message) onMessage?.(result.message)
  }, [onMessage])
  const toggleCheckbox = useCallback((row: number, column: number) => {
    workbook.select(row, column)
    say(workbook.toggleCheckbox(row, column))
  }, [workbook, say])
  const openList = useCallback((row: number, column: number) => {
    workbook.select(row, column)
    setListCell({ row, column })
  }, [workbook])

  const { rowStarts, columnStarts } = layout
  const totalWidth = columnStarts[layout.columns]
  const totalHeight = rowStarts[layout.rows]

  // ── What is in view ──────────────────────────────────────────────────────
  const view = useMemo<Window2D>(() => {
    const viewWidth = Math.max(0, scroll.width - ROW_HEADER_WIDTH)
    const viewHeight = Math.max(0, scroll.height - COLUMN_HEADER_HEIGHT)
    const r1 = Math.max(1, indexAt(rowStarts, scroll.top) + 1 - OVERSCAN_ROWS)
    const r2 = Math.min(layout.rows, indexAt(rowStarts, scroll.top + viewHeight) + 1 + OVERSCAN_ROWS)
    const c1 = Math.max(1, indexAt(columnStarts, scroll.left) + 1 - OVERSCAN_COLUMNS)
    const c2 = Math.min(layout.columns, indexAt(columnStarts, scroll.left + viewWidth) + 1 + OVERSCAN_COLUMNS)
    return { r1, r2, c1, c2 }
  }, [scroll, rowStarts, columnStarts, layout.rows, layout.columns])

  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setScroll((prev) =>
      prev.left === el.scrollLeft && prev.top === el.scrollTop && prev.width === el.clientWidth && prev.height === el.clientHeight
        ? prev
        : { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight },
    )
  }, [])

  useLayoutEffect(() => {
    measure()
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  const onScroll = useCallback(() => {
    // The header strips follow in the same frame as the scroll, not a frame behind it.
    const now = scroller.current
    if (now) {
      if (columnStrip.current) columnStrip.current.style.transform = `translateX(${-now.scrollLeft}px)`
      if (rowStrip.current) rowStrip.current.style.transform = `translateY(${-now.scrollTop}px)`
    }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      measure()
      const el = scroller.current
      if (!el) return
      // Near the bottom or the right edge: there is more sheet.
      if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) workbook.growBy(100, 0)
      if (el.scrollLeft + el.clientWidth > el.scrollWidth - 200) workbook.growBy(0, 10)
    })
  }, [measure, workbook])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // ── Keep the cell that moved in view ─────────────────────────────────────
  const focus = workbook.focusOf(selection)
  const band = workbook.selectedBand()
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || drag.current) return
    const row = Math.min(focus.row, layout.rows)
    const column = Math.min(focus.column, layout.columns)
    const top = rowStarts[row - 1]
    const bottom = rowStarts[row]
    const left = columnStarts[column - 1]
    const right = columnStarts[column]
    const viewHeight = el.clientHeight - COLUMN_HEADER_HEIGHT
    const viewWidth = el.clientWidth - ROW_HEADER_WIDTH
    if (!band.columns) {
      if (top < el.scrollTop) el.scrollTop = top
      else if (bottom > el.scrollTop + viewHeight) el.scrollTop = bottom - viewHeight
    }
    if (!band.rows) {
      if (left < el.scrollLeft) el.scrollLeft = left
      else if (right > el.scrollLeft + viewWidth) el.scrollLeft = right - viewWidth
    }
    // Only when the focus cell or the sheet changes; scrolling by hand must not snap back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.row, focus.column, sheet])

  // ── From a pointer to a cell ─────────────────────────────────────────────
  const cellAt = useCallback(
    (clientX: number, clientY: number): CellRef => {
      const el = scroller.current
      if (!el) return { row: 1, column: 1 }
      const box = el.getBoundingClientRect()
      const x = clientX - box.left - ROW_HEADER_WIDTH + el.scrollLeft
      const y = clientY - box.top - COLUMN_HEADER_HEIGHT + el.scrollTop
      return { row: indexAt(rowStarts, Math.max(0, y)) + 1, column: indexAt(columnStarts, Math.max(0, x)) + 1 }
    },
    [rowStarts, columnStarts],
  )

  /** While a formula is typed with the caret where a reference goes, a click on the grid points instead of selecting. */
  const canPoint = useCallback((): boolean => {
    const edit = workbook.editing
    if (!edit || !isFormula(edit.draft)) return false
    const c = caret.current
    return Boolean(c.pointed) || expectsReference(edit.draft, c.start)
  }, [workbook, caret])

  const point = useCallback(
    (range: CellRange) => {
      const edit = workbook.editing
      if (!edit) return
      const c = caret.current
      const sheets = workbook.sheets()
      const other = workbook.sheet !== edit.sheet ? sheets[workbook.sheet]?.name : null
      const next = insertReference(edit.draft, c.start, referenceText(range, other), c.pointed)
      caret.current = { start: next.end, end: next.end, pointed: { start: next.start, end: next.end } }
      workbook.setDraft(next.draft)
      setPointing({ sheet: workbook.sheet, range })
    },
    [workbook, caret],
  )

  useEffect(() => {
    if (!editing) setPointing(null)
    else setListCell(null)
  }, [editing])

  // ── The mouse ────────────────────────────────────────────────────────────
  const onCellsPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return
    const at = cellAt(event.clientX, event.clientY)
    if (event.button === 2) {
      // A right-click inside the selection keeps it; outside, it moves there.
      const { range } = workbook.selection()
      const inside = at.row >= range.r1 && at.row <= range.r2 && at.column >= range.c1 && at.column <= range.c2
      if (!inside && !workbook.editing) workbook.select(at.row, at.column)
      return
    }
    setSelectedObject(null)
    if (workbook.editing) {
      if (canPoint()) {
        event.preventDefault()
        drag.current = { kind: 'point', from: at }
        point({ r1: at.row, c1: at.column, r2: at.row, c2: at.column })
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      say(workbook.commitEdit())
    }
    if (event.shiftKey) workbook.extendTo(at.row, at.column)
    else workbook.select(at.row, at.column)
    drag.current = { kind: 'select', from: at }
    event.currentTarget.setPointerCapture(event.pointerId)
    host.current?.focus({ preventScroll: true })
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const at = cellAt(event.clientX, event.clientY)
    if (d.kind === 'select') workbook.extendTo(at.row, at.column)
    else if (d.kind === 'rows') workbook.selectRows(d.from.row, at.row)
    else if (d.kind === 'columns') workbook.selectColumns(d.from.column, at.column)
    else if (d.kind === 'point') {
      point({ r1: Math.min(d.from.row, at.row), c1: Math.min(d.from.column, at.column), r2: Math.max(d.from.row, at.row), c2: Math.max(d.from.column, at.column) })
    } else if (d.kind === 'fill') {
      const { range } = workbook.selection()
      const down = at.row > range.r2 ? at.row - range.r2 : 0
      const up = at.row < range.r1 ? range.r1 - at.row : 0
      const right = at.column > range.c2 ? at.column - range.c2 : 0
      const left = at.column < range.c1 ? range.c1 - at.column : 0
      if (Math.max(down, up) >= Math.max(right, left)) {
        setFillPreview(down || up ? { ...range, r1: Math.min(range.r1, at.row), r2: Math.max(range.r2, at.row) } : null)
      } else {
        setFillPreview({ ...range, c1: Math.min(range.c1, at.column), c2: Math.max(range.c2, at.column) })
      }
      d.from = at
    } else if (d.kind === 'extend' && d.origin && d.corner) {
      // A touch handle on the selection's corner, on a phone: it extends the
      // range, keeping the opposite corner fixed.
      const base = d.origin
      if (d.corner === 'br') workbook.selectRange({ r1: base.r1, c1: base.c1, r2: Math.max(base.r1, at.row), c2: Math.max(base.c1, at.column) }, { row: base.r1, column: base.c1 })
      else workbook.selectRange({ r1: Math.min(base.r2, at.row), c1: Math.min(base.c2, at.column), r2: base.r2, c2: base.c2 }, { row: base.r2, column: base.c2 })
    } else if (d.kind === 'move') {
      const base = workbook.selection().range
      // Grab-and-move: the range follows the cell under the pointer, never off the top-left.
      const dRow = Math.max(1 - base.r1, at.row - d.from.row)
      const dColumn = Math.max(1 - base.c1, at.column - d.from.column)
      d.delta = { row: dRow, column: dColumn }
      setMovePreview(dRow === 0 && dColumn === 0 ? null : { r1: base.r1 + dRow, c1: base.c1 + dColumn, r2: base.r2 + dRow, c2: base.c2 + dColumn })
    } else if (d.kind === 'resize-column' && d.index && d.start !== undefined && d.size !== undefined) {
      setResize({ kind: 'column', index: d.index, size: Math.max(8, Math.min(640, d.size + event.clientX - d.start)) })
    } else if (d.kind === 'resize-row' && d.index && d.start !== undefined && d.size !== undefined) {
      setResize({ kind: 'row', index: d.index, size: Math.max(8, Math.min(640, d.size + event.clientY - d.start)) })
    }
  }

  const [resize, setResize] = useState<{ kind: 'column' | 'row'; index: number; size: number } | null>(null)

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!d) return
    if (d.kind === 'fill') {
      setFillPreview(null)
      say(workbook.fillTo(d.from))
    } else if (d.kind === 'move') {
      setMovePreview(null)
      const delta = d.delta ?? { row: 0, column: 0 }
      if (delta.row === 0 && delta.column === 0) return
      // Ask before writing over cells that already hold something.
      if (workbook.moveWouldOverwrite(delta.row, delta.column)) setMoveConfirm(delta)
      else say(workbook.moveSelection(delta.row, delta.column))
    } else if (d.kind === 'point') {
      editorRef.current?.focus()
    } else if ((d.kind === 'resize-column' || d.kind === 'resize-row') && resize) {
      const { range } = workbook.selection()
      const whole = workbook.selectedBand()
      if (resize.kind === 'column') {
        // Dragging the edge of one of several selected columns resizes them all.
        const many = whole.columns && resize.index >= range.c1 && resize.index <= range.c2
        say(workbook.setColumnWidth(many ? range.c1 : resize.index, many ? range.c2 : resize.index, resize.size))
      } else {
        const many = whole.rows && resize.index >= range.r1 && resize.index <= range.r2
        say(workbook.setRowHeight(many ? range.r1 : resize.index, many ? range.r2 : resize.index, resize.size))
      }
      setResize(null)
    }
  }

  // Grab the selection's border to move the range. The cell under the pointer
  // is the grip; the range then follows it (onPointerMove, kind 'move').
  const beginMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || workbook.readOnly || workbook.editing) return
    event.stopPropagation()
    event.preventDefault()
    drag.current = { kind: 'move', from: cellAt(event.clientX, event.clientY), delta: { row: 0, column: 0 } }
    event.currentTarget.setPointerCapture(event.pointerId)
    host.current?.focus({ preventScroll: true })
  }

  // A touch handle on a selection corner (phones): drag to extend the range.
  const beginExtend = (corner: 'tl' | 'br') => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    drag.current = { kind: 'extend', from: cellAt(event.clientX, event.clientY), corner, origin: workbook.selection().range }
    event.currentTarget.setPointerCapture(event.pointerId)
    host.current?.focus({ preventScroll: true })
  }

  const measureText = useCallback((text: string, row: number, column: number): number => {
    const canvas = (measureText as unknown as { canvas?: HTMLCanvasElement }).canvas ?? document.createElement('canvas')
    ;(measureText as unknown as { canvas?: HTMLCanvasElement }).canvas = canvas
    const context = canvas.getContext('2d')
    if (!context) return text.length * 7.5 + 14
    const cell = readCellView(workbook.model, workbook.sheet, row, column)
    const family = getComputedStyle(scroller.current ?? document.body).fontFamily
    context.font = `${cell.italic ? 'italic ' : ''}${cell.bold ? 600 : 400} ${cell.fontPx}px ${cell.fontFamily ? `"${cell.fontFamily}", ` : ''}${family}`
    const widest = Math.max(...text.split('\n').map((line) => context.measureText(line).width))
    return widest + 14
  }, [workbook])

  const onColumnHeaderDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return
    const el = scroller.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const x = event.clientX - box.left - ROW_HEADER_WIDTH + el.scrollLeft
    let column = indexAt(columnStarts, Math.max(0, x)) + 1
    if (event.button === 2) {
      const { range } = workbook.selection()
      if (!(workbook.selectedBand().columns && column >= range.c1 && column <= range.c2)) workbook.selectColumns(column)
      return
    }
    if (workbook.editing) say(workbook.commitEdit())
    // Near a column's right edge (or the left edge of the next one): resize it.
    const nearRight = columnStarts[column] - x <= RESIZE_GRIP
    const nearLeft = x - columnStarts[column - 1] <= RESIZE_GRIP && column > 1
    if (!workbook.readOnly && (nearRight || nearLeft)) {
      if (!nearRight) column -= 1
      // A hidden column has no width: the grip belongs to the last visible one before it.
      while (column > 1 && columnStarts[column] === columnStarts[column - 1]) column -= 1
      if (event.detail >= 2) {
        say(workbook.fitColumns(column, column, measureText))
        return
      }
      const size = columnStarts[column] - columnStarts[column - 1]
      drag.current = { kind: 'resize-column', from: { row: 1, column }, index: column, start: event.clientX, size }
      setResize({ kind: 'column', index: column, size })
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (event.shiftKey) workbook.selectColumns(workbook.selection().column, column)
    else workbook.selectColumns(column)
    drag.current = { kind: 'columns', from: { row: 1, column: event.shiftKey ? workbook.selection().column : column } }
    event.currentTarget.setPointerCapture(event.pointerId)
    host.current?.focus({ preventScroll: true })
  }

  const onRowHeaderDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return
    const el = scroller.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const y = event.clientY - box.top - COLUMN_HEADER_HEIGHT + el.scrollTop
    let row = indexAt(rowStarts, Math.max(0, y)) + 1
    if (event.button === 2) {
      const { range } = workbook.selection()
      if (!(workbook.selectedBand().rows && row >= range.r1 && row <= range.r2)) workbook.selectRows(row)
      return
    }
    if (workbook.editing) say(workbook.commitEdit())
    const nearBottom = rowStarts[row] - y <= RESIZE_GRIP
    const nearTop = y - rowStarts[row - 1] <= RESIZE_GRIP && row > 1
    if (!workbook.readOnly && (nearBottom || nearTop)) {
      if (!nearBottom) row -= 1
      while (row > 1 && rowStarts[row] === rowStarts[row - 1]) row -= 1
      const size = rowStarts[row] - rowStarts[row - 1]
      drag.current = { kind: 'resize-row', from: { row, column: 1 }, index: row, start: event.clientY, size }
      setResize({ kind: 'row', index: row, size })
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (event.shiftKey) workbook.selectRows(workbook.selection().row, row)
    else workbook.selectRows(row)
    drag.current = { kind: 'rows', from: { row: event.shiftKey ? workbook.selection().row : row, column: 1 } }
    event.currentTarget.setPointerCapture(event.pointerId)
    host.current?.focus({ preventScroll: true })
  }

  const [headerCursor, setHeaderCursor] = useState<'col-resize' | 'row-resize' | null>(null)
  const onHeaderHover = (event: React.PointerEvent<HTMLDivElement>, axis: 'column' | 'row') => {
    if (drag.current || workbook.readOnly) return
    const el = scroller.current
    if (!el) return
    const box = el.getBoundingClientRect()
    if (axis === 'column') {
      const x = event.clientX - box.left - ROW_HEADER_WIDTH + el.scrollLeft
      const column = indexAt(columnStarts, Math.max(0, x)) + 1
      const near = columnStarts[column] - x <= RESIZE_GRIP || (x - columnStarts[column - 1] <= RESIZE_GRIP && column > 1)
      setHeaderCursor(near ? 'col-resize' : null)
    } else {
      const y = event.clientY - box.top - COLUMN_HEADER_HEIGHT + el.scrollTop
      const row = indexAt(rowStarts, Math.max(0, y)) + 1
      const near = rowStarts[row] - y <= RESIZE_GRIP || (y - rowStarts[row - 1] <= RESIZE_GRIP && row > 1)
      setHeaderCursor(near ? 'row-resize' : null)
    }
  }

  // ── The keyboard ─────────────────────────────────────────────────────────
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys typed into a field that lives inside the grid (a comment or reply
    // box, a chart title) belong to that field, not to the cells.
    const from = event.target as HTMLElement
    if (from !== event.currentTarget && (from.tagName === 'TEXTAREA' || from.tagName === 'INPUT' || from.tagName === 'SELECT' || from.isContentEditable)) return
    if (workbook.editing) return
    if (event.nativeEvent.isComposing) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key
    // Escape cancels a border drag in progress (the move is not made).
    if (key === 'Escape' && drag.current?.kind === 'move') {
      event.preventDefault()
      drag.current = null
      setMovePreview(null)
      return
    }
    // Ctrl/Cmd+Alt+T: convert the selection to a table (or open its options when already in one).
    if (mod && event.altKey && key.toLowerCase() === 't') {
      event.preventDefault()
      onTableShortcut?.()
      return
    }
    const arrows: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
    const active = workbook.selection()
    // Alt+Down opens the dropdown under the active cell; Space toggles a checkbox there.
    if (event.altKey && key === 'ArrowDown' && workbook.listChoicesAt(active.row, active.column).length > 0) {
      event.preventDefault()
      openList(active.row, active.column)
      return
    }
    if (key === ' ' && !mod && !event.altKey && !workbook.readOnly && workbook.isCheckboxCell(active.row, active.column)) {
      event.preventDefault()
      toggleCheckbox(active.row, active.column)
      return
    }
    if (arrows[key]) {
      event.preventDefault()
      workbook.move(arrows[key], { extend: event.shiftKey, edge: mod })
      return
    }
    if (key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) workbook.move('up')
      else workbook.startEdit()
      return
    }
    if (key === 'F2') {
      event.preventDefault()
      workbook.startEdit()
      return
    }
    if (key === 'Tab') {
      event.preventDefault()
      workbook.move(event.shiftKey ? 'left' : 'right')
      return
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault()
      say(workbook.clearSelection())
      return
    }
    if (key === 'Home') {
      event.preventDefault()
      if (mod) workbook.select(1, 1)
      else if (event.shiftKey) workbook.extendTo(workbook.focusOf(workbook.selection()).row, 1)
      else workbook.select(workbook.selection().row, 1)
      return
    }
    if (key === 'End') {
      event.preventDefault()
      workbook.move('right', { edge: true, extend: event.shiftKey })
      return
    }
    if (key === 'PageDown' || key === 'PageUp') {
      event.preventDefault()
      const el = scroller.current
      const page = Math.max(1, Math.floor(((el?.clientHeight ?? 400) - COLUMN_HEADER_HEIGHT) / 25) - 1)
      const { row, column } = workbook.selection()
      workbook.select(key === 'PageDown' ? Math.min(layout.rows, row + page) : Math.max(1, row - page), column)
      return
    }
    if (mod && !event.altKey) {
      const lower = key.toLowerCase()
      if (lower === 'a') {
        event.preventDefault()
        workbook.selectAll()
      } else if (lower === 'z') {
        event.preventDefault()
        say(event.shiftKey ? workbook.redo() : workbook.undo())
      } else if (lower === 'y') {
        event.preventDefault()
        say(workbook.redo())
      } else if (lower === 'd') {
        event.preventDefault()
        say(workbook.fillDown())
      } else if (lower === 'r') {
        event.preventDefault()
        say(workbook.fillRight())
      } else if (lower === 'b' || lower === 'i' || lower === 'u') {
        event.preventDefault()
        const { row, column } = workbook.selection()
        const font = workbook.style(row, column).font
        const on = lower === 'b' ? font.b : lower === 'i' ? font.i : font.u
        say(workbook.setStyle(`font.${lower}`, on ? 'false' : 'true'))
      }
      return
    }
    // A printable key starts typing over what the cell holds.
    if (key.length === 1 && !event.altKey && !workbook.readOnly) {
      event.preventDefault()
      caret.current = { start: 1, end: 1, pointed: null }
      workbook.startEdit({ initial: key })
    }
  }

  // ── The clipboard ────────────────────────────────────────────────────────
  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>, cut = false) => {
    if (workbook.editing) return
    const values = workbook.selectionValues()
    if (!values) {
      event.preventDefault()
      onMessage?.('That is more than can be copied at once.')
      return
    }
    const text = toTsv(values)
    const clip = workbook.copy()
    internalClipboard = { ...clip.internal, text, cut, from: workbook }
    event.clipboardData.setData('text/plain', text)
    event.clipboardData.setData('text/html', tableHtml(values))
    event.preventDefault()
  }

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (workbook.editing || workbook.readOnly) return
    event.preventDefault()
    say(pasteInto(workbook, event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html')))
  }

  // ── The editor in the cell ───────────────────────────────────────────────
  const editorCell = editing && editing.sheet === sheet ? { row: editing.row, column: editing.column } : null
  const editorRect = editorCell ? rectOf(layout, { r1: editorCell.row, c1: editorCell.column, r2: editorCell.row, c2: editorCell.column }) : null
  const editorView = useMemo(
    () => (editorCell ? readCellView(workbook.model, sheet, editorCell.row, editorCell.column) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorCell?.row, editorCell?.column, sheet, workbook],
  )

  useLayoutEffect(() => {
    const el = editorRef.current
    if (!el || !editing || editing.source !== 'cell') return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    const c = caret.current
    const start = Math.min(c.start, el.value.length)
    const end = Math.min(c.end, el.value.length)
    if (el.selectionStart !== start || el.selectionEnd !== end) el.setSelectionRange(start, end)
  }, [editing, caret])

  const onEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (onEditorKey?.(event)) return
    if (event.key === 'Enter' && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      say(workbook.commitEdit(event.shiftKey ? 'up' : 'down'))
      host.current?.focus({ preventScroll: true })
    } else if (event.key === 'Enter' && event.altKey) {
      // Alt+Enter: a new line inside the cell.
      event.preventDefault()
      const el = event.currentTarget
      const at = el.selectionStart ?? el.value.length
      const next = `${el.value.slice(0, at)}\n${el.value.slice(el.selectionEnd ?? at)}`
      caret.current = { start: at + 1, end: at + 1, pointed: null }
      workbook.setDraft(next, 'cell')
    } else if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      say(workbook.commitEdit(event.shiftKey ? 'left' : 'right'))
      host.current?.focus({ preventScroll: true })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      workbook.cancelEdit()
      host.current?.focus({ preventScroll: true })
    } else if (event.key === 'F4') {
      event.preventDefault()
      const el = event.currentTarget
      try {
        const [text, start, end] = workbook.model.cycleReference(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0)
        caret.current = { start, end, pointed: null }
        workbook.setDraft(text, 'cell')
      } catch {
        // The caret is not on a reference.
      }
    }
  }

  const syncCaret = (el: HTMLTextAreaElement, typed: boolean) => {
    const prev = caret.current
    caret.current = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0, pointed: typed ? null : prev.pointed }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  const range = selection.range
  const rangeRect = rectOf(layout, range)
  const activeRect = rectOf(layout, { r1: selection.row, c1: selection.column, r2: selection.row, c2: selection.column })
  const single = range.r1 === range.r2 && range.c1 === range.c2
  const hole = {
    x: activeRect.left - rangeRect.left,
    y: activeRect.top - rangeRect.top,
  }
  const tintClip = `path(evenodd, "M0 0H${rangeRect.width}V${rangeRect.height}H0Z M${hole.x} ${hole.y}H${hole.x + activeRect.width}V${hole.y + activeRect.height}H${hole.x}Z")`

  const columnHeaders: React.ReactNode[] = []
  for (let c = view.c1; c <= view.c2; c++) {
    const left = columnStarts[c - 1]
    const width = (resize?.kind === 'column' && resize.index === c ? resize.size : columnStarts[c] - left)
    if (width <= 0) {
      // A sliver marks where columns are hidden.
      columnHeaders.push(<div key={`x${c}`} aria-hidden className="absolute top-1 bottom-1 w-[3px] rounded-full bg-primary/40" style={{ left: left - 1 }} />)
      continue
    }
    const selected = c >= range.c1 && c <= range.c2
    columnHeaders.push(
      <div
        key={c}
        role="columnheader"
        aria-colindex={c}
        aria-selected={selected}
        className={cn(
          'absolute top-0 flex h-full select-none items-center justify-center border-r border-border/60 text-[11px] font-medium tabular-nums text-muted-foreground',
          selected && (band.columns ? 'bg-primary/20 text-foreground' : 'bg-primary/[0.08] text-foreground'),
        )}
        style={{ left, width }}
      >
        {columnName(c)}
      </div>,
    )
  }

  const rowHeaders: React.ReactNode[] = []
  for (let r = view.r1; r <= view.r2; r++) {
    const top = rowStarts[r - 1]
    const height = resize?.kind === 'row' && resize.index === r ? resize.size : rowStarts[r] - top
    if (height <= 0) {
      rowHeaders.push(<div key={`x${r}`} aria-hidden className="absolute left-1 right-1 h-[3px] rounded-full bg-primary/40" style={{ top: top - 1 }} />)
      continue
    }
    const selected = r >= range.r1 && r <= range.r2
    rowHeaders.push(
      <div
        key={r}
        role="rowheader"
        aria-rowindex={r}
        aria-selected={selected}
        className={cn(
          'absolute left-0 flex w-full select-none items-center justify-center border-b border-border/60 text-[11px] tabular-nums text-muted-foreground',
          selected && (band.rows ? 'bg-primary/20 text-foreground' : 'bg-primary/[0.08] text-foreground'),
        )}
        style={{ top, height }}
      >
        {r}
      </div>,
    )
  }

  const pointRect = pointing && pointing.sheet === sheet ? rectOf(layout, pointing.range) : null
  const previewRect = fillPreview ? rectOf(layout, fillPreview) : null
  const moveRect = movePreview ? rectOf(layout, movePreview) : null
  // A thin band on each edge of the selection, where a grab starts a move.
  const canMove = !workbook.readOnly && !editing && rangeRect.width > 0 && rangeRect.height > 0
  // On a narrow (phone) grid, two big touch handles on the selection's corners
  // extend it; a mouse uses Shift+click and the small fill handle instead.
  const narrow = scroll.width > 0 && scroll.width < 480
  const touchHandles = narrow && !editing && rangeRect.width > 0 && rangeRect.height > 0
  const activeName = `${columnName(selection.column)}${selection.row}`

  return (
    <div
      ref={host}
      role="grid"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-rowcount={layout.rows}
      aria-colcount={layout.columns}
      aria-readonly={workbook.readOnly || undefined}
      data-active-cell={activeName}
      className={cn('relative h-full w-full overflow-hidden outline-none', className)}
      style={{ contain: 'strict' }}
      onKeyDown={onKeyDown}
      onCopy={(e) => onCopy(e)}
      onCut={(e) => {
        if (workbook.readOnly) return
        onCopy(e, true)
      }}
      onPaste={onPaste}
      onContextMenu={(event) => {
        if (!onContextMenu) return
        event.preventDefault()
        const el = scroller.current
        if (!el) return
        const box = el.getBoundingClientRect()
        const overColumns = event.clientY - box.top < COLUMN_HEADER_HEIGHT
        const overRows = event.clientX - box.left < ROW_HEADER_WIDTH
        const at = cellAt(event.clientX, event.clientY)
        const target: GridMenuTarget = overColumns && !overRows ? { kind: 'column', column: at.column } : overRows && !overColumns ? { kind: 'row', row: at.row } : { kind: 'cell' }
        onContextMenu(target, { x: event.clientX, y: event.clientY })
      }}
    >
      {/*
        The headers are panes the size of the view, laid over the scrolling cells, not strips as long as
        the sheet: a blurred pane 250,000 pixels tall costs every frame of a scroll. Their letters and
        numbers are moved under them by the scroll handler.
      */}
      <div
        data-column-headers
        className={cn('absolute right-0 top-0 z-30 overflow-hidden border-b border-border/70', HEADER_GLASS)}
        style={{ left: ROW_HEADER_WIDTH, height: COLUMN_HEADER_HEIGHT, cursor: headerCursor === 'col-resize' ? 'col-resize' : undefined }}
        onPointerDown={onColumnHeaderDown}
        onPointerMove={(e) => {
          onHeaderHover(e, 'column')
          onPointerMove(e)
        }}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHeaderCursor(null)}
        onWheel={(e) => scroller.current?.scrollBy(e.deltaX || e.deltaY, 0)}
      >
        <div ref={columnStrip} className="absolute inset-y-0 left-0 will-change-transform" style={{ width: totalWidth, transform: `translateX(${-scroll.left}px)` }}>
          {columnHeaders}
        </div>
      </div>
      <div
        data-row-headers
        className={cn('absolute bottom-0 left-0 z-20 overflow-hidden border-r border-border/70', HEADER_GLASS)}
        style={{ top: COLUMN_HEADER_HEIGHT, width: ROW_HEADER_WIDTH, cursor: headerCursor === 'row-resize' ? 'row-resize' : undefined }}
        onPointerDown={onRowHeaderDown}
        onPointerMove={(e) => {
          onHeaderHover(e, 'row')
          onPointerMove(e)
        }}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHeaderCursor(null)}
        onWheel={(e) => scroller.current?.scrollBy(0, e.deltaY)}
      >
        <div ref={rowStrip} className="absolute inset-x-0 top-0 will-change-transform" style={{ height: totalHeight, transform: `translateY(${-scroll.top}px)` }}>
          {rowHeaders}
        </div>
      </div>
      {/* The corner: selects everything. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Select all cells"
        className={cn('absolute left-0 top-0 z-40 border-b border-r border-border/70', HEADER_GLASS, band.rows && band.columns && 'bg-primary/20')}
        style={{ width: ROW_HEADER_WIDTH, height: COLUMN_HEADER_HEIGHT }}
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          if (workbook.editing) say(workbook.commitEdit())
          workbook.selectAll()
          host.current?.focus({ preventScroll: true })
        }}
      />

      <div ref={scroller} data-sheet-scroller className="absolute inset-0 overflow-auto overscroll-contain" onScroll={onScroll}>
       <div style={{ width: totalWidth + ROW_HEADER_WIDTH, height: totalHeight + COLUMN_HEADER_HEIGHT, position: 'relative' }}>
        {/* The cells. */}
        <div
          className="absolute cursor-cell select-none"
          style={{ left: ROW_HEADER_WIDTH, top: COLUMN_HEADER_HEIGHT, width: totalWidth, height: totalHeight }}
          onPointerDown={onCellsPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => {
            if (!workbook.editing) {
              const text = workbook.input(selection.row, selection.column)
              caret.current = { start: text.length, end: text.length, pointed: null }
              workbook.startEdit()
            }
          }}
        >
          {/* Table tints and outline, behind the cell text. */}
          <TableBackground workbook={workbook} sheet={sheet} layout={layout} window={view} />

          <Cells
            workbook={workbook}
            sheet={sheet}
            layout={layout}
            window={view}
            dataVersion={workbook.dataVersion}
            showGridlines={showGridlines}
            showFormulas={showFormulas}
            hide={editorCell && editing?.source === 'cell' ? `${editorCell.row}:${editorCell.column}` : null}
          />

          {/* Checkboxes, dropdown arrows, choice chips and warning corners. */}
          <GridControls workbook={workbook} sheet={sheet} layout={layout} window={view} dataVersion={workbook.dataVersion} onToggle={toggleCheckbox} onOpenList={openList} />

          {/* Table header bars, their column menu arrows and the total-row divider, over the cells. */}
          {onTableColumnMenu && <TableHeaders workbook={workbook} sheet={sheet} layout={layout} window={view} onColumnMenu={onTableColumnMenu} />}

          {/* Charts and images floating over the sheet. */}
          <FloatingObjects workbook={workbook} sheet={sheet} layout={layout} selectedId={selectedObject} onSelect={setSelectedObject} onEditChart={(id) => onEditChart?.(id)} onMessage={onMessage} />

          {/* Comment markers and an open thread, in the sheet's content space. */}
          {renderOverlay?.({ sheet, layout })}

          {/* The selected range: a tint that leaves the active cell clear. */}
          {!single && rangeRect.width > 0 && rangeRect.height > 0 && (
            <div
              aria-hidden
              data-selection-range={`${columnName(range.c1)}${range.r1}:${columnName(range.c2)}${range.r2}`}
              className="pointer-events-none absolute bg-primary/[0.12]"
              style={{ ...rangeRect, clipPath: tintClip }}
            />
          )}
          {!single && <div aria-hidden className="pointer-events-none absolute border border-primary/70" style={rangeRect} />}
          {/* The active cell. */}
          {activeRect.width > 0 && activeRect.height > 0 && (
            <div aria-hidden className="pointer-events-none absolute z-10 border-2 border-primary" style={activeRect} />
          )}
          {/* Grab the selection's edge to move the range (cursor: move). Four
              thin bands leave the interior free to click and the corner free
              for the fill handle (rendered after, so it wins the corner). */}
          {canMove && (
            <>
              <div data-move-edge="top" className="absolute z-10 cursor-move" style={{ left: rangeRect.left, top: rangeRect.top - 3, width: rangeRect.width, height: 6 }} onPointerDown={beginMove} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
              <div data-move-edge="bottom" className="absolute z-10 cursor-move" style={{ left: rangeRect.left, top: rangeRect.top + rangeRect.height - 3, width: rangeRect.width, height: 6 }} onPointerDown={beginMove} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
              <div data-move-edge="left" className="absolute z-10 cursor-move" style={{ left: rangeRect.left - 3, top: rangeRect.top, width: 6, height: rangeRect.height }} onPointerDown={beginMove} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
              <div data-move-edge="right" className="absolute z-10 cursor-move" style={{ left: rangeRect.left + rangeRect.width - 3, top: rangeRect.top, width: 6, height: rangeRect.height }} onPointerDown={beginMove} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
            </>
          )}
          {/* Where the dragged range would land. */}
          {moveRect && <div aria-hidden data-move-preview className="pointer-events-none absolute z-20 border-2 border-dashed border-primary bg-primary/[0.06]" style={moveRect} />}
          {/* Phone: two big touch handles on the selection's corners extend it. */}
          {touchHandles && (
            <>
              <div
                role="presentation"
                data-touch-handle="tl"
                className="absolute z-20 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow"
                style={{ left: rangeRect.left, top: rangeRect.top }}
                onPointerDown={beginExtend('tl')}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
              <div
                role="presentation"
                data-touch-handle="br"
                className="absolute z-20 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow"
                style={{ left: rangeRect.left + rangeRect.width, top: rangeRect.top + rangeRect.height }}
                onPointerDown={beginExtend('br')}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            </>
          )}
          {/* The fill handle, at the range's bottom-right corner. */}
          {!workbook.readOnly && !editing && rangeRect.width > 0 && rangeRect.height > 0 && (
            <div
              role="presentation"
              data-fill-handle
              className="absolute z-10 h-[9px] w-[9px] cursor-crosshair rounded-[2px] border border-background bg-primary"
              style={{ left: rangeRect.left + rangeRect.width - 5, top: rangeRect.top + rangeRect.height - 5 }}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                event.preventDefault()
                drag.current = { kind: 'fill', from: { row: range.r2, column: range.c2 } }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          )}
          {previewRect && <div aria-hidden className="pointer-events-none absolute z-10 border border-dashed border-primary" style={previewRect} />}
          {pointRect && <div aria-hidden className="pointer-events-none absolute z-10 border-2 border-dashed border-primary/80 bg-primary/[0.06]" style={pointRect} />}
          {/* A header edge being dragged. */}
          {resize?.kind === 'column' && (
            <div aria-hidden className="pointer-events-none absolute top-0 z-20 w-px bg-primary" style={{ left: columnStarts[resize.index - 1] + resize.size, height: totalHeight }} />
          )}
          {resize?.kind === 'row' && (
            <div aria-hidden className="pointer-events-none absolute left-0 z-20 h-px bg-primary" style={{ top: rowStarts[resize.index - 1] + resize.size, width: totalWidth }} />
          )}

          {/* The editor: it wears the cell's own font, color and fill, and grows with what is typed. */}
          {editorRect && editing && editorView && (
            <textarea
              ref={editorRef}
              data-formula-input="cell"
              aria-label={`Editing ${columnName(editing.column)}${editing.row}`}
              value={editing.draft}
              rows={1}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(
                'absolute z-20 box-border resize-none overflow-hidden whitespace-pre border-2 border-primary bg-background px-1.5 py-0 text-foreground shadow-md outline-none',
                editing.source === 'bar' && 'pointer-events-none',
              )}
              style={{
                left: editorRect.left,
                top: editorRect.top,
                minWidth: editorRect.width,
                width: `calc(${Math.max(editing.draft.split('\n').reduce((m, l) => Math.max(m, l.length), 0), 1)}ch + 20px)`,
                maxWidth: Math.max(editorRect.width, scroll.width - ROW_HEADER_WIDTH - (editorRect.left - scroll.left) - 8),
                minHeight: editorRect.height,
                height: Math.max(editorRect.height, editing.draft.split('\n').length * Math.round(editorView.fontPx * 1.5) + 4),
                fontSize: editorView.fontPx,
                lineHeight: `${Math.max(editorRect.height - 4, Math.round(editorView.fontPx * 1.5))}px`,
                fontWeight: editorView.bold ? 600 : undefined,
                fontStyle: editorView.italic ? 'italic' : undefined,
                color: editorView.color ?? undefined,
                backgroundColor: editorView.fill ?? undefined,
                fontFamily: editorView.fontFamily ? `"${editorView.fontFamily}", inherit` : undefined,
              }}
              onChange={(event) => {
                syncCaret(event.currentTarget, true)
                workbook.setDraft(event.currentTarget.value, 'cell')
              }}
              onSelect={(event) => syncCaret(event.currentTarget, false)}
              onKeyDown={onEditorKeyDown}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onFocus={() => {
                if (workbook.editing && workbook.editing.source !== 'cell') workbook.setDraft(workbook.editing.draft, 'cell')
              }}
            />
          )}

          {/* The dropdown's choices, under the cell. */}
          {listCell && !editing && (
            <DropdownListbox
              workbook={workbook}
              cell={listCell}
              layout={layout}
              onMessage={onMessage}
              onClose={() => {
                setListCell(null)
                host.current?.focus({ preventScroll: true })
              }}
            />
          )}
        </div>
       </div>
      </div>
      {/* Overwrite confirm for a border move onto cells that hold values. */}
      {moveConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/40" role="dialog" aria-modal="true" aria-label="Replace cells?">
          <div className={cn(FLOATING_CARD_CLASS, 'w-64 p-3 shadow-lg')}>
            <p className="text-sm text-foreground">Replace the cells there?</p>
            <p className="mt-1 text-xs text-muted-foreground">The cells this range lands on already hold values.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => {
                  setMoveConfirm(null)
                  host.current?.focus({ preventScroll: true })
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-move-confirm
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => {
                  say(workbook.moveSelection(moveConfirm.row, moveConfirm.column))
                  setMoveConfirm(null)
                  host.current?.focus({ preventScroll: true })
                }}
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
