import { describe, it, expect } from 'vitest'
import { findEntityRefRanges } from '../entity-ref-decorations'

describe('findEntityRefRanges', () => {
  it('returns the range of a single identifier', () => {
    expect(findEntityRefRanges('See GEN-297 here')).toEqual([
      { from: 4, to: 11, identifier: 'GEN-297' },
    ])
  })

  it('offsets ranges by the text node position', () => {
    // "GEN-1" starts at document position 10.
    expect(findEntityRefRanges('GEN-1', 10)).toEqual([
      { from: 10, to: 15, identifier: 'GEN-1' },
    ])
  })

  it('finds multiple identifiers in one string', () => {
    expect(findEntityRefRanges('GEN-1 and ENG-2')).toEqual([
      { from: 0, to: 5, identifier: 'GEN-1' },
      { from: 10, to: 15, identifier: 'ENG-2' },
    ])
  })

  it('returns an empty array when nothing matches', () => {
    expect(findEntityRefRanges('nothing here v1.2 2024')).toEqual([])
    expect(findEntityRefRanges('')).toEqual([])
  })

  it('does not match a lowercase prefix', () => {
    expect(findEntityRefRanges('gen-1')).toEqual([])
  })

  it('matches identifier-shaped strings that may not resolve (left to the chip)', () => {
    // The finder over-matches on purpose; resolution filters these out later.
    expect(findEntityRefRanges('COVID-19 and ISO-8601').map((r) => r.identifier)).toEqual([
      'COVID-19',
      'ISO-8601',
    ])
  })
})
