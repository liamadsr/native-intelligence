/**
 * `parseEntryFilters` — the query-string whitelist both entry-reading routes
 * share.
 *
 * The values it produces go straight into a PostgREST `.eq()` / `.gte()`, so
 * what is under test is mostly what it REFUSES to pass through.
 */
import { describe, it, expect } from 'vitest'
import { parseEntryFilters } from '../entry-filters'

const parse = (qs: string) => parseEntryFilters(new URLSearchParams(qs))

describe('parseEntryFilters', () => {
  it('returns nothing for an empty query string', () => {
    expect(parse('')).toEqual({})
  })

  it('accepts a real stage and a real kind', () => {
    expect(parse('stage=saved&kind=person')).toEqual({ stage: 'saved', kind: 'person' })
  })

  it('DROPS unknown values rather than rejecting the request', () => {
    // A stale bookmark carrying `?stage=triaged` should render the unfiltered
    // list, not a 400. And, more importantly, an unrecognised value must never
    // reach the `.eq()` — the route has no other validation.
    expect(parse('stage=triaged&kind=robot&min_fit_score=hot')).toEqual({})
  })

  it('accepts an integer score floor in 0–100', () => {
    expect(parse('min_fit_score=80')).toEqual({ min_fit_score: 80 })
    expect(parse('min_fit_score=100')).toEqual({ min_fit_score: 100 })
  })

  it('keeps a floor of 0 — "only the scored rows" is a real question', () => {
    expect(parse('min_fit_score=0')).toEqual({ min_fit_score: 0 })
  })

  it('tolerates whitespace around the number', () => {
    expect(parse('min_fit_score=%2080%20')).toEqual({ min_fit_score: 80 })
  })

  it('leaves the floor ABSENT for a non-integer, an out-of-range number, or a word', () => {
    for (const qs of ['min_fit_score=150', 'min_fit_score=-1', 'min_fit_score=7.5', 'min_fit_score=eighty', 'min_fit_score=1e2']) {
      const out = parse(qs)
      expect(out.min_fit_score, qs).toBeUndefined()
      expect(out).not.toHaveProperty('min_fit_score')
    }
  })

  it('ignores an empty-string parameter', () => {
    expect(parse('stage=&kind=&min_fit_score=')).toEqual({})
  })

  it('combines all three', () => {
    expect(parse('stage=discovered&kind=company&min_fit_score=60')).toEqual({
      stage: 'discovered',
      kind: 'company',
      min_fit_score: 60,
    })
  })
})
