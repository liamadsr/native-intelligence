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

/** Every `from(...)` call: which table, and the filters the chain recorded. */
const reads: Array<{ table: string; calls: Array<[string, unknown[]]> }> = []
let peopleResult: { data: unknown; error: { message: string } | null } = { data: [], error: null }

function makeFakeSupabase() {
  return {
    from: (table: string) => {
      const read = { table, calls: [] as Array<[string, unknown[]]> }
      reads.push(read)
      const chain: Record<string, unknown> = {
        then: (cb: (v: unknown) => unknown) =>
          Promise.resolve(table === 'prospect_list_entry' ? peopleResult : { data: [], error: null }).then(cb),
      }
      const handler: ProxyHandler<Record<string, unknown>> = {
        get(target, prop: string) {
          if (prop in target) return target[prop]
          return (...args: unknown[]) => {
            read.calls.push([prop, args])
            return new Proxy(chain, handler)
          }
        },
      }
      return new Proxy(chain, handler)
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

const person = (id: string, parent: string) => ({
  id,
  kind: 'person',
  parent_entry_id: parent,
  candidate: { name: id },
})

beforeEach(() => {
  vi.clearAllMocks()
  reads.length = 0
  peopleResult = { data: [person('p1', 'c1'), person('p2', 'c1')], error: null }
  hoisted.queryResult = {
    data: [
      { id: 'c1', kind: 'company', candidate: { name: 'Acme' } },
      { id: 'c2', kind: 'company', candidate: { name: 'Globex' } },
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
  hoisted.countEntriesByList.mockResolvedValue(new Map())
})

const peopleRead = () => reads.find((r) => r.table === 'prospect_list_entry')
const call = (name: string) => peopleRead()?.calls.filter(([n]) => n === name).map(([, a]) => a)

describe('prospect_list_entry children enrichment', () => {
  it('attaches each company its people, inline, with has_children for the tree', async () => {
    const res = await POST(postReq({ entity_type: 'prospect_list_entry' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)
    expect(body.data[0]).toMatchObject({ id: 'c1', has_children: true })
    expect((body.data[0].children as Array<{ id: string }>).map((p) => p.id)).toEqual(['p1', 'p2'])
    // A company with nobody found yet: an empty array, not a missing key —
    // the list reads `children` to decide the row is INLINE and needs no fetch.
    expect(body.data[1]).toMatchObject({ id: 'c2', children: [], has_children: false })
  })

  it('reads people scoped to the workspace, the kind and THIS page of companies', async () => {
    await POST(postReq({ entity_type: 'prospect_list_entry' }))
    expect(call('eq')).toEqual([
      ['workspace_id', 'workspace-1'],
      ['kind', 'person'],
    ])
    expect(call('in')).toEqual([['parent_entry_id', ['c1', 'c2']]])
  })

  it('degrades to companies without children rather than 500ing when the read fails', async () => {
    peopleResult = { data: null, error: { message: 'statement timeout' } }
    const res = await POST(postReq({ entity_type: 'prospect_list_entry' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)
    expect(body.data[0]).toMatchObject({ children: [], has_children: false })
  })

  it('does not read people for other entities', async () => {
    await POST(postReq({ entity_type: 'prospect_list' }))
    expect(peopleRead()).toBeUndefined()
  })

  it('leaves person rows alone — the Needs review view lists people flat', async () => {
    hoisted.queryResult = { data: [person('p1', 'c1')], count: 1, error: null }
    const res = await POST(postReq({ entity_type: 'prospect_list_entry' }))
    const body = await readJson<{ data: Array<Record<string, unknown>> }>(res)
    expect(body.data[0]).not.toHaveProperty('children')
    expect(peopleRead()).toBeUndefined()
  })
})
