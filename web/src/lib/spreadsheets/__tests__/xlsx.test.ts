/**
 * .xlsx round trips and CSV both ways. The engine is the real one (the server
 * loader), and the hand-built workbook is assembled from XML strings with
 * JSZip, so the reader is tested against a file it did not write. Fixtures use
 * made-up names and numbers only.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { loadModel, newModel } from '../engine-server'
import { saveWorkbook } from '../workbook'
import { workbookToXlsx } from '../xlsx-write'
import { xlsxToWorkbook, shiftFormula } from '../xlsx-read'
import { sheetToCsv, csvToRows } from '../csv'
import type { Model } from '@ironcalc/wasm'

/** Write a model to .xlsx, read it back, and open the result for inspection. */
async function roundTrip(model: Model): Promise<{ bytes: Uint8Array; back: Model; warnings: string[]; sheetNames: string[] }> {
  const bytes = await workbookToXlsx(model)
  const { workbook, warnings, sheetNames } = await xlsxToWorkbook(bytes)
  return { bytes, back: loadModel(workbook), warnings, sheetNames }
}

async function partText(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  return (await zip.file(path)?.async('string')) ?? ''
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

describe('xlsx round trip: values, formulas and their cached values', () => {
  it('carries numbers, strings, booleans, errors and formulas back', async () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, 'Northwind units')
    m.setUserInput(0, 1, 2, '1250.5')
    m.setUserInput(0, 2, 1, 'TRUE')
    m.setUserInput(0, 2, 2, '=1/0')
    m.setUserInput(0, 3, 1, '=B1*2')
    m.setUserInput(0, 3, 2, '=A1&" sold"')
    m.setUserInput(0, 4, 1, '="=not a formula"') // a string result
    m.evaluate()
    const { bytes, back } = await roundTrip(m)

    expect(back.getFormattedCellValue(0, 1, 1)).toBe('Northwind units')
    expect(back.getFormattedCellValue(0, 1, 2)).toBe('1250.5')
    expect(back.getCellType(0, 2, 1)).toBe(4) // boolean
    expect(back.getFormattedCellValue(0, 2, 2)).toBe('#DIV/0!')
    expect(back.getCellContent(0, 3, 1)).toBe('=B1*2')
    expect(back.getFormattedCellValue(0, 3, 1)).toBe('2501')
    expect(back.getFormattedCellValue(0, 3, 2)).toBe('Northwind units sold')

    // The written XML holds each formula's cached value beside the formula.
    const sheet = await partText(bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toMatch(/<f>B1\*2<\/f><v>2501<\/v>/)
    expect(sheet).toMatch(/<f>1\/0<\/f><v>#DIV\/0!<\/v>/)
    expect(sheet).toContain('t="str"')
    m.free()
    back.free()
  })

  it('keeps every style property, number format, widths, heights, hidden, merges, frozen, gridlines, sheets and defined names', async () => {
    const m = newModel()
    m.renameSheet(0, 'Budget')
    m.setUserInput(0, 1, 1, 'Heading')
    m.setUserInput(0, 1, 2, '1234.5')
    m.setUserInput(0, 2, 1, 'plain')
    // Styles on A1 via the engine's own paths and a paste for the font name.
    const area = { sheet: 0, row: 1, column: 1, width: 1, height: 1 }
    m.updateRangeStyle(area, 'font.b', 'true')
    m.updateRangeStyle(area, 'font.i', 'true')
    m.updateRangeStyle(area, 'font.u', 'true')
    m.updateRangeStyle(area, 'font.strike', 'true')
    m.updateRangeStyle(area, 'font.size', '18')
    m.updateRangeStyle(area, 'font.color', '#D92D20')
    m.updateRangeStyle(area, 'fill.fg_color', '#FEF3C7')
    m.updateRangeStyle(area, 'alignment.horizontal', 'center')
    m.updateRangeStyle(area, 'alignment.vertical', 'top')
    m.updateRangeStyle(area, 'alignment.wrap_text', 'true')
    const nameStyle = { ...m.getCellStyle(0, 1, 1).style }
    nameStyle.font = { ...nameStyle.font, name: 'Georgia' }
    m.setSelectedSheet(0)
    m.setSelectedCell(1, 1)
    m.setSelectedRange(1, 1, 1, 1)
    m.onPasteStyles([[nameStyle]])
    // Number format on B1, a border on A1.
    m.updateRangeStyle({ sheet: 0, row: 1, column: 2, width: 1, height: 1 }, 'num_fmt', '"$"#,##0.00')
    m.setAreaWithBorder(area, { item: { style: 'thick' as never, color: '#1A73E8' }, type: 'Bottom' as never })
    // Layout
    m.setColumnsWidth(0, 1, 1, 160)
    m.setRowsHeight(0, 1, 1, 40)
    m.setColumnsHidden(0, 3, 3, true)
    m.setRowsHidden(0, 5, 5, true)
    m.setUserInput(0, 5, 1, 'hidden row')
    m.mergeCells({ sheet: 0, row: 7, column: 1, width: 2, height: 2 })
    m.setUserInput(0, 7, 1, 'merged')
    m.setFrozenRowsCount(0, 1)
    m.setFrozenColumnsCount(0, 2)
    m.setShowGridLines(0, false)
    m.setSheetColor(0, '#1E8E3E')
    // A second, hidden sheet, and a defined name.
    m.newSheet()
    m.renameSheet(1, 'Notes')
    m.newDefinedName('Headline', null, 'Budget!$A$1')
    m.hideSheet(1)
    m.evaluate()

    const { back, sheetNames } = await roundTrip(m)
    const s = back.getCellStyle(0, 1, 1).style
    expect(s.font.b).toBe(true)
    expect(s.font.i).toBe(true)
    expect(s.font.u).toBe(true)
    expect(s.font.strike).toBe(true)
    expect(s.font.sz).toBe(18)
    expect(back.resolveColor(s.font.color)).toBe('#D92D20')
    expect(s.font.name).toBe('Georgia')
    expect(back.resolveColor(s.fill.color)).toBe('#FEF3C7')
    expect(s.alignment?.horizontal).toBe('center')
    expect(s.alignment?.vertical).toBe('top')
    expect(s.alignment?.wrap_text).toBe(true)
    expect(String(s.border.bottom?.style)).toBe('thick')
    expect(back.resolveColor(s.border.bottom?.color)).toBe('#1A73E8')
    expect(back.getCellStyle(0, 1, 2).style.num_fmt).toBe('"$"#,##0.00')
    expect(back.getFormattedCellValue(0, 1, 2)).toBe('$1,234.50')

    expect(Math.round(back.getColumnWidth(0, 1))).toBe(160)
    expect(Math.round(back.getRowHeight(0, 1))).toBe(40)
    expect(back.getColumnWidth(0, 3)).toBe(0) // hidden
    expect(back.getRowHeight(0, 5)).toBe(0) // hidden
    expect(back.getMergedCells(0)).toHaveLength(1)
    expect(back.getFrozenRowsCount(0)).toBe(1)
    expect(back.getFrozenColumnsCount(0)).toBe(2)
    expect(back.getShowGridLines(0)).toBe(false)

    const props = back.getWorksheetsProperties()
    expect(sheetNames).toEqual(['Budget', 'Notes'])
    expect(props[1].state).not.toBe('visible')
    expect(back.resolveColor(props[0].color)).toBe('#1E8E3E')
    expect(back.getDefinedNameList().map((n) => n.name)).toContain('Headline')
    m.free()
    back.free()
  })

  it('writes a blank cell that only carries a format as a blank, not as 0', async () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, 'Total')
    m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 3, height: 1 }, 'font.b', 'true')
    const { bytes, back } = await roundTrip(m)
    const xml = await partText(bytes, 'xl/worksheets/sheet1.xml')
    expect(xml).toMatch(/<c r="B1" s="\d+"\/>/)
    expect(xml).not.toMatch(/<c r="B1"[^>]*><v>/)
    expect(back.getCellContent(0, 1, 2)).toBe('')
    expect(back.getCellStyle(0, 1, 2).style.font.b).toBe(true)
    m.free()
    back.free()
  })

  it('round-trips a date typed as a date through its serial', async () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, '2026-03-09')
    m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'num_fmt', 'mm/dd/yyyy')
    m.evaluate()
    const { back } = await roundTrip(m)
    expect(back.getFormattedCellValue(0, 1, 1)).toBe('03/09/2026')
    expect(back.getCellType(0, 1, 1)).toBe(1)
    m.free()
    back.free()
  })
})

describe('xlsx reading a hand-built workbook', () => {
  /** Assemble a minimal .xlsx from XML strings, so the reader meets a file it did not write. */
  async function build(parts: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip()
    for (const [path, content] of Object.entries(parts)) zip.file(path, content)
    return zip.generateAsync({ type: 'uint8array' })
  }

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`
  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  const wbRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`

  it('reads shared strings, a shared formula expanded per cell, a date with the 1904 flag, and warns about a chart', async () => {
    const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`
    const sharedStrings = `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Widgets</t></si><si><r><t>Rich </t></r><r><t>text</t></r></si></sst>`
    // B1:B3 share a formula =A1*10; C1 is a date serial (1904) with a date format (xf 1).
    const sheet1 = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*10</f><v>0</v></c><c r="C1" s="1"><v>45716</v></c><c r="E1" t="s"><v>1</v></c></row>` +
      `<row r="2"><c r="A2"><v>5</v></c><c r="B2"><f t="shared" si="0"/><v>0</v></c><c r="D2" t="inlineStr"><is><t>inline here</t></is></c></row>` +
      `<row r="3"><c r="A3"><v>9</v></c><c r="B3"><f t="shared" si="0"/><v>0</v></c></row>` +
      `</sheetData></worksheet>`
    const styles = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1" xfId="0"/></cellXfs></styleSheet>`
    const chart = `${XML_HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`

    const bytes = await build({
      '[Content_Types].xml': contentTypes,
      '_rels/.rels': rootRels,
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': wbRels,
      'xl/sharedStrings.xml': sharedStrings,
      'xl/styles.xml': styles,
      'xl/worksheets/sheet1.xml': sheet1,
      'xl/charts/chart1.xml': chart,
    })

    const { workbook: b64, sheetNames, warnings } = await xlsxToWorkbook(bytes)
    const m = loadModel(b64)
    expect(sheetNames).toEqual(['Data'])
    expect(m.getFormattedCellValue(0, 1, 1)).toBe('Widgets')
    expect(m.getFormattedCellValue(0, 1, 5)).toBe('Rich text') // rich-text runs flattened
    // Shared formula expanded: B1=A1*10 (A1 is text → 0), B2=A2*10=50, B3=A3*10=90.
    expect(m.getCellContent(0, 2, 2)).toBe('=A2*10')
    expect(m.getFormattedCellValue(0, 2, 2)).toBe('50')
    expect(m.getCellContent(0, 3, 2)).toBe('=A3*10')
    expect(m.getFormattedCellValue(0, 3, 2)).toBe('90')
    expect(m.getFormattedCellValue(0, 2, 4)).toBe('inline here')
    // 1904 date: serial 45716 + 1462 = 47178 → 2029-03-08 displayed by the yyyy-mm-dd format.
    expect(m.getCellStyle(0, 1, 3).style.num_fmt).toBe('yyyy-mm-dd')
    expect(m.getFormattedCellValue(0, 1, 3)).toBe('2029-03-01') // 45716 (1904) + 1462 = 47178 (1900)
    expect(warnings).toContain('Charts were left out.')
    m.free()
  })

  it('warns about tables and treats their structured references as #NAME?', async () => {
    const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
    const sheet1 = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>SUM(Sales[Amount])</f><v>0</v></c></row></sheetData></worksheet>`
    const bytes = await build({
      '[Content_Types].xml': contentTypes,
      '_rels/.rels': rootRels,
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': sheet1,
      'xl/tables/table1.xml': `${XML_HEAD}<table/>`,
    })
    const { warnings } = await xlsxToWorkbook(bytes)
    expect(warnings.some((w) => w.includes('structured references'))).toBe(true)
  })
})

describe('xlsx refusals', () => {
  it('refuses a file that is not a zip, and one over the size cap', async () => {
    await expect(xlsxToWorkbook(new TextEncoder().encode('not a zip at all'))).rejects.toThrow(/not a spreadsheet/i)
    const huge = new Uint8Array(51 * 1024 * 1024)
    await expect(xlsxToWorkbook(huge)).rejects.toThrow(/larger than 50 MB/i)
  })

  it('refuses a zip that is not an xlsx', async () => {
    const zip = new JSZip()
    zip.file('hello.txt', 'just a text file')
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    await expect(xlsxToWorkbook(bytes)).rejects.toThrow(/not a spreadsheet/i)
  })
})

describe('shiftFormula', () => {
  it('shifts relative references and leaves absolute ones and strings alone', () => {
    expect(shiftFormula('A1*10', 1, 0)).toBe('A2*10')
    expect(shiftFormula('A1+B1', 2, 1)).toBe('B3+C3')
    expect(shiftFormula('$A$1+B1', 1, 1)).toBe('$A$1+C2')
    expect(shiftFormula('SUM(A1:A3)', 1, 0)).toBe('SUM(A2:A4)')
    expect(shiftFormula('A1&"keep B1 here"', 1, 0)).toBe('A2&"keep B1 here"')
  })
})

describe('csv', () => {
  it('writes shown values with RFC 4180 quoting and CRLF, not formulas', () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, 'Name')
    m.setUserInput(0, 1, 2, 'Note')
    m.setUserInput(0, 2, 1, 'Ada, Jr.')
    m.setUserInput(0, 2, 2, 'line1\nline2')
    m.setUserInput(0, 3, 1, '=1+1')
    m.setUserInput(0, 3, 2, 'say "hi"')
    m.evaluate()
    const csv = sheetToCsv(m, 0)
    expect(csv).toBe('Name,Note\r\n"Ada, Jr.","line1\nline2"\r\n2,"say ""hi"""')
    m.free()
  })

  it('reads quoted multi-line fields, a BOM, and sniffs comma, semicolon and tab', () => {
    expect(csvToRows('﻿a,b,c\r\nd,e,f')).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']])
    expect(csvToRows('a;b;c\nd;e;f')).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']])
    expect(csvToRows('a\tb\tc')).toEqual([['a', 'b', 'c']])
    expect(csvToRows('"two\nlines",next\r\n')).toEqual([['two\nlines', 'next']])
    expect(csvToRows('"he said ""hi""",x')).toEqual([['he said "hi"', 'x']])
    expect(csvToRows('')).toEqual([])
  })
})
