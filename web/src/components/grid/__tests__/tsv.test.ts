/**
 * TSV as spreadsheets write it (../tsv.ts): tabs and newlines, CRLF, quoted
 * cells holding tabs, newlines and doubled quotes, and the round trip.
 */
import { describe, expect, it } from 'vitest'
import { parseTsv, toTsv } from '../tsv'

describe('parseTsv', () => {
  it('splits cells by tabs and rows by newlines, with no empty row for a trailing newline', () => {
    expect(parseTsv('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseTsv('a\tb')).toEqual([['a', 'b']])
    expect(parseTsv('')).toEqual([])
  })

  it('reads CRLF (Excel) and a lone CR', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseTsv('a\rb')).toEqual([['a'], ['b']])
  })

  it('keeps empty cells, leading and trailing', () => {
    expect(parseTsv('\tx\t\n\t\t')).toEqual([['', 'x', ''], ['', '', '']])
  })

  it('reads a quoted cell holding a newline, a tab and a doubled quote', () => {
    const text = 'Name\tNotes\n"Fernhill Studio"\t"Line one\nline two"\n"Tab\there"\t"She said ""yes"""\n'
    expect(parseTsv(text)).toEqual([
      ['Name', 'Notes'],
      ['Fernhill Studio', 'Line one\nline two'],
      ['Tab\there', 'She said "yes"'],
    ])
  })

  it('takes a quote inside an unquoted cell as text', () => {
    expect(parseTsv('5" tile\tok')).toEqual([['5" tile', 'ok']])
  })

  it('reads one value with no tab or newline', () => {
    expect(parseTsv('42')).toEqual([['42']])
  })
})

describe('toTsv', () => {
  it('quotes only cells that need it, and parses back to the same cells', () => {
    const rows = [
      ['Order 12', '1,200.00', ''],
      ['Two\nlines', 'a\tb', 'say "hi"'],
    ]
    const text = toTsv(rows)
    expect(text.split('\n')[0]).toBe('Order 12\t1,200.00\t')
    expect(parseTsv(text)).toEqual(rows)
  })
})
