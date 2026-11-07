/**
 * The scope helpers (search-scope.ts): the window a search runs over, and the
 * short line the chat's tool row shows for it.
 */
import { describe, it, expect } from 'vitest'
import { describeSearchScope, readSearchScope, resolveSearchWindow, type SearchScope } from '../search-scope'

const NOW = Date.parse('2026-10-08T12:00:00Z')

describe('resolveSearchWindow', () => {
  it('nothing named: all time, unless the toolset defaults to the past 4 weeks (the main chat)', () => {
    expect(resolveSearchWindow({ sinceISO: null, untilISO: null }, NOW)).toEqual({ window: 'all_time', since: null, until: null })
    expect(resolveSearchWindow({ sinceISO: null, untilISO: null, defaultWindow: 'all_time' }, NOW)).toEqual({ window: 'all_time', since: null, until: null })
    expect(resolveSearchWindow({ sinceISO: null, untilISO: null, defaultWindow: 'past_4_weeks' }, NOW)).toEqual({
      window: 'past_4_weeks',
      since: new Date(NOW - 28 * 86_400_000).toISOString(),
      until: null,
    })
  })

  it('all time drops the lower bound and keeps an upper one', () => {
    expect(resolveSearchWindow({ sinceISO: '2026-01-01T00:00:00.000Z', untilISO: '2026-02-01T00:00:00.000Z', allTime: true }, NOW)).toEqual({
      window: 'all_time',
      since: null,
      until: '2026-02-01T00:00:00.000Z',
    })
  })

  it('a since or an until alone is the agent\'s range', () => {
    expect(resolveSearchWindow({ sinceISO: '2026-01-01T00:00:00.000Z', untilISO: null }, NOW)).toMatchObject({ window: 'range', since: '2026-01-01T00:00:00.000Z' })
    expect(resolveSearchWindow({ sinceISO: null, untilISO: '2026-01-01T00:00:00.000Z' }, NOW)).toEqual({ window: 'range', since: null, until: '2026-01-01T00:00:00.000Z' })
  })
})

describe('describeSearchScope', () => {
  const now = new Date(NOW)
  const base: SearchScope = { window: 'past_4_weeks', since: '2026-09-10T12:00:00.000Z', until: null, claims_windowed: false, transcripts: false, attachments: false }

  it('names the window, then what it also read', () => {
    expect(describeSearchScope(base, now)).toBe('Past 4 weeks')
    expect(describeSearchScope({ ...base, window: 'all_time', since: null, transcripts: true, attachments: true }, now)).toBe('All time · transcripts · attachments')
    expect(describeSearchScope({ ...base, window: 'range', since: '2026-09-01T12:00:00.000Z' }, now)).toBe('Since Sep 1')
    expect(describeSearchScope({ ...base, window: 'range', since: null, until: '2025-01-05T12:00:00.000Z' }, now)).toBe('Before Jan 5, 2025')
    expect(describeSearchScope({ ...base, window: 'range', since: '2026-09-01T12:00:00.000Z', until: '2026-09-30T12:00:00.000Z' }, now)).toBe('Sep 1 – Sep 30')
  })
})

describe('readSearchScope', () => {
  it('reads a result\'s scope, and nothing from a result without one', () => {
    expect(readSearchScope({ scope: { window: 'all_time', since: null, until: null, claims_windowed: false, transcripts: true, attachments: false } })).toEqual({
      window: 'all_time', since: null, until: null, claims_windowed: false, documents_windowed: false, transcripts: true, attachments: false,
    })
    expect(readSearchScope({ scope: { window: 'range', since: 'x', until: null, claims_windowed: true, documents_windowed: true, transcripts: false, attachments: false } })).toMatchObject({
      documents_windowed: true,
    })
    expect(readSearchScope({ results: [] })).toBeNull()
    expect(readSearchScope({ scope: { window: 'forever' } })).toBeNull()
    expect(readSearchScope('Error')).toBeNull()
  })
})
