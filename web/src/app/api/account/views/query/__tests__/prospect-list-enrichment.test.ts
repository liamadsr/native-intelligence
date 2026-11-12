/**
 * POST /api/account/views/query — the `prospect_list` enrichment block, and the
 * one rule that cannot live in the query builder.
 *
 * TWO things are pinned here:
 *
 *  1. `entry_counts` is merged onto every list row from
 *     `countEntriesByList` — THE shared implementation, also used by
 *     `listLists` (the prospecting API's own index). Two surfaces showing
 *     different candidate counts for the same list is the kind of
 *     disagreement nobody debugs; they just stop trusting both numbers. The
 *     sharing is asserted directly, by mocking the lib and checking the route
 *     calls it.
 *
 *  2. `applyEntityDefaults` runs OUTSIDE the `filters.length > 0` guard. The
 *     route skips `applyFilters` entirely for a view with no filters — which
 *     is exactly the unfiltered index that still has to hide archived lists.
 *     A regression here is invisible in the happy path and shows up as
 *     archived lists reappearing on the index.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  buildEntityQuery: vi.fn(),
  applyFilters: vi.fn(),
  applyEntityDefaults: vi.fn(),
  countEntriesByList: vi.fn(),
  queryResult: { data: [] as unknown[], count: 0, error: null as unknown },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/views/query-engine', () => ({
  buildEntityQuery: hoisted.buildEntityQuery,
  applyFilters: hoisted.applyFilters,
  applyEntityDefaults: hoisted.applyEntityDefaults,
  applyCompletedFilter: vi.fn(),
  applyTeamScope: vi.fn(),
  applyOrdering: vi.fn(),
  applyPagination: vi.fn(),
  applySearch: vi.fn(),
  customFieldTypesFor: vi.fn(async () => undefined),
  viewFieldsOf: vi.fn(() => []),
  groupResults: vi.fn((items: unknown[]) => [{ key: 'all', label: 'All', items }]),
  CATEGORY_ORDER: {},
  CATEGORY_LABELS: {},
  SEQUENCE_STATUS_ORDER: {},
  SEQUENCE_STATUS_LABELS: {},
  NoMatchSignal: class NoMatchSignal extends Error {},
}))

// The REAL emptyEntryCounts (a pure zero tally); only the read is faked.
vi.mock('@/lib/prospecting/lists', async () => {
  const actual = await vi.importActual<typeof import('@/lib/prospecting/lists')>(
    '@/lib/prospecting/lists',
  )
  return { ...actual, countEntriesByList: hoisted.countEntriesByList }
})

const { POST } = await import('@/app/api/account/views/query/route')

function makeQuery() {
  const query: Record<string, unknown> = {
    not: vi.fn(() => query),
    is: vi.fn(() => query),
    eq: vi.fn(() => query),
    neq: vi.fn(() => query),
    then: (cb: (v: unknown) => unknown) => Promise.resolve(hoisted.queryResult).then(cb),
  }
  return query
}

function makeFakeSupabase() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {
        then: (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb),
      }
      return new Proxy(chain, {
        get(target, prop: string) {
          if (prop in target) return target[prop]
          return () => new Proxy(chain, this)
        },
      })
    },
  }
}

function postReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/views/query',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

// Mirrors the REAL emptyEntryCounts shape — `pending_publish` (saved rows the
// CRM does not hold yet, migration 259) is part of the zero tally too.
const counts = (over: Record<string, number> = {}) => ({
  discovered: 0, shortlisted: 0, saved: 0, dismissed: 0,
  total: 0, saved_people: 0, pending_publish: 0, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.queryResult = {
    data: [
      { id: 'list-1', name: 'Seed fintech', purpose: 'investors', status: 'active' },
      { id: 'list-2', name: 'Big sales teams', purpose: 'buyers', status: 'active' },
    ],
    count: 2,
    error: null,
  }
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1' },
  })
  hoisted.buildEntityQuery.mockImplementation(() => makeQuery())
  hoisted.applyFilters.mockResolvedValue(undefined)
  hoisted.countEntriesByList.mockResolvedValue(
    new Map([['list-1', counts({ total: 40, saved: 3, saved_people: 9 })]]),
  )
})

describe('prospect_list enrichment', () => {
  it('merges entry_counts onto every row', async () => {
    const res = await POST(postReq({ entity_type: 'prospect_list' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)
    expect(body.data[0].entry_counts).toEqual(counts({ total: 40, saved: 3, saved_people: 9 }))
  })

  it('zeroes a list the count read returned nothing for — never a blank cell', () => {
    // A list with no candidates must render "0", not an empty chip.
    return POST(postReq({ entity_type: 'prospect_list' }))
      .then((res) => readJson<{ data: Array<Record<string, unknown>> }>(res))
      .then((body) => {
        expect(body.data[1].entry_counts).toEqual(counts())
      })
  })

  it('uses the SHARED countEntriesByList, scoped to the workspace and the page', async () => {
    // The same function listLists calls — one implementation, so the index and
    // a saved view cannot disagree about how many candidates a list holds.
    await POST(postReq({ entity_type: 'prospect_list' }))
    expect(hoisted.countEntriesByList).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'workspace-1',
      listIds: ['list-1', 'list-2'],
    })
  })

  it('degrades to zeros rather than 500ing when the tally read fails', async () => {
    // The counts are two chips on a row; losing the whole list index because a
    // tally read timed out trades a small wrong for a total one.
    hoisted.countEntriesByList.mockRejectedValueOnce(new Error('statement timeout'))
    const res = await POST(postReq({ entity_type: 'prospect_list' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)
    expect(body.data[0].entry_counts).toEqual(counts())
    expect(body.data[1].entry_counts).toEqual(counts())
  })

  it('does not run the tally read for other entities', async () => {
    await POST(postReq({ entity_type: 'sequence' }))
    expect(hoisted.countEntriesByList).not.toHaveBeenCalled()
  })

  it('skips the read entirely when the page is empty', async () => {
    hoisted.queryResult = { data: [], count: 0, error: null }
    const res = await POST(postReq({ entity_type: 'prospect_list' }))
    expect(res.status).toBe(200)
    expect(hoisted.countEntriesByList).not.toHaveBeenCalled()
  })
})

describe('applyEntityDefaults wiring', () => {
  it('runs even when the view carries NO filters — the unfiltered index case', async () => {
    // applyFilters is skipped for an empty filter list; the archived-list
    // default must not be skipped with it.
    await POST(postReq({ entity_type: 'prospect_list' }))
    expect(hoisted.applyFilters).not.toHaveBeenCalled()
    expect(hoisted.applyEntityDefaults).toHaveBeenCalledWith(
      expect.anything(), 'prospect_list', [],
    )
  })

  it('runs after applyFilters when there ARE filters, and is handed them', async () => {
    const filters = [{ id: 'f1', field: 'status', operator: 'is', value: 'archived' }]
    await POST(postReq({ entity_type: 'prospect_list', filters }))
    expect(hoisted.applyFilters).toHaveBeenCalled()
    expect(hoisted.applyEntityDefaults).toHaveBeenCalledWith(
      expect.anything(), 'prospect_list', filters,
    )
    expect(hoisted.applyFilters.mock.invocationCallOrder[0])
      .toBeLessThan(hoisted.applyEntityDefaults.mock.invocationCallOrder[0])
  })

  it('is called for every entity type, not just prospect lists', async () => {
    await POST(postReq({ entity_type: 'capture' }))
    expect(hoisted.applyEntityDefaults).toHaveBeenCalledWith(expect.anything(), 'capture', [])
  })
})
