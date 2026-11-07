/**
 * The chat tool route, principal by principal (trust layer P2): what each
 * verified chat-run token may do today, pinned so the move onto the one trust
 * authority (src/lib/safety/caller.ts) changes nothing.
 *
 * For every kind of chat-run token:
 *   - what the outward gate's hold becomes (the person's card, or a
 *     NEEDS_PERSON refusal), read off what the route hands gateRiskyCall;
 *   - whether an attended-only tool (settle_card) runs, or is refused and by
 *     which check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-caller-pin'
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
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn(async () => ({ ok: true, approvalId: 'a', cardId: 'c' })) }))
/** A class no token maps to today (another person, unknown), forced for the route's own fence. */
const forced = vi.hoisted(() => ({ cls: null as string | null }))
vi.mock('@/lib/safety/caller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safety/caller')>()
  return { ...actual, callerClassOf: (p: Parameters<typeof actual.callerClassOf>[0]) => (forced.cls ?? actual.callerClassOf(p)) as ReturnType<typeof actual.callerClassOf> }
})
vi.mock('@/lib/chat/surface-run-guard', () => ({ chatRunBindingRefusal: async () => null }))
vi.mock('@/lib/chat/chat-ceiling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/chat-ceiling')>()
  return {
    ...actual,
    // A bot granted settle_card (a follow-through grant), as the Captures bot is.
    resolveTeammateChatBounds: async () => ({}),
    resolveTeammateChatCeiling: async () => new Set(['list_actions', 'delete_action', 'settle_card', 'list_bot_work']),
  }
})
// The bot's real follow-through grants (follow-through.ts): settle_card, and not list_bot_work.
const grants = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/chat/follow-through', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/follow-through')>()),
  resolveFollowThrough: async (_db: unknown, args: Record<string, unknown>) => (grants.calls.push(args), new Set(['settle_card'])),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) c[m] = () => c
      c.maybeSingle = async () => ({ data: table === 'workspace' ? { settings: null } : { agent_config: null }, error: null })
      return c
    }
    return { from: (table: string) => chain(table) }
  },
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: vi.fn(async () => undefined) }))
const executeSpy = vi.fn(async () => ({ ok: true }))
const stubTool = { description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: executeSpy }
vi.mock('@/lib/ai/tools', () => ({
  createTools: () => ({ list_actions: stubTool, delete_action: stubTool, settle_card: stubTool, list_bot_work: stubTool }),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }),
}))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, type ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { resetRepeatBreaker } from '@/lib/chat/tool-repeat-breaker'
import { resetTurnTools } from '@/lib/safety/turn-tools'
import { decideAction, type CallerClass } from '@/lib/safety/caller'

type Extra = Partial<Omit<ChatRunTokenClaims, 'exp' | 'conversationId' | 'workspaceId' | 'userId'>>

function req(toolName: string, extra: Extra) {
  const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', ...extra })
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input: { action_id: 'GEN-1' }, turnId: 'turn-1', sessionId: 'sess-1', personMessages: ['hi'] }),
  })
}

/** What the outward gate's hold becomes for the call the route handed it: a card, or a refusal. */
function outwardOutcome(call: Record<string, unknown>): 'card' | 'refused' {
  return decideAction(call.caller as CallerClass, 'outward', String(call.toolName)) === 'ask' ? 'card' : 'refused'
}

const PRINCIPALS: Array<[string, Extra, 'card' | 'refused']> = [
  ['the in-app chat (the person)', {}, 'card'],
  ['a teammate chat with the person', { teammateId: 'bot-1' }, 'card'],
  ['a bot conversation in the main chat', { teammateId: 'bot-1', teammateIn: 'chat' }, 'card'],
  ['a relayed turn in a bot thread (the main agent’s words)', { teammateId: 'bot-1', relay: 'relay-1' }, 'refused'],
  ['the device ask (the person, away from the app)', { surface: 'device_ask' }, 'card'],
  ['a home turn the server started', { server: 'home_turn' }, 'refused'],
  ['idle compaction', { server: 'idle_compaction' }, 'refused'],
]

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  gate.calls.length = 0
  forced.cls = null
  executeSpy.mockClear()
  resetRepeatBreaker()
  resetTurnTools()
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('chat tool route: the outward gate’s hold, per principal', () => {
  it.each(PRINCIPALS)('%s', async (_label, extra, expected) => {
    const res = await POST(req('list_actions', extra))
    expect(res.status).toBe(200)
    expect(gate.calls).toHaveLength(1)
    expect(outwardOutcome(gate.calls[0])).toBe(expected)
  })
})

describe('chat tool route: an attended-only tool (settle_card), per principal', () => {
  it('runs for the person in the in-app chat', async () => {
    const res = await POST(req('settle_card', {}))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a teammate chat with the person', { teammateId: 'bot-1' }],
    ['a relayed turn, on the bot’s follow-through grant', { teammateId: 'bot-1', relay: 'relay-1' }],
  ] as Array<[string, Extra]>)('runs in %s', async (_label, extra) => {
    const res = await POST(req('settle_card', extra))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('is out of the device ask’s ceiling', async () => {
    const res = await POST(req('settle_card', { surface: 'device_ask' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('is refused on a server turn (read-only)', async () => {
    const res = await POST(req('settle_card', { server: 'home_turn' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('SERVER_TURN_READ_ONLY')
    expect(executeSpy).not.toHaveBeenCalled()
  })
})

describe('chat tool route: past the ceiling, the trust authority refuses what the caller\u2019s class may not do', () => {
  it('another person (a class no token has today) may read but never write', async () => {
    forced.cls = 'other_person'
    const read = await POST(req('list_actions', {}))
    expect(read.status).toBe(200)
    const write = await POST(req('delete_action', {}))
    expect(write.status).toBe(403)
    expect(await write.json()).toMatchObject({ code: 'CALLER_NOT_ALLOWED', caller: 'other_person' })
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('an unknown caller gets no tool at all', async () => {
    forced.cls = 'unknown'
    const res = await POST(req('list_actions', {}))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CALLER_NOT_ALLOWED')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('an unattended caller without a grant never runs an attended-only tool, even when a ceiling drifts to hold one', async () => {
    forced.cls = 'agent_unattended'
    const res = await POST(req('settle_card', {}))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CALLER_NOT_ALLOWED')
    expect(executeSpy).not.toHaveBeenCalled()
  })
})

describe('chat tool route: a relayed turn keeps only the attended-only tools this bot is granted', () => {
  it('an attended-only tool in the ceiling but not granted to the bot is refused on a relayed turn, and runs for the person', async () => {
    const relayed = await POST(req('list_bot_work', { teammateId: 'bot-1', relay: 'relay-1' }))
    expect(relayed.status).toBe(403)
    expect(await relayed.json()).toMatchObject({ code: 'CALLER_NOT_ALLOWED', caller: 'agent_unattended' })
    expect(executeSpy).not.toHaveBeenCalled()
    expect(grants.calls.at(-1)).toMatchObject({ workspaceId: 'ws-1', teammateId: 'bot-1' })
    const person = await POST(req('list_bot_work', { teammateId: 'bot-1' }))
    expect(person.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })
})
