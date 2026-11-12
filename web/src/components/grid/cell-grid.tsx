'use client'

/**
 * A general cell grid: rows and columns, a sticky header and a sticky first
 * column, keyboard moves and edits, range selection, TSV copy and paste,
 * column resize and drag to reorder. It knows nothing about what it shows:
 * the owner passes the rows, the columns, and how a cell renders, edits and
 * copies. Tables use it (src/components/tables); a spreadsheet can too.
 *
 * Cost stays flat: rows and columns are virtualized (@tanstack/react-virtual,
 * fixed row height, nothing measured), a row re-renders only when its own
 * cells' state changes, and nothing animates or loops while idle (no rAF, no
 * transitions on cells). The keyboard model is ./selection.ts.
 *
 * Accessibility: role grid with rows, column headers and gridcells,
 * aria-selected on the selected cells, aria-activedescendant on the active
 * one (always rendered: the virtualizer pins its row and column).
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import {
  afterEdit,
  clampSelection,
  collapsed,
  gridKey,
  inRange,
  pasteTargets,
  selectionRange,
  type CellPos,
  type CellRange,
  type EditMove,
  type GridSelection,
} from './selection'
import { parseTsv, toTsv } from './tsv'

export interface GridColumn {
  id: string
  /** What a screen reader calls it. */
  label: string
  width: number
  minWidth?: number
  header: ReactNode
  /** Drag it to another place (the sticky first column never moves). Default true. */
  movable?: boolean
  /** Default true. */
  resizable?: boolean
}

export interface CellEditorProps {
  /** The character that started the edit: it replaces the value. */
  initial?: string
  /**
   * The edit is saved (by the editor): close it. A move (or null: stay)
   * moves the active cell and takes focus back to the grid; no argument (a
   * blur) leaves both where the click put them.
   */
  done: (move?: EditMove) => void
  /** Close it without saving. */
  cancel: () => void
}

export interface PasteTarget {
  /** At or past `rows.length`: a new row. */
  row: number
  col: number
  text: string
}

export interface CellGridApi {
  select: (pos: CellPos, opts?: { edit?: boolean }) => void
  focus: () => void
  selection: () => GridSelection
}

export interface CellGridProps<R> {
  rows: readonly R[]
  getRowId: (row: R) => string
  columns: readonly GridColumn[]
  renderCell: (row: R, column: GridColumn, rowIndex: number) => ReactNode
  renderEditor?: (row: R, column: GridColumn, rowIndex: number, editor: CellEditorProps) => ReactNode
  /** A cell's text on the clipboard. */
  copyText: (row: R, column: GridColumn) => string
  readOnly?: boolean
  canEdit?: (row: R, column: GridColumn) => boolean
  /** An edit is asked for: true when handled with no editor (a checkbox toggles). */
  onActivate?: (pos: CellPos, row: R, column: GridColumn, initial?: string) => boolean
  onPaste?: (targets: PasteTarget[]) => void
  onClear?: (range: CellRange) => void
  onColumnResize?: (id: string, width: number) => void
  /** To this index in `columns` (it never lands on 0). */
  onColumnMove?: (id: string, toIndex: number) => void
  onHeaderClick?: (id: string) => void
  /** Keys the grid leaves alone (⌘Z): true when handled. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => boolean
  onContextMenuCell?: (pos: CellPos) => void
  /** Near the last loaded row: load more. */
  onReachEnd?: () => void
  /** Enter on the last row: the owner may add one. */
  onEditPastEnd?: () => void
  /** A cell after the last column's header (the + to add one). */
  headerTrailing?: { width: number; node: ReactNode }
  /** Under the last row (+ New). */
  footer?: ReactNode
  rowHeight?: number
  headerHeight?: number
  ariaLabel: string
  apiRef?: React.MutableRefObject<CellGridApi | null>
  className?: string
}

const ROW_H = 33
const HEADER_H = 33
const FOOTER_H = 33
const MIN_W = 60

type Live = { id: string; width: number } | null
type Drag = { from: number; startX: number; moved: boolean; pointer: number }

/** Everything a row needs that isn't its own state, read through a ref so rows stay memoized. */
interface RowCtx {
  gridId: string
  columns: readonly GridColumn[]
  widths: number[]
  renderCell: (row: unknown, column: GridColumn, rowIndex: number) => ReactNode
  renderEditor?: (row: unknown, column: GridColumn, rowIndex: number, editor: CellEditorProps) => ReactNode
  editor: CellEditorProps
  trailing: number
}

export function CellGrid<R>(props: CellGridProps<R>) {
  const {
    rows,
    getRowId,
    columns,
    readOnly = false,
    rowHeight = ROW_H,
    headerHeight = HEADER_H,
    headerTrailing,
    footer,
  } = props
  const gridId = useId().replace(/:/g, '')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<GridSelection>(collapsed({ row: 0, col: 0 }))
  const [editing, setEditing] = useState<{ pos: CellPos; initial?: string } | null>(null)
  const [live, setLive] = useState<Live>(null)
  const [dropX, setDropX] = useState<number | null>(null)
  const dragging = useRef(false)
  const drag = useRef<Drag | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const selRef = useRef(selection)
  selRef.current = selection
  const editingRef = useRef(editing)
  editingRef.current = editing

  const widths = useMemo(
    () => columns.map((c) => Math.max(c.minWidth ?? MIN_W, live?.id === c.id ? live.width : c.width)),
    [columns, live],
  )
  const firstW = widths[0] ?? 0
  const colsWidth = widths.reduce((a, b) => a + b, 0)
  const trailingW = headerTrailing?.width ?? 0
  const totalW = colsWidth + trailingW
  const bounds = { rows: rows.length, cols: columns.length }

  // The active and edited cells always render (the virtualizer pins them).
  const pinRows = useRef<number[]>([])
  pinRows.current = [selection.anchor.row, ...(editing ? [editing.pos.row] : [])]
  const pinCols = useRef<number[]>([])
  pinCols.current = [selection.anchor.col - 1, ...(editing ? [editing.pos.col - 1] : [])]
  const withPins = (pins: React.MutableRefObject<number[]>, count: number) => (range: Range) => {
    const base = defaultRangeExtractor(range)
    const extra = pins.current.filter((i) => i >= 0 && i < count && !base.includes(i))
    return extra.length ? [...base, ...extra].sort((a, b) => a - b) : base
  }

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    paddingStart: headerHeight,
    scrollPaddingStart: headerHeight,
    scrollPaddingEnd: footer ? FOOTER_H : 0,
    getItemKey: (i) => getRowId(rows[i]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    rangeExtractor: useCallback(withPins(pinRows, rows.length), [rows.length]),
  })
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: Math.max(0, columns.length - 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i + 1] ?? MIN_W,
    overscan: 3,
    paddingStart: firstW,
    scrollPaddingStart: firstW,
    getItemKey: (i) => columns[i + 1]?.id ?? i,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    rangeExtractor: useCallback(withPins(pinCols, Math.max(0, columns.length - 1)), [columns.length]),
  })
  // Sizes come from the props: tell the virtualizer when they change.
  const widthsKey = widths.join(',')
  useLayoutEffect(() => {
    colVirtualizer.measure()
  }, [widthsKey, colVirtualizer])
  useLayoutEffect(() => {
    rowVirtualizer.measure()
  }, [rowHeight, rowVirtualizer])

  // Rows or columns went away: keep the selection inside.
  useEffect(() => {
    setSelection((s) => {
      const next = clampSelection(s, bounds)
      return next.anchor.row === s.anchor.row && next.anchor.col === s.anchor.col && next.focus.row === s.focus.row && next.focus.col === s.focus.col ? s : next
    })
    if (editing && (editing.pos.row >= bounds.rows || editing.pos.col >= bounds.cols)) setEditing(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.rows, bounds.cols])

  const focusGrid = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), [])

  const scrollToCell = useCallback(
    (p: CellPos) => {
      rowVirtualizer.scrollToIndex(p.row, { align: 'auto' })
      if (p.col > 0) colVirtualizer.scrollToIndex(p.col - 1, { align: 'auto' })
    },
    [rowVirtualizer, colVirtualizer],
  )

  const startEdit = useCallback(
    (pos: CellPos, initial?: string) => {
      const p = propsRef.current
      if (p.readOnly || !p.renderEditor) return
      const row = p.rows[pos.row]
      const column = p.columns[pos.col]
      if (row === undefined || !column) return
      if (p.canEdit && !p.canEdit(row, column)) return
      if (p.onActivate?.(pos, row, column, initial)) return
      scrollToCell(pos)
      setEditing({ pos, initial })
    },
    [scrollToCell],
  )

  const select = useCallback(
    (pos: CellPos, opts: { edit?: boolean } = {}) => {
      setSelection(collapsed(pos))
      scrollToCell(pos)
      if (opts.edit) startEdit(pos)
      else focusGrid()
    },
    [scrollToCell, startEdit, focusGrid],
  )

  useEffect(() => {
    if (!props.apiRef) return
    props.apiRef.current = { select, focus: focusGrid, selection: () => selRef.current }
  })

  const editor = useMemo<CellEditorProps>(
    () => ({
      initial: editing?.initial,
      done: (move) => {
        const current = editingRef.current
        if (!current) return
        setEditing(null)
        // Saved on blur (a click elsewhere): the click decides where focus and the selection go.
        if (move === undefined) return
        const b = { rows: propsRef.current.rows.length, cols: propsRef.current.columns.length }
        if (move === 'down' && current.pos.row >= b.rows - 1) propsRef.current.onEditPastEnd?.()
        const next = afterEdit(current.pos, move, b)
        setSelection(collapsed(next))
        if (move) scrollToCell(next)
        focusGrid()
      },
      cancel: () => {
        setEditing(null)
        focusGrid()
      },
    }),
    [editing?.initial, scrollToCell, focusGrid],
  )

  // ── Keys ────────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return
    if (e.target !== e.currentTarget && !(e.currentTarget as HTMLElement).contains(e.target as Node)) return
    if (props.onKeyDown?.(e)) {
      e.preventDefault()
      return
    }
    const el = scrollRef.current
    const pageRows = el ? Math.max(1, Math.floor((el.clientHeight - headerHeight) / rowHeight) - 1) : 10
    const result = gridKey(e, selection, { ...bounds, pageRows })
    if (result.type === 'none') return
    e.preventDefault()
    if (result.type === 'select') {
      setSelection(result.selection)
      scrollToCell(result.scrollTo)
    } else if (result.type === 'edit') {
      startEdit(selection.anchor, result.initial)
    } else if (result.type === 'clear') {
      if (!readOnly) props.onClear?.(selectionRange(selection))
    }
  }

  // ── Clipboard ───────────────────────────────────────────────────────────
  const rangeText = () => {
    const r = selectionRange(selection)
    const out: string[][] = []
    for (let i = r.top; i <= Math.min(r.bottom, rows.length - 1); i++) {
      const line: string[] = []
      for (let c = r.left; c <= Math.min(r.right, columns.length - 1); c++) line.push(props.copyText(rows[i], columns[c]))
      out.push(line)
    }
    return toTsv(out)
  }
  /** A dialog or menu input (portaled, bubbling through React) is not the grid. */
  const outside = (e: React.SyntheticEvent) => !scrollRef.current?.contains(e.target as Node)
  const onCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current || !rows.length || outside(e)) return
    e.clipboardData.setData('text/plain', rangeText())
    e.preventDefault()
  }
  const onCut = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current || !rows.length || outside(e)) return
    e.clipboardData.setData('text/plain', rangeText())
    e.preventDefault()
    if (!readOnly) props.onClear?.(selectionRange(selection))
  }
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current || readOnly || !props.onPaste || outside(e)) return
    const block = parseTsv(e.clipboardData.getData('text/plain'))
    e.preventDefault()
    if (!block.length) return
    const targets = pasteTargets(selectionRange(selection), block, columns.length)
    if (!targets.length) return
    props.onPaste(targets)
    const last = targets[targets.length - 1]
    setSelection({ anchor: { row: targets[0].row, col: targets[0].col }, focus: { row: last.row, col: last.col } })
  }

  // ── Mouse ───────────────────────────────────────────────────────────────
  const cellAt = (target: EventTarget | null): CellPos | null => {
    const el = (target as HTMLElement | null)?.closest?.('[data-c]') as HTMLElement | null
    if (!el || !scrollRef.current?.contains(el) || el.closest('[data-grid-editor]')) return null
    const row = Number(el.dataset.r)
    const col = Number(el.dataset.c)
    return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null
  }
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const pos = cellAt(e.target)
    if (!pos) return
    // Clicking out of an editor saves it (its blur) before the selection moves.
    if (editingRef.current) focusGrid()
    if (e.button !== 0) {
      if (!inRange(selectionRange(selection), pos.row, pos.col)) setSelection(collapsed(pos))
      return
    }
    e.preventDefault()
    focusGrid()
    setSelection(e.shiftKey ? { anchor: selection.anchor, focus: pos } : collapsed(pos))
    dragging.current = true
    const up = () => {
      dragging.current = false
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mouseup', up)
  }
  const onMouseOver = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const pos = cellAt(e.target)
    if (!pos) return
    setSelection((s) => (s.focus.row === pos.row && s.focus.col === pos.col ? s : { anchor: s.anchor, focus: pos }))
  }
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const pos = cellAt(e.target)
    if (pos) startEdit(pos)
  }
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const pos = cellAt(e.target)
    if (pos) props.onContextMenuCell?.(pos)
  }

  // ── Header: resize and move ─────────────────────────────────────────────
  const contentX = (clientX: number) => {
    const el = scrollRef.current
    return el ? clientX - el.getBoundingClientRect().left + el.scrollLeft : clientX
  }
  /** The boundary a dragged column would land at: before column b (1..n). */
  const boundaryAt = (x: number) => {
    let left = firstW
    for (let c = 1; c < columns.length; c++) {
      if (x < left + widths[c] / 2) return { b: c, x: left }
      left += widths[c]
    }
    return { b: columns.length, x: left }
  }
  const startResize = (e: React.PointerEvent<HTMLDivElement>, c: number) => {
    e.stopPropagation()
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture?.(e.pointerId)
    const startX = e.clientX
    const startW = widths[c]
    const col = columns[c]
    let width = startW
    const move = (ev: PointerEvent) => {
      width = Math.max(col.minWidth ?? MIN_W, Math.round(startW + ev.clientX - startX))
      setLive({ id: col.id, width })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setLive(null)
      if (width !== startW) propsRef.current.onColumnResize?.(col.id, width)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>, c: number) => {
    if (e.button !== 0) return
    // The owner's menu opens on a click (pointer up without a drag), not here.
    e.preventDefault()
    drag.current = { from: c, startX: e.clientX, moved: false, pointer: e.pointerId }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const canMove = (c: number) => c > 0 && !readOnly && !!props.onColumnMove && columns[c]?.movable !== false
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !canMove(d.from)) return
    if (!d.moved && Math.abs(e.clientX - d.startX) < 5) return
    d.moved = true
    setDropX(boundaryAt(contentX(e.clientX)).x)
  }
  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    setDropX(null)
    if (!d) return
    if (!d.moved) {
      props.onHeaderClick?.(columns[d.from].id)
      return
    }
    const { b } = boundaryAt(contentX(e.clientX))
    const to = b > d.from ? b - 1 : b
    if (to !== d.from && to >= 1) props.onColumnMove?.(columns[d.from].id, to)
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const range = selectionRange(selection)
  const vRows = rowVirtualizer.getVirtualItems()
  const vCols = colVirtualizer.getVirtualItems()
  const colsKey = vCols.map((v) => `${v.index}:${v.start}`).join(',')
  const rowsEnd = headerHeight + rows.length * rowHeight
  const totalH = rowsEnd + (footer ? FOOTER_H : 0)

  // Near the end of what's loaded: ask for more.
  const lastIndex = vRows.length ? vRows[vRows.length - 1].index : -1
  useEffect(() => {
    if (props.onReachEnd && rows.length > 0 && lastIndex >= rows.length - 40) props.onReachEnd()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastIndex, rows.length])

  const ctx = useRef<RowCtx>(null as unknown as RowCtx)
  ctx.current = {
    gridId,
    columns,
    widths,
    renderCell: props.renderCell as RowCtx['renderCell'],
    renderEditor: props.renderEditor as RowCtx['renderEditor'],
    editor,
    trailing: trailingW,
  }
  // Rows re-render when what they draw with changes.
  const renderKey = useRenderKey(props.renderCell, props.renderEditor, widthsKey, editor)
  const active = `${gridId}-${selection.anchor.row}-${selection.anchor.col}`

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={props.ariaLabel}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      aria-multiselectable="true"
      aria-readonly={readOnly || undefined}
      aria-activedescendant={rows.length ? active : undefined}
      tabIndex={0}
      className={cn('relative min-h-0 flex-1 overflow-auto outline-none', props.className)}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={onPaste}
      onMouseDown={onMouseDown}
      onMouseOver={onMouseOver}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="relative" style={{ width: totalW, height: totalH }}>
        <div role="row" aria-rowindex={1} className="sticky top-0 z-20 bg-background" style={{ width: totalW, height: headerHeight }}>
          {columns.length > 0 && (
            <HeaderCell
              col={columns[0]}
              index={0}
              width={firstW}
              sticky
              onPointerDown={onHeaderPointerDown}
              onPointerMove={onHeaderPointerMove}
              onPointerUp={onHeaderPointerUp}
              onResize={columns[0].resizable === false || !props.onColumnResize ? undefined : startResize}
            />
          )}
          {vCols.map((v) => {
            const c = v.index + 1
            const col = columns[c]
            if (!col) return null
            return (
              <HeaderCell
                key={col.id}
                col={col}
                index={c}
                left={v.start}
                width={widths[c]}
                onPointerDown={onHeaderPointerDown}
                onPointerMove={onHeaderPointerMove}
                onPointerUp={onHeaderPointerUp}
                onResize={col.resizable === false || !props.onColumnResize ? undefined : startResize}
              />
            )
          })}
          {headerTrailing && (
            <div className="absolute top-0 flex h-full items-center border-b border-border" style={{ left: colsWidth, width: trailingW }}>
              {headerTrailing.node}
            </div>
          )}
        </div>
        {vRows.map((v) => {
          const r = v.index
          const row = rows[r]
          if (row === undefined) return null
          const selected = r >= range.top && r <= range.bottom
          return (
            <GridRow
              key={v.key}
              ctx={ctx}
              row={row}
              rowIndex={r}
              top={v.start}
              height={rowHeight}
              width={totalW}
              vCols={vCols}
              colsKey={colsKey}
              selLeft={selected ? range.left : -1}
              selRight={selected ? range.right : -1}
              activeCol={selection.anchor.row === r ? selection.anchor.col : -1}
              editingCol={editing?.pos.row === r ? editing.pos.col : -1}
              renderKey={renderKey}
            />
          )
        })}
        {footer && (
          <div className="absolute left-0" style={{ top: rowsEnd, height: FOOTER_H, width: totalW }}>
            <div className="sticky left-0 flex h-full items-center" style={{ width: Math.min(totalW, 480) }}>
              {footer}
            </div>
          </div>
        )}
        {dropX !== null && <div aria-hidden className="pointer-events-none absolute top-0 z-30 w-0.5 bg-primary" style={{ left: dropX - 1, height: totalH }} />}
      </div>
    </div>
  )
}

/** A number that changes when any of `deps` does. */
function useRenderKey(...deps: unknown[]): number {
  const prev = useRef<unknown[]>(deps)
  const key = useRef(0)
  if (deps.some((d, i) => d !== prev.current[i])) {
    key.current += 1
    prev.current = deps
  }
  return key.current
}

function HeaderCell({
  col,
  index,
  left,
  width,
  sticky,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResize,
}: {
  col: GridColumn
  index: number
  left?: number
  width: number
  sticky?: boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, c: number) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
  onResize?: (e: React.PointerEvent<HTMLDivElement>, c: number) => void
}) {
  return (
    <div
      role="columnheader"
      aria-colindex={index + 1}
      aria-label={col.label}
      data-hc={index}
      className={cn(
        'top-0 flex h-full select-none items-center border-b border-r border-border bg-background text-xs font-medium text-muted-foreground',
        sticky ? 'sticky left-0 z-10' : 'absolute',
      )}
      style={sticky ? { width } : { left, width }}
      // A menu the header opens is portaled, but its events bubble here through React: not the header's.
      onPointerDown={(e) => e.currentTarget.contains(e.target as Node) && onPointerDown(e, index)}
      onPointerMove={(e) => e.currentTarget.contains(e.target as Node) && onPointerMove(e)}
      onPointerUp={(e) => e.currentTarget.contains(e.target as Node) && onPointerUp(e)}
    >
      <div className="min-w-0 flex-1 overflow-hidden">{col.header}</div>
      {onResize && (
        <div
          aria-hidden
          data-resize=""
          className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
          onPointerDown={(e) => onResize(e, index)}
        />
      )}
    </div>
  )
}

interface GridRowProps {
  ctx: React.MutableRefObject<RowCtx>
  row: unknown
  rowIndex: number
  top: number
  height: number
  width: number
  vCols: ReadonlyArray<{ index: number; start: number }>
  colsKey: string
  selLeft: number
  selRight: number
  activeCol: number
  editingCol: number
  renderKey: number
}

const GridRow = memo(
  function GridRow({ ctx, row, rowIndex, top, height, width, vCols, selLeft, selRight, activeCol, editingCol }: GridRowProps) {
    const { gridId, columns, widths } = ctx.current
    const cellFor = (c: number, left?: number) => {
      const column = columns[c]
      if (!column) return null
      const selected = c >= selLeft && c <= selRight
      const isActive = c === activeCol
      const isEditing = c === editingCol
      const sticky = c === 0
      return (
        <div
          key={column.id}
          id={`${gridId}-${rowIndex}-${c}`}
          role="gridcell"
          aria-colindex={c + 1}
          aria-selected={selected}
          data-r={rowIndex}
          data-c={c}
          className={cn(
            'top-0 flex h-full items-center border-b border-r border-border/70 bg-background text-sm',
            sticky ? 'sticky left-0 z-10' : 'absolute',
            isEditing ? 'z-[15] overflow-visible' : 'overflow-hidden',
          )}
          style={sticky ? { width: widths[0] } : { left, width: widths[c] }}
        >
          {selected && !isEditing && <span aria-hidden className="pointer-events-none absolute inset-0 bg-primary/[0.08]" />}
          {isEditing && ctx.current.renderEditor ? (
            <div data-grid-editor="" className="relative h-full w-full">
              {ctx.current.renderEditor(row, column, rowIndex, ctx.current.editor)}
            </div>
          ) : (
            ctx.current.renderCell(row, column, rowIndex)
          )}
          {(isActive || isEditing) && <span aria-hidden className="pointer-events-none absolute inset-0 z-[1] border-2 border-primary" />}
        </div>
      )
    }
    return (
      <div role="row" aria-rowindex={rowIndex + 2} aria-selected={selLeft >= 0 || undefined} className="absolute left-0" style={{ top, height, width }}>
        {cellFor(0)}
        {vCols.map((v) => cellFor(v.index + 1, v.start))}
      </div>
    )
  },
  (a, b) =>
    a.row === b.row &&
    a.rowIndex === b.rowIndex &&
    a.top === b.top &&
    a.height === b.height &&
    a.width === b.width &&
    a.colsKey === b.colsKey &&
    a.selLeft === b.selLeft &&
    a.selRight === b.selRight &&
    a.activeCol === b.activeCol &&
    a.editingCol === b.editingCol &&
    a.renderKey === b.renderKey,
)
