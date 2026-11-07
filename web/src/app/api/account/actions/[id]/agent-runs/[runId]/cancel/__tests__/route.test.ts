import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/account/actions/[id]/agent-runs/[runId]/cancel (Loops v3 Phase 3 hardening).
 *
 * The optimistic `canceling` flip now goes through the SERVICE client (member-wide
 * agent_run UPDATE RLS is dropped in mig 200) and is CAS-guarded on a non-terminal
 * status, so a run that settled in the gap since the read is NOT resurrected to
 * `canceling` (which agentRunCancel would then finalize as `canceled`, clobbering a
 * real deliverable). Locks: auth, the terminal pre-guard, the service-role CAS write,
 * and the cancel event emitted ONLY when the flip took.
 */

let currentUser: { id: string } | null = { id: 'u1' }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    from: () => cookieAgentRunChain(),
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

const inngestSend = vi.fn(async (..._a: unknown[]) => ({ ids: ['evt'] }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => inngestSend(...a) } }))

// The CAS WRITE goes through the service client.
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
            if (casTook) {
              serviceWrites.push(patch)
              return { data: [{ id: 'run-1' }], error: null }
            }
            return { data: [], error: null }
          },
        })
        return chain
      },
    }),
  }),
}))

let runRow: { id: string; status: string } | null = { id: 'run-1', status: 'running' }
function cookieAgentRunChain() {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: runRow, error: runRow ? null : { message: 'not found' } }),
  })
  return chain
}

import { POST } from '../route'

function call() {
  const req = new Request('http://localhost/x', { method: 'POST' })
  return POST(req, { params: Promise.resolve({ id: 'action-1', runId: 'run-1' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = { id: 'u1' }
  runRow = { id: 'run-1', status: 'running' }
  casTook = true
  serviceWrites.length = 0
})

describe('cancel route — service-role CAS flip', () => {
  it('flips a live run to canceling via the service client and emits the cancel event', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'canceling' })
    // Service-role write recorded the canceling flip.
    expect(serviceWrites).toHaveLength(1)
    expect(serviceWrites[0]).toEqual({ status: 'canceling' })
    expect(inngestSend).toHaveBeenCalledTimes(1)
  })

  it('401 when unauthenticated', async () => {
    currentUser = null
    const res = await call()
    expect(res.status).toBe(401)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('404 when the run is not found', async () => {
    runRow = null
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('409 (pre-guard) when the run is already terminal at read time', async () => {
    runRow = { id: 'run-1', status: 'completed' }
    const res = await call()
    expect(res.status).toBe(409)
    expect(serviceWrites).toHaveLength(0)
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('409 (CAS loss) + no cancel event when the run settled in the read→write gap', async () => {
    // Read saw 'running' (pre-guard passes), but the CAS matches 0 rows (a settle won).
    casTook = false
    const res = await call()
    expect(res.status).toBe(409)
    // Crucially: the cancel event is NOT emitted, so a finished run is never settled canceled.
    expect(inngestSend).not.toHaveBeenCalled()
  })
})
