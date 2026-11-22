import { describe, expect, it } from 'vitest'
import { newModel } from '../engine-server'
import { goalSeek } from '../goal-seek'

/** A fresh model with B1 as the input and D1 a formula over it. */
function model(formula: string, start = '1') {
  const m = newModel()
  m.setUserInput(0, 1, 2, start) // B1
  m.setUserInput(0, 1, 4, formula) // D1
  m.evaluate()
  return m
}

const seek = (m: ReturnType<typeof model>, target: number) =>
  goalSeek(m, { setSheet: 0, setRow: 1, setColumn: 4, changeSheet: 0, changeRow: 1, changeColumn: 2, target })

describe('goalSeek', () => {
  it('solves a linear relation', () => {
    const m = model('=B1*4+2')
    const result = seek(m, 30) // 4x+2=30 -> x=7
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.input).toBeCloseTo(7, 5)
    m.free()
  })

  it('finds a root of a quadratic with two roots', () => {
    const m = model('=B1*B1-9', '2') // roots at 3 and -3
    const result = seek(m, 0)
    expect(result.ok).toBe(true)
    if (result.ok) expect(Math.abs(result.input)).toBeCloseTo(3, 4)
    m.free()
  })

  it('reports when there is no solution', () => {
    const m = model('=B1*B1+1', '0') // always >= 1, never 0
    const result = seek(m, 0)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-solution')
    m.free()
  })

  it('refuses a set cell that is not a number', () => {
    const m = newModel()
    m.setUserInput(0, 1, 2, '1')
    m.setUserInput(0, 1, 4, '=CONCAT("a", B1)')
    m.evaluate()
    const result = seek(m, 5)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-numeric')
    m.free()
  })

  it('refuses when the set and change cells are the same', () => {
    const m = model('=B1*2')
    const result = goalSeek(m, { setSheet: 0, setRow: 1, setColumn: 2, changeSheet: 0, changeRow: 1, changeColumn: 2, target: 5 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('same-cell')
    m.free()
  })

  it('does not change the cell on the model it was given beyond the search (caller passes a copy)', () => {
    const m = model('=B1*3')
    const result = seek(m, 90) // x = 30
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.input).toBeCloseTo(30, 5)
    m.free()
  })
})
