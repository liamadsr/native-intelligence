/**
 * Tests for GET/POST /api/account/projects/[id]/milestones — perf phase 2.
 *
 * Locked in for GET:
 *  - auth via requireWorkspace (401 passthrough),
 *  - 404 when the project is not in the caller's workspace,
 *  - per-milestone action stats come from head-only `count: 'exact'` queries
 *    (two PER MILESTONE) instead of a full-row scan with the workflow_state
 *    join on every action. head counts are NOT subject to PostgREST's max-rows
 *    cap, which is what keeps `completed <= total` structurally true on a
 *    project whose milestones own more than 1000 actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  projectRow: null as { id: string } | null,
  milestoneRows: [] as Record<string, unknown>[],
  /** Every actions select issued: the field list + the count/head options. */
  actionSelects: [] as { fields: string; opts?: { count?: string; head?: boolean } }[],
  /** milestone_id the current select was filtered to (recorded per query). */
  actionFilters: [] as string[],
  /** Per-milestone counts the fake DB reports: [total, completed]. */
  counts: {} as Record<string, [number, number]>,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

function chain(result: unknown) {
  const target: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => new Proxy(target, handler)
    },
  }
  return new Proxy(target, handler)
}

function makeFakeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'projects') {
        return chain({ data: hoisted.projectRow, error: null })
      }
      if (table === 'milestone') {
        return chain({ data: hoisted.milestoneRows, error: null })
      }
      if (table === 'actions') {
        return {
          select: (fields: string, opts?: { count?: string; head?: boolean }) => {
            hoisted.actionSelects.push({ fields, opts })
            const isCompletedQuery = fields.includes('workflow_state')
            // The route narrows to ONE milestone per query via
            // .eq('milestone_id', mid); capture it so the count returned is
            // that milestone's, exactly as Postgres would.
            let milestoneId: string | null = null
            const target: Record<string, unknown> = {
              then: (cb: (v: unknown) => unknown) => {
                const [total, completed] = hoisted.counts[milestoneId ?? ''] ?? [0, 0]
                return Promise.resolve({
                  data: null,
                  count: isCompletedQuery ? completed : total,
                  error: null,
                }).then(cb)
              },
            }
            const handler: ProxyHandler<Record<string, unknown>> = {
              get(t, prop: string) {
                if (prop in t) return t[prop]
                return (col?: unknown, val?: unknown) => {
                  if (prop === 'eq' && col === 'milestone_id') {
                    milestoneId = val as string
                    hoisted.actionFilters.push(milestoneId)
                  }
                  return new Proxy(target, handler)
                }
              },
            }
            return new Proxy(target, handler)
          },
        }
      }
      return chain({ data: null, error: null })
    },
  }
}

const { GET } = await import('@/app/api/account/projects/[id]/milestones/route')

function getReq(): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/projects/proj-1/milestones',
    method: 'GET',
  }) as unknown as NextRequest
}

const fakeParams = { params: Promise.resolve({ id: 'proj-1' }) }

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.projectRow = { id: 'proj-1' }
  hoisted.milestoneRows = [
    { id: 'ms-1', name: 'Alpha', description: null, status: 'pending', target_date: null, sort_order: 0 },
    { id: 'ms-2', name: 'Beta', description: null, status: 'pending', target_date: null, sort_order: 1 },
  ]
  hoisted.actionSelects = []
  hoisted.actionFilters = []
  hoisted.counts = { 'ms-1': [3, 1], 'ms-2': [1, 0] }

  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  })
})

describe('GET /api/account/projects/[id]/milestones', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when project is not in the workspace', async () => {
    hoisted.projectRow = null
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(404)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body.error).toBe('Project not found')
    expect(body.code).toBe('NOT_FOUND')
  })

  it('computes per-milestone stats from head-only exact counts', async () => {
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{
      milestones: { id: string; action_count: number; completed_action_count: number }[]
    }>(res)
    expect(body.milestones).toHaveLength(2)
    expect(body.milestones[0]).toMatchObject({ id: 'ms-1', action_count: 3, completed_action_count: 1 })
    expect(body.milestones[1]).toMatchObject({ id: 'ms-2', action_count: 1, completed_action_count: 0 })

    // Two queries per milestone, and EVERY one is head-only + count exact —
    // that is what makes the counts immune to the max-rows cap.
    expect(hoisted.actionSelects).toHaveLength(4)
    for (const s of hoisted.actionSelects) {
      expect(s.opts).toMatchObject({ count: 'exact', head: true })
    }
    // One of each pair carries the inner join that restricts to completed.
    expect(
      hoisted.actionSelects.filter((s) => s.fields.includes('workflow_state!status_id!inner(category)')),
    ).toHaveLength(2)
    // Each query is narrowed to a single milestone (no .in() bulk scan).
    expect(hoisted.actionFilters.sort()).toEqual(['ms-1', 'ms-1', 'ms-2', 'ms-2'])
  })

  /**
   * Pins the row-cap finding (route.ts:47). The pre-fix rollup ran ONE totals
   * query and ONE completed query over every milestone at once, each
   * independently truncated at PostgREST's max-rows cap (1000 on hosted
   * Supabase) — so a completed action present in the second result but cut out
   * of the first incremented `completed` without ever incrementing `total`, and
   * the panel rendered "1400/1000 actions" at >100% progress.
   *
   * With head counts there are no rows to truncate: whatever Postgres counts is
   * what the route reports, so the subset invariant cannot invert.
   */
  it('reports counts far beyond the 1000-row cap without inverting completed/total', async () => {
    hoisted.milestoneRows = [
      { id: 'ms-big', name: 'Big', description: null, status: 'pending', target_date: null, sort_order: 0 },
    ]
    hoisted.counts = { 'ms-big': [4200, 3100] }

    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{
      milestones: { action_count: number; completed_action_count: number }[]
    }>(res)

    expect(body.milestones[0].action_count).toBe(4200)
    expect(body.milestones[0].completed_action_count).toBe(3100)
    // The invariant the split-row-query version could break.
    expect(body.milestones[0].completed_action_count).toBeLessThanOrEqual(
      body.milestones[0].action_count,
    )
  })

  it('counts every milestone of a large project (bounded fan-out still covers all)', async () => {
    // Past the COUNT_CONCURRENCY batch size, so more than one wave runs.
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `ms-${i}`,
      name: `M${i}`,
      description: null,
      status: 'pending',
      target_date: null,
      sort_order: i,
    }))
    hoisted.milestoneRows = many
    hoisted.counts = Object.fromEntries(many.map((m, i) => [m.id, [i + 1, i] as [number, number]]))

    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{
      milestones: { id: string; action_count: number; completed_action_count: number }[]
    }>(res)

    expect(body.milestones).toHaveLength(30)
    for (let i = 0; i < 30; i++) {
      expect(body.milestones[i]).toMatchObject({
        id: `ms-${i}`,
        action_count: i + 1,
        completed_action_count: i,
      })
    }
    // Two head counts per milestone, no more and no fewer.
    expect(hoisted.actionSelects).toHaveLength(60)
  })

  it('reports zero for a milestone with no actions', async () => {
    hoisted.counts = { 'ms-1': [0, 0], 'ms-2': [0, 0] }
    const res = await GET(getReq(), fakeParams)
    const body = await readJson<{
      milestones: { action_count: number; completed_action_count: number }[]
    }>(res)
    expect(body.milestones[0]).toMatchObject({ action_count: 0, completed_action_count: 0 })
    expect(body.milestones[1]).toMatchObject({ action_count: 0, completed_action_count: 0 })
  })

  it('skips the stats queries entirely for a milestone-less project', async () => {
    hoisted.milestoneRows = []
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ milestones: unknown[] }>(res)
    expect(body.milestones).toEqual([])
    expect(hoisted.actionSelects).toHaveLength(0)
  })
})
