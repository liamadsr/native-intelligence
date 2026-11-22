/**
 * Merging two editors' work through the save path (phase 5). Two real engine
 * Models stand in for two people: one has saved, the other replays its pending
 * work onto it. The engine's change-set behaviour was checked against the real
 * runtime first; these tests pin what the app depends on.
 */
import { describe, expect, it } from 'vitest'
import { WorkbookController } from '../controller'
import { loadModel, newModel } from '../engine-server'
import { emptyExtras, type WorkbookExtras } from '../extras'
import { mergeExtras, rebasePending } from '../sync'
import { saveWorkbook } from '../workbook'

function controller(workbook?: string): WorkbookController {
  return new WorkbookController(workbook ? loadModel(workbook) : newModel())
}

describe('rebasePending over two engine models', () => {
  it('merges disjoint cells', () => {
    const mine = controller()
    mine.setCell(1, 1, 'from A')
    const theirs = newModel()
    theirs.setUserInput(0, 2, 2, 'from B')
    theirs.evaluate()
    rebasePending(theirs, mine.pendingDiffs())
    expect(theirs.getFormattedCellValue(0, 1, 1)).toBe('from A')
    expect(theirs.getFormattedCellValue(0, 2, 2)).toBe('from B')
    mine.dispose()
    theirs.free()
  })

  it('lets my pending value win on the same cell (last writer wins)', () => {
    const mine = controller()
    mine.setCell(1, 1, 'A value')
    const theirs = newModel()
    theirs.setUserInput(0, 1, 1, 'B value')
    theirs.evaluate()
    rebasePending(theirs, mine.pendingDiffs())
    expect(theirs.getFormattedCellValue(0, 1, 1)).toBe('A value')
    mine.dispose()
    theirs.free()
  })

  it('carries a formula with its result, and a style', () => {
    const mine = controller()
    mine.setCell(1, 1, '10')
    mine.setCell(2, 1, '=A1*2')
    mine.select(3, 1)
    mine.setCell(3, 1, '5')
    mine.select(3, 1)
    mine.setStyle('font.b', 'true')
    const theirs = newModel()
    theirs.evaluate()
    rebasePending(theirs, mine.pendingDiffs())
    expect(theirs.getFormattedCellValue(0, 2, 1)).toBe('20')
    expect(theirs.getCellStyle(0, 3, 1).style.font.b).toBe(true)
    mine.dispose()
    theirs.free()
  })

  it('applies my cell edit at its absolute row even when the other inserted a row above it', () => {
    const base = newModel()
    base.setUserInput(0, 5, 1, 'row5')
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.setCell(5, 1, 'edited5')
    const theirs = loadModel(saved)
    theirs.insertRows(0, 1, 1) // their row pushes old row5 down to row6
    theirs.evaluate()
    rebasePending(theirs, mine.pendingDiffs())
    // My edit lands on the absolute row 5, not where my value logically followed.
    expect(theirs.getFormattedCellValue(0, 5, 1)).toBe('edited5')
    expect(theirs.getFormattedCellValue(0, 6, 1)).toBe('row5')
    mine.dispose()
    theirs.free()
  })

  it('carries a new sheet', () => {
    const mine = controller()
    mine.addSheet()
    const theirs = newModel()
    theirs.evaluate()
    rebasePending(theirs, mine.pendingDiffs())
    expect(theirs.getWorksheetsProperties().length).toBe(2)
    mine.dispose()
    theirs.free()
  })

  it('drops my change to a sheet the other person deleted, and stays usable', () => {
    const base = newModel()
    base.newSheet()
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.selectSheet(1)
    mine.setCell(1, 1, 'on sheet 2')
    const theirs = loadModel(saved)
    theirs.deleteSheet(1)
    theirs.evaluate()
    const { dropped } = rebasePending(theirs, mine.pendingDiffs())
    expect(dropped).toBe(1)
    expect(theirs.getWorksheetsProperties().length).toBe(1)
    // Still usable.
    theirs.setUserInput(0, 1, 1, 'ok')
    theirs.evaluate()
    expect(theirs.getFormattedCellValue(0, 1, 1)).toBe('ok')
    mine.dispose()
    theirs.free()
  })
})

describe('mergeExtras per top-level key', () => {
  const key = (n: string): WorkbookExtras => {
    const e = emptyExtras()
    e.charts = [{ id: n, sheetId: 1, type: 'column', title: n, legend: true, source: { r1: 1, c1: 1, r2: 2, c2: 2 }, anchor: { row: 1, column: 1, dx: 0, dy: 0 }, width: 200, height: 150 }]
    return e
  }

  it('keeps theirs for kinds I did not touch and mine for the kinds I did', () => {
    const base = emptyExtras()
    const mine = emptyExtras()
    mine.checkboxes = [{ sheetId: 1, range: { r1: 1, c1: 1, r2: 1, c2: 1 } }]
    const theirs = key('theirChart')
    const merged = mergeExtras(base, mine, theirs)
    // I changed checkboxes → mine; I did not touch charts → theirs.
    expect(merged.checkboxes).toHaveLength(1)
    expect(merged.charts.map((c) => c.id)).toEqual(['theirChart'])
  })

  it('keeps my change to a kind over theirs', () => {
    const base = emptyExtras()
    const mine = key('myChart')
    const theirs = key('theirChart')
    const merged = mergeExtras(base, mine, theirs)
    expect(merged.charts.map((c) => c.id)).toEqual(['myChart'])
  })
})

describe('controller.adopt', () => {
  it('keeps the active sheet, the selection and an open draft', () => {
    const c = controller()
    c.addSheet() // now two sheets, selected index 1
    const sheetId = c.sheetIdAt(1)
    c.selectSheet(1)
    c.select(3, 2)
    c.startEdit({ initial: 'hi' })
    expect(c.editing?.draft).toBe('hi')

    const merged = loadModel(saveWorkbook(c.model))
    c.adopt(merged, c.extras)

    expect(c.sheetIdAt(c.sheet)).toBe(sheetId)
    const sel = c.selection()
    expect([sel.row, sel.column]).toEqual([3, 2])
    expect(c.editing?.draft).toBe('hi')
    expect(c.pendingDiffs()).toHaveLength(0)
    c.dispose()
  })

  it('clears the undo history (the engine model is replaced)', () => {
    const c = controller()
    c.setCell(1, 1, 'x')
    expect(c.canUndo()).toBe(true)
    c.adopt(loadModel(saveWorkbook(c.model)), c.extras)
    expect(c.canUndo()).toBe(false)
    c.dispose()
  })
})
