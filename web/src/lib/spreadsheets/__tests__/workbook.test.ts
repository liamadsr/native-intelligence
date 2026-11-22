import { describe, expect, it } from 'vitest'
import { loadModel, newModel } from '../engine-server'
import { blankWorkbook, describeWorkbook } from '../store'
import { base64ToBytes, bytesToBase64, listSheets, readCell, saveWorkbook, usedRange, workbookDigest } from '../workbook'

describe('the engine on the server', () => {
  it('calculates across sheets and gives Excel’s error values', () => {
    const m = newModel()
    m.newSheet()
    m.setUserInput(0, 1, 1, '120')
    m.setUserInput(0, 2, 1, '80')
    m.setUserInput(1, 1, 1, '=SUM(Sheet1!A1:A2)')
    m.setUserInput(1, 2, 1, '=1/0')
    m.setUserInput(1, 3, 1, '=NOSUCH(1)')
    m.setUserInput(1, 4, 1, '=Sheet9!A1')
    m.setUserInput(1, 5, 1, '=XLOOKUP(80,Sheet1!A:A,Sheet1!A:A)*2')
    m.evaluate()
    expect([1, 2, 3, 4, 5].map((r) => m.getFormattedCellValue(1, r, 1))).toEqual(['200', '#DIV/0!', '#NAME?', '#REF!', '160'])
    expect(readCell(m, 1, 1, 1)).toEqual({ input: '=SUM(Sheet1!A1:A2)', text: '200', kind: 'number', formula: true })
    expect(readCell(m, 1, 2, 1).kind).toBe('error')
    expect(readCell(m, 0, 9, 9)).toEqual({ input: '', text: '', kind: 'empty', formula: false })
    m.free()
  })

  it('saves a workbook and opens it again with its formulas', () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, '7')
    m.setUserInput(0, 1, 2, '=A1*6')
    m.renameSheet(0, 'Budget')
    const saved = saveWorkbook(m)
    m.free()
    const again = loadModel(saved)
    again.evaluate()
    expect(again.getCellContent(0, 1, 2)).toBe('=A1*6')
    expect(again.getFormattedCellValue(0, 1, 2)).toBe('42')
    expect(listSheets(again)).toEqual([{ index: 0, id: 1, name: 'Budget', hidden: false, color: null }])
    again.free()
  })

  it('opens an empty workbook when nothing was saved', () => {
    const m = loadModel(null)
    expect(listSheets(m).map((s) => s.name)).toEqual(['Sheet1'])
    m.free()
  })
})

describe('what a workbook says about itself', () => {
  it('finds the rectangle that holds every filled cell', () => {
    const m = newModel()
    expect(usedRange(m, 0)).toBeNull()
    m.setUserInput(0, 3, 2, 'a')
    m.setUserInput(0, 40, 9, 'b')
    m.setUserInput(0, 12, 1, 'c')
    expect(usedRange(m, 0)).toEqual({ r1: 3, c1: 1, r2: 40, c2: 9 })
    m.free()
  })

  it('collects the words for search and leaves bare numbers out', () => {
    const m = newModel()
    m.renameSheet(0, 'Vendors')
    m.setUserInput(0, 1, 1, 'Northwind Paper')
    m.setUserInput(0, 1, 2, '1250.5')
    m.setUserInput(0, 2, 1, '=UPPER("quarterly")')
    m.evaluate()
    expect(workbookDigest(m)).toBe('Vendors Northwind Paper QUARTERLY')
    expect(workbookDigest(m, 10).length).toBeLessThanOrEqual(10)
    m.free()
  })

  it('describes a saved workbook, and refuses bytes that are not one', () => {
    expect(describeWorkbook(blankWorkbook('Plan'))).toEqual({ sheetNames: ['Plan'], digest: 'Plan' })
    expect(describeWorkbook(bytesToBase64(new Uint8Array([1, 2, 3, 4])))).toBeNull()
    expect(describeWorkbook('not base64 at all')).toBeNull()
  })

  it('turns bytes into base64 and back', () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 251)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)).subarray(0, 300))).toEqual(Array.from(bytes.subarray(0, 300)))
    expect(base64ToBytes(bytesToBase64(bytes)).length).toBe(70000)
  })
})

describe('a large sheet', () => {
  it('fills, calculates, saves and reopens 20,000 rows of formulas in seconds', () => {
    const started = Date.now()
    const m = newModel()
    m.pauseEvaluation()
    for (let r = 1; r <= 20000; r++) {
      m.setUserInput(0, r, 1, String(r))
      m.setUserInput(0, r, 2, `=A${r}*2`)
    }
    m.resumeEvaluation()
    m.setUserInput(0, 1, 4, '=SUM(B1:B20000)')
    m.evaluate()
    expect(m.getFormattedCellValue(0, 1, 4)).toBe('400020000')
    expect(usedRange(m, 0)).toEqual({ r1: 1, c1: 1, r2: 20000, c2: 4 })
    const again = loadModel(saveWorkbook(m))
    again.evaluate()
    expect(again.getFormattedCellValue(0, 20000, 2)).toBe('40000')
    m.free()
    again.free()
    expect(Date.now() - started).toBeLessThan(20000)
  })
})
