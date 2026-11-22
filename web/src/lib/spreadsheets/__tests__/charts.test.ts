import { describe, expect, it } from 'vitest'
import { compactNumber, niceTicks, pieSlices, prepareChartData, type ChartCell } from '../charts'

const cell = (text: string, value: number | null = null): ChartCell => ({ text, value })
const num = (n: number): ChartCell => ({ text: String(n), value: n })

describe('prepareChartData', () => {
  it('reads a header row and a category column', () => {
    const grid = [
      [cell(''), cell('Q1'), cell('Q2')],
      [cell('North'), num(10), num(20)],
      [cell('South'), num(30), num(40)],
    ]
    const prepared = prepareChartData(grid, 'column')
    expect(prepared.ok).toBe(true)
    expect(prepared.categories).toEqual(['North', 'South'])
    expect(prepared.series.map((s) => s.name)).toEqual(['Q1', 'Q2'])
    expect(prepared.series[0].values).toEqual([10, 30])
    expect(prepared.series[1].values).toEqual([20, 40])
    expect(prepared.max).toBe(40)
  })

  it('numbers the categories when the first column is not text', () => {
    const grid = [
      [num(10)],
      [num(20)],
      [num(30)],
    ]
    const prepared = prepareChartData(grid, 'line')
    expect(prepared.categories).toEqual(['1', '2', '3'])
    expect(prepared.series).toHaveLength(1)
    expect(prepared.series[0].values).toEqual([10, 20, 30])
  })

  it('reports no data when the range holds no numbers', () => {
    const grid = [[cell('a'), cell('b')], [cell('c'), cell('d')]]
    expect(prepareChartData(grid, 'column').ok).toBe(false)
  })

  it('builds x/y points for a scatter', () => {
    const grid = [
      [cell('x'), cell('y')],
      [num(1), num(2)],
      [num(3), num(6)],
    ]
    const prepared = prepareChartData(grid, 'scatter')
    expect(prepared.scatter).toHaveLength(1)
    expect(prepared.scatter[0].points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 6 }])
  })
})

describe('niceTicks', () => {
  it('rounds the bounds and spans zero', () => {
    const t = niceTicks(0, 100)
    expect(t.min).toBe(0)
    expect(t.max).toBe(100)
    expect(t.ticks[0]).toBe(0)
    expect(t.ticks[t.ticks.length - 1]).toBe(100)
  })

  it('keeps zero in range for a positive series', () => {
    const t = niceTicks(3, 27)
    expect(t.min).toBe(0)
    expect(t.max).toBeGreaterThanOrEqual(27)
    expect(t.ticks).toContain(0)
  })

  it('handles a negative extent', () => {
    const t = niceTicks(-40, 10)
    expect(t.min).toBeLessThanOrEqual(-40)
    expect(t.max).toBeGreaterThanOrEqual(10)
  })

  it('gives a sane span for a flat series', () => {
    const t = niceTicks(5, 5)
    expect(t.max).toBeGreaterThan(t.min)
    expect(t.ticks.length).toBeGreaterThan(1)
  })
})

describe('pieSlices', () => {
  it('splits the circle by each value share', () => {
    const slices = pieSlices([1, 3])
    expect(slices[0].fraction).toBeCloseTo(0.25, 5)
    expect(slices[1].fraction).toBeCloseTo(0.75, 5)
    expect(slices[1].end).toBeCloseTo(1, 5)
  })

  it('uses magnitudes and returns nothing for an all-zero set', () => {
    expect(pieSlices([0, 0])).toEqual([])
    expect(pieSlices([-2, 2])[0].fraction).toBeCloseTo(0.5, 5)
  })
})

describe('compactNumber', () => {
  it('abbreviates thousands and millions', () => {
    expect(compactNumber(1250)).toBe('1.25K')
    expect(compactNumber(2_000_000)).toBe('2M')
    expect(compactNumber(42)).toBe('42')
  })
})
