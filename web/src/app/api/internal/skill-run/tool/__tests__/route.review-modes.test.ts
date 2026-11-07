/**
 * The skill-run route (a loop's unattended run) with the REAL reviewer and
 * ACTION_REVIEW_MODE (L5). Only Jev (runDecision), the approval writer and
 * the loop's saved words are stubbed:
 *   - the default (unset): a loop that doesn't use the Mac stays shadow, as on
 *     PROD: a call the reviewer would hold runs, with no card;
 *   - blocking: the same call is held as the loop's card and never runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/flows/skill-run-binding.ts) has its own
// tests; this file's fake database holds no member / skill rows.
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => null }))
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'

const SECRET = 'test-internal-secret-abcdefghij'
const jev = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: jev.decide }))
const approvals = vi.hoisted(() => ({ create: vi.fn(async (..._a: unknown[]) => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })) }))
vi.mock('@/lib/safety/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/approvals')>()), createToolApproval: approvals.create }))
vi.mock('@/lib/safety/loop-instructions', () => ({ skillRunLoopInstructions: async () => ['Instructions: summarize the week.'] }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = () => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'limit']) c[m] = () => c
      c.maybeSingle = async () => ({ data: { agent_config: { enabled_tools: [...ALL_CATEGORY_IDS] } }, error: null })
      return c
    }
    return { from: () => chain() }
  },
}))
const executeSpy = vi.fn(async () => ({ ok: true }))
const stubTool = { description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: executeSpy }
vi.mock('@/lib/ai/tools', () => ({ createTools: () => ({ list_actions: stubTool, delete_action: stubTool }) }))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER } from '@/lib/flows/skill-run-token'

const claims = {
  workspaceId: 'ws-1', runAsUserId: 'user-1', skillId: 'skill-1', mode: 'act' as const, hasCapture: false,
  outputContract: 'prose' as const, model: 'claude-haiku-4-5-20251001', workItemId: 'job-1',
}
const req = () => new Request('http://localhost/api/internal/skill-run/tool', {
  method: 'POST',
  headers: { 'content-type': 'application/json', [RUN_SKILL_SECRET_HEADER]: SECRET, [RUN_SKILL_TOKEN_HEADER]: mintRunToken(claims) },
  body: JSON.stringify({ toolName: 'delete_action', input: { action_id: 'GEN-1' } }),
})

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  jev.decide.mockReset().mockResolvedValue({ status: 'accepted', inferenceId: 'inf-b', value: { allow: false, probability: 0.22 } })
  approvals.create.mockClear()
  executeSpy.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  vi.unstubAllEnvs()
})

describe('skill-run route, the reviewer modes', () => {
  it('the default: a loop off the Mac stays shadow, as on PROD (the call runs, no card)', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(approvals.create).not.toHaveBeenCalled()
  })

  it('blocking: the same call is held as the loop’s card and never runs', async () => {
    vi.stubEnv('ACTION_REVIEW_MODE', 'blocking')
    const res = await POST(req())
    expect((await res.json()).output).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(executeSpy).not.toHaveBeenCalled()
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ door: 'skill_run', reason: 'not_asked' }))
  })
})
