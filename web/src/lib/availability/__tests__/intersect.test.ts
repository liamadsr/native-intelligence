/**
 * Interval intersection (../engine.ts): mergeSpans joins overlapping and
 * touching spans, intersectSpans keeps the time in both lists, intersectAll
 * the time in every list (several people's free time: when all are free).
 * Lists come in any order, with overlaps.
 */
import { describe, expect, it } from 'vitest'
import { intersectAll, intersectSpans, mergeSpans, type Span } from '../engine'

const s = (start: number, end: number): Span => ({ start, end })
const pairs = (spans: readonly Span[]) => spans.map((x) => [x.start, x.end])

describe('mergeSpans', () => {
  it('sorts, joins overlapping and touching spans, and drops empty ones', () => {
    expect(pairs(mergeSpans([s(50, 60), s(10, 20), s(15, 30), s(30, 40), s(70, 70), s(80, 75)]))).toEqual([
      [10, 40],
      [50, 60],
    ])
  })

  it('never changes what it was given', () => {
    const input = [s(10, 20), s(15, 30)]
    mergeSpans(input)
    expect(pairs(input)).toEqual([
      [10, 20],
      [15, 30],
    ])
  })
})

describe('intersectSpans', () => {
  it('keeps the time in both lists', () => {
    // a: 9-12, 13-18   b: 10-14, 16-17
    const a = [s(9, 12), s(13, 18)]
    const b = [s(10, 14), s(16, 17)]
    expect(pairs(intersectSpans(a, b))).toEqual([
      [10, 12],
      [13, 14],
      [16, 17],
    ])
    expect(pairs(intersectSpans(b, a))).toEqual(pairs(intersectSpans(a, b)))
  })

  it('takes either list in any order, with overlaps', () => {
    expect(pairs(intersectSpans([s(13, 18), s(9, 12), s(10, 11)], [s(16, 17), s(10, 14)]))).toEqual([
      [10, 12],
      [13, 14],
      [16, 17],
    ])
  })

  it('touching is not overlapping; nothing in common, nothing back', () => {
    expect(intersectSpans([s(9, 12)], [s(12, 14)])).toEqual([])
    expect(intersectSpans([s(9, 12)], [])).toEqual([])
    expect(intersectSpans([], [])).toEqual([])
  })

  it('one span inside another', () => {
    expect(pairs(intersectSpans([s(0, 100)], [s(20, 30), s(40, 50)]))).toEqual([
      [20, 30],
      [40, 50],
    ])
  })
})

describe('intersectAll', () => {
  it('the time every list holds', () => {
    const ada = [s(9, 18)]
    const dana = [s(10, 12), s(14, 17)]
    const lee = [s(11, 15)]
    expect(pairs(intersectAll([ada, dana, lee]))).toEqual([
      [11, 12],
      [14, 15],
    ])
  })

  it('one list is that list, merged; no lists is no time; one empty list empties the rest', () => {
    expect(pairs(intersectAll([[s(10, 20), s(15, 25)]]))).toEqual([[10, 25]])
    expect(intersectAll([])).toEqual([])
    expect(intersectAll([[s(9, 18)], [], [s(9, 18)]])).toEqual([])
  })
})
