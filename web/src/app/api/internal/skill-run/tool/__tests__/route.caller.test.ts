/**
 * The skill-run tool route, principal by principal (trust layer P2): what an
 * unattended loop's run, a follow-up chat turn with the person, and a turn the
 * main agent relayed may do today, pinned so the move onto the one trust
 * authority (src/lib/safety/caller.ts) changes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/flows/skill-run-binding.ts) has its own
// tests; this file's fake database holds no member / skill rows.
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => null }))
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'

const SECRET = 'test-internal-secret-caller-pin'
const gate = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/safety/action-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safety/action-review')>()
  return {
    ...actual,
    gateRiskyCall: async (request: Record<string, unknown>, run: () => Promise<unknown>) => {
      gate.calls.push(request)
      return { held: false, value: await run() }
    },
  }
})
vi.mock('@/lib/safety/loop-instructions', () => ({ skillRunLoopInstructions: async () => ['Loop: triage.'] }))
vi.mock('@/lib/work/agent-paused', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/work/agent-paused')>()),
  checkAgentPaused: async () => false,
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: vi.fn(async () => undefined), entitiesFiledByWork: vi.fn(async () => new Set()) }))
vi.mock('@/lib/work/review-actions', () => ({ REVIEW_ROUTED_TOOLS: new Set(), reviewActionIdsForWork: async () => [] }))
// The bot's real follow-through grants (follow-through.ts): settle_card, and not list_bot_work.
const grants = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/chat/follow-through', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/follow-through')>()),
  resolveFollowThrough: async (_db: unknown, args: Record<string, unknown>) => (grants.calls.push(args), new Set(['settle_card'])),
}))
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
  createTools: () => ({ list_actions: stubTool, delete_action: stubTool, settle_card: stubTool, list_bot_work: stubTool }),
}))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})
// The bot's attended chat ceiling, with its follow-through grant (settle_card).
vi.mock('@/lib/flows/skill-run-chat-ceiling', () => ({ resolveSkillRunChatCeiling: async () => new Set(['list_actions', 'delete_action', 'settle_card', 'list_bot_work']) }))

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER, type RunTokenClaims } from '@/lib/flows/skill-run-token'
import { decideAction, type CallerClass } from '@/lib/safety/caller'

const base = {
  workspaceId: 'ws-1', runAsUserId: 'user-1', skillId: 'skill-1', mode: 'act' as const, hasCapture: false,
  outputContract: 'prose' as const, model: 'claude-haiku-4-5-20251001', workItemId: 'job-1',
}
function req(toolName: string, extra: Partial<Omit<RunTokenClaims, 'exp'>> = {}) {
  return new Request('http://localhost/api/internal/skill-run/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_SKILL_SECRET_HEADER]: SECRET, [RUN_SKILL_TOKEN_HEADER]: mintRunToken({ ...base, ...extra }) },
    body: JSON.stringify({ toolName, input: { action_id: 'GEN-1' }, personMessages: ['Delete GEN-1'], personMessageSeq: 1 }),
  })
}

/** What the outward gate's hold becomes for the call the route handed it. */
function outwardOutcome(call: Record<string, unknown>): 'card' | 'refused' {
  return decideAction(call.caller as CallerClass, 'outward', String(call.toolName)) === 'ask' ? 'card' : 'refused'
}

const PRINCIPALS: Array<[string, Partial<Omit<RunTokenClaims, 'exp'>>, 'card' | 'refused']> = [
  ['an unattended loop run', {}, 'refused'],
  ['a follow-up chat turn with the person', { chat: { teammateId: 'bot-1' } }, 'card'],
  ['a turn the main agent relayed', { chat: { teammateId: 'bot-1', relay: true } }, 'refused'],
]

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  gate.calls.length = 0
  executeSpy.mockClear()
})
afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('skill-run tool route: the outward gate’s hold, per principal', () => {
  it.each(PRINCIPALS)('%s', async (_label, extra, expected) => {
    const res = await POST(req('delete_action', extra))
    expect(res.status).toBe(200)
    expect(gate.calls).toHaveLength(1)
    expect(outwardOutcome(gate.calls[0])).toBe(expected)
  })
})

describe('skill-run tool route: an attended-only tool (settle_card), per principal', () => {
  it('is out of an unattended loop run’s ceiling', async () => {
    const res = await POST(req('settle_card'))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a follow-up chat turn with the person', { chat: { teammateId: 'bot-1' } }],
    ['a relayed turn, on the bot’s follow-through grant', { chat: { teammateId: 'bot-1', relay: true as const } }],
  ] as Array<[string, Partial<Omit<RunTokenClaims, 'exp'>>]>)('runs in %s', async (_label, extra) => {
    const res = await POST(req('settle_card', extra))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('skill-run tool route: a relayed turn keeps only the attended-only tools this bot is granted', () => {
  it('an attended-only tool in the bot ceiling but not granted is refused on a relayed turn, and runs for the person', async () => {
    const relayed = await POST(req('list_bot_work', { chat: { teammateId: 'bot-1', relay: true } }))
    expect(relayed.status).toBe(403)
    expect(await relayed.json()).toMatchObject({ code: 'CALLER_NOT_ALLOWED', caller: 'agent_unattended' })
    expect(grants.calls.at(-1)).toMatchObject({ workspaceId: 'ws-1', teammateId: 'bot-1' })
    const person = await POST(req('list_bot_work', { chat: { teammateId: 'bot-1' } }))
    expect(person.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })
})
