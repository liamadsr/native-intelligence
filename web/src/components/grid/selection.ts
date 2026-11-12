/**
 * The cell grid's selection and keys (./cell-grid.tsx), as plain functions
 * so they test without a DOM. A selection is an anchor (the active cell,
 * where typing goes) and a focus (the far corner a shift-arrow or a drag
 * moves); the range is the rectangle between them.
 *
 * Client-safe and pure.
 */

export interface CellPos {
  row: number
  col: number
}

export interface GridSelection {
  anchor: CellPos
  focus: CellPos
}

export interface CellRange {
  top: number
  left: number
  bottom: number
  right: number
}

export interface GridBounds {
  rows: number
  cols: number
  /** Rows a page up or down moves (the rows the viewport shows). */
  pageRows: number
}

export const cell = (row: number, col: number): CellPos => ({ row, col })
export const collapsed = (p: CellPos): GridSelection => ({ anchor: p, focus: p })

/** The rectangle a selection covers. */
export function selectionRange(sel: GridSelection): CellRange {
  return {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  }
}

export const inRange = (r: CellRange, row: number, col: number) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
export const isSingleCell = (sel: GridSelection) => sel.anchor.row === sel.focus.row && sel.anchor.col === sel.focus.col
export const rangeSize = (r: CellRange) => ({ rows: r.bottom - r.top + 1, cols: r.right - r.left + 1 })

/** A position kept inside the grid (an empty grid pins it at 0,0). */
export function clampPos(p: CellPos, b: Pick<GridBounds, 'rows' | 'cols'>): CellPos {
  return {
    row: Math.max(0, Math.min(p.row, Math.max(0, b.rows - 1))),
    col: Math.max(0, Math.min(p.col, Math.max(0, b.cols - 1))),
  }
}

export function clampSelection(sel: GridSelection, b: Pick<GridBounds, 'rows' | 'cols'>): GridSelection {
  return { anchor: clampPos(sel.anchor, b), focus: clampPos(sel.focus, b) }
}

/** The keys the grid reads from a keyboard event. */
export interface GridKey {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

export type GridKeyResult =
  /** Move or grow the selection; `scrollTo` is the cell to keep in view. */
  | { type: 'select'; selection: GridSelection; scrollTo: CellPos }
  /** Edit the active cell; `initial` is the typed character that started it (it replaces the value). */
  | { type: 'edit'; initial?: string }
  | { type: 'clear' }
  | { type: 'none' }

/** Where an arrow, Tab, Home, End or a page key takes `from`. Null for any other key. */
function moved(from: CellPos, k: GridKey, b: GridBounds): CellPos | null {
  const jump = !!(k.metaKey || k.ctrlKey)
  const lastRow = Math.max(0, b.rows - 1)
  const lastCol = Math.max(0, b.cols - 1)
  switch (k.key) {
    case 'ArrowUp':
      return { row: jump ? 0 : from.row - 1, col: from.col }
    case 'ArrowDown':
      return { row: jump ? lastRow : from.row + 1, col: from.col }
    case 'ArrowLeft':
      return { row: from.row, col: jump ? 0 : from.col - 1 }
    case 'ArrowRight':
      return { row: from.row, col: jump ? lastCol : from.col + 1 }
    case 'Home':
      return jump ? { row: 0, col: 0 } : { row: from.row, col: 0 }
    case 'End':
      return jump ? { row: lastRow, col: lastCol } : { row: from.row, col: lastCol }
    case 'PageUp':
      return { row: from.row - Math.max(1, b.pageRows), col: from.col }
    case 'PageDown':
      return { row: from.row + Math.max(1, b.pageRows), col: from.col }
    default:
      return null
  }
}

/** Tab and Shift-Tab: the next cell across, wrapping to the next row's first (or the last row's last). */
export function tabbed(from: CellPos, back: boolean, b: Pick<GridBounds, 'rows' | 'cols'>): CellPos {
  const lastCol = Math.max(0, b.cols - 1)
  if (back) {
    if (from.col > 0) return { row: from.row, col: from.col - 1 }
    return from.row > 0 ? { row: from.row - 1, col: lastCol } : from
  }
  if (from.col < lastCol) return { row: from.row, col: from.col + 1 }
  return from.row < b.rows - 1 ? { row: from.row + 1, col: 0 } : from
}

const isPrintable = (k: GridKey) => k.key.length === 1 && !k.metaKey && !k.ctrlKey && !k.altKey

/**
 * What a key does to the grid while no cell is being edited. Arrows move the
 * active cell (with shift they grow the range from it, with ⌘ or Ctrl they
 * jump to the edge), Tab moves across, Enter or F2 edits, a printable key
 * starts an edit with itself, Delete and Backspace clear, ⌘A selects all,
 * Esc shrinks a range back to its active cell.
 */
export function gridKey(k: GridKey, sel: GridSelection, b: GridBounds): GridKeyResult {
  if (b.rows === 0 || b.cols === 0) return { type: 'none' }
  if (k.key === 'Tab') {
    const next = tabbed(sel.anchor, !!k.shiftKey, b)
    return { type: 'select', selection: collapsed(next), scrollTo: next }
  }
  if (k.key === 'Enter' || k.key === 'F2') return k.metaKey || k.ctrlKey || k.altKey ? { type: 'none' } : { type: 'edit' }
  if (k.key === 'Delete' || k.key === 'Backspace') return { type: 'clear' }
  if (k.key === 'Escape') {
    return isSingleCell(sel) ? { type: 'none' } : { type: 'select', selection: collapsed(sel.anchor), scrollTo: sel.anchor }
  }
  if ((k.metaKey || k.ctrlKey) && k.key.toLowerCase() === 'a') {
    const all: GridSelection = { anchor: { row: 0, col: 0 }, focus: { row: b.rows - 1, col: b.cols - 1 } }
    return { type: 'select', selection: all, scrollTo: sel.anchor }
  }
  const from = k.shiftKey ? sel.focus : sel.anchor
  const to = moved(from, k, b)
  if (to) {
    const next = clampPos(to, b)
    return k.shiftKey ? { type: 'select', selection: { anchor: sel.anchor, focus: next }, scrollTo: next } : { type: 'select', selection: collapsed(next), scrollTo: next }
  }
  if (isPrintable(k)) return { type: 'edit', initial: k.key }
  return { type: 'none' }
}

/**
 * Where a finished edit moves the active cell: Enter down, Shift-Enter up,
 * Tab across. A move past the last row stays put (the grid's owner may add
 * a row there instead).
 */
export type EditMove = 'down' | 'up' | 'right' | 'left' | null

export function afterEdit(from: CellPos, move: EditMove, b: Pick<GridBounds, 'rows' | 'cols'>): CellPos {
  switch (move) {
    case 'down':
      return clampPos({ row: from.row + 1, col: from.col }, b)
    case 'up':
      return clampPos({ row: from.row - 1, col: from.col }, b)
    case 'right':
      return tabbed(from, false, b)
    case 'left':
      return tabbed(from, true, b)
    default:
      return from
  }
}

/**
 * Where a paste lands: from the range's top-left, the pasted block's size,
 * except that one copied value pasted over a bigger range fills the range
 * (as spreadsheets do). Returns each target cell with the text it takes;
 * rows past `rows` are new rows to add.
 */
export function pasteTargets(range: CellRange, block: readonly (readonly string[])[], cols: number): Array<{ row: number; col: number; text: string }> {
  const out: Array<{ row: number; col: number; text: string }> = []
  if (!block.length) return out
  const one = block.length === 1 && block[0].length === 1
  const size = rangeSize(range)
  const height = one ? size.rows : block.length
  for (let r = 0; r < height; r++) {
    const src = one ? block[0] : block[r]
    const width = one ? size.cols : src.length
    for (let c = 0; c < width; c++) {
      const col = range.left + c
      if (col >= cols) break
      out.push({ row: range.top + r, col, text: one ? block[0][0] : src[c] })
    }
  }
  return out
}
