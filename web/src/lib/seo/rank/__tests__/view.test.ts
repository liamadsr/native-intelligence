import { estimateRankCheckUsd } from '@/lib/seo/shared/rank-tracking'
import { describe, expect, it } from 'vitest'
import {
  estimateView,
  positionView,
  raisesCost,
  roundUsd,
  summarizePositions,
  type RankPositionView,
} from '../view'

function view(
  position: number | null,
  previous: number | null | undefined,
  device: 'desktop' | 'mobile' = 'mobile',
): RankPositionView {
  return positionView({
    device,
    has_current: true,
    position,
    has_previous: previous !== undefined,
    previous_position: previous ?? null,
    url: position === null ? null : 'https://example.com/a',
    serp_features: ['organic', 3, 'local_pack'],
    checked_at: '2026-11-12T10:00:00Z',
  })
}

describe('positionView', () => {
  it('a move up is a positive change', () => {
    expect(view(3, 7)).toMatchObject({
      status: 'ranked',
      position: 3,
      previous_position: 7,
      change: 4,
      movement: 'up',
    })
    expect(view(9, 4)).toMatchObject({ change: -5, movement: 'down' })
    expect(view(5, 5)).toMatchObject({ change: 0, movement: 'same' })
  })

  it('found now and not before is new; the other way round is lost', () => {
    expect(view(8, null)).toMatchObject({ change: null, movement: 'new' })
    expect(view(null, 6)).toMatchObject({
      status: 'not_found',
      change: null,
      movement: 'lost',
      ranking_url: null,
    })
  })

  it('no previous check: no movement', () => {
    expect(view(4, undefined)).toMatchObject({ movement: null, change: null })
  })

  it('no completed check yet reads as not checked', () => {
    const v = positionView({
      device: 'desktop',
      has_current: false,
      position: null,
      has_previous: false,
      previous_position: null,
      url: null,
      serp_features: null,
      checked_at: null,
    })
    expect(v).toMatchObject({
      status: 'not_checked',
      position: null,
      serp_features: [],
      checked_at: null,
    })
  })

  it('keeps only the string result kinds', () => {
    expect(view(1, 1).serp_features).toEqual(['organic', 'local_pack'])
  })
})

describe('summarizePositions', () => {
  const rows = [
    { keyword_id: 'a', keyword: 'alpha', view: view(1, 4) },
    { keyword_id: 'b', keyword: 'bravo', view: view(8, 2) },
    { keyword_id: 'c', keyword: 'charlie', view: view(15, 15) },
    { keyword_id: 'd', keyword: 'delta', view: view(null, 9) },
    { keyword_id: 'e', keyword: 'echo', view: view(40, null) },
    { keyword_id: 'f', keyword: 'foxtrot', view: view(3, 30) },
    {
      keyword_id: 'g',
      keyword: 'golf',
      view: positionView({
        device: 'mobile',
        has_current: false,
        position: null,
        has_previous: false,
        previous_position: null,
        url: null,
        serp_features: [],
        checked_at: null,
      }),
    },
    { keyword_id: 'h', keyword: 'hotel', view: view(2, 3, 'desktop') },
  ]

  it('counts the top 3 / 10 / 100 and averages the found positions, on one device', () => {
    const s = summarizePositions('mobile', 7, rows)
    expect(s).toMatchObject({
      device: 'mobile',
      tracked: 7,
      checked: 6,
      ranking: 5,
      not_found: 1,
      top3: 2,
      top10: 3,
      top100: 5,
    })
    expect(s.average_position).toBe(
      Math.round(((1 + 8 + 15 + 40 + 3) / 5) * 10) / 10,
    )
    expect(s).toMatchObject({
      improved: 2,
      declined: 1,
      unchanged: 1,
      new_rankings: 1,
      lost_rankings: 1,
    })
  })

  it('names the biggest movers each way, biggest first', () => {
    const s = summarizePositions('mobile', 7, rows)
    expect(s.movers.up.map((m) => [m.keyword, m.change])).toEqual([
      ['foxtrot', 27],
      ['alpha', 3],
    ])
    expect(s.movers.down.map((m) => [m.keyword, m.change])).toEqual([
      ['bravo', -6],
    ])
    expect(summarizePositions('mobile', 7, rows, 1).movers.up).toHaveLength(1)
  })

  it('nothing found: no average', () => {
    expect(summarizePositions('desktop', 0, []).average_position).toBeNull()
  })
})

describe('estimateView', () => {
  it('prices the most a check reads, and a month on the schedule', () => {
    const keywords = ['plumber austin', 'emergency plumber', 'site:example.com']
    const e = estimateView({
      keywords,
      devices: 'both',
      serp_depth: 30,
      schedule: 'daily',
    })
    const { costUsd } = estimateRankCheckUsd(keywords, 'both', 30)
    expect(e.per_check_usd).toBe(roundUsd(costUsd))
    expect(e).toMatchObject({
      keyword_count: 3,
      searches_per_read: 6,
      reads_per_check: { min: 3, max: 6 },
      checks_per_month: 30,
    })
    expect(e.monthly_usd).toBe(roundUsd(costUsd * 30))
    // An operator keyword costs five times as much.
    expect(
      estimateView({
        keywords: ['site:example.com'],
        devices: 'mobile',
        serp_depth: 10,
        schedule: 'manual',
      }).per_check_usd,
    ).toBe(
      roundUsd(5 * estimateRankCheckUsd(['plumber'], 'mobile', 10).costUsd),
    )
  })

  it('a schedule that is off costs nothing a month', () => {
    expect(
      estimateView({
        keywords: ['a'],
        devices: 'mobile',
        serp_depth: 20,
        schedule: 'manual',
      }),
    ).toMatchObject({ checks_per_month: 0, monthly_usd: 0 })
    expect(
      estimateView({
        keywords: ['a'],
        devices: 'mobile',
        serp_depth: 20,
        schedule: 'weekly',
      }).checks_per_month,
    ).toBe(4)
  })

  it('rounds up, never below the maths', () => {
    expect(roundUsd(0.00001)).toBe(0.0001)
    expect(roundUsd(0.0126)).toBe(0.0126)
  })
})

describe('raisesCost', () => {
  const base = {
    keywords: ['a', 'b'],
    devices: 'mobile' as const,
    serp_depth: 20,
    schedule: 'weekly' as const,
  }
  it('more keywords, devices, depth or a faster schedule raise a scheduled tracker’s cost', () => {
    const before = estimateView(base)
    expect(
      raisesCost(before, estimateView({ ...base, keywords: ['a', 'b', 'c'] })),
    ).toBe(true)
    expect(raisesCost(before, estimateView({ ...base, devices: 'both' }))).toBe(
      true,
    )
    expect(raisesCost(before, estimateView({ ...base, serp_depth: 50 }))).toBe(
      true,
    )
    expect(
      raisesCost(before, estimateView({ ...base, schedule: 'daily' })),
    ).toBe(true)
  })

  it('less, the same, or anything on a tracker with its schedule off does not', () => {
    const before = estimateView(base)
    expect(
      raisesCost(before, estimateView({ ...base, schedule: 'monthly' })),
    ).toBe(false)
    expect(raisesCost(before, before)).toBe(false)
    const manual = estimateView({ ...base, schedule: 'manual' })
    expect(
      raisesCost(
        manual,
        estimateView({ ...base, schedule: 'manual', serp_depth: 100 }),
      ),
    ).toBe(false)
  })
})
