/**
 * Test-only helpers for the keyword and domain services: a stubbed provider
 * (fetch answered per endpoint with the provider's task envelope), the
 * in-memory database with an `rpc` stand-in, and made-up keyword payloads.
 * Never imported by shipped code. No live call is ever made: every test runs
 * against these stubs.
 */
import { memoryDb } from '@/test/memory-db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { vi } from 'vitest'

type Row = Record<string, unknown>

/** The in-memory database, with `rpc` answering from `rpcs` by function name. */
export function testDb(
  tables: Record<string, Row[]> = {},
  rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {},
) {
  const db = memoryDb(tables) as unknown as Record<string, unknown>
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const answer = rpcs[name]
    if (!answer) return { data: null, error: { message: `no rpc ${name}` } }
    return { data: answer(args), error: null }
  })
  return { svc: { ...db, rpc } as unknown as SupabaseClient, tables, rpc }
}

/** One successful provider task with this result. */
export function okTask(path: string, result: unknown, cost = 0.01) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: path.split('/').filter(Boolean),
        cost,
        result: [result],
      },
    ],
  }
}

/** A keywords_data (Google Ads) task: items directly in `result`. */
export function adsTask(path: string, items: unknown[], cost = 0.075) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: path.split('/').filter(Boolean),
        cost,
        result: items,
      },
    ],
  }
}

/**
 * Stubs fetch: each request is answered by the route whose key the URL ends
 * with (a function of the posted body). An unrouted request fails the test.
 */
export function stubProvider(
  routes: Record<string, (body: unknown) => unknown>,
) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const key = Object.keys(routes).find((route) =>
      url.split('?')[0].endsWith(route),
    )
    if (!key) throw new Error(`unrouted provider call: ${url}`)
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null
    return Response.json(routes[key](body))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The bodies posted to endpoints ending with `route`, in order. */
export function posted(
  fetchMock: ReturnType<typeof stubProvider>,
  route: string,
): unknown[] {
  return fetchMock.mock.calls
    .filter(([input]) =>
      String(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      ).endsWith(route),
    )
    .map(([, init]) =>
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : null,
    )
}

/** A made-up Labs keyword item. */
export function kw(
  keyword: string,
  volume: number | null,
  extra: {
    kd?: number
    cpc?: number
    competition?: number
    intent?: string
  } = {},
) {
  return {
    keyword,
    keyword_info: {
      search_volume: volume,
      cpc: extra.cpc ?? 1.25,
      competition: extra.competition ?? 0.3,
      monthly_searches: [
        { year: 2026, month: 9, search_volume: volume },
        { year: 2026, month: 8, search_volume: volume },
      ],
    },
    keyword_properties: { keyword_difficulty: extra.kd ?? 30 },
    search_intent_info: { main_intent: extra.intent ?? 'commercial' },
  }
}

export const allowAccess = async () => ({ ok: true as const })

export const LABS = {
  suggestions: '/v3/dataforseo_labs/google/keyword_suggestions/live',
  ideas: '/v3/dataforseo_labs/google/keyword_ideas/live',
  related: '/v3/dataforseo_labs/google/related_keywords/live',
  overview: '/v3/dataforseo_labs/google/keyword_overview/live',
  rankOverview: '/v3/dataforseo_labs/google/domain_rank_overview/live',
  rankedKeywords: '/v3/dataforseo_labs/google/ranked_keywords/live',
  relevantPages: '/v3/dataforseo_labs/google/relevant_pages/live',
  serpCompetitors: '/v3/dataforseo_labs/google/serp_competitors/live',
} as const

export const ADS = {
  ideas: '/v3/keywords_data/google_ads/keywords_for_keywords/live',
  volume: '/v3/keywords_data/google_ads/search_volume/live',
} as const
