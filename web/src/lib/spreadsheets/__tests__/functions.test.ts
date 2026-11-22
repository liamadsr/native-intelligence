import { describe, expect, it } from 'vitest'
import { newModel } from '../engine-server'
import { ENGINE_MISSING, FUNCTIONS_BY_CATEGORY } from '../function-names'
import { FUNCTIONS, completeFunction, functionInfo } from '../functions'

const ALL = Object.values(FUNCTIONS_BY_CATEGORY).flat()

describe('the function list', () => {
  it('is the 492 names of the plan, each once', () => {
    expect(ALL).toHaveLength(492)
    expect(new Set(ALL).size).toBe(492)
  })

  it('the engine knows every name but the ones listed as missing', () => {
    const m = newModel()
    ALL.forEach((name, i) => m.setUserInput(0, i + 1, 1, `=${name}()`))
    m.evaluate()
    const unknown = ALL.filter((_, i) => m.getFormattedCellValue(0, i + 1, 1) === '#NAME?')
    m.free()
    expect(unknown).toEqual([...ENGINE_MISSING])
  })

  it('calculates a sample from every category', () => {
    const m = newModel()
    // Lookups and joins read cells here: over an inline array ({"a","b"}) this engine's XLOOKUP
    // answers #N/A, and its TEXTJOIN keeps a literal "" it was told to ignore (the plan lists both).
    m.setUserInput(0, 1, 5, 'a')
    m.setUserInput(0, 2, 5, 'b')
    m.setUserInput(0, 1, 6, '10')
    m.setUserInput(0, 2, 6, '20')
    m.setUserInput(0, 1, 7, 'x')
    m.setUserInput(0, 3, 7, 'y')
    const cases: Array<[string, string]> = [
      ['=SUMPRODUCT({1,2,3},{4,5,6})', '32'],
      ['=ROUND(MEDIAN(3,9,4.25),1)', '4.3'],
      ['=ROUND(PMT(0.05/12,36,-10000),2)', '299.71'],
      ['=IFS(1>2,"a",2>1,"b")', 'b'],
      ['=XLOOKUP("b",E1:E2,F1:F2)', '20'],
      ['=TEXTJOIN("-",TRUE,G1:G3)', 'x-y'],
      ['=TEXT(DATE(2026,3,9),"yyyy-mm-dd")', '2026-03-09'],
      ['=HEX2DEC("FF")', '255'],
      ['=ISNUMBER(4)', 'TRUE'],
      ['=LET(x,5,x*x)', '25'],
      ['=SUM(MAP({1,2,3},LAMBDA(v,v*2)))', '12'],
      ['=REGEXTEST("order-42","[0-9]+")', 'TRUE'],
      ['=NETWORKDAYS(DATE(2026,3,2),DATE(2026,3,6))', '5'],
      ['=IMSUM("1+i","2")', '3+i'],
    ]
    cases.forEach(([formula], i) => m.setUserInput(0, i + 1, 1, formula))
    m.evaluate()
    expect(cases.map((_, i) => m.getFormattedCellValue(0, i + 1, 1))).toEqual(cases.map(([, want]) => want))
    m.free()
  })

  it('spills an array into the cells below, and says #SPILL! when something is in the way', () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, '=SEQUENCE(3)')
    m.evaluate()
    expect([1, 2, 3].map((r) => m.getFormattedCellValue(0, r, 1))).toEqual(['1', '2', '3'])
    m.setUserInput(0, 2, 1, 'in the way')
    m.evaluate()
    expect(m.getFormattedCellValue(0, 1, 1)).toBe('#SPILL!')
    m.free()
  })
})

describe('completing a function name', () => {
  it('offers the names that start with what was typed, the common ones first', () => {
    expect(completeFunction('su').map((f) => f.name).slice(0, 4)).toEqual(['SUM', 'SUMIF', 'SUMIFS', 'SUBTOTAL'])
    expect(completeFunction('xl').map((f) => f.name)).toEqual(['XLOOKUP'])
    expect(completeFunction('')).toEqual([])
    expect(completeFunction('zzz')).toEqual([])
    expect(completeFunction('a', 3)).toHaveLength(3)
  })

  it('leaves out what the engine cannot calculate', () => {
    expect(FUNCTIONS.map((f) => f.name)).not.toContain('AGGREGATE')
    expect(completeFunction('getpivot')).toEqual([])
  })

  it('knows a function by any casing, with its arguments when it has help', () => {
    expect(functionInfo('vlookup')).toMatchObject({ name: 'VLOOKUP', category: 'lookup', signature: expect.stringContaining('column_number') })
    expect(functionInfo('BESSELI')).toMatchObject({ categoryLabel: 'Engineering' })
    expect(functionInfo('nope')).toBeNull()
  })

  it('every help entry is for a function in the list', () => {
    for (const f of FUNCTIONS) if (f.signature) expect(f.signature.startsWith(`${f.name}(`)).toBe(true)
    expect(FUNCTIONS.filter((f) => f.signature).length).toBeGreaterThan(90)
  })
})
