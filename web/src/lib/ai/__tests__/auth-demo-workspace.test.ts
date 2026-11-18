/**
 * checkUsageLimits for a demo workspace's visitor (migration 669).
 *
 * The SQL gate answers per person: 'demo_workspace' while the workspace's
 * shared spend is under its cap, 'demo_cost_limit_exceeded' once it is not.
 * It cannot see where the request is, so "inside the demo workspace only" is
 * checked here: a request that names another workspace is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  serviceRpc: vi.fn(),
  currentWorkspace: vi.fn(),
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: vi.fn() } }) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ rpc: hoisted.serviceRpc }) }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: hoisted.currentWorkspace }))

const { checkUsageLimits } = await import('@/lib/ai/auth')
const { DEMO_CAP_REACHED_MESSAGE, DEMO_ONLY_MESSAGE, DEMO_UNREADABLE_MESSAGE, setDemoWorkspaceLookupForTests } = await import('@/lib/demo/demo-mode')

const DEMO = 'demo-ws'
const OWN = 'own-ws'

function gateAnswers(row: Record<string, unknown>) {
  hoisted.serviceRpc.mockImplementation(async (name: string) => {
    if (name === 'check_ai_usage_limit') return { data: [row], error: null }
    throw new Error(`unexpected rpc ${name}`)
  })
}

async function refusal(run: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await run
  } catch (thrown) {
    const res = thrown as Response
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  hoisted.serviceRpc.mockReset()
  hoisted.currentWorkspace.mockReset()
  setDemoWorkspaceLookupForTests((id) => id === DEMO)
})

describe('checkUsageLimits: a demo workspace visitor', () => {
  it('passes inside the demo workspace', async () => {
    gateAnswers({ allowed: true, reason: 'demo_workspace', plan_name: 'Demo workspace', is_paid_plan: false })
    hoisted.currentWorkspace.mockResolvedValue(DEMO)
    await expect(checkUsageLimits('u1')).resolves.toMatchObject({ allowed: true, reason: 'demo_workspace' })
  })

  it('is refused in any other workspace: their own is not a free seat', async () => {
    gateAnswers({ allowed: true, reason: 'demo_workspace' })
    hoisted.currentWorkspace.mockResolvedValue(OWN)
    const { status, body } = await refusal(checkUsageLimits('u1'))
    expect(status).toBe(429)
    expect(body).toMatchObject({ reason: 'demo_workspace_only', message: DEMO_ONLY_MESSAGE })
  })

  it('is refused when no workspace is named at all (an internal route, a job with no cookie): it cannot pass into any workspace they belong to', async () => {
    gateAnswers({ allowed: true, reason: 'demo_workspace' })
    hoisted.currentWorkspace.mockResolvedValue(null)
    expect((await refusal(checkUsageLimits('u1'))).body.reason).toBe('demo_workspace_only')
    hoisted.currentWorkspace.mockRejectedValue(new Error('no request scope'))
    expect((await refusal(checkUsageLimits('u1'))).body.reason).toBe('demo_workspace_only')
    // The same check, told where it runs (as the chat's spec route tells it), passes.
    await expect(checkUsageLimits('u1', undefined, { workspaceId: DEMO })).resolves.toMatchObject({ allowed: true })
  })

  it('where the work really runs wins over what the request names', async () => {
    gateAnswers({ allowed: true, reason: 'demo_workspace' })
    // The request names the demo (a cookie), the job's session is in their own workspace: refused.
    hoisted.currentWorkspace.mockResolvedValue(DEMO)
    const { body } = await refusal(checkUsageLimits('u1', undefined, { workspaceId: OWN }))
    expect(body.reason).toBe('demo_workspace_only')
    // And the other way round: the request names another, the work runs in the demo.
    hoisted.currentWorkspace.mockResolvedValue(OWN)
    await expect(checkUsageLimits('u1', undefined, { workspaceId: DEMO })).resolves.toMatchObject({ allowed: true })
    expect(hoisted.currentWorkspace).not.toHaveBeenCalled()
  })

  it('a flag that cannot be read is still a refusal, but says "try again", never "switch back": they may be in the demo already', async () => {
    gateAnswers({ allowed: true, reason: 'demo_workspace' })
    setDemoWorkspaceLookupForTests(() => {
      throw new Error('no answer in 4000 ms')
    })
    hoisted.currentWorkspace.mockResolvedValue(DEMO)
    const { status, body } = await refusal(checkUsageLimits('u1'))
    expect(status).toBe(503)
    expect(body).toMatchObject({ code: 'BILLING_UNAVAILABLE', error: DEMO_UNREADABLE_MESSAGE })
    expect(body.reason).toBeUndefined()
    expect((await refusal(checkUsageLimits('u1', undefined, { workspaceId: OWN }))).status).toBe(503)
    // No workspace named is not a read failure: the plain refusal, as before.
    expect((await refusal(checkUsageLimits('u1', undefined, { workspaceId: null }))).body.reason).toBe('demo_workspace_only')
  })

  it('says so in plain words once the workspace’s monthly cap is reached', async () => {
    gateAnswers({ allowed: false, reason: 'demo_cost_limit_exceeded', plan_name: 'Demo workspace' })
    const { status, body } = await refusal(checkUsageLimits('u1'))
    expect(status).toBe(429)
    expect(body).toMatchObject({ reason: 'demo_cost_limit_exceeded', message: DEMO_CAP_REACHED_MESSAGE })
    expect(hoisted.currentWorkspace).not.toHaveBeenCalled()
  })

  it('leaves everyone else alone: no workspace lookup for a seat holder', async () => {
    gateAnswers({ allowed: true, reason: 'within_limits', is_paid_plan: true })
    await expect(checkUsageLimits('u1')).resolves.toMatchObject({ reason: 'within_limits' })
    expect(hoisted.currentWorkspace).not.toHaveBeenCalled()
  })
})
