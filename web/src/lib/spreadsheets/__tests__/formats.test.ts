import { describe, expect, it } from 'vitest'
import { newModel } from '../engine-server'
import { DATE_FORMATS, FONT_SIZES, NUMBER_FORMATS, PALETTE, changeDecimals, clampFontSize, decimalsOf, formatKind, isDateFormat } from '../formats'

describe('the number formats on offer', () => {
  it('the engine draws each as its example says', () => {
    const m = newModel()
    NUMBER_FORMATS.forEach((f, i) => {
      // 9 March 2026, 2:30 PM for dates and times; 0.125 for a percent; 1234.5 otherwise.
      const value = f.id === 'date' || f.id === 'time' ? '46090.604166666664' : f.id === 'percent' ? '0.125' : '1234.5'
      m.setUserInput(0, i + 1, 1, value)
      m.updateRangeStyle({ sheet: 0, row: i + 1, column: 1, width: 1, height: 1 }, 'num_fmt', f.code)
    })
    m.evaluate()
    for (const [i, f] of NUMBER_FORMATS.entries()) {
      const shown = m.getFormattedCellValue(0, i + 1, 1).trim().replace(/\s+/g, ' ')
      // Plain text is the one the engine rounds (1235): the app writes such cells as text instead (controller).
      if (f.id !== 'text') expect(shown, f.label).toBe(f.example)
    }
    m.free()
  })

  it('accounting puts negatives in brackets and zero as a dash', () => {
    const m = newModel()
    const code = NUMBER_FORMATS.find((f) => f.id === 'accounting')?.code as string
    ;['-1234.5', '0'].forEach((v, i) => {
      m.setUserInput(0, i + 1, 1, v)
      m.updateRangeStyle({ sheet: 0, row: i + 1, column: 1, width: 1, height: 1 }, 'num_fmt', code)
    })
    expect(m.getFormattedCellValue(0, 1, 1).trim().replace(/\s+/g, ' ')).toBe('$ (1,234.50)')
    expect(m.getFormattedCellValue(0, 2, 1).trim().replace(/\s+/g, ' ')).toBe('$ -')
    m.free()
  })

  it('the engine writes 9 March 2026 in each date format as its example says', () => {
    const m = newModel()
    DATE_FORMATS.forEach((f, i) => {
      m.setUserInput(0, i + 1, 1, '46090')
      m.updateRangeStyle({ sheet: 0, row: i + 1, column: 1, width: 1, height: 1 }, 'num_fmt', f.code)
    })
    expect(DATE_FORMATS.map((_, i) => m.getFormattedCellValue(0, i + 1, 1))).toEqual(DATE_FORMATS.map((f) => f.example))
    m.free()
  })
})

describe('reading a format code', () => {
  it('knows which of the menu’s formats a code is', () => {
    for (const f of NUMBER_FORMATS) expect(formatKind(f.code), f.label).toBe(f.id)
    expect(formatKind('')).toBe('automatic')
    expect(formatKind('#,##0')).toBe('number')
    expect(formatKind('#,##0%')).toBe('percent')
    expect(formatKind('€#,##0.00')).toBe('currency')
    expect(formatKind('yyyy-mm-dd hh:mm')).toBe('date')
    expect(formatKind('h:mm:ss')).toBe('time')
    expect(formatKind('mm:ss')).toBe('time')
    expect(formatKind('"Total: "0')).toBe('number')
  })

  it('tells a date code from a number code, quotes and brackets aside', () => {
    expect(isDateFormat('d mmm yyyy')).toBe(true)
    expect(isDateFormat('h:mm AM/PM')).toBe(true)
    expect(isDateFormat('0.00')).toBe(false)
    expect(isDateFormat('"days: "0')).toBe(false)
    expect(isDateFormat('[Red]0.0')).toBe(false)
    expect(isDateFormat('general')).toBe(false)
  })

  it('counts decimal places', () => {
    expect(decimalsOf('#,##0.00')).toBe(2)
    expect(decimalsOf('0')).toBe(0)
    expect(decimalsOf('"$"#,##0.000;("$"#,##0.000)')).toBe(3)
    expect(decimalsOf('0.0%')).toBe(1)
  })
})

describe('more and fewer decimal places', () => {
  it('adds and removes places in every section, leaving the rest of the code alone', () => {
    expect(changeDecimals('#,##0.00', 1)).toBe('#,##0.000')
    expect(changeDecimals('#,##0.00', -1)).toBe('#,##0.0')
    expect(changeDecimals('#,##0.0', -1)).toBe('#,##0')
    expect(changeDecimals('#,##0', -1)).toBe('#,##0')
    expect(changeDecimals('0%', 2)).toBe('0.00%')
    expect(changeDecimals('"$"#,##0.00', 1)).toBe('"$"#,##0.000')
    expect(changeDecimals('0.00E+00', -1)).toBe('0.0E+00')
    expect(changeDecimals('"0.5 "0.0', 1)).toBe('"0.5 "0.00')
    expect(changeDecimals('_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)', -2)).toBe('_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"??_);_(@_)')
  })

  it('starts an automatic cell from the places it is showing', () => {
    expect(changeDecimals('general', 1, '12.5')).toBe('0.00')
    expect(changeDecimals('general', -1, '12.57')).toBe('0.0')
    expect(changeDecimals('general', 1, '12')).toBe('0.0')
    expect(changeDecimals('general', -1, '12')).toBe('0')
  })

  it('leaves dates and text as they are, and stops at thirty places', () => {
    expect(changeDecimals('yyyy-mm-dd', 1)).toBe('yyyy-mm-dd')
    expect(changeDecimals('@', 1)).toBe('@')
    expect(decimalsOf(changeDecimals('0.0', 99))).toBe(30)
  })

  it('what it writes, the engine draws', () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, '1234.5678')
    for (const [code, want] of [[changeDecimals('#,##0.00', 1), '1,234.568'], [changeDecimals('#,##0.00', -2), '1,235'], [changeDecimals('general', -3, '1234.5678'), '1234.6']] as const) {
      m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'num_fmt', code)
      expect(m.getFormattedCellValue(0, 1, 1)).toBe(want)
    }
    m.free()
  })
})

describe('sizes and colors', () => {
  it('keeps a font size within reach', () => {
    expect(clampFontSize(2)).toBe(6)
    expect(clampFontSize(500)).toBe(96)
    expect(clampFontSize(11.4)).toBe(11)
    expect(FONT_SIZES).toContain(12)
  })

  it('names every color once, each a full hex', () => {
    expect(new Set(PALETTE.map((c) => c.name)).size).toBe(PALETTE.length)
    expect(new Set(PALETTE.map((c) => c.hex)).size).toBe(PALETTE.length)
    for (const c of PALETTE) expect(c.hex).toMatch(/^#[0-9A-F]{6}$/)
  })
})
