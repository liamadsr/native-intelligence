/**
 * POST /api/account/views/query with `lazy_done_groups`: an action list
 * grouped by status leaves the completed and canceled groups' rows out of the
 * page and sends each such group with its COUNT (lib/views/lazy-done-groups.ts),
 * and a group's own page comes with `status_ids`.
 *
 * Pinned here: the count is taken over the SAME query as the rows (the same
 * filters, completed window, team and search, built by the same builder),
 * narrowed to the group's states; the page excludes those states; nothing
 * changes for a request that does not ask; a view hiding finished actions
 * counts nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

type Call = { method: string; args: unknown[] }
interface FakeQuery { calls: Call[]; opts: Record<string, unknown> }

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  buildEntityQuery: vi.fn(),
  applyFilters: vi.fn(),
  applyCompletedFilter: vi.fn(),
  applySearch: vi.fn(),
  applyTeamScope: vi.fn(),
  doneStatesInScope: vi.fn(),
  queries: [] as FakeQuery[],
  rows: [] as unknown[],
  counts: new Map<string, number>(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
  requireWorkspaceFeature: vi.fn(async () => null),
}))

vi.mock('@/lib/views/query-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/views/query-engine')>('@/lib/views/query-engine')
  return {
    ...actual,
    buildEntityQuery: hoisted.buildEntityQuery,
    applyFilters: hoisted.applyFilters,
    applyCompletedFilter: hoisted.applyCompletedFilter,
    applyEntityDefaults: vi.fn(),
    applyTeamScope: hoisted.applyTeamScope,
    applyOrdering: vi.fn(),
    applyPagination: vi.fn(),
    applySearch: hoisted.applySearch,
    customFieldTypesFor: vi.fn(async () => undefined),
    viewFieldsOf: vi.fn(() => []),
    resolvePersonalScope: vi.fn(),
    doneStatesInScope: hoisted.doneStatesInScope,
  }
})

const { POST } = await import('@/app/api/account/views/query/route')

const TEAM = '00000000-0000-4000-8000-0000000000aa'
const S_TODO = '00000000-0000-4000-8000-000000000001'
const S_DONE = '00000000-0000-4000-8000-000000000002'
const S_CANCEL = '00000000-0000-4000-8000-000000000003'

/** A recording, thenable query: a count query resolves to the count its `in('status_id')` names. */
function makeQuery(opts: Record<string, unknown>) {
  const q: FakeQuery = { calls: [], opts }
  hoisted.queries.push(q)
  const chain: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => {
      if (opts.countOnly) {
        const inCall = q.calls.find((c) => c.method === 'in' && c.args[0] === 'status_id')
        const ids = (inCall?.args[1] as string[]) ?? []
        const count = ids.reduce((n, id) => n + (hoisted.counts.get(id) ?? 0), 0)
        return Promise.resolve({ data: null, count, error: null }).then(cb)
      }
      return Promise.resolve({ data: hoisted.rows, count: hoisted.rows.length, error: null }).then(cb)
    },
  }
  for (const m of ['not', 'is', 'eq', 'neq', 'in', 'or']) {
    chain[m] = vi.fn((...args: unknown[]) => { q.calls.push({ method: m, args }); return chain })
  }
  return chain
}

/** Any other table read (has_children, project names, workflow states for empty columns): empty. */
function fakeSupabase() {
  const chain: Record<string, unknown> = { then: (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb) }
  const proxy: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return () => new Proxy(chain, proxy)
    },
  }
  return { from: () => new Proxy(chain, proxy) }
}

function post(body: unknown) {
  return POST(buildRequest({ url: 'https://nativeintelligence.dev/api/account/views/query', method: 'POST', body }) as unknown as NextRequest)
}

const openRow = (id: string) => ({
  id, title: id, team_id: TEAM, status_id: S_TODO,
  workflow_state: { id: S_TODO, name: 'Todo', category: 'unstarted', color: '#999', sort_order: 1 },
})

const STATUS_BODY = {
  entity_type: 'action',
  grouping: { field: 'status_id', direction: 'asc' },
  filters: [{ id: 'f', field: 'priority', operator: 'is', value: 'high' }],
  search: 'invoice',
  completed_filter: 'past_week',
  show_completed: true,
  per_page: 500,
}

beforeEach(() => {
  hoisted.queries = []
  hoisted.rows = [openRow('a-1'), openRow('a-2')]
  hoisted.counts = new Map([[S_DONE, 312], [S_CANCEL, 9]])
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: fakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1' },
  })
  hoisted.buildEntityQuery.mockReset().mockImplementation((_s, _e, _w, _u, opts) => makeQuery(opts ?? {}))
  hoisted.applyFilters.mockReset().mockResolvedValue(undefined)
  hoisted.applyCompletedFilter.mockReset().mockResolvedValue(undefined)
  hoisted.applySearch.mockReset()
  hoisted.applyTeamScope.mockReset()
  hoisted.doneStatesInScope.mockReset().mockResolvedValue([
    { id: S_DONE, name: 'Done', category: 'completed', sort_order: 4, team_id: TEAM },
    { id: S_CANCEL, name: 'Canceled', category: 'canceled', sort_order: 5, team_id: TEAM },
  ])
})

describe('lazy finished groups', () => {
  it('sends Done and Canceled as counts, their rows left out of the page', async () => {
    const res = await post({ ...STATUS_BODY, lazy_done_groups: true })
    expect(res.status).toBe(200)
    const body = await readJson<{ data: Array<{ key: string; label: string; items: unknown[]; metadata?: Record<string, unknown> }>; total: number }>(res)

    const page = hoisted.queries.find((q) => !q.opts.countOnly)!
    expect(page.calls).toContainEqual({ method: 'not', args: ['status_id', 'in', `(${S_CANCEL},${S_DONE})`] })

    const done = body.data.find((g) => g.key === 'completed')!
    const canceled = body.data.find((g) => g.key === 'canceled')!
    expect(done).toMatchObject({ label: 'Done', items: [], metadata: { lazy: true, count: 312, status_ids: [S_DONE] } })
    expect(canceled).toMatchObject({ items: [], metadata: { lazy: true, count: 9, status_ids: [S_CANCEL] } })
    // The open group keeps every row; the finished groups go last.
    expect(body.data[0].items).toHaveLength(2)
    expect(body.data.map((g) => g.key).slice(-2)).toEqual(['completed', 'canceled'])
    // The total is every row the view holds, the finished ones too.
    expect(body.total).toBe(2 + 312 + 9)
  })

  it('counts over the same query as the rows: filters, completed window, search, team', async () => {
    await post({ ...STATUS_BODY, team_id: TEAM, lazy_done_groups: true })
    const counts = hoisted.queries.filter((q) => q.opts.countOnly)
    expect(counts).toHaveLength(2)
    // Each query, page and counts alike, went through every step of one builder.
    expect(hoisted.applyFilters).toHaveBeenCalledTimes(3)
    expect(hoisted.applyCompletedFilter).toHaveBeenCalledTimes(3)
    for (const call of hoisted.applyCompletedFilter.mock.calls) expect(call[2]).toBe('past_week')
    expect(hoisted.applySearch).toHaveBeenCalledTimes(3)
    expect(hoisted.applyTeamScope).toHaveBeenCalledTimes(3)
    for (const call of hoisted.applyFilters.mock.calls) expect(call[2]).toEqual(STATUS_BODY.filters)
    // A team's list reads that team's finished states.
    expect(hoisted.doneStatesInScope).toHaveBeenCalledWith(expect.anything(), 'workspace-1', TEAM)
    // Each count is narrowed to its group's states.
    expect(counts.map((q) => q.calls.find((c) => c.method === 'in')!.args)).toEqual([['status_id', [S_CANCEL]], ['status_id', [S_DONE]]])
  })

  it('a cross-team list merges by category over every team in scope', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000bb'
    const S_DONE_2 = '00000000-0000-4000-8000-000000000004'
    hoisted.doneStatesInScope.mockResolvedValue([
      { id: S_DONE, name: 'Done', category: 'completed', sort_order: 4, team_id: TEAM },
      { id: S_DONE_2, name: 'Shipped', category: 'completed', sort_order: 4, team_id: OTHER },
    ])
    hoisted.counts.set(S_DONE_2, 5)
    const body = await readJson<{ data: Array<{ key: string; metadata?: Record<string, unknown> }> }>(await post({ ...STATUS_BODY, lazy_done_groups: true }))
    expect(hoisted.doneStatesInScope).toHaveBeenCalledWith(expect.anything(), 'workspace-1', null)
    const done = body.data.find((g) => g.key === 'completed')!
    expect(done.metadata).toMatchObject({ count: 317, status_id_by_team: { [TEAM]: S_DONE, [OTHER]: S_DONE_2 } })
    expect((done.metadata!.status_ids as string[]).sort()).toEqual([S_DONE, S_DONE_2].sort())
  })

  it('a view hiding finished actions counts nothing and reads no finished states', async () => {
    await post({ ...STATUS_BODY, completed_filter: 'none', lazy_done_groups: true })
    expect(hoisted.doneStatesInScope).not.toHaveBeenCalled()
    expect(hoisted.queries.filter((q) => q.opts.countOnly)).toHaveLength(0)
  })

  it('without the flag, a status grouping is what it always was', async () => {
    const body = await readJson<{ data: Array<{ metadata?: Record<string, unknown> }>; total: number }>(await post(STATUS_BODY))
    expect(hoisted.doneStatesInScope).not.toHaveBeenCalled()
    expect(hoisted.queries).toHaveLength(1)
    expect(hoisted.queries[0].calls.some((c) => c.method === 'not')).toBe(false)
    expect(body.data.some((g) => g.metadata?.lazy)).toBe(false)
    expect(body.total).toBe(2)
  })

  it('not for a sub-grouped list or another grouping', async () => {
    await post({ ...STATUS_BODY, sub_grouping: { field: 'priority', direction: 'asc' }, lazy_done_groups: true })
    await post({ ...STATUS_BODY, grouping: { field: 'priority', direction: 'asc' }, lazy_done_groups: true })
    await post({ ...STATUS_BODY, entity_type: 'project', lazy_done_groups: true })
    expect(hoisted.doneStatesInScope).not.toHaveBeenCalled()
  })
})

describe("a finished group's page", () => {
  it('is the same query, flat, narrowed to the group\'s states', async () => {
    hoisted.rows = [{ id: 'd-1', status_id: S_DONE }]
    const res = await post({ ...STATUS_BODY, grouping: null, status_ids: [S_DONE], page: 2, per_page: 50 })
    expect(res.status).toBe(200)
    expect(hoisted.queries).toHaveLength(1)
    expect(hoisted.queries[0].calls).toContainEqual({ method: 'in', args: ['status_id', [S_DONE]] })
    expect(hoisted.applyCompletedFilter.mock.calls[0][2]).toBe('past_week')
    const body = await readJson<{ data: Array<{ id: string }> }>(res)
    expect(body.data.map((r) => r.id)).toEqual(['d-1'])
  })

  it('refuses anything that is not a state id', async () => {
    const res = await post({ ...STATUS_BODY, grouping: null, status_ids: ['x); drop table actions; --'] })
    expect(res.status).toBe(400)
    expect(hoisted.buildEntityQuery).not.toHaveBeenCalled()
  })
})
