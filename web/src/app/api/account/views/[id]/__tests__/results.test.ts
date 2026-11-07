/**
 * Tests for GET /api/account/views/[id]/results — executing a SAVED view.
 *
 * The behaviour under test is the Evals feature gate. Evals is hidden and
 * per-workspace, and every other route in its REST surface refuses when the
 * workspace cannot see it — including the ad-hoc POST /api/account/views/query.
 * A saved view OUTLIVES the toggle, and `eval_suite`'s RLS is plain
 * `is_workspace_member`, so without a gate here executing a saved eval view by
 * id would be the one way left to list a workspace's suites with Evals off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  requireWorkspaceFeature: vi.fn(),
  executeView: vi.fn(),
  viewRow: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    from: (table: string) => {
      if (table === 'view') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve(
                    hoisted.viewRow
                      ? { data: hoisted.viewRow, error: null }
                      : { data: null, error: { message: 'not found' } },
                  ),
              }),
            }),
          }),
        }
      }
      if (table === 'member') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'm1' } }) }) }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceFeature: hoisted.requireWorkspaceFeature }))
vi.mock('@/lib/views/query-engine', () => ({ executeView: hoisted.executeView }))

const { GET } = await import('@/app/api/account/views/[id]/results/route')

const WS = 'ws-1'
const params = (id: string) => ({ params: Promise.resolve({ id }) })

function req(): NextRequest {
  const url = 'https://dial8.ai/api/account/views/view-1/results'
  const r = buildRequest({ url, method: 'GET' }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return r as unknown as NextRequest
}

beforeEach(() => {
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  hoisted.getCurrentWorkspaceId.mockResolvedValue(WS)
  hoisted.requireWorkspaceFeature.mockReset().mockResolvedValue(null)
  hoisted.executeView.mockReset().mockResolvedValue({ items: [], total: 0 })
  hoisted.viewRow = { id: 'view-1', workspace_id: WS, entity_type: 'action' }
})

describe('GET /api/account/views/[id]/results', () => {
  it('executes an ordinary view without consulting the feature gate', async () => {
    const res = await GET(req(), params('view-1'))
    expect(res.status).toBe(200)
    expect(hoisted.requireWorkspaceFeature).not.toHaveBeenCalled()
    expect(hoisted.executeView).toHaveBeenCalled()
  })

  it.each(['eval_suite', 'eval_case', 'eval_run'])(
    'gates a saved %s view on the evals feature',
    async (entityType) => {
      hoisted.viewRow = { id: 'view-1', workspace_id: WS, entity_type: entityType }
      const res = await GET(req(), params('view-1'))
      expect(res.status).toBe(200)
      expect(hoisted.requireWorkspaceFeature).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS }),
        'evals',
      )
    },
  )

  it('403s a saved eval view and never runs the query when Evals is off', async () => {
    hoisted.viewRow = { id: 'view-1', workspace_id: WS, entity_type: 'eval_suite' }
    hoisted.requireWorkspaceFeature.mockResolvedValue(
      new Response(JSON.stringify({ error: 'off', code: 'FEATURE_DISABLED' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await GET(req(), params('view-1'))
    expect(res.status).toBe(403)
    expect((await readJson<{ code: string }>(res)).code).toBe('FEATURE_DISABLED')
    expect(hoisted.executeView).not.toHaveBeenCalled()
  })

  it('404s a view from another workspace before any gate or query', async () => {
    hoisted.viewRow = null
    const res = await GET(req(), params('view-1'))
    expect(res.status).toBe(404)
    expect(hoisted.requireWorkspaceFeature).not.toHaveBeenCalled()
    expect(hoisted.executeView).not.toHaveBeenCalled()
  })
})
