/**
 * The cell grid's keys and selection (../selection.ts): moves, ranges, edits,
 * Tab wrapping, page keys, and where a paste lands.
 */
import { describe, expect, it } from 'vitest'
import { afterEdit, collapsed, gridKey, pasteTargets, selectionRange, tabbed, type GridSelection } from '../selection'

const b = { rows: 10, cols: 4, pageRows: 3 }
const at = (row: number, col: number) => collapsed({ row, col })
const sel = (r: ReturnType<typeof gridKey>) => (r.type === 'select' ? r.selection : null)

describe('gridKey', () => {
  it('moves the active cell with the arrows and stops at the edges', () => {
    expect(sel(gridKey({ key: 'ArrowDown' }, at(0, 0), b))).toEqual(at(1, 0))
    expect(sel(gridKey({ key: 'ArrowRight' }, at(0, 3), b))).toEqual(at(0, 3))
    expect(sel(gridKey({ key: 'ArrowUp' }, at(0, 2), b))).toEqual(at(0, 2))
    expect(sel(gridKey({ key: 'ArrowLeft' }, at(5, 2), b))).toEqual(at(5, 1))
  })

  it('jumps to the edge with ⌘ or Ctrl, and Home and End go along the row', () => {
    expect(sel(gridKey({ key: 'ArrowDown', metaKey: true }, at(2, 1), b))).toEqual(at(9, 1))
    expect(sel(gridKey({ key: 'ArrowLeft', ctrlKey: true }, at(2, 3), b))).toEqual(at(2, 0))
    expect(sel(gridKey({ key: 'Home' }, at(4, 3), b))).toEqual(at(4, 0))
    expect(sel(gridKey({ key: 'End' }, at(4, 0), b))).toEqual(at(4, 3))
    expect(sel(gridKey({ key: 'End', metaKey: true }, at(4, 0), b))).toEqual(at(9, 3))
    expect(sel(gridKey({ key: 'Home', ctrlKey: true }, at(4, 2), b))).toEqual(at(0, 0))
  })

  it('pages by the rows in view, clamped', () => {
    expect(sel(gridKey({ key: 'PageDown' }, at(1, 1), b))).toEqual(at(4, 1))
    expect(sel(gridKey({ key: 'PageDown' }, at(8, 1), b))).toEqual(at(9, 1))
    expect(sel(gridKey({ key: 'PageUp' }, at(2, 1), b))).toEqual(at(0, 1))
  })

  it('grows a range from the active cell with shift, which stays the anchor', () => {
    let s: GridSelection = at(2, 1)
    s = sel(gridKey({ key: 'ArrowDown', shiftKey: true }, s, b))!
    s = sel(gridKey({ key: 'ArrowRight', shiftKey: true }, s, b))!
    expect(s).toEqual({ anchor: { row: 2, col: 1 }, focus: { row: 3, col: 2 } })
    expect(selectionRange(s)).toEqual({ top: 2, bottom: 3, left: 1, right: 2 })
    // A plain arrow collapses from the anchor.
    expect(sel(gridKey({ key: 'ArrowDown' }, s, b))).toEqual(at(3, 1))
    // Esc shrinks the range back; on one cell it does nothing.
    expect(sel(gridKey({ key: 'Escape' }, s, b))).toEqual(at(2, 1))
    expect(gridKey({ key: 'Escape' }, at(2, 1), b).type).toBe('none')
  })

  it('selects everything with ⌘A', () => {
    expect(sel(gridKey({ key: 'a', metaKey: true }, at(3, 3), b))).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 9, col: 3 } })
  })

  it('Tab moves across and wraps; Shift-Tab goes back', () => {
    expect(sel(gridKey({ key: 'Tab' }, at(0, 3), b))).toEqual(at(1, 0))
    expect(sel(gridKey({ key: 'Tab', shiftKey: true }, at(1, 0), b))).toEqual(at(0, 3))
    expect(tabbed({ row: 9, col: 3 }, false, b)).toEqual({ row: 9, col: 3 })
    expect(tabbed({ row: 0, col: 0 }, true, b)).toEqual({ row: 0, col: 0 })
  })

  it('edits on Enter or F2, or with the printable key that started it', () => {
    expect(gridKey({ key: 'Enter' }, at(0, 0), b)).toEqual({ type: 'edit' })
    expect(gridKey({ key: 'F2' }, at(0, 0), b)).toEqual({ type: 'edit' })
    expect(gridKey({ key: 'q' }, at(0, 0), b)).toEqual({ type: 'edit', initial: 'q' })
    expect(gridKey({ key: '7' }, at(0, 0), b)).toEqual({ type: 'edit', initial: '7' })
    // ⌘C and friends are the clipboard's, not an edit.
    expect(gridKey({ key: 'c', metaKey: true }, at(0, 0), b).type).toBe('none')
    expect(gridKey({ key: 'Enter', metaKey: true }, at(0, 0), b).type).toBe('none')
  })

  it('clears on Delete and Backspace, and does nothing on an empty grid', () => {
    expect(gridKey({ key: 'Delete' }, at(0, 0), b).type).toBe('clear')
    expect(gridKey({ key: 'Backspace' }, at(0, 0), b).type).toBe('clear')
    expect(gridKey({ key: 'ArrowDown' }, at(0, 0), { rows: 0, cols: 3, pageRows: 3 }).type).toBe('none')
  })
})

describe('afterEdit', () => {
  it('moves down on Enter, up on Shift-Enter, across on Tab, and stays on the last row', () => {
    expect(afterEdit({ row: 1, col: 1 }, 'down', b)).toEqual({ row: 2, col: 1 })
    expect(afterEdit({ row: 1, col: 1 }, 'up', b)).toEqual({ row: 0, col: 1 })
    expect(afterEdit({ row: 1, col: 3 }, 'right', b)).toEqual({ row: 2, col: 0 })
    expect(afterEdit({ row: 9, col: 1 }, 'down', b)).toEqual({ row: 9, col: 1 })
    expect(afterEdit({ row: 4, col: 2 }, null, b)).toEqual({ row: 4, col: 2 })
  })
})

describe('pasteTargets', () => {
  it('lays a block out from the range’s top-left, past the last row when it must, never past the last column', () => {
    const t = pasteTargets({ top: 8, left: 2, bottom: 8, right: 2 }, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']], 4)
    expect(t).toEqual([
      { row: 8, col: 2, text: 'a' },
      { row: 8, col: 3, text: 'b' },
      { row: 9, col: 2, text: 'd' },
      { row: 9, col: 3, text: 'e' },
      { row: 10, col: 2, text: 'g' },
      { row: 10, col: 3, text: 'h' },
    ])
  })

  it('fills a bigger range with one copied value', () => {
    const t = pasteTargets({ top: 0, left: 0, bottom: 1, right: 1 }, [['x']], 4)
    expect(t.map((x) => [x.row, x.col, x.text])).toEqual([
      [0, 0, 'x'],
      [0, 1, 'x'],
      [1, 0, 'x'],
      [1, 1, 'x'],
    ])
  })

  it('takes rows of different lengths as they are', () => {
    expect(pasteTargets({ top: 0, left: 0, bottom: 0, right: 0 }, [['a'], ['b', 'c']], 4).length).toBe(3)
    expect(pasteTargets({ top: 0, left: 0, bottom: 0, right: 0 }, [], 4)).toEqual([])
  })
})
