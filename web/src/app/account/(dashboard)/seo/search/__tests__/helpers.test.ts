import { describe, expect, it } from 'vitest'
import { metricChange, type UrlInspectionRow } from '@/lib/seo/google/view'
import { tableColumns } from '../analytics-tab'
import {
  changeNote,
  columnLabel,
  daysBetween,
  formatMetric,
  gaDate,
  inspectionSummary,
  percent,
  periodDates,
  position,
  siteLabel,
} from '../helpers'
import { sortRows } from '../performance-tab'

describe('periodDates', () => {
  const now = new Date('2026-11-12T15:00:00Z')
  it('ends three days ago for Search Console and yesterday for Analytics', () => {
    expect(periodDates('last_28_days', 'search_console', now)).toEqual({ start_date: '2026-10-13', end_date: '2026-11-09' })
    expect(periodDates('last_7_days', 'analytics', now)).toEqual({ start_date: '2026-11-05', end_date: '2026-11-11' })
  })
  it('counts months back on the calendar, the day clamped', () => {
    expect(periodDates('last_3_months', 'analytics', now)).toEqual({ start_date: '2026-08-11', end_date: '2026-11-11' })
    expect(periodDates('last_12_months', 'search_console', new Date('2026-03-03T00:00:00Z'))).toEqual({ start_date: '2025-02-28', end_date: '2026-02-28' })
  })
})

describe('changeNote', () => {
  it('counts move by a percentage; nothing before is new, or nothing', () => {
    expect(changeNote('count', metricChange(116, 100))).toEqual({ note: 'Up 16%', tone: 'up' })
    expect(changeNote('count', metricChange(95, 100))).toEqual({ note: 'Down 5%', tone: 'down' })
    expect(changeNote('count', metricChange(100, 100))).toEqual({ note: 'No change', tone: 'flat' })
    expect(changeNote('count', metricChange(5, 0))).toEqual({ note: 'New this period', tone: 'up' })
    expect(changeNote('count', metricChange(0, 0))).toBeNull()
    expect(changeNote('count', metricChange(5, null))).toBeNull()
    expect(changeNote('count', null)).toBeNull()
  })
  it('rates move by points', () => {
    expect(changeNote('rate', metricChange(0.023, 0.019))).toEqual({ note: 'Up 0.4 points', tone: 'up' })
    expect(changeNote('rate', metricChange(0.02, 0.03))).toEqual({ note: 'Down 1.0 point', tone: 'down' })
  })
  it('a lower position is better', () => {
    expect(changeNote('position', metricChange(8.7, 9.4))).toEqual({ note: '0.7 places higher', tone: 'up' })
    expect(changeNote('position', metricChange(10, 9))).toEqual({ note: '1.0 place lower', tone: 'down' })
    expect(changeNote('position', metricChange(0, 9))).toBeNull()
  })
})

describe('numbers and names', () => {
  it('percent, position', () => {
    expect(percent(0.0226)).toBe('2.3%')
    expect(percent(0.21)).toBe('21%')
    expect(percent(0)).toBe('0%')
    expect(percent(null)).toBe('—')
    expect(position(8.73)).toBe('8.7')
    expect(position(0)).toBe('—')
    expect(position(null)).toBe('—')
  })
  it('siteLabel says a Search Console site as people say it', () => {
    expect(siteLabel('sc-domain:fernhillstudio.example')).toBe('fernhillstudio.example')
    expect(siteLabel('https://www.fernhillstudio.example/')).toBe('www.fernhillstudio.example')
    expect(siteLabel('https://fernhillstudio.example/shop/')).toBe('fernhillstudio.example/shop')
  })
  it('formatMetric: rates, money, time, a withheld number', () => {
    expect(formatMetric('engagementRate', 0.633)).toBe('63%')
    expect(formatMetric('purchaseRevenue', 1240, 'GBP')).toMatch(/£1,240/)
    expect(formatMetric('userEngagementDuration', 3900)).toBe('1 h 5 min')
    expect(formatMetric('sessions', 1912)).toBe('1,912')
    expect(formatMetric('sessions', null)).toBe('—')
  })
  it('columnLabel: the map, else Google’s name in words', () => {
    expect(columnLabel('sessions')).toBe('Visits')
    expect(columnLabel('averageSessionDuration')).toBe('Average session duration')
  })
  it('gaDate and daysBetween', () => {
    expect(gaDate('20261109')).toBe('2026-11-09')
    expect(gaDate('202645')).toBeNull()
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    expect(daysBetween('2026-11-02', '2026-10-30')).toEqual([])
  })
})

describe('inspectionSummary', () => {
  const base: UrlInspectionRow = {
    url: 'https://fernhillstudio.example/shop',
    verdict: 'PASS',
    coverage_state: 'Submitted and indexed',
    robots_txt_state: 'ALLOWED',
    indexing_state: 'INDEXING_ALLOWED',
    page_fetch_state: 'SUCCESSFUL',
    last_crawl_time: null,
    crawled_as: null,
    google_canonical: null,
    user_canonical: null,
    canonical_mismatch: false,
    sitemaps: [],
    referring_urls: [],
    mobile_usability: null,
    rich_results: null,
    details_link: null,
    error: null,
  }
  it('says whether Google lists it, and why not in plain words', () => {
    expect(inspectionSummary(base)).toEqual({ tone: 'ok', headline: 'On Google', reasons: ['Submitted and indexed'] })
    expect(inspectionSummary({ ...base, verdict: 'FAIL', coverage_state: 'Not found (404)', page_fetch_state: 'NOT_FOUND' })).toEqual({
      tone: 'bad',
      headline: 'Not on Google',
      reasons: ['Not found (404)', 'The page answered “not found” (404)'],
    })
    expect(inspectionSummary({ ...base, verdict: 'NEUTRAL', coverage_state: null, robots_txt_state: 'DISALLOWED' }).reasons).toEqual(['robots.txt tells Google not to read it'])
    expect(inspectionSummary({ ...base, canonical_mismatch: true, google_canonical: 'https://fernhillstudio.example/shop/' }).reasons).toContain(
      'Google treats https://fernhillstudio.example/shop/ as the main copy of this page',
    )
    expect(inspectionSummary({ ...base, verdict: null, error: 'Google could not inspect this page.' })).toEqual({ tone: 'neutral', headline: 'Could not check this page', reasons: ['Google could not inspect this page.'] })
  })
})

describe('tableColumns', () => {
  it('joins a host and a path into one page column; metrics after, the later ones only on wider cards', () => {
    const cols = tableColumns(['hostName', 'landingPage'], ['sessions', 'activeUsers', 'engagedSessions', 'engagementRate', 'keyEvents'])
    expect(cols.map((c) => `${c.key}:${c.kind}:${c.tier}`)).toEqual([
      'landingPage:page:0',
      'sessions:metric:0',
      'activeUsers:metric:0',
      'engagedSessions:metric:1',
      'engagementRate:metric:1',
      'keyEvents:metric:2',
    ])
    expect(tableColumns(['itemName', 'itemId'], ['itemRevenue']).map((c) => `${c.key}:${c.kind}:${c.tier}`)).toEqual(['itemName:dimension:0', 'itemId:dimension:1', 'itemRevenue:metric:0'])
  })
})

describe('sortRows', () => {
  const rows = [
    { keys: ['a'], clicks: 10, impressions: 100, ctr: 0.1, position: 4 },
    { keys: ['b'], clicks: 30, impressions: 50, ctr: 0.6, position: null },
    { keys: ['c'], clicks: 20, impressions: 900, ctr: 0.02, position: 1.5 },
  ]
  it('by clicks or impressions, most first; by position, best first and none last', () => {
    expect(sortRows(rows, 'clicks').map((r) => r.keys[0])).toEqual(['b', 'c', 'a'])
    expect(sortRows(rows, 'impressions').map((r) => r.keys[0])).toEqual(['c', 'a', 'b'])
    expect(sortRows(rows, 'position').map((r) => r.keys[0])).toEqual(['c', 'a', 'b'])
  })
})
