/**
 * POST /api/internal/agent-run/event with `kind: 'plan'` (A4): a work run's
 * `update_plan`. Pins: the work item is the run's (resolved from the token's
 * run, never the body); the one writer stores it; no log line, no ledger beat
 * and no queued → running flip; an invalid plan is a 400 with the words to fix
 * it; a run with no job answers ok:false; the cancel signal still rides.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-agent-run-secret-event-plan'

const agentRunRow: { current: Record<string, unknown> | null } = { current: null }
const agentRunUpdates: Array<Record<string, unknown>> = []

function makeClient() {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) c[m] = () => c
  c.maybeSingle = async () => ({ data: agentRunRow.current, error: null })
  c.update = (patch: Record<string, unknown>) => {
    agentRunUpdates.push(patch)
    const q: Record<string, unknown> = {
      eq: () => q,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    }
    return q
  }
  return { from: () => c }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => makeClient() }))

const resolveWorkItemIdForAgentRun = vi.fn<(s: unknown, runId: string) => Promise<string | null>>()
vi.mock('@/lib/work/touch', () => ({
  resolveWorkItemIdForAgentRun: (s: unknown, runId: string) => resolveWorkItemIdForAgentRun(s, runId),
}))
const beatAgentRunWork = vi.fn(async () => {})
vi.mock('@/lib/work/agent-run-mirror', () => ({ beatAgentRunWork: (...a: unknown[]) => beatAgentRunWork(...(a as [])) }))
const setWorkPlan = vi.fn()
vi.mock('@/lib/work/plan', async (orig) => {
  const real = await orig<typeof import('@/lib/work/plan')>()
  return { ...real, setWorkPlan: (...a: unknown[]) => setWorkPlan(...a) }
})

import { POST } from '@/app/api/internal/agent-run/event/route'
import { mintAgentRunToken, AGENT_RUN_SECRET_HEADER, AGENT_RUN_TOKEN_HEADER } from '@/lib/agent-run/agent-run-token'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }
const STEPS = [{ text: 'Read the thread', status: 'in_progress' }]

function req(body: unknown) {
  return new Request('http://localhost/api/internal/agent-run/event', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AGENT_RUN_SECRET_HEADER]: SECRET,
      [AGENT_RUN_TOKEN_HEADER]: mintAgentRunToken(CLAIMS),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  agentRunRow.current = { status: 'queued', log_tail: 'old', kind: 'workspace', triggered_by: 'u', task_prompt: 't', action_id: null }
  agentRunUpdates.length = 0
  resolveWorkItemIdForAgentRun.mockReset().mockResolvedValue('job-1')
  beatAgentRunWork.mockClear()
  setWorkPlan.mockReset().mockResolvedValue({ ok: true, plan: { steps: STEPS, updated_at: 'now' } })
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
})

describe('POST /api/internal/agent-run/event — kind plan', () => {
  it("writes the run's job plan through the one writer, scoped by the token", async () => {
    const res = await POST(req({ kind: 'plan', steps: STEPS, workspaceId: 'ws-evil', workItemId: 'job-evil' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, plan: { steps: STEPS, updated_at: 'now' }, canceling: false })
    expect(resolveWorkItemIdForAgentRun).toHaveBeenCalledWith(expect.anything(), 'run-1')
    expect(setWorkPlan).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', workItemId: 'job-1', steps: STEPS })
  })

  it('adds no log line, no ledger beat, and never flips a queued run to running', async () => {
    await POST(req({ kind: 'plan', steps: STEPS, text: 'should not land' }))
    expect(agentRunUpdates).toEqual([])
    expect(beatAgentRunWork).not.toHaveBeenCalled()
  })

  it('an invalid plan is a 400 with the words to fix it', async () => {
    setWorkPlan.mockResolvedValue({ ok: false, code: 'INPUT_INVALID', error: 'Only one step can be in_progress at a time (2 are).' })
    const res = await POST(req({ kind: 'plan', steps: [] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, code: 'INPUT_INVALID', error: expect.stringContaining('Only one step') })
  })

  it('a run with no job answers ok:false without writing', async () => {
    resolveWorkItemIdForAgentRun.mockResolvedValue(null)
    const res = await POST(req({ kind: 'plan', steps: STEPS }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, canceling: false })
    expect(setWorkPlan).not.toHaveBeenCalled()
  })

  it('still carries the cancel signal', async () => {
    agentRunRow.current = { ...agentRunRow.current!, status: 'canceling' }
    const res = await POST(req({ kind: 'plan', steps: STEPS }))
    expect(await res.json()).toMatchObject({ canceling: true })
  })

  it('a log beat still appends and beats the ledger (the plan branch is separate)', async () => {
    await POST(req({ kind: 'log', text: ' new' }))
    expect(agentRunUpdates[0]).toMatchObject({ log_tail: 'old new', status: 'running' })
    expect(beatAgentRunWork).toHaveBeenCalledTimes(1)
    expect(setWorkPlan).not.toHaveBeenCalled()
  })
})
