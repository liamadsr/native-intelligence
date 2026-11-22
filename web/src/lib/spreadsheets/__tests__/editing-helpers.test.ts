import { describe, expect, it } from 'vitest'
import { cellView, contrastOn } from '../cell-view'
import { parseTableHtml, sameClipboardText, tableHtml } from '../clipboard'
import { enclosingFunction, expectsReference, functionPrefix, insertReference, referenceText } from '../formula-edit'
import { newModel } from '../engine-server'
import { CELL_TYPE } from '../workbook'
import { readCellView } from '../cell-view'

const plain = { read_only: false, quote_prefix: false, fill: {}, font: { u: false, b: false, i: false, strike: false, sz: 12, name: 'Inter', family: 2, scheme: 'minor' }, border: {}, num_fmt: 'general' }
const resolve = (c: unknown) => (typeof c === 'string' ? c : '')

describe('how a cell is drawn', () => {
  it('puts numbers right, text left, and booleans and errors in the middle', () => {
    expect(cellView('12', CELL_TYPE.number, plain, resolve).align).toBe('right')
    expect(cellView('twelve', CELL_TYPE.text, plain, resolve).align).toBe('left')
    expect(cellView('TRUE', CELL_TYPE.boolean, plain, resolve).align).toBe('center')
    expect(cellView('#REF!', CELL_TYPE.error, plain, resolve)).toMatchObject({ align: 'center', error: true })
  })

  it('a chosen alignment wins over the kind of value', () => {
    const style = { ...plain, alignment: { horizontal: 'center' as const, vertical: 'top' as const, wrap_text: true } }
    expect(cellView('12', CELL_TYPE.number, style, resolve)).toMatchObject({ align: 'center', valign: 'top', wrap: true })
  })

  it('reads black on no fill as "no color", and keeps it on a fill', () => {
    const black = { ...plain, font: { ...plain.font, color: '#000000' } }
    expect(cellView('a', CELL_TYPE.text, black, resolve).color).toBeNull()
    expect(cellView('a', CELL_TYPE.text, { ...black, fill: { color: '#FFEE00' } }, resolve)).toMatchObject({ color: '#000000', fill: '#FFEE00' })
    expect(cellView('a', CELL_TYPE.text, { ...plain, font: { ...plain.font, color: '#C00000' } }, resolve).color).toBe('#C00000')
  })

  it('text on a fill with no color of its own is dark on a light fill and white on a dark one, in any theme', () => {
    expect(cellView('a', CELL_TYPE.text, { ...plain, fill: { color: '#DCEBFD' } }, resolve).color).toBe('#111111')
    expect(cellView('a', CELL_TYPE.text, { ...plain, fill: { color: '#1A2B4C' } }, resolve).color).toBe('#FFFFFF')
    expect(cellView('a', CELL_TYPE.text, { ...plain, fill: { color: '#FFEE00' }, font: { ...plain.font, color: '#C00000' } }, resolve).color).toBe('#C00000')
    expect(contrastOn('not a color')).toBeNull()
    expect(cellView('a', CELL_TYPE.text, plain, resolve).color).toBeNull()
  })

  it('knows a cell with nothing to draw, and one that only has a fill or a border', () => {
    expect(cellView('', 0, plain, resolve).blank).toBe(true)
    expect(cellView('', 0, { ...plain, fill: { color: '#EEEEEE' } }, resolve).blank).toBe(false)
    const bordered = cellView('', 0, { ...plain, border: { bottom: { style: 'medium' as never, color: '#111111' } } }, resolve)
    expect(bordered.blank).toBe(false)
    expect(bordered.borderBottom).toEqual({ width: 2, style: 'solid', color: '#111111' })
  })

  it('reads a styled cell straight from the engine', () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, '0.25')
    m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'num_fmt', '0%')
    m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'font.b', 'true')
    m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'fill.fg_color', '#DDEEFF')
    expect(readCellView(m, 0, 1, 1)).toMatchObject({ text: '25%', bold: true, fill: '#DDEEFF', align: 'right', fontFamily: null })
    expect(readCellView(m, 0, 5, 5).blank).toBe(true)
    m.free()
  })
})

describe('typing a formula', () => {
  it('knows where a click should drop a reference', () => {
    expect(expectsReference('=', 1)).toBe(true)
    expect(expectsReference('=SUM(', 5)).toBe(true)
    expect(expectsReference('=A1+ ', 5)).toBe(true)
    expect(expectsReference('=A1', 3)).toBe(false)
    expect(expectsReference('="a,', 4)).toBe(false)
    expect(expectsReference('plain,', 6)).toBe(false)
    expect(expectsReference('=SUM(A1)', 8)).toBe(false)
  })

  it('writes a reference, with its sheet when it is on another one', () => {
    expect(referenceText({ r1: 2, c1: 2, r2: 2, c2: 2 })).toBe('B2')
    expect(referenceText({ r1: 1, c1: 1, r2: 3, c2: 2 })).toBe('A1:B3')
    expect(referenceText({ r1: 1, c1: 1, r2: 1, c2: 1 }, 'Q3 plan')).toBe("'Q3 plan'!A1")
  })

  it('drops a reference at the caret, and the next click replaces it', () => {
    const first = insertReference('=SUM()', 5, 'A1')
    expect(first).toEqual({ draft: '=SUM(A1)', start: 5, end: 7 })
    expect(insertReference(first.draft, 7, 'B2:B9', first)).toEqual({ draft: '=SUM(B2:B9)', start: 5, end: 10 })
  })

  it('finds the function name being typed', () => {
    expect(functionPrefix('=SU', 3)).toEqual({ prefix: 'SU', from: 1 })
    expect(functionPrefix('=IF(A1>2,vlo', 12)).toEqual({ prefix: 'vlo', from: 9 })
    expect(functionPrefix('=A1', 3)).toBeNull()
    expect(functionPrefix('="su', 4)).toBeNull()
    expect(functionPrefix('SU', 2)).toBeNull()
    expect(functionPrefix('=SUM', 2)).toBeNull()
  })

  it('finds the function the caret is inside, and which argument', () => {
    expect(enclosingFunction('=IF(A1>2, ', 10)).toEqual({ name: 'IF', argument: 2 })
    expect(enclosingFunction('=IF(SUM(A1,B1)>2,"a,b",', 23)).toEqual({ name: 'IF', argument: 3 })
    expect(enclosingFunction('=sum(a1,', 8)).toEqual({ name: 'SUM', argument: 2 })
    expect(enclosingFunction('=A1+2', 5)).toBeNull()
    expect(enclosingFunction('=(1+2', 5)).toBeNull()
  })
})

describe('the clipboard', () => {
  it('writes a table other spreadsheets paste from', () => {
    expect(tableHtml([['a', '1 < 2'], ['two\nlines', '']])).toBe('<table><tr><td>a</td><td>1 &lt; 2</td></tr><tr><td>two<br>lines</td><td></td></tr></table>')
  })

  it('reads a table copied from another spreadsheet', () => {
    const html = '<meta charset="utf-8"><table><tbody><tr><td style="x">Item</td><td><b>Cost</b></td></tr><tr><td>Paper &amp; ink</td><td>12.5</td></tr></tbody></table>'
    expect(parseTableHtml(html)).toEqual([['Item', 'Cost'], ['Paper & ink', '12.5']])
    expect(parseTableHtml('<p>no table</p>')).toBeNull()
  })

  it('keeps merged cells in their place', () => {
    const html = '<table><tr><td colspan="2">Wide</td><td>c</td></tr><tr><td rowspan="2">Tall</td><td>b</td><td>c</td></tr><tr><td>b2</td><td>c2</td></tr></table>'
    expect(parseTableHtml(html)).toEqual([['Wide', '', 'c'], ['Tall', 'b', 'c'], ['', 'b2', 'c2']])
  })

  it('round-trips its own table', () => {
    const rows = [['x', '"quoted"'], ['a\nb', '<tag>']]
    expect(parseTableHtml(tableHtml(rows))).toEqual(rows)
  })

  it('compares clipboard text whatever its line endings', () => {
    expect(sameClipboardText('a\tb\r\nc\td\r\n', 'a\tb\nc\td')).toBe(true)
    expect(sameClipboardText('a', 'b')).toBe(false)
  })
})
