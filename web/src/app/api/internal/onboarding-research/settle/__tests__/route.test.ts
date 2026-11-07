/**
 * POST /api/internal/onboarding-research/settle — finish_research's ledger
 * hand-off (Sequence row 6). Driven end to end against the stateful work fake:
 * the route is auth + body parsing, and what the row becomes is read from the
 * member's STORED research state, never from the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const SECRET = 'test-internal-secret-research-settle'

const hoisted = vi.hoisted(() => ({
  client: null as unknown,
  createNotification: vi.fn(async () => {}),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.client }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
// The recorder wakes the agent router through Inngest: mocked, so no test sends
// a real event (src/test/setup.ts fails any that slip through).
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }))

import { POST } from '@/app/api/internal/onboarding-research/settle/route'
import { AGENT_RUN_SECRET_HEADER } from '@/lib/agent-run/agent-run-token'
import { mirrorOnboardingResearchStarted } from '@/lib/work/onboarding-research-mirror'

function req(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret != null) headers[AGENT_RUN_SECRET_HEADER] = secret
  return new Request('http://localhost/api/internal/onboarding-research/settle', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function world(research: Record<string, unknown>) {
  const fake = makeFakeSupabase({ unique: { tracked_job: ['kind,run_key'] } })
  fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1', onboarding_progress: { research } }])
  await mirrorOnboardingResearchStarted(fake as never, { workspaceId: 'w1', memberId: 'm1', sessionId: 'sess-1' })
  hoisted.client = fake
  return fake
}

beforeEach(() => {
  vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', SECRET)
  hoisted.createNotification.mockClear()
})

describe('POST /api/internal/onboarding-research/settle', () => {
  it('401s without the secret or with a wrong one, and touches nothing', async () => {
    const fake = await world({ sessionId: 'sess-1', status: 'done', companyFound: true })
    expect((await POST(req({ sessionId: 'sess-1' }, null))).status).toBe(401)
    expect((await POST(req({ sessionId: 'sess-1' }, 'nope-nope-nope-nope'))).status).toBe(401)
    expect(fake.rows('tracked_job')[0].status).toBe('running')
  })

  it('400s a body without a session id, and a non-JSON body', async () => {
    await world({ sessionId: 'sess-1', status: 'done' })
    expect((await POST(req({}))).status).toBe(400)
    expect((await POST(req('not json'))).status).toBe(400)
  })

  it('settles the row from the stored state', async () => {
    const fake = await world({ sessionId: 'sess-1', status: 'done', companyFound: true })
    const res = await POST(req({ sessionId: 'sess-1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settled: 'done' })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'done', result_summary: 'Found your company' })
  })

  it('reports why it did not settle rather than erroring, and leaves the row open', async () => {
    const fake = await world({ sessionId: 'sess-OTHER', status: 'done' })
    const res = await POST(req({ sessionId: 'sess-1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settled: null, reason: 'session_mismatch' })
    expect(fake.rows('tracked_job')[0].status).toBe('running')

    const none = await POST(req({ sessionId: 'sess-unknown' }))
    expect(await none.json()).toEqual({ settled: null, reason: 'no_item' })
  })
})
