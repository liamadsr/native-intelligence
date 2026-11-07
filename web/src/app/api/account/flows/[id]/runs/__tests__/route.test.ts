/**
 * GET /api/account/flows/[id]/runs — `?include=<runId>`.
 *
 * A notification deep link lands the Run history on one specific run, which may
 * be older than the newest-N page. `include` guarantees that run is in the
 * response: fetched separately (fenced to THIS flow) and appended when the page
 * doesn't already hold it; a second query never happens when it does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  page: [] as Array<{ id: string }>,
  extra: null as { id: string } | null,
  /** Every (table, eq-args) pair the route issued, in order. */
  queries: [] as Array<{ table: string; eqs: unknown[][]; terminal: 'list' | 'maybeSingle' }>,
}))

function makeFakeSupabase() {
  return {
    from: vi.fn((table: string) => {
      const eqs: unknown[][] = []
      const chain = {
        select: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        eq: vi.fn((...args: unknown[]) => {
          eqs.push(args)
          return chain
        }),
        // The flow fence + the include lookup end in maybeSingle.
        maybeSingle: vi.fn(async () => {
          hoisted.queries.push({ table, eqs, terminal: 'maybeSingle' })
          if (table === 'flow') return { data: { id: 'flow-1' }, error: null }
          return { data: hoisted.extra, error: null }
        }),
        // The page query is awaited directly.
        then: (resolve: (r: unknown) => unknown) => {
          hoisted.queries.push({ table, eqs, terminal: 'list' })
          return Promise.resolve({ data: hoisted.page, error: null }).then(resolve)
        },
      }
      return chain
    }),
  }
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => ({
    supabase: makeFakeSupabase(),
    workspaceId: 'ws-1',
    user: { id: 'user-1' },
  })),
}))

const { GET } = await import('@/app/api/account/flows/[id]/runs/route')

function req(query = ''): NextRequest {
  return new Request(`http://localhost/api/account/flows/flow-1/runs${query}`) as unknown as NextRequest
}
const params = Promise.resolve({ id: 'flow-1' })

beforeEach(() => {
  hoisted.queries.length = 0
  hoisted.page = [{ id: 'run-3' }, { id: 'run-2' }]
  hoisted.extra = null
})

describe('GET /api/account/flows/[id]/runs — include', () => {
  it('without include: the page as-is, one run query', async () => {
    const res = await GET(req('?limit=20'), { params })
    expect(res.status).toBe(200)
    const body = await readJson<{ runs: Array<{ id: string }> }>(res)
    expect(body.runs.map((r) => r.id)).toEqual(['run-3', 'run-2'])
    expect(hoisted.queries.filter((q) => q.table === 'flow_run')).toHaveLength(1)
  })

  it('appends an included run that aged out of the page, fenced to this flow', async () => {
    hoisted.extra = { id: 'run-old' }
    const res = await GET(req('?limit=20&include=run-old'), { params })
    const body = await readJson<{ runs: Array<{ id: string }> }>(res)
    expect(body.runs.map((r) => r.id)).toEqual(['run-3', 'run-2', 'run-old'])
    const lookups = hoisted.queries.filter((q) => q.table === 'flow_run' && q.terminal === 'maybeSingle')
    expect(lookups).toHaveLength(1)
    expect(lookups[0].eqs).toEqual([
      ['id', 'run-old'],
      ['flow_id', 'flow-1'],
    ])
  })

  it('does not query again when the included run is already on the page', async () => {
    const res = await GET(req('?include=run-2'), { params })
    const body = await readJson<{ runs: Array<{ id: string }> }>(res)
    expect(body.runs.map((r) => r.id)).toEqual(['run-3', 'run-2'])
    expect(hoisted.queries.filter((q) => q.table === 'flow_run')).toHaveLength(1)
  })

  it('leaves the page alone when the included run is not this flow\'s (lookup misses)', async () => {
    hoisted.extra = null
    const res = await GET(req('?include=run-foreign'), { params })
    const body = await readJson<{ runs: Array<{ id: string }> }>(res)
    expect(body.runs.map((r) => r.id)).toEqual(['run-3', 'run-2'])
  })
})
