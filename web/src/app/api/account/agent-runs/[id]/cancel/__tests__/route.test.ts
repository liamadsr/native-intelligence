import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/account/agent-runs/[id]/cancel — Stop for a run with no tracked
 * board action (an auto-attempted run, Sequence step 3). Same contract as the
 * action-scoped route: RLS-scoped read in the caller's current workspace,
 * terminal pre-guard, service-role CAS flip, the cancel event only when the
 * flip took.
 */

let currentUser: { id: string } | null = { id: 'u1' }
const cookieFilters: Array<[string, unknown]> = []
let runRow: { id: string; status: string } | null = { id: 'run-1', status: 'running' }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    from: () => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          cookieFilters.push([k, v])
          return chain
        },
        single: async () => ({ data: runRow, error: runRow ? null : { message: 'not found' } }),
      })
      return chain
    },
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

const inngestSend = vi.fn(async (..._a: unknown[]) => ({ ids: ['evt'] }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => inngestSend(...a) } }))

let casTook = true
const serviceWrites: Array<Record<string, unknown>> = []
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          eq: () => chain,
          not: () => chain,
          select: async () => {
            if (!casTook) return { data: [], error: null }
            serviceWrites.push(patch)
            return { data: [{ id: 'run-1' }], error: null }
          },
        })
        return chain
      },
    }),
  }),
}))

import { POST } from '../route'

const call = () => POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id: 'run-1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = { id: 'u1' }
  runRow = { id: 'run-1', status: 'running' }
  casTook = true
  serviceWrites.length = 0
  cookieFilters.length = 0
})

describe('run-scoped cancel route', () => {
  it('reads the run by id in the caller\'s workspace (no action needed), flips it to canceling and emits the cancel event', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'canceling' })
    expect(cookieFilters).toEqual([
      ['id', 'run-1'],
      ['workspace_id', 'ws-1'],
    ])
    expect(serviceWrites).toEqual([{ status: 'canceling' }])
    expect(inngestSend).toHaveBeenCalledWith({ name: 'agent/run.cancel', data: { agent_run_id: 'run-1', workspace_id: 'ws-1' } })
  })

  it('401 unauthenticated, 404 not found (e.g. another workspace\'s run) — nothing written or sent', async () => {
    currentUser = null
    expect((await call()).status).toBe(401)
    currentUser = { id: 'u1' }
    runRow = null
    expect((await call()).status).toBe(404)
    expect(serviceWrites).toHaveLength(0)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('409 when already terminal at read time, and 409 with NO cancel event when it settled in the gap', async () => {
    runRow = { id: 'run-1', status: 'completed' }
    expect((await call()).status).toBe(409)
    runRow = { id: 'run-1', status: 'running' }
    casTook = false
    expect((await call()).status).toBe(409)
    expect(inngestSend).not.toHaveBeenCalled()
  })
})
