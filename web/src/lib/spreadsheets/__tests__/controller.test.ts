import { describe, expect, it } from 'vitest'
import { MAX_CELL_CHARS } from '../a1'
import { START_COLUMNS, START_ROWS, WorkbookController, indexAt } from '../controller'
import { loadModel, newModel } from '../engine-server'

function open(cells: Array<[number, number, string]> = [], options: { readOnly?: boolean } = {}) {
  const model = newModel()
  for (const [r, c, v] of cells) model.setUserInput(0, r, c, v)
  return new WorkbookController(model, options)
}

const column = (wb: WorkbookController, c: number, rows: number[]) => rows.map((r) => wb.text(r, c))

describe('editing a cell', () => {
  it('commits a draft, calculates, and moves down on Enter and right on Tab', () => {
    const wb = open([[1, 1, '20']])
    wb.select(1, 2)
    expect(wb.startEdit({ initial: '=' })).toBe(true)
    wb.setDraft('=A1*3')
    expect(wb.commitEdit('down')).toEqual({ ok: true })
    expect(wb.text(1, 2)).toBe('60')
    expect(wb.input(1, 2)).toBe('=A1*3')
    expect(wb.selection()).toMatchObject({ row: 2, column: 2 })
    wb.startEdit({ initial: 'x' })
    wb.commitEdit('right')
    expect(wb.selection()).toMatchObject({ row: 2, column: 3 })
  })

  it('starts from what the cell holds when no key started the edit, and Escape leaves it alone', () => {
    const wb = open([[1, 1, '=1+1']])
    wb.select(1, 1)
    wb.startEdit()
    expect(wb.editing?.draft).toBe('=1+1')
    wb.setDraft('=1+2')
    wb.cancelEdit()
    expect(wb.editing).toBeNull()
    expect(wb.text(1, 1)).toBe('2')
    expect(wb.dirty).toBe(false)
  })

  it('an unchanged draft is not a change', () => {
    const wb = open([[1, 1, 'same']])
    wb.select(1, 1)
    wb.startEdit()
    wb.commitEdit('down')
    expect(wb.dirty).toBe(false)
    expect(wb.canUndo()).toBe(false)
  })

  it('holds a cell to its character limit', () => {
    const wb = open()
    expect(wb.setCell(1, 1, 'x'.repeat(MAX_CELL_CHARS + 1))).toMatchObject({ ok: false })
    expect(wb.setCell(1, 1, 'x'.repeat(MAX_CELL_CHARS))).toEqual({ ok: true })
    wb.select(1, 2)
    wb.startEdit({ initial: '' })
    wb.setDraft('y'.repeat(MAX_CELL_CHARS + 50))
    expect(wb.editing?.draft.length).toBe(MAX_CELL_CHARS)
  })

  it('changes nothing when the workbook is view-only', () => {
    const wb = open([[1, 1, 'keep']], { readOnly: true })
    expect(wb.startEdit({ initial: 'x' })).toBe(false)
    expect(wb.setCell(1, 1, 'gone')).toMatchObject({ ok: false, message: expect.stringMatching(/view/) })
    expect(wb.clearSelection().ok).toBe(false)
    expect(wb.addSheet().ok).toBe(false)
    expect(wb.text(1, 1)).toBe('keep')
  })
})

describe('undo and redo', () => {
  it('takes back one action at a time, and redoes it', () => {
    const wb = open()
    wb.setCell(1, 1, '1')
    wb.setCell(1, 1, '2')
    expect(wb.canUndo()).toBe(true)
    wb.undo()
    expect(wb.text(1, 1)).toBe('1')
    wb.undo()
    expect(wb.text(1, 1)).toBe('')
    expect(wb.canUndo()).toBe(false)
    wb.redo()
    wb.redo()
    expect(wb.text(1, 1)).toBe('2')
    expect(wb.canRedo()).toBe(false)
  })

  it('a paste of many cells is one step', () => {
    const wb = open([[1, 1, 'old']])
    wb.select(1, 1)
    expect(wb.pasteValues([['a', 'b'], ['c', 'd'], ['e', '=1+1']])).toEqual({ ok: true })
    expect([wb.text(1, 1), wb.text(2, 2), wb.text(3, 2)]).toEqual(['a', 'd', '2'])
    expect(wb.selection().range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 2 })
    wb.undo()
    expect([wb.text(1, 1), wb.text(2, 2), wb.text(3, 2)]).toEqual(['old', '', ''])
    expect(wb.canUndo()).toBe(false)
  })

  it('a new action clears what could be redone', () => {
    const wb = open()
    wb.setCell(1, 1, '1')
    wb.undo()
    wb.setCell(1, 1, '9')
    expect(wb.canRedo()).toBe(false)
  })
})

describe('selection and movement', () => {
  it('moves with arrows, stretches with Shift and jumps to the edge of a block', () => {
    const wb = open([[1, 1, 'a'], [2, 1, 'b'], [3, 1, 'c'], [1, 2, 'x']])
    wb.select(1, 1)
    wb.move('down')
    expect(wb.selection()).toMatchObject({ row: 2, column: 1 })
    wb.move('down', { extend: true })
    expect(wb.selection().range).toEqual({ r1: 2, c1: 1, r2: 3, c2: 1 })
    wb.select(1, 1)
    wb.move('down', { edge: true })
    expect(wb.selection()).toMatchObject({ row: 3, column: 1 })
    wb.select(1, 1)
    wb.move('down', { edge: true, extend: true })
    expect(wb.selection()).toMatchObject({ row: 1, column: 1, range: { r1: 1, c1: 1, r2: 3, c2: 1 } })
  })

  it('stays put at the top-left corner', () => {
    const wb = open()
    wb.select(1, 1)
    wb.move('up')
    wb.move('left')
    expect(wb.selection()).toMatchObject({ row: 1, column: 1 })
  })

  it('a jump down an empty column lands on the last row the grid shows', () => {
    const wb = open()
    wb.select(1, 1)
    wb.move('down', { edge: true })
    expect(wb.selection().row).toBe(START_ROWS)
  })

  it('selects whole rows, whole columns and everything', () => {
    const wb = open()
    wb.selectRows(3, 5)
    expect(wb.selection().range).toEqual({ r1: 3, c1: 1, r2: 5, c2: START_COLUMNS })
    expect(wb.selectedBand()).toEqual({ rows: true, columns: false })
    wb.selectColumns(2)
    expect(wb.selectedBand()).toEqual({ rows: false, columns: true })
    wb.selectAll()
    expect(wb.selectedBand()).toEqual({ rows: true, columns: true })
  })

  it('a drag stretches the range from the active cell', () => {
    const wb = open()
    wb.select(4, 4)
    wb.extendTo(2, 6)
    expect(wb.selection()).toMatchObject({ row: 4, column: 4, range: { r1: 2, c1: 4, r2: 4, c2: 6 } })
  })
})

describe('the grid grows', () => {
  it('starts at 200 rows by 26 columns and reaches past what is filled', () => {
    expect(open().layout()).toMatchObject({ rows: START_ROWS, columns: START_COLUMNS })
    const wb = open([[900, 40, 'far']])
    expect(wb.layout().rows).toBeGreaterThanOrEqual(900)
    expect(wb.layout().columns).toBeGreaterThanOrEqual(40)
  })

  it('grows when the selection reaches the end, and when asked', () => {
    const wb = open()
    wb.select(START_ROWS, 1)
    expect(wb.layout().rows).toBeGreaterThan(START_ROWS)
    const before = wb.layout().columns
    wb.growBy(0, 5)
    expect(wb.layout().columns).toBe(before + 5)
  })

  it('finds a row or a column from a scroll offset', () => {
    const wb = open()
    const layout = wb.layout()
    expect(indexAt(layout.rowStarts, 0)).toBe(0)
    expect(indexAt(layout.rowStarts, 24)).toBe(0)
    expect(indexAt(layout.rowStarts, 25)).toBe(1)
    expect(indexAt(layout.rowStarts, 1e9)).toBe(START_ROWS - 1)
    expect(indexAt(layout.columnStarts, 95)).toBe(1)
  })
})

describe('rows and columns', () => {
  it('inserting and deleting rows rewrites the formulas that point past them', () => {
    const wb = open([[1, 1, '5'], [2, 1, '=A1*2']])
    expect(wb.insertRows(1, 2)).toEqual({ ok: true })
    expect(wb.input(4, 1)).toBe('=A3*2')
    expect(wb.text(4, 1)).toBe('10')
    wb.undo()
    expect(wb.input(2, 1)).toBe('=A1*2')
    wb.deleteRows(1, 1)
    expect(wb.text(1, 1)).toBe('#REF!')
  })

  it('inserting and deleting columns does the same sideways', () => {
    const wb = open([[1, 1, '5'], [1, 2, '=A1+1']])
    wb.insertColumns(1, 1)
    expect(wb.input(1, 3)).toBe('=B1+1')
    wb.deleteColumns(1, 1)
    expect(wb.input(1, 2)).toBe('=A1+1')
  })

  it('resizes within the limits and the layout follows', () => {
    const wb = open()
    wb.setColumnWidth(2, 2, 5000)
    wb.setColumnWidth(3, 3, 1)
    const layout = wb.layout()
    expect(layout.columnStarts[2] - layout.columnStarts[1]).toBe(640)
    expect(layout.columnStarts[3] - layout.columnStarts[2]).toBe(8)
    wb.setRowHeight(1, 1, 60)
    expect(wb.layout().rowStarts[1]).toBe(60)
  })

  it('hides rows and columns, lists them, and shows them all again', () => {
    const wb = open()
    wb.select(2, 2)
    expect(wb.hideRows(2, 3)).toEqual({ ok: true })
    expect(wb.hiddenRows()).toEqual([2, 3])
    expect(wb.selection().row).toBe(4)
    wb.hideColumns(2)
    expect(wb.hiddenColumns()).toEqual([2])
    wb.unhideAllRows()
    wb.unhideAllColumns()
    expect(wb.hiddenRows()).toEqual([])
    expect(wb.hiddenColumns()).toEqual([])
  })

  it('refuses to hide every row', () => {
    const wb = open()
    expect(wb.hideRows(1, wb.layout().rows)).toMatchObject({ ok: false })
  })

  it('fits a column to its widest cell and leaves empty columns alone', () => {
    const wb = open([[1, 1, 'short'], [2, 1, 'a much longer label']])
    wb.fitColumns(1, 3, (text) => text.length * 7 + 12)
    const layout = wb.layout()
    expect(layout.columnStarts[1]).toBe('a much longer label'.length * 7 + 12)
    expect(layout.columnStarts[2] - layout.columnStarts[1]).toBe(90)
  })
})

describe('fill', () => {
  it('the handle shifts a formula down and continues a run of numbers', () => {
    const wb = open([[1, 1, '1'], [2, 1, '2'], [1, 2, '=A1*10'], [2, 2, '=A2*10']])
    wb.selectRange({ r1: 1, c1: 1, r2: 2, c2: 2 })
    expect(wb.fillTo({ row: 5, column: 2 })).toEqual({ ok: true })
    expect(column(wb, 1, [3, 4, 5])).toEqual(['3', '4', '5'])
    expect(wb.input(5, 2)).toBe('=A5*10')
    expect(wb.selection().range).toEqual({ r1: 1, c1: 1, r2: 5, c2: 2 })
    wb.undo()
    expect(wb.text(3, 1)).toBe('')
  })

  it('fills across when the drag goes further sideways', () => {
    const wb = open([[1, 1, '=ROW()+COLUMN()']])
    wb.select(1, 1)
    wb.fillTo({ row: 1, column: 3 })
    expect([wb.text(1, 2), wb.text(1, 3)]).toEqual(['3', '4'])
  })

  it('Ctrl+D repeats the top row down the selection and Ctrl+R the left column across it', () => {
    const wb = open([[1, 1, '=B1&"!"'], [1, 2, 'hi']])
    wb.selectRange({ r1: 1, c1: 1, r2: 3, c2: 1 })
    wb.fillDown()
    expect(wb.input(3, 1)).toBe('=B3&"!"')
    wb.selectRange({ r1: 1, c1: 2, r2: 1, c2: 4 })
    wb.fillRight()
    expect([wb.text(1, 3), wb.text(1, 4)]).toEqual(['hi', 'hi'])
  })
})

describe('the clipboard', () => {
  it('copies as tab-separated text and pastes its own copy with shifted formulas and formats', () => {
    const wb = open([[1, 1, '4'], [1, 2, '=A1*2'], [2, 1, '6']])
    wb.select(1, 2)
    wb.setStyle('font.b', 'true')
    const clip = wb.copy()
    expect(clip.text).toBe('8')
    wb.select(2, 2)
    expect(wb.pasteInternal(clip.internal)).toEqual({ ok: true })
    expect(wb.input(2, 2)).toBe('=A2*2')
    expect(wb.text(2, 2)).toBe('12')
    expect(wb.style(2, 2).font.b).toBe(true)
    wb.undo()
    expect(wb.input(2, 2)).toBe('')
  })

  it('a cut empties where it came from', () => {
    const wb = open([[1, 1, 'move me']])
    wb.select(1, 1)
    const clip = wb.copy()
    wb.select(3, 3)
    wb.pasteInternal(clip.internal, { cut: true })
    expect([wb.text(1, 1), wb.text(3, 3)]).toEqual(['', 'move me'])
  })

  it('one pasted cell fills the whole selection', () => {
    const wb = open()
    wb.selectRange({ r1: 1, c1: 1, r2: 2, c2: 2 })
    wb.pasteValues([['7']])
    expect([wb.text(1, 1), wb.text(1, 2), wb.text(2, 1), wb.text(2, 2)]).toEqual(['7', '7', '7', '7'])
  })

  it('reads the selection’s values for another app, stopping at the last filled cell', () => {
    const wb = open([[1, 1, '1'], [2, 2, '=A1+1']])
    wb.selectColumns(1, 2)
    expect(wb.selectionValues()).toEqual([['1', ''], ['', '2']])
  })
})

describe('formats', () => {
  it('sets one part of the style on the selection and clears it again', () => {
    const wb = open([[1, 1, '0.5']])
    wb.selectRange({ r1: 1, c1: 1, r2: 2, c2: 1 })
    wb.setStyle('font.i', 'true')
    wb.setStyle('num_fmt', '0%')
    expect(wb.style(2, 1).font.i).toBe(true)
    expect(wb.text(1, 1)).toBe('50%')
    wb.clearFormatting()
    expect(wb.style(1, 1).font.i).toBeFalsy()
    expect(wb.text(1, 1)).toBe('0.5')
  })

  it('answers a refusal for a style the engine does not know, and changes nothing', () => {
    const wb = open()
    expect(wb.setStyle('font.nope', 'true')).toMatchObject({ ok: false })
    expect(wb.canUndo()).toBe(false)
  })

  it('clearing values keeps the format', () => {
    const wb = open([[1, 1, '3']])
    wb.select(1, 1)
    wb.setStyle('font.b', 'true')
    wb.clearSelection()
    expect(wb.text(1, 1)).toBe('')
    expect(wb.style(1, 1).font.b).toBe(true)
  })
})

describe('sheets', () => {
  it('adds, renames, duplicates, moves and deletes', () => {
    const wb = open([[1, 1, 'first']])
    expect(wb.addSheet()).toEqual({ ok: true })
    expect(wb.sheet).toBe(1)
    expect(wb.renameSheet(1, 'Costs')).toEqual({ ok: true })
    expect(wb.sheets().map((s) => s.name)).toEqual(['Sheet1', 'Costs'])
    wb.duplicateSheet(0)
    expect(wb.sheets()).toHaveLength(3)
    expect(wb.text(1, 1)).toBe('first')
    wb.selectSheet(2)
    wb.moveSheet(2, 0)
    expect(wb.sheets()[0].name).toBe('Costs')
    expect(wb.sheet).toBe(0)
    wb.deleteSheet(0)
    expect(wb.sheets().map((s) => s.name)).not.toContain('Costs')
  })

  it('refuses a name that is taken, too long or empty, and the last sheet’s deletion', () => {
    const wb = open()
    wb.addSheet()
    expect(wb.renameSheet(1, 'sheet1')).toMatchObject({ ok: false, message: expect.stringMatching(/already/) })
    expect(wb.renameSheet(1, 'x'.repeat(32)).ok).toBe(false)
    expect(wb.renameSheet(1, '  ').ok).toBe(false)
    wb.deleteSheet(1)
    expect(wb.deleteSheet(0)).toMatchObject({ ok: false, message: expect.stringMatching(/at least one/) })
  })

  it('undo brings a deleted sheet back with its cells', () => {
    const wb = open()
    wb.addSheet()
    wb.setCell(1, 1, 'kept')
    wb.deleteSheet(1)
    wb.undo()
    wb.selectSheet(1)
    expect(wb.text(1, 1)).toBe('kept')
  })

  it('a formula on another sheet follows a rename', () => {
    const wb = open([[1, 1, '3']])
    wb.addSheet()
    wb.setCell(1, 1, '=Sheet1!A1+1')
    wb.renameSheet(0, 'In put')
    expect(wb.input(1, 1)).toBe("='In put'!A1+1")
    expect(wb.text(1, 1)).toBe('4')
  })
})

describe('sort', () => {
  it('sorts the selection’s rows by a column: numbers, then text, blanks last', () => {
    const wb = open([[1, 1, 'pear'], [1, 2, '3'], [2, 1, 'apple'], [2, 2, '10'], [3, 1, ''], [3, 2, ''], [4, 1, 'fig'], [4, 2, '1']])
    wb.selectRange({ r1: 1, c1: 1, r2: 4, c2: 2 })
    wb.sortRange(2)
    expect(column(wb, 1, [1, 2, 3, 4])).toEqual(['fig', 'pear', 'apple', ''])
    wb.sortRange(1, true)
    expect(column(wb, 1, [1, 2, 3, 4])).toEqual(['pear', 'fig', 'apple', ''])
    wb.undo()
    expect(column(wb, 1, [1, 2, 3])).toEqual(['fig', 'pear', 'apple'])
  })

  it('leaves a sorted range alone', () => {
    const wb = open([[1, 1, '1'], [2, 1, '2']])
    wb.selectRange({ r1: 1, c1: 1, r2: 2, c2: 1 })
    wb.sortRange(1)
    expect(wb.canUndo()).toBe(false)
  })
})

describe('find and replace', () => {
  it('finds in what cells show, or in what was typed', () => {
    const wb = open([[1, 1, 'Northwind'], [2, 2, '=UPPER("north")'], [3, 1, 'south']])
    expect(wb.find('north')).toEqual([{ row: 1, column: 1 }, { row: 2, column: 2 }])
    expect(wb.find('north', { matchCase: true })).toEqual([])
    expect(wb.find('UPPER', { formulas: true })).toEqual([{ row: 2, column: 2 }])
    expect(wb.find('south', { wholeCell: true })).toEqual([{ row: 3, column: 1 }])
    expect(wb.find('')).toEqual([])
  })

  it('replaces in every match as one step', () => {
    const wb = open([[1, 1, 'red pen'], [2, 1, 'Red ink'], [3, 1, '="red"&1']])
    const result = wb.replace(wb.find('red', { formulas: true }), 'red', 'blue')
    expect(result).toEqual({ ok: true, replaced: 3 })
    expect(column(wb, 1, [1, 2, 3])).toEqual(['blue pen', 'blue ink', 'blue1'])
    wb.undo()
    expect(wb.text(2, 1)).toBe('Red ink')
  })
})

describe('saving', () => {
  it('knows when there is something to save, and a saved workbook opens the same', () => {
    const wb = open()
    expect(wb.dirty).toBe(false)
    wb.setCell(2, 3, '=40+2')
    expect(wb.dirty).toBe(true)
    const { workbook, version } = wb.snapshot()
    wb.markSaved(version)
    expect(wb.dirty).toBe(false)
    const again = new WorkbookController(loadModel(workbook))
    expect(again.text(2, 3)).toBe('42')
    wb.select(1, 1)
    expect(wb.dirty).toBe(false)
  })

  it('tells its listeners about every change', () => {
    const wb = open()
    let calls = 0
    const stop = wb.subscribe(() => { calls += 1 })
    wb.select(2, 2)
    wb.setCell(2, 2, 'x')
    expect(calls).toBe(2)
    stop()
    wb.select(1, 1)
    expect(calls).toBe(2)
  })
})

describe('a large sheet stays quick', () => {
  it('lays out and edits a sheet of 50,000 rows without re-reading it all', () => {
    const model = newModel()
    model.pauseEvaluation()
    for (let r = 1; r <= 50000; r++) {
      model.setUserInput(0, r, 1, String(r))
      model.setUserInput(0, r, 2, `=A${r}+1`)
    }
    model.resumeEvaluation()
    const wb = new WorkbookController(model)
    const started = Date.now()
    expect(wb.layout().rows).toBeGreaterThanOrEqual(50000)
    wb.setCell(1, 1, '100')
    expect(wb.text(1, 2)).toBe('101')
    wb.layout()
    wb.select(49999, 2)
    wb.move('down')
    expect(wb.selection().row).toBe(50000)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
