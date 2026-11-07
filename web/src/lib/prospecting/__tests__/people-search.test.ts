/**
 * Reading `candidate.people_search` — the row's own summary of what the last
 * people search saw. Tolerant of a blob written by any vintage, and honest
 * about the one state it exists for: people found, none kept.
 */
import { describe, it, expect } from 'vitest'
import {
  foundOnlyKnownPeople,
  knownPeopleLines,
  knownPeopleSummary,
  readPeopleSearch,
} from '../people-search'

const STAMP = {
  at: '2026-09-07T12:44:30.658Z',
  found: 1,
  added: 0,
  known: [{ name: 'Theo Sandford', by: 'this_list', ref_id: 'entry-theo' }],
  capped: 0,
  invalid: 0,
}

describe('readPeopleSearch', () => {
  it('reads the stamp off the candidate', () => {
    expect(readPeopleSearch({ name: 'Solenne', people_search: STAMP })).toEqual(STAMP)
  })

  it('is null without one, and for junk', () => {
    expect(readPeopleSearch({ name: 'Solenne' })).toBeNull()
    expect(readPeopleSearch({ people_search: 'yes' })).toBeNull()
    expect(readPeopleSearch(null)).toBeNull()
    expect(readPeopleSearch([])).toBeNull()
  })

  it('drops a known entry with an unknown rule and defaults missing numbers', () => {
    const read = readPeopleSearch({
      people_search: {
        found: 2,
        known: [
          { name: 'Tom', by: 'this_list', ref_id: 'e1' },
          { name: 'Nobody', by: 'made_up', ref_id: null },
          'junk',
        ],
      },
    })
    expect(read).toEqual({
      at: '',
      found: 2,
      added: 0,
      known: [{ name: 'Tom', by: 'this_list', ref_id: 'e1' }],
      capped: 0,
      invalid: 0,
    })
  })
})

describe('foundOnlyKnownPeople', () => {
  it('is the state "people found, none kept, all of them known"', () => {
    expect(foundOnlyKnownPeople(readPeopleSearch({ people_search: STAMP }))).toBe(true)
    expect(foundOnlyKnownPeople(readPeopleSearch({ people_search: { ...STAMP, added: 1 } }))).toBe(false)
    expect(foundOnlyKnownPeople(readPeopleSearch({ people_search: { ...STAMP, found: 0, known: [] } }))).toBe(false)
    // Found people and capped every one of them, knowing none: not this state.
    expect(
      foundOnlyKnownPeople(readPeopleSearch({ people_search: { ...STAMP, known: [], capped: 1 } })),
    ).toBe(false)
    expect(foundOnlyKnownPeople(null)).toBe(false)
  })
})

describe('the words', () => {
  it('names the one rule when every known person shares it', () => {
    expect(knownPeopleSummary(STAMP as never)).toBe('1 found, already in this list')
    expect(
      knownPeopleSummary({
        ...STAMP,
        found: 2,
        known: [
          { name: 'Tom', by: 'crm', ref_id: null },
          { name: 'Ana', by: 'crm', ref_id: null },
        ],
      } as never),
    ).toBe('2 found, already in your CRM')
  })

  it('says "already known" when the rules differ or some were capped', () => {
    expect(
      knownPeopleSummary({
        ...STAMP,
        found: 3,
        known: [
          { name: 'Tom', by: 'this_list', ref_id: 'e1' },
          { name: 'Ana', by: 'crm', ref_id: null },
        ],
        capped: 1,
      } as never),
    ).toBe('3 found, already known')
  })

  it('lists one line per person for the tooltip', () => {
    expect(knownPeopleLines(STAMP as never)).toEqual(['Theo Sandford — already in this list'])
  })
})
