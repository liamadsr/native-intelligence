import { describe, it, expect } from 'vitest'

import type { GatewayReportRow } from '@/lib/ai/gateway-report'
import {
  toGatewayDateRange,
  sumField,
  aggregateTotals,
  rowTokens,
  tagBreakdown,
  topUsers,
  countTaggedUsers,
  modelBreakdown,
  credentialBreakdown,
  perDay,
  FEATURE_TAG_PREFIX,
  ENV_TAG_PREFIX,
  UNTAGGED_USER_ID,
} from '../gateway-helpers'

describe('toGatewayDateRange', () => {
  // Inputs use the LOCAL-time constructor (`new Date(y, m, d)`) — the exact path
  // the page's resolveRange() takes when it builds local-midnight range bounds.
  // Reading local calendar-day getters is TZ-independent by construction, so
  // these assertions hold under any process TZ (verified: America/New_York,
  // Asia/Tokyo — no per-TZ vitest matrix is possible within one process).
  it('converts an exclusive [from, to) range to inclusive YYYY-MM-DD (to − 1ms lands on the last included day)', () => {
    // A this-month range: Jul 1 00:00 → Aug 1 00:00 (exclusive, local) → end = Jul 31.
    const from = new Date(2026, 6, 1) // 2026-07-01 local midnight
    const to = new Date(2026, 7, 1) // 2026-08-01 local midnight (exclusive)
    expect(toGatewayDateRange(from, to)).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    })
  })

  it('a single-day range yields start === end', () => {
    const from = new Date(2026, 6, 10) // 2026-07-10 local midnight
    const to = new Date(2026, 6, 11) // 2026-07-11 local midnight (exclusive)
    expect(toGatewayDateRange(from, to)).toEqual({
      startDate: '2026-07-10',
      endDate: '2026-07-10',
    })
  })
})

describe('sumField / rowTokens / aggregateTotals', () => {
  const rows: GatewayReportRow[] = [
    {
      day: '2026-07-01',
      total_cost: 1,
      market_cost: 2,
      surcharge_cost: 0.1,
      gateway_cost: 0.2,
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 10,
      cache_creation_input_tokens: 5,
      reasoning_tokens: 3,
      request_count: 4,
    },
    {
      day: '2026-07-02',
      total_cost: 3,
      market_cost: 4,
      // surcharge/gateway absent → coalesce to 0
      input_tokens: 200,
      output_tokens: 100,
      request_count: 6,
    },
  ]

  it('sumField coalesces missing numbers to 0', () => {
    expect(sumField(rows, 'market_cost')).toBe(6)
    expect(sumField(rows, 'surcharge_cost')).toBeCloseTo(0.1)
  })

  it('rowTokens is input + output only', () => {
    expect(rowTokens(rows[0])).toBe(150)
    expect(rowTokens({ total_cost: 0 })).toBe(0)
  })

  it('aggregateTotals rolls every field up', () => {
    const t = aggregateTotals(rows)
    expect(t.marketCost).toBe(6)
    expect(t.totalCost).toBe(4)
    expect(t.inputTokens).toBe(300)
    expect(t.outputTokens).toBe(150)
    expect(t.requestCount).toBe(10)
    expect(t.reasoningTokens).toBe(3)
    expect(t.cacheCreationInputTokens).toBe(5)
  })
})

describe('tagBreakdown', () => {
  const rows: GatewayReportRow[] = [
    { tag: 'feature:chat', total_cost: 1, market_cost: 5, request_count: 10 },
    { tag: 'feature:email_drafts', total_cost: 1, market_cost: 9, request_count: 3 },
    { tag: 'env:production', total_cost: 1, market_cost: 12, request_count: 20 },
    { tag: 'env:preview', total_cost: 1, market_cost: 1, request_count: 2 },
    { tag: 'ws:abc', total_cost: 1, market_cost: 99, request_count: 1 },
  ]

  it('keeps only feature: tags, strips prefix, sorts by market cost desc', () => {
    const out = tagBreakdown(rows, FEATURE_TAG_PREFIX)
    expect(out).toEqual([
      { label: 'email_drafts', marketCost: 9, requestCount: 3 },
      { label: 'chat', marketCost: 5, requestCount: 10 },
    ])
  })

  it('keeps only env: tags', () => {
    const out = tagBreakdown(rows, ENV_TAG_PREFIX)
    expect(out.map((e) => e.label)).toEqual(['production', 'preview'])
  })

  it('returns [] when no rows match the prefix', () => {
    expect(tagBreakdown([], FEATURE_TAG_PREFIX)).toEqual([])
    expect(
      tagBreakdown([{ total_cost: 1 }], FEATURE_TAG_PREFIX),
    ).toEqual([])
  })
})

describe('topUsers', () => {
  it('sorts by market cost desc and folds untagged rows into one bucket', () => {
    const rows: GatewayReportRow[] = [
      { user: 'u1', total_cost: 1, market_cost: 3, input_tokens: 10, output_tokens: 5, request_count: 2 },
      { user: 'u2', total_cost: 1, market_cost: 8, input_tokens: 20, output_tokens: 10, request_count: 4 },
      // No `user` field → untagged/legacy traffic.
      { total_cost: 1, market_cost: 2, input_tokens: 5, output_tokens: 5, request_count: 1 },
      { total_cost: 1, market_cost: 1, input_tokens: 1, output_tokens: 1, request_count: 1 },
    ]
    const out = topUsers(rows)
    expect(out[0]).toMatchObject({ userId: 'u2', marketCost: 8, untagged: false })
    expect(out[1]).toMatchObject({ userId: 'u1', marketCost: 3, untagged: false })
    const untaggedRow = out.find((r) => r.userId === UNTAGGED_USER_ID)
    expect(untaggedRow).toMatchObject({
      untagged: true,
      marketCost: 3, // 2 + 1
      tokens: 12, // (5+5) + (1+1)
      requestCount: 2,
    })
  })

  it('omits the untagged bucket entirely when all traffic is tagged', () => {
    const rows: GatewayReportRow[] = [
      { user: 'u1', total_cost: 1, market_cost: 3, request_count: 2 },
    ]
    const out = topUsers(rows)
    expect(out).toHaveLength(1)
    expect(out.some((r) => r.userId === UNTAGGED_USER_ID)).toBe(false)
  })

  it('respects the limit', () => {
    const rows: GatewayReportRow[] = Array.from({ length: 20 }, (_, i) => ({
      user: `u${i}`,
      total_cost: 1,
      market_cost: i,
      request_count: 1,
    }))
    expect(topUsers(rows, 5)).toHaveLength(5)
  })
})

describe('countTaggedUsers', () => {
  it('counts every distinct tagged user, not just the top 15', () => {
    const rows: GatewayReportRow[] = Array.from({ length: 40 }, (_, i) => ({
      user: `u${i % 20}`,
      total_cost: 1,
      market_cost: i,
      request_count: 1,
    }))
    rows.push({ total_cost: 1, market_cost: 1, request_count: 1 })
    expect(countTaggedUsers(rows)).toBe(20)
  })
})

describe('modelBreakdown / credentialBreakdown / perDay', () => {
  it('modelBreakdown sorts by market cost desc and defaults model name', () => {
    const rows: GatewayReportRow[] = [
      { model: 'anthropic/claude-sonnet-4.5', total_cost: 1, market_cost: 2, request_count: 3 },
      { total_cost: 1, market_cost: 9, request_count: 1 },
    ]
    const out = modelBreakdown(rows)
    expect(out[0]).toMatchObject({ model: 'unknown', marketCost: 9 })
    expect(out[1]).toMatchObject({ model: 'anthropic/claude-sonnet-4.5', marketCost: 2 })
  })

  it('credentialBreakdown maps byok/system and defaults unknown', () => {
    const rows: GatewayReportRow[] = [
      { credential_type: 'system', total_cost: 5, market_cost: 5, request_count: 10 },
      { credential_type: 'byok', total_cost: 0, market_cost: 8, request_count: 4 },
      { total_cost: 1, market_cost: 1, request_count: 1 },
    ]
    const out = credentialBreakdown(rows)
    expect(out[0]).toMatchObject({ credentialType: 'byok', marketCost: 8, totalCost: 0 })
    expect(out.map((r) => r.credentialType)).toContain('unknown')
  })

  it('perDay filters to dated rows and sorts ascending', () => {
    const rows: GatewayReportRow[] = [
      { day: '2026-07-03', total_cost: 1, market_cost: 3, input_tokens: 1, output_tokens: 1, request_count: 1 },
      { day: '2026-07-01', total_cost: 1, market_cost: 1, input_tokens: 2, output_tokens: 2, request_count: 2 },
      { total_cost: 1, market_cost: 99, request_count: 9 }, // no day → dropped
    ]
    const out = perDay(rows)
    expect(out.map((d) => d.day)).toEqual(['2026-07-01', '2026-07-03'])
    expect(out[0]).toMatchObject({ marketCost: 1, tokens: 4, requestCount: 2 })
  })
})
