import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  hubspotFetch,
  listObjects,
  searchObjects,
  searchContactByEmail,
  createContact,
  archiveContact,
  advanceSearchWatermark,
  lastModifiedMs,
  HubspotUnauthorizedError,
  HubspotApiError,
  SEARCH_MAX_LIMIT,
  type HubspotObject,
} from '@/lib/integrations/hubspot-api'

/**
 * Tests for src/lib/integrations/hubspot-api.ts.
 *
 * Invariants locked in:
 *  - 429 backoff: retries with fake timers, honors the max-attempt cap, throws
 *    HubspotApiError(429) after the cap, surfaces the policyName.
 *  - 401 → distinct HubspotUnauthorizedError; other non-2xx → HubspotApiError.
 *  - listObjects: caps limit at 100, passes properties/associations/after,
 *    returns paging; pagination termination (absent paging.next.after).
 *  - searchObjects: exact filter/sort/limit body shape; caps at 200.
 *  - advanceSearchWatermark: re-anchors past the 10k window and never regresses.
 */

// A controllable fetch. Each test pushes responses; requests are recorded.
type FakeResponse = {
  status?: number
  ok?: boolean
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}
let responses: FakeResponse[] = []
let requests: Array<{ url: string; init: RequestInit | undefined }> = []

function pushJson(body: unknown, status = 200) {
  responses.push({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}
function push429(policyName = 'SECONDLY') {
  responses.push({
    status: 429,
    ok: false,
    json: async () => ({ policyName }),
    text: async () => JSON.stringify({ policyName }),
  })
}

beforeEach(() => {
  responses = []
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    const next = responses.shift()
    if (!next) throw new Error(`no fake response queued for ${url}`)
    return {
      status: next.status ?? 200,
      ok: next.ok ?? true,
      json: next.json ?? (async () => ({})),
      text: next.text ?? (async () => ''),
    } as unknown as Response
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('hubspotFetch — auth + errors', () => {
  it('sends a bearer token and returns parsed JSON on 200', async () => {
    pushJson({ hello: 'world' })
    const result = await hubspotFetch('tok-123', '/crm/v3/objects/contacts')
    expect(result).toEqual({ hello: 'world' })
    const headers = requests[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(requests[0].url).toContain('https://api.hubapi.com/crm/v3/objects/contacts')
  })

  it('throws a distinct HubspotUnauthorizedError on 401', async () => {
    pushJson({ message: 'expired' }, 401)
    await expect(hubspotFetch('tok', '/x')).rejects.toBeInstanceOf(HubspotUnauthorizedError)
  })

  it('throws HubspotApiError with the status on other non-2xx', async () => {
    pushJson({ message: 'boom' }, 500)
    const err = await hubspotFetch('tok', '/x').catch((e) => e)
    expect(err).toBeInstanceOf(HubspotApiError)
    expect((err as HubspotApiError).status).toBe(500)
  })
})

describe('hubspotFetch — 429 backoff (fake timers)', () => {
  it('retries after backoff, then succeeds without throwing', async () => {
    vi.useFakeTimers()
    push429('SECONDLY') // attempt 1 → sleep
    pushJson({ ok: true }) // attempt 2 → success

    const promise = hubspotFetch('tok', '/x')
    // Let the first fetch + its .json() settle, then advance past the backoff.
    await vi.advanceTimersByTimeAsync(2000)
    const result = await promise
    expect(result).toEqual({ ok: true })
    expect(requests).toHaveLength(2)
  })

  it('throws HubspotApiError(429) with policyName after hitting the attempt cap', async () => {
    vi.useFakeTimers()
    push429('DAILY')
    push429('DAILY')
    push429('DAILY') // 3rd 429 → attempt reaches MAX_RETRIES, throws

    const promise = hubspotFetch('tok', '/x')
    const settled = promise.catch((e) => e)
    await vi.advanceTimersByTimeAsync(10000)
    const err = await settled
    expect(err).toBeInstanceOf(HubspotApiError)
    expect((err as HubspotApiError).status).toBe(429)
    expect((err as HubspotApiError).message).toContain('DAILY')
    // Exactly MAX_RETRIES (3) requests were made.
    expect(requests).toHaveLength(3)
  })
})

describe('listObjects', () => {
  it('caps limit at 100 and passes properties + associations + after', async () => {
    pushJson({ results: [{ id: '1', properties: {} }], paging: { next: { after: 'c2' } } })
    const res = await listObjects('tok', 'contacts', {
      after: 'c1',
      properties: ['email', 'firstname'],
      associations: ['companies'],
      limit: 500, // over the cap
    })
    const url = new URL(requests[0].url)
    expect(url.pathname).toBe('/crm/v3/objects/contacts')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('properties')).toBe('email,firstname')
    expect(url.searchParams.get('associations')).toBe('companies')
    expect(url.searchParams.get('after')).toBe('c1')
    expect(res.paging?.next?.after).toBe('c2')
  })

  it('signals termination via absent paging.next.after', async () => {
    pushJson({ results: [{ id: '9', properties: {} }] }) // no paging
    const res = await listObjects('tok', 'companies', { properties: ['name'] })
    expect(res.paging?.next?.after).toBeUndefined()
    expect(res.results).toHaveLength(1)
  })
})

describe('searchObjects', () => {
  it('builds the exact filter/sort/limit body and caps limit at 200', async () => {
    pushJson({ results: [], paging: {} })
    await searchObjects('tok', 'companies', {
      since: 1_700_000_000_000,
      after: 'p2',
      properties: ['name', 'domain'],
      limit: 999, // over the cap
    })
    const body = JSON.parse((requests[0].init?.body as string) ?? '{}')
    expect(requests[0].init?.method).toBe('POST')
    expect(body.filterGroups).toEqual([
      {
        filters: [
          { propertyName: 'hs_lastmodifieddate', operator: 'GT', value: '1700000000000' },
        ],
      },
    ])
    expect(body.sorts).toEqual([
      { propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' },
    ])
    expect(body.limit).toBe(SEARCH_MAX_LIMIT)
    expect(body.after).toBe('p2')
    expect(body.properties).toEqual(['name', 'domain'])
  })
})

describe('lastModifiedMs', () => {
  it('parses an epoch-ms string', () => {
    expect(lastModifiedMs({ id: '1', properties: { hs_lastmodifieddate: '1700000000000' } })).toBe(
      1_700_000_000_000,
    )
  })
  it('parses an ISO timestamp', () => {
    const iso = '2026-07-24T00:00:00.000Z'
    expect(lastModifiedMs({ id: '1', properties: { hs_lastmodifieddate: iso } })).toBe(Date.parse(iso))
  })
  it('returns NaN when absent', () => {
    expect(Number.isNaN(lastModifiedMs({ id: '1', properties: {} }))).toBe(true)
  })
})

describe('advanceSearchWatermark — 10k re-anchor + monotonic watermark', () => {
  function obj(id: string, ms: number): HubspotObject {
    return { id, properties: { hs_lastmodifieddate: String(ms) } }
  }

  it('re-anchors `since` after filling a 10k window and never regresses', async () => {
    // pageLimit 2 → pagesPerWindow = 5000; too many to enumerate. Use a small
    // custom cap by monkeypatching via limit + a tiny window through maxPages.
    // Simpler: assert single-window termination + monotonic watermark here, and
    // exercise the re-anchor with a forced small window below.
    pushJson({ results: [obj('a', 100), obj('b', 200)], paging: { next: { after: 'p2' } } })
    pushJson({ results: [obj('c', 300)] }) // no paging → done

    const seen: string[] = []
    const run = await advanceSearchWatermark('tok', 'contacts', {
      since: 50,
      properties: ['email'],
      limit: 2,
      onPage: async (results) => {
        for (const r of results) seen.push(r.id)
      },
    })
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(run.totalSeen).toBe(3)
    expect(run.watermark).toBe(300)
  })

  it('re-anchors the query when a window fills to its page cap', async () => {
    // Drive the real 10k window re-anchor with the `resultCap` test-seam: a
    // 1-result cap at limit 1 → pagesPerWindow = 1, so the window "fills" after
    // one page and forces a re-anchor whenever a cursor remains.
    // Window 1: page returns a cursor (watermark 200) → cap hit → re-anchor.
    pushJson({ results: [obj('a', 200)], paging: { next: { after: 'p2' } } })
    // Window 2 (since re-anchored to 199): drains, no cursor → pass done.
    pushJson({ results: [obj('b', 300)] })

    const seen: string[] = []
    const run = await advanceSearchWatermark('tok', 'contacts', {
      since: 50,
      properties: ['email'],
      limit: 1,
      resultCap: 1,
      onPage: async (results) => {
        for (const r of results) seen.push(r.id)
      },
    })
    // Both windows fetched; the second query re-anchored, not paged past 10k.
    expect(run.pagesFetched).toBe(2)
    expect(seen).toEqual(['a', 'b'])
    expect(run.watermark).toBe(300)
    // Re-anchor was at (maxSeen - 1) = 199, so the GT filter re-includes the
    // boundary-ms cohort at 200.
    const window2Body = JSON.parse(requests[1].init?.body as string)
    expect(window2Body.filterGroups[0].filters[0].value).toBe('199')
  })

  // FINDING 3: boundary-millisecond tie. Records sharing the window's max
  // hs_lastmodifieddate that spilled beyond the 10k cap must be re-fetched, not
  // permanently skipped. Re-anchoring at (maxSeen - 1) with the GT filter
  // re-includes the whole boundary-ms cohort.
  it('re-fetches boundary-ms ties by re-anchoring one ms before maxSeen', async () => {
    // Window 1 caps at a page whose max ms is 500, and a cursor remains — the
    // records at ms 500 beyond this window would be dropped by GT 500.
    pushJson({ results: [obj('a', 400), obj('b', 500)], paging: { next: { after: 'p2' } } })
    // Window 2 re-anchored to 499 → re-fetches the ms-500 tie (obj c at 500),
    // then drains.
    pushJson({ results: [obj('c', 500)] })

    const seen: string[] = []
    const run = await advanceSearchWatermark('tok', 'companies', {
      since: 50,
      properties: ['name'],
      limit: 2,
      resultCap: 2, // window fills after this single 2-result page
      onPage: async (results) => {
        for (const r of results) seen.push(r.id)
      },
    })
    // The ms-500 tie (c) was re-fetched in the second window rather than skipped.
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(run.watermark).toBe(500)
    const window2Body = JSON.parse(requests[1].init?.body as string)
    expect(window2Body.filterGroups[0].filters[0].value).toBe('499') // maxSeen - 1
  })

  // FINDING 3: livelock guard. If >resultCap records share a single millisecond,
  // (maxSeen - 1) can't advance the anchor. The guard force-advances past the
  // boundary (accepting the documented skip) instead of re-querying forever.
  it('force-advances past a stuck boundary millisecond (livelock guard)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Every window returns a single record at the SAME ms 1000 with a cursor —
    // the boundary can never advance via (maxSeen - 1) = 999 <= windowStart.
    // Window 1: since 999 (from a prior re-anchor won't help). Start at since 999
    // so windowStart >= maxSeen-1 immediately triggers the guard.
    pushJson({ results: [obj('a', 1000)], paging: { next: { after: 'p2' } } }) // window @ since 999 → cap → guard → since 1001
    pushJson({ results: [] }) // window @ since 1001 → empty → done

    const run = await advanceSearchWatermark('tok', 'contacts', {
      since: 999,
      properties: ['email'],
      limit: 1,
      resultCap: 1,
      onPage: async () => {},
    })
    // The guard fired, warned about the stuck ms, and force-advanced to 1001.
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0][0]).toContain('1000')
    const window2Body = JSON.parse(requests[1].init?.body as string)
    expect(window2Body.filterGroups[0].filters[0].value).toBe('1001') // maxSeen + 1
    expect(run.watermark).toBe(1000)
    warn.mockRestore()
  })

  it('leaves the normal (uncapped) path unchanged — single window, no re-anchor', async () => {
    // A window that drains within its cap must NOT re-anchor: exactly the pages
    // it takes, one query window, watermark = max seen, GT stays at the original
    // `since`.
    pushJson({ results: [obj('a', 100), obj('b', 200)], paging: { next: { after: 'p2' } } })
    pushJson({ results: [obj('c', 300)] }) // no cursor → done, still window 1

    const run = await advanceSearchWatermark('tok', 'contacts', {
      since: 50,
      properties: ['email'],
      limit: 2, // resultCap defaults to 10k → pagesPerWindow huge → never caps
      onPage: async () => {},
    })
    expect(run.pagesFetched).toBe(2)
    expect(run.watermark).toBe(300)
    // Both queries used the ORIGINAL since (50) — no re-anchor happened.
    expect(JSON.parse(requests[0].init?.body as string).filterGroups[0].filters[0].value).toBe('50')
    expect(JSON.parse(requests[1].init?.body as string).filterGroups[0].filters[0].value).toBe('50')
  })

  it('returns the starting since as watermark when nothing changed', async () => {
    pushJson({ results: [] }) // empty, no paging
    const run = await advanceSearchWatermark('tok', 'companies', {
      since: 12345,
      properties: ['name'],
      onPage: async () => {},
    })
    expect(run.totalSeen).toBe(0)
    expect(run.watermark).toBe(12345)
  })
})

describe('searchContactByEmail — dedupe lookup', () => {
  it('posts an exact email EQ filter (limit 1) and returns the first match', async () => {
    pushJson({ results: [{ id: '999', properties: { email: 'a@b.com' } }] })
    const found = await searchContactByEmail('tok', 'a@b.com')

    expect(found).toEqual({ id: '999', properties: { email: 'a@b.com' } })
    const req = requests[0]
    expect(req.url).toContain('/crm/v3/objects/contacts/search')
    const body = JSON.parse(req.init?.body as string)
    expect(body.filterGroups[0].filters[0]).toEqual({
      propertyName: 'email',
      operator: 'EQ',
      value: 'a@b.com',
    })
    expect(body.limit).toBe(1)
  })

  it('returns null when HubSpot has no match', async () => {
    pushJson({ results: [] })
    const found = await searchContactByEmail('tok', 'nobody@nowhere.com')
    expect(found).toBeNull()
  })

  it('propagates a 401 as HubspotUnauthorizedError', async () => {
    pushJson({ message: 'expired' }, 401)
    await expect(searchContactByEmail('tok', 'a@b.com')).rejects.toBeInstanceOf(
      HubspotUnauthorizedError,
    )
  })
})

describe('createContact — writeback create', () => {
  it('posts only the non-empty properties and returns the new id', async () => {
    pushJson({ id: 'new-123' })
    const created = await createContact('tok', {
      email: 'a@b.com',
      firstname: 'Ada',
      lastname: null,
      phone: '',
      jobtitle: 'CEO',
    })

    expect(created).toEqual({ id: 'new-123' })
    const req = requests[0]
    expect(req.url).toContain('/crm/v3/objects/contacts')
    const body = JSON.parse(req.init?.body as string)
    // null lastname and empty-string phone are dropped; the rest are sent.
    expect(body.properties).toEqual({
      email: 'a@b.com',
      firstname: 'Ada',
      jobtitle: 'CEO',
    })
  })

  it('surfaces a 409 (email exists) as HubspotApiError with the status', async () => {
    pushJson({ message: 'CONTACT_EXISTS' }, 409)
    const err = await createContact('tok', { email: 'a@b.com' }).catch((e) => e)
    expect(err).toBeInstanceOf(HubspotApiError)
    expect((err as HubspotApiError).status).toBe(409)
  })

  it('propagates a 401 as HubspotUnauthorizedError', async () => {
    pushJson({ message: 'expired' }, 401)
    await expect(
      createContact('tok', { email: 'a@b.com' }),
    ).rejects.toBeInstanceOf(HubspotUnauthorizedError)
  })
})

describe('archiveContact — orphan cleanup (DELETE)', () => {
  it('issues a DELETE to the contact path and resolves on 204', async () => {
    responses.push({ status: 204, ok: true }) // No Content
    await expect(archiveContact('tok', 'hs-9')).resolves.toBeUndefined()
    const req = requests[0]
    expect(req.init?.method).toBe('DELETE')
    expect(req.url).toContain('/crm/v3/objects/contacts/hs-9')
    expect((req.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('treats a 404 (already gone) as success — no throw', async () => {
    pushJson({ message: 'not found' }, 404)
    await expect(archiveContact('tok', 'hs-missing')).resolves.toBeUndefined()
  })

  it('swallows other failures with a warning (best-effort cleanup)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushJson({ message: 'boom' }, 500)
    // Does NOT throw — the caller is on a no-op lost-race path.
    await expect(archiveContact('tok', 'hs-err')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0][0]).toContain('hs-err')
    warn.mockRestore()
  })

  it('swallows a 401 (lost scope) rather than throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pushJson({ message: 'expired' }, 401)
    await expect(archiveContact('tok', 'hs-401')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
