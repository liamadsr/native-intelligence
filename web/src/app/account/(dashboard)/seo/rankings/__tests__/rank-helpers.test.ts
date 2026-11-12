/**
 * The Rankings page's words: the index row's sub-line and the tracker's
 * settings line (markets, devices, schedule, next check), the estimate in
 * plain words (only the route's figures), keywords as typed, a position and
 * its move (LOWER is better), the tiles' changes and the run rail's line.
 */
import { describe, expect, it } from 'vitest'
import type { SeoMarketOptions } from '@/lib/seo/keywords/view'
import type { RankEstimateView, RankPositionView, RankRunView, RankTrackerView } from '@/lib/seo/rank/view'
import {
  averageChange,
  changeNote,
  countChange,
  dataView,
  estimateSentence,
  keywordsOutcomeWords,
  lastTwo,
  marketWords,
  monthlyWords,
  nextCheckWords,
  parseKeywordLines,
  positionCell,
  runRailLine,
  trackerSettingsLine,
  trackerStatus,
  trackerSubline,
  usdWords,
} from '../rank-helpers'

const MARKETS: SeoMarketOptions = {
  default_location_code: 2840,
  locations: [
    { code: 2840, label: 'United States', short_label: 'US', default_language: 'en', languages: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }], keyword_data: 'labs', domain_data: true },
  ],
  serp_languages: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }],
}

const tracker = (extra: Partial<RankTrackerView> = {}): RankTrackerView => ({
  id: 't1',
  domain: 'fernhillstudio.example',
  location_code: 2840,
  language_code: 'en',
  location_name: null,
  devices: 'mobile',
  serp_depth: 20,
  schedule: { interval: 'daily', weekday: null, hour: 9, minute: 0, time_zone: null },
  next_check_at: null,
  last_checked_at: null,
  paused: false,
  skip_reason: null,
  skip_message: null,
  keyword_count: 31,
  created_by: null,
  created_at: '2026-11-01T00:00:00Z',
  latest_run: null,
  ...extra,
})

const estimate = (extra: Partial<RankEstimateView> = {}): RankEstimateView => ({
  keyword_count: 3,
  devices: 'mobile',
  serp_depth: 20,
  searches_per_read: 3,
  reads_per_check: { min: 3, max: 6 },
  per_check_usd: 0.06,
  schedule: 'daily',
  checks_per_month: 30,
  monthly_usd: 1.8,
  ...extra,
})

const view = (extra: Partial<RankPositionView>): RankPositionView => ({
  device: 'mobile',
  status: 'ranked',
  position: 4,
  previous_position: 6,
  change: 2,
  movement: 'up',
  ranking_url: null,
  serp_features: [],
  checked_at: null,
  ...extra,
})

describe('markets and settings', () => {
  it('names the country, the city when there is one, and the language only when it is not the country’s own', () => {
    expect(marketWords(tracker(), MARKETS)).toBe('United States')
    expect(marketWords(tracker({ language_code: 'es' }), MARKETS)).toBe('United States · Spanish')
    expect(marketWords(tracker({ language_code: 'fr' }), MARKETS)).toBe('United States · French')
    expect(marketWords(tracker({ location_name: 'Austin,Texas,United States' }), MARKETS)).toBe('Austin, Texas')
    expect(marketWords(tracker(), null)).toBeNull()
  })

  it('the index sub-line drops what is not known', () => {
    expect(trackerSubline(tracker(), MARKETS)).toBe('31 keywords · United States · mobile · checked daily')
    expect(trackerSubline(tracker({ keyword_count: 1, devices: 'both', schedule: { interval: 'manual', weekday: null, hour: null, minute: null, time_zone: null } }), null)).toBe(
      '1 keyword · mobile and desktop · checked by hand',
    )
    expect(trackerSubline(tracker({ keyword_count: 0 }), MARKETS)).toBe('No keywords yet · United States · mobile · checked daily')
  })

  it('the settings line says the next check, or Paused', () => {
    const now = new Date(2026, 10, 12, 15, 0)
    const tomorrow = new Date(2026, 10, 13, 9, 0)
    expect(trackerSettingsLine(tracker({ next_check_at: tomorrow.toISOString() }), MARKETS, now)).toMatch(/^United States · mobile · checked daily · next check tomorrow 9:00/)
    expect(trackerSettingsLine(tracker({ paused: true, next_check_at: tomorrow.toISOString() }), MARKETS, now)).toBe('United States · mobile · checked daily · Paused')
    expect(trackerSettingsLine(tracker({ schedule: { interval: 'manual', weekday: null, hour: null, minute: null, time_zone: null } }), MARKETS, now)).toBe('United States · mobile · checked by hand')
  })

  it('next check words: today, tomorrow, a weekday, a date', () => {
    const now = new Date(2026, 10, 12, 8, 0)
    expect(nextCheckWords(new Date(2026, 10, 12, 14, 30).toISOString(), now)).toMatch(/^today 2:30/)
    expect(nextCheckWords(new Date(2026, 10, 15, 9, 0).toISOString(), now)).toMatch(/^Sun 9:00/)
    expect(nextCheckWords(new Date(2026, 10, 30, 9, 0).toISOString(), now)).toBe('Nov 30')
    expect(nextCheckWords(new Date(2026, 10, 11).toISOString(), now)).toBe('due now')
    expect(nextCheckWords(null, now)).toBeNull()
  })

  it('a status word while checking, paused, skipped or failed', () => {
    expect(trackerStatus(tracker())).toBeNull()
    expect(trackerStatus(tracker({ paused: true }))?.word).toBe('Paused')
    expect(trackerStatus(tracker({ skip_reason: 'no_keywords', skip_message: 'Skipped: no keywords.' }))).toMatchObject({ word: 'Skipped', title: 'Skipped: no keywords.' })
    const run = { status: 'failed', error: 'No answer.' } as RankRunView
    expect(trackerStatus(tracker({ latest_run: run }))).toMatchObject({ word: 'Check failed', tone: 'red', title: 'No answer.' })
  })
})

describe('money', () => {
  it('says the route’s figures in plain words', () => {
    expect(usdWords(0.06)).toBe('$0.06')
    expect(usdWords(0.001)).toBe('less than a cent')
    expect(estimateSentence(estimate())).toBe('A check costs about $0.06. Daily, about $1.80 a month.')
    expect(estimateSentence(estimate({ schedule: 'manual', checks_per_month: 0, monthly_usd: 0 }))).toBe('A check costs about $0.06.')
    expect(estimateSentence(estimate({ per_check_usd: 0.0012, schedule: 'manual', checks_per_month: 0 }))).toBe('A check costs less than a cent.')
    expect(estimateSentence(estimate({ keyword_count: 0 }))).toBeNull()
    expect(monthlyWords(estimate())).toBe('about $1.80 a month')
    expect(monthlyWords(estimate({ checks_per_month: 0 }))).toBe('nothing on its own')
  })
})

describe('keywords', () => {
  it('reads one per line: trimmed, lowercased, once each', () => {
    expect(parseKeywordLines('  Oak  side table \n\nlinen throw\nOAK SIDE TABLE\r\n')).toEqual(['oak side table', 'linen throw'])
  })

  it('says what an add did, dropping the zeros', () => {
    expect(keywordsOutcomeWords({ added: [{ id: 'a', keyword: 'x' }], already_tracked: 0, over_cap: 0, rejected: 0 }, 500)).toBe('Added 1 keyword')
    expect(keywordsOutcomeWords({ added: [], already_tracked: 3, over_cap: 2, rejected: 1 }, 500)).toBe('No new keywords · 3 already tracked · 2 over the limit of 500 · 1 left out (empty or too long)')
  })
})

describe('positions', () => {
  it('a position cell: the number, not in the top N, or a dash before any check', () => {
    expect(positionCell(view({}), 20)).toEqual({ text: '4', muted: false })
    expect(positionCell(view({ status: 'not_found', position: null }), 20)).toMatchObject({ text: 'Not in top 20', muted: true })
    expect(positionCell(view({ status: 'not_checked', position: null }), 20)).toMatchObject({ text: '—', title: 'Not checked yet' })
    expect(positionCell(null, 20)).toMatchObject({ text: '—' })
  })

  it('a move: up the page is emerald, down is red, nothing when unchanged', () => {
    expect(changeNote(view({}))).toMatchObject({ text: '↑ 2', tone: 'up' })
    expect(changeNote(view({ change: -6, movement: 'down' }))).toMatchObject({ text: '↓ 6', tone: 'down' })
    expect(changeNote(view({ change: 0, movement: 'same' }))).toBeNull()
    expect(changeNote(view({ movement: 'new', change: null }))).toMatchObject({ text: 'New', tone: 'up' })
    expect(changeNote(view({ movement: 'lost', change: null }))).toMatchObject({ text: 'Dropped', tone: 'down' })
  })

  it('tile changes: more in the top N is better; a LOWER average position is better', () => {
    expect(countChange(5, 3)).toEqual({ note: '2 more', tone: 'up' })
    expect(countChange(1, 3)).toEqual({ note: '2 fewer', tone: 'down' })
    expect(countChange(3, 3)).toEqual({ note: 'No change', tone: 'flat' })
    expect(countChange(3, null)).toBeNull()
    expect(averageChange(9.5, 10.4)).toEqual({ note: '0.9 better', tone: 'up' })
    expect(averageChange(12, 10)).toEqual({ note: '2 worse', tone: 'down' })
    expect(averageChange(null, 10)).toBeNull()
  })

  it('the two newest checks, whatever order they came in', () => {
    const p = (run_id: string, checked_at: string) => ({ run_id, checked_at, keywords_total: 1, checked: 1, found: 1, top3: 0, top10: 0, top100: 0, average_position: null })
    const { last, previous } = lastTwo([p('b', '2026-11-11T00:00:00Z'), p('c', '2026-11-12T00:00:00Z'), p('a', '2026-11-10T00:00:00Z')])
    expect([last?.run_id, previous?.run_id]).toEqual(['c', 'b'])
    expect(lastTwo([])).toEqual({ last: null, previous: null })
  })
})

describe('the run rail and lookups', () => {
  it('says what runs, how many keywords, and since when', () => {
    const now = new Date('2026-11-12T10:12:00Z')
    const run = { status: 'running', keywords_total: 31, keywords_checked: 0, started_at: '2026-11-12T10:00:00Z', created_at: '2026-11-12T10:00:00Z' } as RankRunView
    expect(runRailLine(run, now)).toEqual({ verb: 'Checking rankings', clauses: ['31 keywords', 'started 12 minutes ago'] })
    expect(runRailLine({ ...run, keywords_checked: 12 }, now).clauses[0]).toBe('12 of 31 keywords')
    expect(runRailLine({ ...run, status: 'queued' }, now).verb).toBe('Starting the check')
  })

  it('lookups off: the spend read, or the server’s word when that read failed', () => {
    expect(dataView({ view: null }, true)).toBeNull()
    expect(dataView({ view: null }, false)).toMatchObject({ can_buy: false, refusal: { code: 'SEO_NOT_CONFIGURED' } })
  })
})
