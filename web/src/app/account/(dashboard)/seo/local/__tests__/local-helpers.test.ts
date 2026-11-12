/**
 * The Local page's words: ratings and lines with what is missing dropped, a
 * scan's headline, the estimate as the route gave it, a cell's text and
 * title, the week's hours folded, the stars by count, the reviews filter,
 * and links out only to http(s).
 */
import { describe, expect, it } from 'vitest'
import type { GoogleBusinessReview, LocalScanView } from '@/lib/seo/local/view'
import {
  businessLine,
  businessSubline,
  cellText,
  cellTitle,
  estimateLine,
  filterReviews,
  gridChangedSince,
  gridSettingsLine,
  httpUrl,
  latestCompletedScan,
  parseKeywords,
  ratingBars,
  ratingWords,
  reviewsLine,
  scanDialogSentence,
  scanHeadline,
  scanRailLine,
  starParts,
  weeklyHours,
} from '../local-helpers'

const summary = { points_total: 25, points_collected: 24, points_found: 20, top3: 15, top10: 18, top3_percent: 62, average_position: 4.1 }

describe('ratings and lines', () => {
  it('a rating with one decimal and a star character; none without one', () => {
    expect(ratingWords(4.6)).toBe('4.6 ★')
    expect(ratingWords(5)).toBe('5.0 ★')
    expect(ratingWords(null)).toBeNull()
  })
  it('five stars split into filled and empty', () => {
    expect(starParts(4.4)).toEqual({ filled: '★★★★', empty: '☆' })
    expect(starParts(null)).toEqual({ filled: '', empty: '☆☆☆☆☆' })
  })
  it('the index line and the business line drop what is missing', () => {
    expect(businessSubline({ address: '12 Alder St', rating: 4.6, review_count: 1 })).toBe('12 Alder St · 4.6 ★ · 1 review')
    expect(businessSubline({ address: null, rating: null, review_count: 0 })).toBe('')
    expect(businessLine({ address: null, rating: 3.9, review_count: 1204, category: 'Rug store' })).toBe('3.9 ★ · 1,204 reviews · Rug store')
  })
})

describe('scans', () => {
  const scan = (extra: Partial<LocalScanView>): LocalScanView => ({
    id: 's',
    grid_id: 'g',
    business_id: 'b',
    status: 'completed',
    keywords: ['rug cleaning'],
    size: 5,
    radius_km: 3,
    spacing_km: 1.5,
    center_latitude: 0,
    center_longitude: 0,
    zoom: 14,
    device: 'mobile',
    points_total: 25,
    points_collected: 25,
    points_found: 20,
    estimate_usd: 0.05,
    cost_usd: 0.05,
    error: null,
    summary,
    started_by: null,
    created_at: '2026-11-01T00:00:00Z',
    started_at: null,
    completed_at: '2026-11-01T00:05:00Z',
    ...extra,
  })

  it('the headline as chips, the unknown ones dropped', () => {
    expect(scanHeadline(summary)).toEqual(['62% in top 3', 'average 4.1'])
    expect(scanHeadline({ ...summary, top3_percent: null, average_position: null })).toEqual([])
    expect(scanHeadline({ ...summary, average_position: 3 })).toEqual(['62% in top 3', 'average 3'])
  })

  it('the newest completed scan with numbers wins', () => {
    const older = scan({ id: 'old', completed_at: '2026-11-01T00:00:00Z' })
    const newer = scan({ id: 'new', completed_at: '2026-11-05T00:00:00Z' })
    const failed = scan({ id: 'failed', status: 'failed', summary: null, completed_at: '2026-11-09T00:00:00Z' })
    expect(latestCompletedScan([older, newer, failed].map((latest_scan) => ({ grid: {} as never, latest_scan })))?.id).toBe('new')
    expect(latestCompletedScan([{ grid: {} as never, latest_scan: null }])).toBeNull()
  })

  it('the rail: points for one search, searches for several', () => {
    expect(scanRailLine(scan({ status: 'running', points_total: 49, points_collected: 31 }))).toEqual({ verb: 'Scanning the map', clauses: ['31 of 49 points'] })
    expect(scanRailLine(scan({ status: 'running', keywords: ['a', 'b'], points_total: 98, points_collected: 4 })).clauses).toEqual(['4 of 98 searches'])
    expect(scanRailLine(scan({ status: 'queued' }))).toEqual({ verb: 'Starting the scan', clauses: [] })
  })

  it('a grid changed since its scan', () => {
    const grid = { keywords: ['rug cleaning'], size: 5, radius_km: 3 } as never
    expect(gridChangedSince(grid, scan({}))).toBe(false)
    expect(gridChangedSince({ ...(grid as object), radius_km: 4 } as never, scan({}))).toBe(true)
    expect(gridChangedSince(grid, null)).toBe(false)
  })

  it('the grid’s settings in plain words', () => {
    expect(gridSettingsLine({ size: 7, radius_km: 2.5, device: 'mobile' })).toBe('7×7 points across a 5 km square · mobile')
  })
})

describe('estimates (the route’s numbers, worded)', () => {
  it('the form’s line, and "in all" only with several searches', () => {
    expect(estimateLine({ keywords: 1, points: 49, searches: 49, estimate_usd: 0.29, needs_confirmation: true })).toBe('49 searches per keyword · about $0.29 for this scan')
    expect(estimateLine({ keywords: 2, points: 9, searches: 18, estimate_usd: 0.001, needs_confirmation: false })).toBe('9 searches per keyword · 18 in all · less than a cent for this scan')
  })
  it('the scan dialog’s sentence', () => {
    expect(scanDialogSentence({ keywords: 2, points: 25, searches: 50, estimate_usd: 0.3, needs_confirmation: true })).toBe(
      'Searches Google Maps from 25 points for each of 2 keywords, 50 searches in all. It costs about $0.30, paid for from this workspace’s search data, and usually takes a few minutes.',
    )
  })
  it('keywords tidied, lowercased and each once', () => {
    expect(parseKeywords(' Rug  Cleaning \n\ncarpet cleaner, rug cleaning ')).toEqual(['rug cleaning', 'carpet cleaner'])
  })
})

describe('cells', () => {
  const top = { title: 'Oakline Carpet Care', cid: null, place_id: null }
  it('the position, a dash where not found, nothing otherwise', () => {
    expect(cellText({ status: 'found', position: 4 })).toBe('4')
    expect(cellText({ status: 'found', position: 27 })).toBe('20+')
    expect(cellText({ status: 'not_found', position: null })).toBe('–')
    expect(cellText({ status: 'pending', position: null })).toBe('')
  })
  it('the title says where it was, of how many, and who led', () => {
    expect(cellTitle({ status: 'found', position: 4, results_count: 20, top_result: top })).toBe('4 of 20 · top result: Oakline Carpet Care')
    expect(cellTitle({ status: 'found', position: 1, results_count: 20, top_result: top })).toBe('1 of 20 · first here')
    expect(cellTitle({ status: 'not_found', position: null, results_count: 3, top_result: top })).toBe('Not among the 3 businesses listed · top result: Oakline Carpet Care')
    expect(cellTitle({ status: 'not_collected', position: null, results_count: null, top_result: null })).toBe('Not collected: this search did not come back')
  })
})

describe('the profile', () => {
  it('folds runs of days with the same hours, in week order', () => {
    expect(
      weeklyHours([
        { day: 'sunday', spans: [] },
        { day: 'monday', spans: ['09:00-17:00'] },
        { day: 'tuesday', spans: ['09:00-17:00'] },
        { day: 'wednesday', spans: ['09:00-12:00', '13:00-17:00'] },
        { day: 'thursday', spans: ['09:00-17:00'] },
        { day: 'saturday', spans: [] },
      ]),
    ).toEqual([
      { days: 'Mon–Tue', hours: '9:00–17:00' },
      { days: 'Wed', hours: '9:00–12:00, 13:00–17:00' },
      { days: 'Thu', hours: '9:00–17:00' },
      { days: 'Sat–Sun', hours: 'Closed' },
    ])
    expect(weeklyHours(null)).toEqual([])
  })
  it('stars by count with their shares; nothing when there are none', () => {
    expect(ratingBars({ '5': 3, '1': 1 }).map((b) => [b.stars, b.count, b.share])).toEqual([
      [5, 3, 0.75],
      [4, 0, 0],
      [3, 0, 0],
      [2, 0, 0],
      [1, 1, 0.25],
    ])
    expect(ratingBars({})).toEqual([])
    expect(ratingBars(null)).toEqual([])
  })
  it('links out only to http(s)', () => {
    expect(httpUrl('https://fernhillrugs.example/')).toBe('https://fernhillrugs.example/')
    expect(httpUrl('javascript:alert(1)')).toBeNull()
    expect(httpUrl('not a url')).toBeNull()
  })
})

describe('reviews', () => {
  const review = (id: string, rating: number | null, reply: string | null) => ({ review_id: id, rating, owner_reply: reply }) as GoogleBusinessReview
  const list = [review('a', 5, 'Thanks'), review('b', 2, null), review('c', null, null), review('d', 3, 'Sorry')]
  it('filters on the page', () => {
    expect(filterReviews(list, 'all').map((r) => r.review_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterReviews(list, 'unreplied').map((r) => r.review_id)).toEqual(['b', 'c'])
    expect(filterReviews(list, 'low').map((r) => r.review_id)).toEqual(['b', 'd'])
  })
  it('the line: how many were read of how many, and the ones without a reply', () => {
    expect(reviewsLine(20, 128, 12)).toBe('20 newest of 128 reviews · 12 without a reply')
    expect(reviewsLine(3, 3, 0)).toBe('3 reviews')
    expect(reviewsLine(1, null, 1)).toBe('1 review · 1 without a reply')
  })
})
