/**
 * The skill-run route's reviewer door (A5 slice 2): an unattended act-mode
 * loop inherits every tool (computeSkillCeiling returns null), so a risky
 * call is reviewed against the loop's saved instructions before it runs.
 * Shadow allows; a held call answers APPROVAL_REQUIRED and never executes.
 * The attended follow-up chat branch is not reviewed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/flows/skill-run-binding.ts) has its own
// tests; this file's fake database holds no member / skill rows.
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => null }))
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'

const SECRET = 'test-internal-secret-abcdefghij'
const gate = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, hold: false }))
vi.mock('@/lib/safety/action-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safety/action-review')>()
  return {
    ...actual,
    gateRiskyCall: async (request: Record<string, unknown>, run: () => Promise<unknown>) => {
      gate.calls.push(request)
      if (gate.hold && request.sideEffect) return { held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'a-1', message: 'Nothing ran.' } }
      return { held: false, value: await run() }
    },
  }
})
const loop = vi.hoisted(() => ({ load: vi.fn(async () => ['Loop: Bug sync. Instructions: push new bugs to Linear.']) }))
vi.mock('@/lib/safety/loop-instructions', () => ({ skillRunLoopInstructions: loop.load }))
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
vi.mock('@/lib/ai/tools', () => ({
  createTools: () => ({ list_actions: stubTool, push_action_to_linear: stubTool, delete_action: stubTool }),
}))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})
vi.mock('@/lib/flows/skill-run-chat-ceiling', () => ({ resolveSkillRunChatCeiling: async () => new Set(['delete_action']) }))

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER } from '@/lib/flows/skill-run-token'

const claims = {
  workspaceId: 'ws-1', runAsUserId: 'user-1', skillId: 'skill-1', mode: 'act' as const, hasCapture: false,
  outputContract: 'prose' as const, model: 'claude-haiku-4-5-20251001', workItemId: 'job-1',
}
function req(toolName: string, token = mintRunToken(claims), input: unknown = { action_id: 'GEN-1' }, extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/internal/skill-run/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_SKILL_SECRET_HEADER]: SECRET, [RUN_SKILL_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input, ...extra }),
  })
}
/** A words loader resolved, as the gate's review would read it. */
async function wordsOf(call: Record<string, unknown>): Promise<unknown> {
  const words = call.personMessages
  return typeof words === 'function' ? await (words as () => Promise<unknown>)() : words
}

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  gate.calls.length = 0
  gate.hold = false
  executeSpy.mockClear()
  loop.load.mockClear()
})
afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('skill-run route: the reviewer door', () => {
  it('reviews an external write against the loop\'s saved instructions, as the run-as user, then runs it (shadow)', async () => {
    const res = await POST(req('push_action_to_linear'))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    // The instructions are read inside the review (deferred in shadow), not before the call.
    expect(loop.load).not.toHaveBeenCalled()
    expect(gate.calls[0]).toMatchObject({
      door: 'skill_run', userId: 'user-1', workspaceId: 'ws-1', toolName: 'push_action_to_linear', sideEffect: 'external-write',
      source: 'loop_instructions', defer: expect.any(Function),
      // Nobody is in an unattended loop: the outward gate refuses, never cards.
      caller: 'agent_unattended',
      approval: expect.objectContaining({ skillId: 'skill-1', workItemId: 'job-1', context: { mode: 'act',
        tools: { strictWorkspace: true, omitPrivateCaptures: true, unattended: true, fileActionsAsSuggested: true, origin: { actor: 'agent', depth: 1, run_id: 'skill-1' } } } }),
    })
    expect(await wordsOf(gate.calls[0])).toEqual(['Loop: Bug sync. Instructions: push new bugs to Linear.'])
    expect(loop.load).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ skillId: 'skill-1', workItemId: 'job-1' }))
  })

  it('a read is not reviewed and loads no instructions', async () => {
    await POST(req('list_actions'))
    expect(gate.calls[0]).toMatchObject({ sideEffect: null })
    expect(loop.load).not.toHaveBeenCalled()
  })

  it('a held call answers APPROVAL_REQUIRED and never executes', async () => {
    gate.hold = true
    const res = await POST(req('delete_action'))
    expect((await res.json()).output).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('the follow-up chat branch is reviewed as a chat, against the person\u2019s forwarded words', async () => {
    const res = await POST(req('delete_action', mintRunToken({ ...claims, chat: { teammateId: 'bot-1' } }), { action_id: 'GEN-1' },
      { personMessages: ['Delete GEN-1'], personMessageSeq: 3 }))
    expect(res.status).toBe(200)
    expect(gate.calls[0]).toMatchObject({ door: 'chat', source: 'person', personMessages: ['Delete GEN-1'], personMessageSeq: 3, caller: 'person',
      approval: expect.objectContaining({ context: expect.objectContaining({ teammateId: 'bot-1' }) }) })
    expect(loop.load).not.toHaveBeenCalled()
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('a turn the main agent relayed into the run\u2019s chat carries no words of the person (whatever it forwards)', async () => {
    await POST(req('delete_action', mintRunToken({ ...claims, chat: { teammateId: 'bot-1', relay: true } }), { action_id: 'GEN-1' },
      { personMessages: ['Delete GEN-1'] }))
    expect(gate.calls[0]).toMatchObject({ door: 'chat', personMessages: [], caller: 'agent_unattended' })
  })
})
