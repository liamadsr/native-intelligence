/**
 * Merging two editors' work through the save path (phase 5). Two real engine
 * Models stand in for two people: one has saved, the other replays its pending
 * work onto it. The engine's change-set behaviour was checked against the real
 * runtime first; these tests pin what the app depends on.
 */
import type { Model } from '@ironcalc/wasm'
import { describe, expect, it } from 'vitest'
import { WorkbookController } from '../controller'
import { loadModel, newModel } from '../engine-server'
import { emptyExtras, type StructureEntry, type WorkbookExtras } from '../extras'
import { mergeExtras, rebasePending, rebaseWithLog } from '../sync'
import { listSheets, saveWorkbook } from '../workbook'

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

describe('rebaseWithLog moves late cell edits onto the newer layout', () => {
  const extrasWith = (structure: StructureEntry[], structureFloor = 0): WorkbookExtras => ({ ...emptyExtras(), structure, structureFloor })
  const sid = (model: Model) => listSheets(model)[0].id
  const input = (mine: WorkbookController, theirs: Model, theirsExtras: WorkbookExtras, myBaseRevision = 1) => ({
    theirs,
    theirsExtras,
    myBaseRevision,
    mySheets: mine.sheets(),
    pending: mine.pendingActions(),
  })

  it('a cell edit follows a row the other person inserted above it', () => {
    const base = newModel()
    base.setUserInput(0, 5, 1, 'row5')
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.setCell(5, 1, 'edited5')
    const theirs = loadModel(saved)
    theirs.insertRows(0, 1, 1) // their row pushes old row 5 down to row 6
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, extrasWith([{ base: 1, sheetId: sid(theirs), type: 'insertRows', at: 1, count: 1 }])))
    expect(result.status).toBe('merged')
    // My edit followed the row to its new home, instead of landing on row 5.
    expect(theirs.getFormattedCellValue(0, 6, 1)).toBe('edited5')
    mine.dispose()
    theirs.free()
  })

  it('a cell edit follows a row deleted above it', () => {
    const base = newModel()
    base.setUserInput(0, 5, 1, 'row5')
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.setCell(5, 1, 'edited5')
    const theirs = loadModel(saved)
    theirs.deleteRows(0, 1, 1) // old row 5 moves up to row 4
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, extrasWith([{ base: 1, sheetId: sid(theirs), type: 'deleteRows', at: 1, count: 1 }])))
    expect(result.status).toBe('merged')
    expect(theirs.getFormattedCellValue(0, 4, 1)).toBe('edited5')
    mine.dispose()
    theirs.free()
  })

  it('drops a cell edit whose own row the other person deleted, and counts it', () => {
    const base = newModel()
    base.setUserInput(0, 3, 1, 'row3')
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.setCell(3, 1, 'mine')
    const theirs = loadModel(saved)
    theirs.deleteRows(0, 3, 1)
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, extrasWith([{ base: 1, sheetId: sid(theirs), type: 'deleteRows', at: 3, count: 1 }])))
    expect(result).toMatchObject({ status: 'merged', dropped: 1 })
    mine.dispose()
    theirs.free()
  })

  it('a cell edit follows an inserted column, and is dropped when its own column is deleted', () => {
    const base = newModel()
    base.setUserInput(0, 1, 3, 'c3')
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.setCell(1, 3, 'mine')
    const theirs = loadModel(saved)
    theirs.insertColumns(0, 1, 1) // column 3 → column 4
    theirs.evaluate()
    const ins = rebaseWithLog(input(mine, theirs, extrasWith([{ base: 1, sheetId: sid(theirs), type: 'insertColumns', at: 1, count: 1 }])))
    expect(ins.status).toBe('merged')
    expect(theirs.getFormattedCellValue(0, 1, 4)).toBe('mine')
    mine.dispose()
    theirs.free()

    const mine2 = controller(saved)
    mine2.setCell(1, 3, 'mine')
    const theirs2 = loadModel(saved)
    theirs2.deleteColumns(0, 3, 1)
    theirs2.evaluate()
    const del = rebaseWithLog(input(mine2, theirs2, extrasWith([{ base: 1, sheetId: sid(theirs2), type: 'deleteColumns', at: 3, count: 1 }])))
    expect(del).toMatchObject({ status: 'merged', dropped: 1 })
    mine2.dispose()
    theirs2.free()
  })

  it('stops when an opaque action (a style) is on a sheet the other person changed structurally', () => {
    const base = newModel()
    base.setUserInput(0, 1, 1, 'x')
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.setStyle('font.b', 'true') // opaque, on Sheet1
    const theirs = loadModel(saved)
    theirs.insertRows(0, 1, 1)
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, extrasWith([{ base: 1, sheetId: sid(theirs), type: 'insertRows', at: 1, count: 1 }])))
    expect(result.status).toBe('stop')
    // theirs was left untouched: the style was not applied.
    expect(theirs.getCellStyle(0, 1, 1).style.font.b).not.toBe(true)
    mine.dispose()
    theirs.free()
  })

  it('replays an opaque action on another sheet the other person did not touch', () => {
    const base = newModel()
    base.newSheet() // Sheet2 at index 1
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.selectSheet(1)
    mine.setStyle('font.b', 'true') // opaque, on Sheet2
    const theirs = loadModel(saved)
    const sheet1 = listSheets(theirs)[0].id
    theirs.insertRows(0, 1, 1) // their change is on Sheet1 only
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, extrasWith([{ base: 1, sheetId: sheet1, type: 'insertRows', at: 1, count: 1 }])))
    expect(result.status).toBe('merged')
    expect(theirs.getCellStyle(1, 1, 1).style.font.b).toBe(true)
    mine.dispose()
    theirs.free()
  })

  it('stops when the log was trimmed below my base, or a reset is in range', () => {
    const base = newModel()
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const floored = controller(saved)
    floored.setCell(1, 1, 'x')
    const t1 = loadModel(saved)
    expect(rebaseWithLog(input(floored, t1, extrasWith([], 5), 1)).status).toBe('stop')
    floored.dispose()
    t1.free()

    const reset = controller(saved)
    reset.setCell(1, 1, 'x')
    const t2 = loadModel(saved)
    expect(rebaseWithLog(input(reset, t2, extrasWith([{ base: 1, sheetId: 0, type: 'reset' }]), 1)).status).toBe('stop')
    reset.dispose()
    t2.free()
  })

  it('with no log and no structural change, merges disjoint cells as before', () => {
    const mine = controller()
    mine.setCell(1, 1, 'from A')
    const theirs = newModel()
    theirs.setUserInput(0, 2, 2, 'from B')
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, emptyExtras()))
    expect(result.status).toBe('merged')
    expect(theirs.getFormattedCellValue(0, 1, 1)).toBe('from A')
    expect(theirs.getFormattedCellValue(0, 2, 2)).toBe('from B')
    mine.dispose()
    theirs.free()
  })

  it('resolves a cell edit by its sheet’s stable id when a sheet was deleted before it (no log needed)', () => {
    const base = newModel()
    base.newSheet() // Sheet2 at index 1
    base.setUserInput(1, 1, 1, 'orig')
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.selectSheet(1)
    mine.setCell(2, 2, 'mine') // on Sheet2
    const theirs = loadModel(saved)
    theirs.deleteSheet(0) // Sheet1 gone; Sheet2 moves to index 0
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, emptyExtras()))
    expect(result.status).toBe('merged')
    // My edit followed Sheet2 to its new index, not the stale index 1.
    expect(theirs.getFormattedCellValue(0, 2, 2)).toBe('mine')
    expect(theirs.getFormattedCellValue(0, 1, 1)).toBe('orig')
    mine.dispose()
    theirs.free()
  })

  it('stops an opaque action whose sheet moved to a different index', () => {
    const base = newModel()
    base.newSheet()
    base.evaluate()
    const saved = saveWorkbook(base)
    base.free()
    const mine = controller(saved)
    mine.selectSheet(1)
    mine.setStyle('font.b', 'true') // opaque, on Sheet2 (index 1)
    const theirs = loadModel(saved)
    theirs.deleteSheet(0) // Sheet2 now at index 0 — a diff would hit the wrong index
    theirs.evaluate()
    const result = rebaseWithLog(input(mine, theirs, emptyExtras()))
    expect(result.status).toBe('stop')
    mine.dispose()
    theirs.free()
  })

  it('follows the exact two-insert sequence seen in the browser (555 lands on Clips)', () => {
    // Item/Qty header, then Pens, Paper, Clips, Tape down column A with quantities in B.
    const start = newModel()
    const seed: Array<[number, number, string]> = [
      [1, 1, 'Item'], [1, 2, 'Qty'],
      [2, 1, 'Pens'], [2, 2, '10'],
      [3, 1, 'Paper'], [3, 2, '20'],
      [4, 1, 'Clips'], [4, 2, '30'],
      [5, 1, 'Tape'], [5, 2, '40'],
    ]
    for (const [r, c, v] of seed) start.setUserInput(0, r, c, v)
    start.evaluate()

    // Revision 2: A inserts a row above row 3 (made over revision 1).
    const afterFirst = loadModel(saveWorkbook(start))
    afterFirst.insertRows(0, 3, 1)
    afterFirst.evaluate()
    const rev2 = saveWorkbook(afterFirst)
    afterFirst.free()
    start.free()

    // B is on revision 2 (sees Clips on row 5) and types 555 into B5.
    const mine = controller(rev2)
    mine.setCell(5, 2, '555')
    const sheetId = mine.sheets()[0].id

    // Revision 3: A inserts another row above row 3 (made over revision 2).
    const theirs = loadModel(rev2)
    theirs.insertRows(0, 3, 1)
    theirs.evaluate()
    const log: StructureEntry[] = [
      { base: 1, sheetId, type: 'insertRows', at: 3, count: 1 },
      { base: 2, sheetId, type: 'insertRows', at: 3, count: 1 },
    ]
    const result = rebaseWithLog(input(mine, theirs, extrasWith(log), 2))
    expect(result.status).toBe('merged')
    // In revision 3 Clips sits on row 6: 555 is its quantity, Paper (row 5) untouched.
    expect(theirs.getFormattedCellValue(0, 6, 1)).toBe('Clips')
    expect(theirs.getFormattedCellValue(0, 6, 2)).toBe('555')
    expect(theirs.getFormattedCellValue(0, 5, 1)).toBe('Paper')
    expect(theirs.getFormattedCellValue(0, 5, 2)).toBe('20')
    expect(theirs.getFormattedCellValue(0, 7, 2)).toBe('40') // Tape

    // The save after that merge is refused too: A inserted a THIRD row (revision 4,
    // made over 3). What is replayed now is the pending work as the first merge
    // left it (555 on row 6), moved once more, not the address B first typed at.
    expect(result.status === 'merged' && result.pending).toEqual([
      expect.objectContaining({ action: { kind: 'cells', sheetId, cells: [{ row: 6, column: 2, input: '555' }] } }),
    ])
    const rev3 = loadModel(rev2)
    rev3.insertRows(0, 3, 1)
    rev3.evaluate()
    const third = loadModel(saveWorkbook(rev3))
    rev3.free()
    third.insertRows(0, 3, 1)
    third.evaluate()
    const again = rebaseWithLog({
      theirs: third,
      theirsExtras: extrasWith([...log, { base: 3, sheetId, type: 'insertRows', at: 3, count: 1 }]),
      myBaseRevision: 3,
      mySheets: listSheets(theirs),
      pending: result.status === 'merged' ? result.pending : [],
    })
    expect(again.status).toBe('merged')
    expect(third.getFormattedCellValue(0, 7, 1)).toBe('Clips')
    expect(third.getFormattedCellValue(0, 7, 2)).toBe('555')
    expect(third.getFormattedCellValue(0, 6, 2)).toBe('20') // Paper, untouched
    third.free()
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

  it('takes the structure log from theirs, adding my entries it does not have', () => {
    const base = emptyExtras()
    const mine = { ...emptyExtras(), structure: [{ base: 2, sheetId: 1, type: 'insertRows' as const, at: 1, count: 1 }], structureFloor: 0 }
    const theirs = { ...emptyExtras(), structure: [{ base: 1, sheetId: 1, type: 'insertRows' as const, at: 5, count: 1 }], structureFloor: 1 }
    const merged = mergeExtras(base, mine, theirs)
    // Theirs' log is kept and my own (not-yet-saved) entry is added — never mine replacing theirs.
    expect(merged.structure.map((e) => e.at)).toEqual([5, 1])
    expect(merged.structureFloor).toBe(1)
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
    // The sheet I added is not saved yet: it stays pending until a save lands,
    // so a second refused save can replay it again.
    expect(c.pendingDiffs()).toHaveLength(1)
    c.markSaved(c.dataVersion, undefined, 1)
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
