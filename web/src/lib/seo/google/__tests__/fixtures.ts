/**
 * Shared test doubles for the Google half of the SEO area: a fetch that
 * answers by URL (recording every call), and a workspace with members,
 * connections, token rows and a source row in the in-memory database. Made-up
 * sites and people only (example.com, fernhillstudio.example).
 *
 * The response bodies follow the shapes in the ported project's own fixtures
 * (sites.list, searchAnalytics.query, urlInspection, accountSummaries,
 * properties.get, runReport).
 */
import { memoryDb } from '@/test/memory-db'
import { vi } from 'vitest'

export const WS = '11111111-1111-4111-8111-111111111111'
export const ALEX = '22222222-2222-4222-8222-222222222222'
export const BEA = '33333333-3333-4333-8333-333333333333'
export const ALEX_SC = '44444444-4444-4444-8444-444444444444'
export const ALEX_GA = '55555555-5555-4555-8555-555555555555'
export const BEA_SC = '66666666-6666-4666-8666-666666666666'

export const SC_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
]
export const GA_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
]

export type Route = {
  match: (url: string, init?: RequestInit) => boolean
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** A Google error body as the APIs send it. */
export function googleError(
  status: number,
  opts: { status?: string; reason?: string; message?: string } = {},
): Response {
  return json(
    {
      error: {
        code: status,
        message: opts.message ?? 'error',
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.reason
          ? {
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: opts.reason,
                },
              ],
            }
          : {}),
      },
    },
    status,
  )
}

/** A fetch that answers from `routes` in order (first match wins) and records each call with its parsed body. */
export function fakeFetch(routes: Route[]) {
  const calls: Array<{
    url: string
    method: string
    body: unknown
    auth: string | null
  }> = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization ?? null,
    })
    const route = routes.find((r) => r.match(url, init))
    if (!route) throw new Error(`fakeFetch: no route for ${url}`)
    return route.respond(url, init)
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

export const on = (
  pattern: string | RegExp,
  respond: Route['respond'],
): Route => ({
  match: (url) =>
    typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url),
  respond,
})

type Row = Record<string, unknown>

/** A workspace: Alex (Search Console + Analytics) and Bea (Search Console), both members. */
export function workspace(
  over: {
    accounts?: Row[]
    tokens?: Row[]
    source?: Row[]
    members?: Row[]
  } = {},
) {
  const tables: Record<string, Row[]> = {
    member: over.members ?? [
      {
        id: 'm1',
        workspace_id: WS,
        user_id: ALEX,
        role: 'owner',
        display_name: 'Alex Rivera',
      },
      {
        id: 'm2',
        workspace_id: WS,
        user_id: BEA,
        role: 'member',
        display_name: 'Bea Chen',
      },
    ],
    connected_account: over.accounts ?? [
      {
        id: ALEX_SC,
        user_id: ALEX,
        provider: 'google',
        capability: 'search_console',
        account_email: 'alex@fernhillstudio.example',
        is_enabled: true,
        is_primary: true,
        reauth_required_at: null,
        created_at: '2026-11-01T00:00:00Z',
      },
      {
        id: ALEX_GA,
        user_id: ALEX,
        provider: 'google',
        capability: 'analytics',
        account_email: 'alex@fernhillstudio.example',
        is_enabled: true,
        is_primary: true,
        reauth_required_at: null,
        created_at: '2026-11-01T00:00:00Z',
      },
      {
        id: BEA_SC,
        user_id: BEA,
        provider: 'google',
        capability: 'search_console',
        account_email: 'bea@fernhillstudio.example',
        is_enabled: true,
        is_primary: true,
        reauth_required_at: null,
        created_at: '2026-11-02T00:00:00Z',
      },
    ],
    user_oauth_tokens: over.tokens ?? [
      {
        id: 't1',
        user_id: ALEX,
        account_id: ALEX_SC,
        capability: 'search_console',
        scopes: SC_SCOPES,
        updated_at: '2026-11-01T00:00:00Z',
      },
      {
        id: 't2',
        user_id: ALEX,
        account_id: ALEX_GA,
        capability: 'analytics',
        scopes: GA_SCOPES,
        updated_at: '2026-11-01T00:00:00Z',
      },
      {
        id: 't3',
        user_id: BEA,
        account_id: BEA_SC,
        capability: 'search_console',
        scopes: SC_SCOPES,
        updated_at: '2026-11-02T00:00:00Z',
      },
    ],
    seo_google_source: over.source ?? [],
    company: [],
  }
  return { db: memoryDb(tables), tables }
}

/** Alex chose sc-domain:example.com and properties/123 for the workspace. */
export function chosenSource(over: Row = {}): Row {
  return {
    id: 'src-1',
    workspace_id: WS,
    sc_site_url: 'sc-domain:example.com',
    sc_account_id: ALEX_SC,
    sc_chosen_by: ALEX,
    sc_chosen_at: '2026-11-03T00:00:00Z',
    ga4_property_id: 'properties/123',
    ga4_property_name: 'Example site',
    ga4_time_zone: 'America/New_York',
    ga4_currency_code: 'USD',
    ga4_account_id: ALEX_GA,
    ga4_chosen_by: ALEX,
    ga4_chosen_at: '2026-11-03T00:00:00Z',
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T00:00:00Z',
    ...over,
  }
}

/** A token per connection: `tok-<account id prefix>`. */
export const tokenFor = vi.fn(async (accountId: string) => ({
  token: `tok-${accountId.slice(0, 4)}`,
}))

/** A runReport answer with the headers asked for. */
export function report(
  dimensions: string[],
  metrics: string[],
  rows: Array<[string[], string[]]>,
  extra: Row = {},
): Response {
  return json({
    dimensionHeaders: dimensions.map((name) => ({ name })),
    metricHeaders: metrics.map((name) => ({ name, type: 'TYPE_INTEGER' })),
    rows: rows.map(([d, m]) => ({
      dimensionValues: d.map((value) => ({ value })),
      metricValues: m.map((value) => ({ value })),
    })),
    rowCount: rows.length,
    ...extra,
  })
}
