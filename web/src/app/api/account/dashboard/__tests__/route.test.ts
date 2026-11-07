/**
 * GET /api/account/dashboard — capture visibility in the dashboard widgets.
 *
 * Two widgets read captures directly: pending-review and recent-captures.
 * Pending-review also rolls up suggested actions/decisions per capture — those
 * rollups are keyed on the capture id list, so filtering the capture query is
 * what keeps a private capture's suggestions out of a teammate's dashboard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  client: vi.fn(),
  workspaceId: vi.fn(),
  captureOrSpy: vi.fn(),
  captureNeqSpy: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: hoisted.client }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: hoisted.workspaceId }))
vi.mock('@/lib/integrations/calendar-sync', () => ({ getUpcomingCaptures: async () => [] }))

const WORKSPACE_ID = 'ws-test-1'
const USER_ID = 'user-1'

function makeClient() {
  const captureChain: Record<string, unknown> = {
    select: () => captureChain,
    eq: () => captureChain,
    // The eval fence (.neq('is_eval', true), migration 252) sits on both
    // capture widgets — see the route.
    neq: (col: string, val: unknown) => {
      hoisted.captureNeqSpy(col, val)
      return captureChain
    },
    gte: () => captureChain,
    order: () => captureChain,
    limit: () => captureChain,
    or: (expr: string) => {
      hoisted.captureOrSpy(expr)
      return captureChain
    },
    then: (resolve: (v: { data: never[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  }

  const memberChain: Record<string, unknown> = {
    select: () => memberChain,
    eq: () => memberChain,
    single: async () => ({
      data: { id: 'member-1', display_name: 'Me', avatar_url: null },
      error: null,
    }),
  }

  const emptyChain: Record<string, unknown> = {
    select: () => emptyChain,
    eq: () => emptyChain,
    neq: () => emptyChain,
    in: () => emptyChain,
    not: () => emptyChain,
    gte: () => emptyChain,
    gt: () => emptyChain,
    order: () => emptyChain,
    limit: () => emptyChain,
    single: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: never[]; error: null; count: number }) => unknown) =>
      resolve({ data: [], error: null, count: 0 }),
  }

  return {
    from: (table: string) => {
      if (table === 'captures') return captureChain
      if (table === 'member') return memberChain
      return emptyChain
    },
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  }
}

const { GET } = await import('@/app/api/account/dashboard/route')

describe('GET /api/account/dashboard — capture visibility', () => {
  beforeEach(() => {
    hoisted.captureOrSpy.mockReset()
    hoisted.captureNeqSpy.mockReset()
    hoisted.client.mockResolvedValue(makeClient())
    hoisted.workspaceId.mockResolvedValue(WORKSPACE_ID)
  })

  it('applies the visibility predicate to BOTH capture widgets', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    // pending-review + recent-captures.
    expect(hoisted.captureOrSpy).toHaveBeenCalledTimes(2)
    for (const call of hoisted.captureOrSpy.mock.calls) {
      expect(call[0]).toBe(`visibility.eq.workspace,user_id.eq.${USER_ID}`)
    }
  })

  it('fences EVAL captures out of BOTH capture widgets', async () => {
    // A synthetic mock meeting (`is_eval`, migration 252) must never appear in
    // the review queue or the recent-meetings list. See docs/plans/evals.md §5.2.
    await GET()
    const evalFences = hoisted.captureNeqSpy.mock.calls.filter(([col]) => col === 'is_eval')
    expect(evalFences).toHaveLength(2)
    for (const [, val] of evalFences) expect(val).toBe(true)
  })

  it('keys the predicate on the signed-in user, not the workspace', async () => {
    await GET()
    expect(hoisted.captureOrSpy).toHaveBeenCalledWith(
      expect.stringContaining(`user_id.eq.${USER_ID}`),
    )
    expect(hoisted.captureOrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKSPACE_ID),
    )
  })
})
