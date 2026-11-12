/**
 * The Google clients against stubbed answers: the right URLs, bearer token
 * and bodies; answers checked by zod; and every failure mapped to a code a
 * person can act on (401, missing scope, 403, API off, 404, 429 with
 * Retry-After, 400, 5xx, a timeout, a malformed answer).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { canonicalPropertyId, createAnalyticsClient } from '../analytics-client'
import { GoogleSeoError } from '../errors'
import { googleFailure, googleJson } from '../fetch'
import { createSearchConsoleClient } from '../search-console-client'
import { fakeFetch, googleError, json, on, report } from './fixtures'

async function failureOf(p: Promise<unknown>): Promise<GoogleSeoError> {
  try {
    await p
  } catch (err) {
    if (err instanceof GoogleSeoError) return err
    throw err
  }
  throw new Error('expected a failure')
}

describe('googleFailure', () => {
  it('401 and a missing scope ask for a reconnect; a 403 otherwise is no access, never a revoked grant', () => {
    expect(googleFailure('search_console', 401, '', null).code).toBe(
      'RECONNECT_NEEDED',
    )
    expect(
      googleFailure(
        'analytics',
        403,
        JSON.stringify({
          error: {
            status: 'PERMISSION_DENIED',
            details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
          },
        }),
        null,
      ).code,
    ).toBe('RECONNECT_NEEDED')
    expect(
      googleFailure(
        'search_console',
        403,
        JSON.stringify({
          error: { message: 'Request had insufficient authentication scopes.' },
        }),
        null,
      ).code,
    ).toBe('RECONNECT_NEEDED')
    expect(
      googleFailure(
        'search_console',
        403,
        JSON.stringify({
          error: {
            errors: [{ reason: 'forbidden' }],
            message:
              "User does not have sufficient permission for site 'sc-domain:example.com'.",
          },
        }),
        null,
      ).code,
    ).toBe('NO_ACCESS')
    expect(googleFailure('analytics', 404, '', null).code).toBe('NO_ACCESS')
  })

  it('an API not switched on for the app is ours to fix, not the person’s', () => {
    const err = googleFailure(
      'analytics',
      403,
      JSON.stringify({ error: { details: [{ reason: 'SERVICE_DISABLED' }] } }),
      null,
    )
    expect(err.code).toBe('UPSTREAM')
    expect(err.message).toMatch(/Nothing to fix on your side/)
  })

  it('quota: 429, RESOURCE_EXHAUSTED, or the older API’s 403 rate limit', () => {
    const err = googleFailure('analytics', 429, '', 120)
    expect(err.code).toBe('QUOTA')
    expect(err.details().retry_after_seconds).toBe(120)
    expect(err.message).toMatch(/2 minutes/)
    expect(
      googleFailure(
        'analytics',
        400,
        JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }),
        null,
      ).code,
    ).toBe('QUOTA')
    expect(
      googleFailure(
        'search_console',
        403,
        JSON.stringify({
          error: { errors: [{ reason: 'userRateLimitExceeded' }] },
        }),
        null,
      ).code,
    ).toBe('QUOTA')
  })

  it('400 is a bad request; 5xx is Google’s', () => {
    expect(googleFailure('analytics', 400, '', null).code).toBe(
      'INVALID_REQUEST',
    )
    expect(googleFailure('analytics', 503, '', null).code).toBe('UPSTREAM')
  })

  it('never puts Google’s own words in the message', () => {
    const err = googleFailure(
      'search_console',
      403,
      JSON.stringify({ error: { message: 'SECRET-UPSTREAM-DETAIL' } }),
      null,
    )
    expect(err.message).not.toContain('SECRET')
    expect(err.extra.detail).toContain('HTTP 403')
  })
})

describe('googleJson', () => {
  it('a timeout is UPSTREAM, said plainly', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    const err = await failureOf(
      googleJson('https://example.com/x', z.object({}), {
        product: 'search_console',
        token: 't',
        fetchImpl: hang,
        timeoutMs: 5,
      }),
    )
    expect(err.code).toBe('UPSTREAM')
    expect(err.message).toMatch(/in time/)
  })

  it('an answer that fails the schema is UPSTREAM', async () => {
    const { fetch } = fakeFetch([
      on('example.com', () => json({ rows: 'nope' })),
    ])
    const err = await failureOf(
      googleJson(
        'https://example.com/x',
        z.object({ rows: z.array(z.string()) }),
        { product: 'analytics', token: 't', fetchImpl: fetch },
      ),
    )
    expect(err.code).toBe('UPSTREAM')
  })
})

describe('Search Console client', () => {
  it('lists sites with the bearer token', async () => {
    const { fetch, calls } = fakeFetch([
      on('/webmasters/v3/sites', () =>
        json({
          siteEntry: [
            { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          ],
        }),
      ),
    ])
    const sites = await createSearchConsoleClient('tok-1', {
      fetchImpl: fetch,
    }).listSites()
    expect(sites).toEqual([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    ])
    expect(calls[0]).toMatchObject({
      url: 'https://www.googleapis.com/webmasters/v3/sites',
      method: 'GET',
      auth: 'Bearer tok-1',
    })
  })

  it('encodes the site in the Search Analytics path, both property forms, and posts the body', async () => {
    const { fetch, calls } = fakeFetch([
      on('/searchAnalytics/query', () =>
        json({
          rows: [
            {
              keys: ['rug cleaning'],
              clicks: 3,
              impressions: 40,
              ctr: 0.075,
              position: 6.2,
            },
          ],
        }),
      ),
    ])
    const client = createSearchConsoleClient('tok-1', { fetchImpl: fetch })
    const rows = await client.querySearchAnalytics('sc-domain:example.com', {
      startDate: '2026-10-01',
      endDate: '2026-10-28',
      dimensions: ['query'],
    })
    await client.querySearchAnalytics('https://example.com/', {
      startDate: '2026-10-01',
      endDate: '2026-10-28',
    })
    expect(rows[0].keys).toEqual(['rug cleaning'])
    expect(calls[0].url).toBe(
      'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
    )
    expect(calls[1].url).toBe(
      'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query',
    )
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: {
        startDate: '2026-10-01',
        endDate: '2026-10-28',
        dimensions: ['query'],
      },
    })
  })

  it('reads a row with no position (discover) and an empty answer', async () => {
    const { fetch } = fakeFetch([
      on('/searchAnalytics/query', () =>
        json({
          rows: [
            { keys: ['2026-10-01'], clicks: 1, impressions: 9, ctr: 0.11 },
          ],
        }),
      ),
    ])
    const rows = await createSearchConsoleClient('t', {
      fetchImpl: fetch,
    }).querySearchAnalytics('sc-domain:example.com', {
      startDate: '2026-10-01',
      endDate: '2026-10-01',
    })
    expect(rows[0].position).toBeUndefined()
    const empty = fakeFetch([on('/searchAnalytics/query', () => json({}))])
    expect(
      await createSearchConsoleClient('t', {
        fetchImpl: empty.fetch,
      }).querySearchAnalytics('x', {
        startDate: '2026-10-01',
        endDate: '2026-10-01',
      }),
    ).toEqual([])
  })

  it('posts a URL inspection and returns its result', async () => {
    const { fetch, calls } = fakeFetch([
      on('urlInspection/index:inspect', () =>
        json({
          inspectionResult: {
            indexStatusResult: {
              verdict: 'PASS',
              coverageState: 'Submitted and indexed',
            },
            inspectionResultLink: 'https://search.google.com/x',
          },
        }),
      ),
    ])
    const result = await createSearchConsoleClient('t', {
      fetchImpl: fetch,
    }).inspectUrl('sc-domain:example.com', 'https://example.com/a', 'en-US')
    expect(result?.indexStatusResult?.verdict).toBe('PASS')
    expect(calls[0].body).toEqual({
      siteUrl: 'sc-domain:example.com',
      inspectionUrl: 'https://example.com/a',
      languageCode: 'en-US',
    })
  })

  it.each([
    [401, 'RECONNECT_NEEDED'],
    [403, 'NO_ACCESS'],
    [429, 'QUOTA'],
    [500, 'UPSTREAM'],
  ])('maps a %i to %s', async (status, code) => {
    const { fetch } = fakeFetch([on('/sites', () => googleError(status))])
    expect(
      (
        await failureOf(
          createSearchConsoleClient('t', { fetchImpl: fetch }).listSites(),
        )
      ).code,
    ).toBe(code)
  })
})

describe('Google Analytics client', () => {
  it('pages through account summaries', async () => {
    const { fetch, calls } = fakeFetch([
      on(/accountSummaries\?pageSize=200$/, () =>
        json({
          accountSummaries: [
            {
              account: 'accounts/1',
              displayName: 'Fernhill',
              propertySummaries: [
                { property: 'properties/11', displayName: 'Site A' },
              ],
            },
          ],
          nextPageToken: 'page-2',
        }),
      ),
      on('pageToken=page-2', () =>
        json({
          accountSummaries: [
            {
              account: 'accounts/2',
              displayName: 'Client',
              propertySummaries: [
                { property: 'properties/22', displayName: 'Site B' },
              ],
            },
          ],
        }),
      ),
    ])
    const properties = await createAnalyticsClient('tok-ga', {
      fetchImpl: fetch,
    }).listProperties()
    expect(properties).toEqual([
      {
        propertyId: 'properties/11',
        displayName: 'Site A',
        accountDisplayName: 'Fernhill',
      },
      {
        propertyId: 'properties/22',
        displayName: 'Site B',
        accountDisplayName: 'Client',
      },
    ])
    expect(calls.every((c) => c.auth === 'Bearer tok-ga')).toBe(true)
  })

  it('reads a property and runs a report on its own resource name', async () => {
    const { fetch, calls } = fakeFetch([
      on('/v1beta/properties/123:runReport', () =>
        report(['hostName'], ['sessions'], [[['example.com'], ['12']]]),
      ),
      on('/v1beta/properties/123', () =>
        json({
          name: 'properties/123',
          displayName: 'Example',
          timeZone: 'America/New_York',
          currencyCode: 'USD',
        }),
      ),
    ])
    const client = createAnalyticsClient('t', { fetchImpl: fetch })
    expect(await client.getProperty('123')).toMatchObject({
      name: 'properties/123',
      timeZone: 'America/New_York',
    })
    const out = await client.runReport('properties/123', {
      dateRanges: [{ startDate: '2026-10-01', endDate: '2026-10-28' }],
      dimensions: [{ name: 'hostName' }],
      metrics: [{ name: 'sessions' }],
      offset: '0',
      limit: '100',
      orderBys: [],
      keepEmptyRows: false,
      returnPropertyQuota: true,
    })
    expect(out.rows?.[0].metricValues?.[0].value).toBe('12')
    expect(calls[1]).toMatchObject({
      url: 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport',
      method: 'POST',
    })
  })

  it('refuses a property id that isn’t one', async () => {
    expect(canonicalPropertyId('properties/42')).toBe('properties/42')
    expect(canonicalPropertyId(' 42 ')).toBe('properties/42')
    expect(canonicalPropertyId('properties/42/../x')).toBeNull()
    const { fetch } = fakeFetch([])
    expect(
      (
        await failureOf(
          createAnalyticsClient('t', { fetchImpl: fetch }).getProperty(
            '../admin',
          ),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
  })

  it.each([
    [401, {}, 'RECONNECT_NEEDED'],
    [403, {}, 'NO_ACCESS'],
    [403, { reason: 'SERVICE_DISABLED' }, 'UPSTREAM'],
    [429, { status: 'RESOURCE_EXHAUSTED' }, 'QUOTA'],
    [400, {}, 'INVALID_REQUEST'],
    [502, {}, 'UPSTREAM'],
  ] as const)('maps a runReport %i %j to %s', async (status, body, code) => {
    const { fetch } = fakeFetch([
      on(':runReport', () => googleError(status, body)),
    ])
    const err = await failureOf(
      createAnalyticsClient('t', { fetchImpl: fetch }).runReport(
        'properties/1',
        {
          dateRanges: [],
          dimensions: [],
          metrics: [],
          offset: '0',
          limit: '1',
          orderBys: [],
          keepEmptyRows: false,
          returnPropertyQuota: true,
        },
      ),
    )
    expect(err.code).toBe(code)
    expect(err.product).toBe('analytics')
  })
})
