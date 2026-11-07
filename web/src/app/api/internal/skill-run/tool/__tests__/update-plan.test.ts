/**
 * POST /api/internal/skill-run/tool with toolName `update_plan` (A4): the
 * skill-runner's native plan tool. Pins: handled before the ceiling (a
 * report-mode run with a narrow ceiling still plans), writes only the token's
 * own job (never a body-named one) through the one writer, never builds the
 * workspace tools, a run with no job is told to skip it, and an invalid plan is
 * a 400 INPUT_INVALID.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/flows/skill-run-binding.ts) has its own
// tests; this file's fake database holds no member / skill rows.
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => null }))

const SECRET = 'test-internal-secret-update-plan'

const from = vi.fn()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from }) }))
const createTools = vi.fn(() => ({}))
vi.mock('@/lib/ai/tools', () => ({ createTools: () => createTools() }))
const setWorkPlan = vi.fn()
vi.mock('@/lib/work/plan', async (orig) => {
  const real = await orig<typeof import('@/lib/work/plan')>()
  return { ...real, setWorkPlan: (...a: unknown[]) => setWorkPlan(...a) }
})

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER } from '@/lib/flows/skill-run-token'

const STEPS = [{ text: 'Pull the meeting notes', status: 'in_progress' }]

function token(workItemId?: string) {
  return mintRunToken({
    workspaceId: 'ws-1',
    runAsUserId: 'user-1',
    skillId: 'skill-1',
    mode: 'report',
    hasCapture: false,
    outputContract: 'prose',
    model: 'm',
    ...(workItemId ? { workItemId } : {}),
  })
}

function req(tok: string, input: unknown) {
  return new Request('http://localhost/api/internal/skill-run/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_SKILL_SECRET_HEADER]: SECRET, [RUN_SKILL_TOKEN_HEADER]: tok },
    body: JSON.stringify({ toolName: 'update_plan', input }),
  })
}

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  from.mockReset()
  createTools.mockClear()
  setWorkPlan.mockReset().mockResolvedValue({ ok: true, plan: { steps: STEPS, updated_at: 'now' } })
})
afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('skill-run tool route — update_plan', () => {
  it("writes the token's own job plan, before any ceiling or tool build", async () => {
    const res = await POST(req(token('job-1'), { steps: STEPS, workItemId: 'job-evil' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ output: { ok: true, plan: STEPS } })
    expect(setWorkPlan).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', workItemId: 'job-1', steps: STEPS })
    // No recipe read (the ceiling) and no workspace tools built.
    expect(from).not.toHaveBeenCalled()
    expect(createTools).not.toHaveBeenCalled()
  })

  it('a run with no job is told to skip it, without writing', async () => {
    const res = await POST(req(token(), { steps: STEPS }))
    expect(await res.json()).toEqual({ output: { ok: false, note: expect.stringContaining('Skip update_plan') } })
    expect(setWorkPlan).not.toHaveBeenCalled()
  })

  it('an invalid plan is a 400 INPUT_INVALID with the words to fix it', async () => {
    setWorkPlan.mockResolvedValue({ ok: false, code: 'INPUT_INVALID', error: 'A plan needs at least one step.' })
    const res = await POST(req(token('job-1'), { steps: [] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'A plan needs at least one step.', code: 'INPUT_INVALID' })
  })

  it('a settled job answers ok:false in the output (the model reads it, no throw)', async () => {
    setWorkPlan.mockResolvedValue({ ok: false, code: 'NOT_LIVE', error: 'This job is no longer running, so its plan stays as it was.' })
    const res = await POST(req(token('job-1'), { steps: STEPS }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ output: { ok: false, error: expect.stringContaining('no longer running') } })
  })
})
