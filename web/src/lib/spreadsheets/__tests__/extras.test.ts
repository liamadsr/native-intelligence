import { describe, expect, it } from 'vitest'
import {
  addCheckboxes,
  clearValidationIn,
  describeValidation,
  emptyExtras,
  extrasAreEmpty,
  isCheckbox,
  passesBound,
  putValidation,
  readExtras,
  removeCheckboxesIn,
  shiftExtras,
  subtractRange,
  validationAt,
  type ListValidation,
} from '../extras'
import type { CellRange } from '../a1'

const R = (r1: number, c1: number, r2: number, c2: number): CellRange => ({ r1, c1, r2, c2 })
const list = (reject = true): ListValidation => ({ type: 'list', choices: [{ value: 'Yes' }, { value: 'No' }], reject })

describe('readExtras', () => {
  it('drops what it does not understand and keeps what it does', () => {
    const extras = readExtras({
      v: 99,
      validations: [
        { sheetId: 1, range: { r1: 1, c1: 1, r2: 2, c2: 2 }, rule: { type: 'list', choices: [{ value: 'A', color: '#1A73E8' }], reject: true } },
        { sheetId: 1, range: { r1: 1, c1: 1, r2: 2, c2: 2 }, rule: { type: 'mystery' } }, // dropped: bad rule
        { sheetId: 1, rule: { type: 'list', choices: [{ value: 'X' }] } }, // dropped: no range
      ],
      checkboxes: [{ sheetId: 2, range: { r1: 3, c1: 3, r2: 3, c2: 3 } }],
      gremlins: [1, 2, 3],
    })
    expect(extras.v).toBe(1)
    expect(extras.validations).toHaveLength(1)
    expect((extras.validations[0].rule as ListValidation).choices[0].color).toBe('#1A73E8')
    expect(extras.checkboxes).toHaveLength(1)
    expect((extras as unknown as Record<string, unknown>).gremlins).toBeUndefined()
  })

  it('reads junk as empty extras', () => {
    expect(extrasAreEmpty(readExtras(null))).toBe(true)
    expect(extrasAreEmpty(readExtras('nope'))).toBe(true)
    expect(extrasAreEmpty(readExtras({}))).toBe(true)
  })

  it('normalizes an out-of-order range', () => {
    const extras = readExtras({ checkboxes: [{ sheetId: 0, range: { r1: 5, c1: 4, r2: 2, c2: 1 } }] })
    expect(extras.checkboxes[0].range).toEqual({ r1: 2, c1: 1, r2: 5, c2: 4 })
  })
})

describe('subtractRange', () => {
  it('returns the four pieces around a hole', () => {
    const pieces = subtractRange(R(1, 1, 5, 5), R(2, 2, 3, 3))
    // top, bottom, left-middle, right-middle
    expect(pieces).toHaveLength(4)
    // every cell of the original except the hole is covered exactly once
    const covered = new Set<string>()
    for (const p of pieces) for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) covered.add(`${r},${c}`)
    expect(covered.size).toBe(25 - 4)
    expect(covered.has('2,2')).toBe(false)
  })

  it('returns the whole rectangle when there is no overlap', () => {
    expect(subtractRange(R(1, 1, 2, 2), R(5, 5, 6, 6))).toEqual([R(1, 1, 2, 2)])
  })

  it('returns nothing when fully covered', () => {
    expect(subtractRange(R(2, 2, 3, 3), R(1, 1, 5, 5))).toEqual([])
  })
})

describe('validations', () => {
  it('a new rule carves its range out of an overlapping one', () => {
    let extras = putValidation(emptyExtras(), 7, R(1, 1, 4, 4), list())
    extras = putValidation(extras, 7, R(2, 2, 3, 3), { type: 'list', choices: [{ value: 'Mid' }], reject: false })
    // The inner cell has the new rule; a corner of the old range keeps the old rule.
    expect((validationAt(extras, 7, 2, 2)!.rule as ListValidation).choices[0].value).toBe('Mid')
    expect((validationAt(extras, 7, 1, 1)!.rule as ListValidation).choices[0].value).toBe('Yes')
    expect(validationAt(extras, 7, 2, 2)!.rule.reject).toBe(false)
  })

  it('clears validation in a range, leaving the pieces outside it', () => {
    let extras = putValidation(emptyExtras(), 0, R(1, 1, 3, 1), list())
    extras = clearValidationIn(extras, 0, R(2, 1, 2, 1))
    expect(validationAt(extras, 0, 1, 1)).not.toBeNull()
    expect(validationAt(extras, 0, 2, 1)).toBeNull()
    expect(validationAt(extras, 0, 3, 1)).not.toBeNull()
  })
})

describe('checkboxes', () => {
  it('adds and removes, by range', () => {
    let extras = addCheckboxes(emptyExtras(), 0, R(1, 1, 1, 3))
    expect(isCheckbox(extras, 0, 1, 2)).toBe(true)
    expect(isCheckbox(extras, 0, 2, 2)).toBe(false)
    extras = removeCheckboxesIn(extras, 0, R(1, 2, 1, 2))
    expect(isCheckbox(extras, 0, 1, 1)).toBe(true)
    expect(isCheckbox(extras, 0, 1, 2)).toBe(false)
    expect(isCheckbox(extras, 0, 1, 3)).toBe(true)
  })
})

describe('shiftExtras', () => {
  it('moves ranges down when rows are inserted above them', () => {
    const extras = addCheckboxes(emptyExtras(), 0, R(5, 2, 6, 2))
    const next = shiftExtras(extras, { type: 'insertRows', sheetId: 0, at: 3, count: 2 })
    expect(next.checkboxes[0].range).toEqual(R(7, 2, 8, 2))
  })

  it('does not move ranges above the insert point, or on another sheet', () => {
    const extras = addCheckboxes(addCheckboxes(emptyExtras(), 0, R(1, 1, 1, 1)), 1, R(5, 1, 5, 1))
    const next = shiftExtras(extras, { type: 'insertRows', sheetId: 0, at: 3, count: 1 })
    expect(next.checkboxes.find((b) => b.sheetId === 0)!.range).toEqual(R(1, 1, 1, 1))
    expect(next.checkboxes.find((b) => b.sheetId === 1)!.range).toEqual(R(5, 1, 5, 1))
  })

  it('shrinks a range that straddles deleted rows and drops one wholly inside', () => {
    let extras = putValidation(emptyExtras(), 0, R(2, 1, 8, 1), list())
    extras = addCheckboxes(extras, 0, R(4, 1, 5, 1))
    const next = shiftExtras(extras, { type: 'deleteRows', sheetId: 0, at: 4, count: 2 })
    expect(next.validations[0].range).toEqual(R(2, 1, 6, 1)) // 8 - 2
    expect(next.checkboxes).toHaveLength(0) // 4..5 removed entirely
  })

  it('shifts and shrinks columns too', () => {
    const extras = addCheckboxes(emptyExtras(), 0, R(1, 5, 1, 8))
    expect(shiftExtras(extras, { type: 'insertColumns', sheetId: 0, at: 2, count: 1 }).checkboxes[0].range).toEqual(R(1, 6, 1, 9))
    expect(shiftExtras(extras, { type: 'deleteColumns', sheetId: 0, at: 1, count: 4 }).checkboxes[0].range).toEqual(R(1, 1, 1, 4))
  })

  it('drops a deleted sheet and copies a duplicated one', () => {
    const extras = addCheckboxes(emptyExtras(), 3, R(1, 1, 1, 1))
    expect(shiftExtras(extras, { type: 'deleteSheet', sheetId: 3 }).checkboxes).toHaveLength(0)
    const dup = shiftExtras(extras, { type: 'duplicateSheet', fromId: 3, toId: 9 })
    expect(dup.checkboxes.map((b) => b.sheetId).sort()).toEqual([3, 9])
  })
})

describe('bound rules', () => {
  it('checks the operators', () => {
    expect(passesBound(5, { type: 'number', operator: 'between', min: '1', max: '10', reject: true })).toBe(true)
    expect(passesBound(50, { type: 'number', operator: 'between', min: '1', max: '10', reject: true })).toBe(false)
    expect(passesBound(5, { type: 'number', operator: 'greaterThan', min: '4', reject: true })).toBe(true)
    expect(passesBound(5, { type: 'number', operator: 'lessThan', min: '4', reject: true })).toBe(false)
    expect(describeValidation({ type: 'number', operator: 'greaterThan', min: '4', reject: true })).toContain('greater than 4')
  })
})
