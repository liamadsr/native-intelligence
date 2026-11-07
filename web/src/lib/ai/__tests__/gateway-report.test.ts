import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for getGatewayUsageReport (src/lib/ai/gateway-report.ts).
 *
 * This is the Phase-B reporting client — it turns request options into a
 * `/v1/report` URL and passes the rows straight through. The load-bearing
 * behavior we lock in here:
 *   - URL/param construction (dates, group_by, user_id, tags, tags_match)
 *   - Bearer auth header presence
 *   - row passthrough (results array is returned verbatim)
 *   - a 403 surfaces as a typed error CARRYING the status (so the dashboard
 *     can tell plan-gating apart from other failures)
 *   - a missing AI_GATEWAY_API_KEY throws a config error with NO status
 *
 * fetch is stubbed via vi.stubGlobal (the repo idiom — see
 * api/deepgram-token/__tests__/route.test.ts) so nothing hits the network.
 */

import {
  getGatewayUsageReport,
  GatewayReportError,
  type GatewayReportRow,
} from '@/lib/ai/gateway-report'

const fetchMock = vi.fn()

function okResponse(results: GatewayReportRow[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ results }),
    text: async () => JSON.stringify({ results }),
  } as unknown as Response
}

function errorResponse(status: number, statusText: string, body = ''): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response
}

/** Parse the single URL fetch was called with. */
function calledUrl(): URL {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
  return new URL(url)
}

function calledInit(): RequestInit {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return init
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  process.env.AI_GATEWAY_API_KEY = 'gw-test-key'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getGatewayUsageReport — request construction', () => {
  it('sets inclusive start_date/end_date and hits the /v1/report endpoint', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]))
    await getGatewayUsageReport({ startDate: '2026-07-01', endDate: '2026-07-31' })

    const url = calledUrl()
    expect(url.origin + url.pathname).toBe('https://ai-gateway.vercel.sh/v1/report')
    expect(url.searchParams.get('start_date')).toBe('2026-07-01')
    expect(url.searchParams.get('end_date')).toBe('2026-07-31')
  })

  it('passes the Bearer auth header from AI_GATEWAY_API_KEY', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]))
    await getGatewayUsageReport({ startDate: '2026-07-01', endDate: '2026-07-31' })

    const headers = calledInit().headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gw-test-key')
  })

  it('serializes group_by, user_id, tags (comma-joined) and tags_match', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]))
    await getGatewayUsageReport({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      groupBy: 'tag',
      userId: 'user-123',
      tags: ['feature:chat', 'env:production'],
      tagsMatch: 'all',
    })

    const url = calledUrl()
    expect(url.searchParams.get('group_by')).toBe('tag')
    expect(url.searchParams.get('user_id')).toBe('user-123')
    expect(url.searchParams.get('tags')).toBe('feature:chat,env:production')
    expect(url.searchParams.get('tags_match')).toBe('all')
  })

  it('omits optional params when not provided (no group_by/user_id/tags)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]))
    await getGatewayUsageReport({ startDate: '2026-07-01', endDate: '2026-07-31' })

    const url = calledUrl()
    expect(url.searchParams.has('group_by')).toBe(false)
    expect(url.searchParams.has('user_id')).toBe(false)
    expect(url.searchParams.has('tags')).toBe(false)
    expect(url.searchParams.has('tags_match')).toBe(false)
  })

  it('does not emit tags_match when there are no tags', async () => {
    fetchMock.mockResolvedValueOnce(okResponse([]))
    await getGatewayUsageReport({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      tags: [],
      tagsMatch: 'all',
    })

    const url = calledUrl()
    expect(url.searchParams.has('tags')).toBe(false)
    expect(url.searchParams.has('tags_match')).toBe(false)
  })
})

describe('getGatewayUsageReport — responses', () => {
  it('returns the results array verbatim', async () => {
    const rows: GatewayReportRow[] = [
      { day: '2026-07-01', total_cost: 1.23, market_cost: 2.34, request_count: 10 },
      { day: '2026-07-02', total_cost: 0.5, market_cost: 0.9, request_count: 4 },
    ]
    fetchMock.mockResolvedValueOnce(okResponse(rows))

    const result = await getGatewayUsageReport({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      groupBy: 'day',
    })
    expect(result).toEqual(rows)
  })

  it('returns [] when the response has no results key', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Response)

    const result = await getGatewayUsageReport({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    })
    expect(result).toEqual([])
  })
})

describe('getGatewayUsageReport — errors', () => {
  it('throws a GatewayReportError carrying status 403 on plan-gating', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(403, 'Forbidden', 'reporting requires a Pro plan'),
    )

    await expect(
      getGatewayUsageReport({ startDate: '2026-07-01', endDate: '2026-07-31' }),
    ).rejects.toMatchObject({
      name: 'GatewayReportError',
      status: 403,
    })
  })

  it('carries the status for non-403 HTTP failures too (e.g. 500)', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))

    const err = await getGatewayUsageReport({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayReportError)
    expect((err as GatewayReportError).status).toBe(500)
  })

  it('throws a config error (no status) when AI_GATEWAY_API_KEY is missing', async () => {
    delete process.env.AI_GATEWAY_API_KEY

    const err = await getGatewayUsageReport({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayReportError)
    expect((err as GatewayReportError).status).toBeUndefined()
    // Never even attempts the fetch.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('wraps a network-level fetch rejection as a GatewayReportError with no status', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))

    const err = await getGatewayUsageReport({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayReportError)
    expect((err as GatewayReportError).status).toBeUndefined()
  })
})
