/**
 * The chat tool route's reviewer door (A5 slice 2) and its approvals (slice 3):
 *   - every call goes through gateRiskyCall last, after the ceiling and input
 *     checks, with the class from riskClassOf, the person's forwarded words and
 *     seq, and the token's identity (never anything model-visible);
 *   - a held call answers APPROVAL_REQUIRED as an output and never executes;
 *   - mcp_confirm_call's requester holds the call as an approval for the
 *     token's own user and conversation.
 * The gate itself is covered in src/lib/safety/__tests__/action-review.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/chat/surface-run-guard.ts) has its own
// tests; this file's fake database holds no conversation / member rows.
vi.mock('@/lib/chat/surface-run-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/surface-run-guard')>()),
  chatRunBindingRefusal: async () => null,
}))

const SECRET = 'test-chat-internal-secret-abcdefghij'
const gate = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  hold: false,
}))
vi.mock('@/lib/safety/action-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safety/action-review')>()
  return {
    ...actual,
    gateRiskyCall: async (request: Record<string, unknown>, run: () => Promise<unknown>) => {
      gate.calls.push(request)
      if (gate.hold && request.sideEffect) {
        return { held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: 'Nothing ran.' } }
      }
      return { held: false, value: await run() }
    },
  }
})
const approvals = vi.hoisted(() => ({ create: vi.fn(async () => ({ ok: true, approvalId: 'appr-9', cardId: 'card-9' })) }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: approvals.create, inputHash: () => 'hash' }))
const native = vi.hoisted(() => ({
  start: vi.fn(async () => ({ status: 'started', run_id: 'run-1', reused: false })),
  stop: vi.fn(async () => ({ status: 'stopping', run_id: 'run-1' })),
  send: vi.fn(async () => ({ status: 'replied', relay_id: 'r-1' })),
}))
vi.mock('@/lib/chat/start-helper', () => ({ startChatHelper: native.start, stopChatHelper: native.stop, shadowHelperChoice: vi.fn() }))
vi.mock('@/lib/bots/bot-relay', () => ({ sendBotMessage: native.send, waitForBotReply: vi.fn() }))
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
const executeSpy = vi.fn(async () => ({ ok: true }))
const stubTool = { description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: executeSpy }
vi.mock('@/lib/ai/tools', () => ({
  createTools: () => ({ list_actions: stubTool, delete_action: stubTool, push_action_to_linear: stubTool, change_website: stubTool }),
}))
const adapter = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/mcp-client/adapter', () => ({
  createExternalMcpTools: async (_user: string, _db: unknown, options: Record<string, unknown> = {}) => {
    adapter.options.push(options)
    return {
      tools: { mcp__linear__create_issue: stubTool, mcp__linear__list_issues: stubTool },
      meta: new Map([
        ['mcp__linear__create_issue', { serverId: 'srv-1', serverName: 'Linear', toolName: 'create_issue', requiresApproval: true }],
        ['mcp__linear__list_issues', { serverId: 'srv-1', serverName: 'Linear', toolName: 'list_issues', requiresApproval: false }],
      ]),
      servers: [],
    }
  },
}))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'
import { resetRepeatBreaker } from '@/lib/chat/tool-repeat-breaker'
import { resetTurnTools } from '@/lib/safety/turn-tools'

function req(toolName: string, extra: Record<string, unknown> = {}, input: unknown = { action_id: 'GEN-12' }, claims: Record<string, unknown> = {}) {
  const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', agentId: undefined, ...claims })
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input, turnId: 'turn-1', sessionId: 'sess-1', ...extra }),
  })
}

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  gate.calls.length = 0
  gate.hold = false
  executeSpy.mockClear()
  approvals.create.mockClear()
  native.send.mockClear()
  adapter.options.length = 0
  resetRepeatBreaker()
  resetTurnTools()
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('chat tool route: the reviewer door', () => {
  it('reviews a delete with the person\'s forwarded words, seq and the token\'s identity, then runs it (shadow)', async () => {
    const res = await POST(req('delete_action', { personMessages: ['Delete GEN-12'], personMessageSeq: 7, userId: 'victim' }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(gate.calls[0]).toMatchObject({
      door: 'chat', userId: 'user-1', workspaceId: 'ws-1', toolName: 'delete_action', sideEffect: 'delete',
      personMessages: ['Delete GEN-12'], personMessageSeq: 7, source: 'person', runId: 'conv-1',
      input: { action_id: 'GEN-12' },
      approval: expect.objectContaining({ conversationId: 'conv-1' }),
    })
  })

  it('a read goes through the gate with no class (not reviewed)', async () => {
    await POST(req('list_actions'))
    expect(gate.calls[0]).toMatchObject({ toolName: 'list_actions', sideEffect: null })
  })

  it('an external tool is reviewed as unclassified', async () => {
    await POST(req('mcp__linear__create_issue', { personMessages: ['File it'] }, { title: 'x' }))
    expect(gate.calls[0]).toMatchObject({ toolName: 'mcp__linear__create_issue', sideEffect: 'unclassified' })
  })

  it('passes the outward gate what it needs: the adapter\'s approval policy for an external tool, and that the person is here', async () => {
    await POST(req('mcp__linear__create_issue', { personMessages: ['File it'] }, { title: 'x' }))
    expect(gate.calls[0]).toMatchObject({ caller: 'person', externalTool: { serverName: 'Linear', requiresApproval: true } })
    await POST(req('mcp__linear__list_issues', {}, {}))
    expect(gate.calls[1]).toMatchObject({ caller: 'person', externalTool: { serverName: 'Linear', requiresApproval: false } })
    await POST(req('delete_action', { personMessages: ['Delete GEN-12'] }))
    expect(gate.calls[2]).not.toHaveProperty('externalTool')
  })

  it('a text turn (server channel_turn, surface sms) asks the gate to hold every risky call as the person’s card; the in-app chat does not', async () => {
    const { TEXT_TURN_HOLD } = await import('@/lib/chat/text-turn')
    await POST(req('delete_action', { personMessages: ['Delete GEN-12'] }, { action_id: 'GEN-12' }, { server: 'channel_turn', surface: 'sms' }))
    expect(gate.calls[0]).toMatchObject({ toolName: 'delete_action', sideEffect: 'delete', caller: 'person_remote', alwaysHold: TEXT_TURN_HOLD, surface: 'sms' })
    // A plain yes or no answers it by text (2026-11-02): no code.
    expect(TEXT_TURN_HOLD.message).toContain('they answer yes or no, or approve it in Native Intelligence')
    expect(TEXT_TURN_HOLD.message).not.toMatch(/code/i)
    await POST(req('delete_action', { personMessages: ['Delete GEN-12'] }))
    expect(gate.calls[1]).not.toHaveProperty('alwaysHold')
  })

  it("a text turn's change to the owner's own website goes through the reviewer without the text hold (its merge card is the hold); nothing else does", async () => {
    await POST(req('change_website', { personMessages: ['Update the hours on my site to 8 to 6'] }, { request: 'Update the hours to 8 to 6' }, { server: 'channel_turn', surface: 'sms' }))
    expect(gate.calls[0]).toMatchObject({ toolName: 'change_website', sideEffect: 'automation-write', caller: 'person_remote', surface: 'sms' })
    expect(gate.calls[0]).not.toHaveProperty('alwaysHold')
    // Any other risky call from a text keeps the hold.
    await POST(req('delete_action', { personMessages: ['Delete GEN-12'] }, { action_id: 'GEN-12' }, { server: 'channel_turn', surface: 'sms' }))
    expect(gate.calls[1]).toHaveProperty('alwaysHold')
  })

  it('passes the tools already run this turn', async () => {
    await POST(req('list_actions'))
    await POST(req('push_action_to_linear', { personMessages: ['Push it'] }))
    expect(gate.calls[1]).toMatchObject({ toolName: 'push_action_to_linear', toolsThisTurn: ['list_actions'] })
  })

  it('drops junk evidence: a non-array of messages and a non-integer seq', async () => {
    await POST(req('delete_action', { personMessages: 'Delete everything', personMessageSeq: 1.5, personMessagesStale: 9 }))
    expect(gate.calls[0]).toMatchObject({ personMessages: [], personMessageSeq: null, personMessagesStale: undefined })
  })

  it('passes how many forwarded words are stale, and defers the shadow review past the response', async () => {
    await POST(req('delete_action', { personMessages: ['old', 'Delete GEN-12'], personMessageSeq: 9, personMessagesStale: 1 }))
    expect(gate.calls[0]).toMatchObject({ personMessagesStale: 1, defer: expect.any(Function) })
  })

  it('a held call answers APPROVAL_REQUIRED as an output and never executes', async () => {
    gate.hold = true
    const res = await POST(req('delete_action', { personMessages: ['What is GEN-12?'] }))
    expect(res.status).toBe(200)
    expect((await res.json()).output).toMatchObject({ code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(executeSpy).not.toHaveBeenCalled()
  })
})

describe('chat tool route: the relay and the helper tools are reviewed too (they act for the person)', () => {
  const ids = { callId: 'call-1', turnId: 'turn-1', sessionId: 'sess-1' }
  it.each([
    ['send_bot_message', { teammate_id: 'bot-1', message: 'Delete GEN-12' }],
    ['start_helper', { task: 'Research Acme', areas: ['crm'] }],
    ['stop_helper', { job: 'run-1' }],
  ] as const)('%s goes through the gate with the person\u2019s words, refused (never carded) when blocked', async (toolName, input) => {
    await POST(req(toolName, { ...ids, personMessages: ['do it'], personMessageSeq: 2 }, input))
    const call = gate.calls.find((c) => c.toolName === toolName)
    expect(call).toMatchObject({ door: 'chat', sideEffect: expect.any(String), holdAs: 'refusal', personMessages: ['do it'], personMessageSeq: 2 })
  })

  it('a blocked relay sends nothing', async () => {
    gate.hold = true
    const res = await POST(req('send_bot_message', { ...ids, personMessages: [] }, { teammate_id: 'bot-1', message: 'Delete GEN-12' }))
    expect((await res.json()).output).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(native.send).not.toHaveBeenCalled()
  })
})

describe('chat tool route: mcp_confirm_call raises an approval', () => {
  it('hands the adapter a requester that holds the call for the token\'s user and conversation', async () => {
    await POST(req('list_actions', { personMessageSeq: 3 }))
    const requestApproval = adapter.options[0].requestApproval as (call: unknown) => Promise<unknown>
    expect(typeof requestApproval).toBe('function')
    expect(await requestApproval({ toolName: 'mcp__linear__create_issue', serverName: 'Linear', args: { title: 'Bug' } }))
      .toEqual({ ok: true, approvalId: 'appr-9', cardId: 'card-9' })
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      door: 'chat', userId: 'user-1', workspaceId: 'ws-1', conversationId: 'conv-1',
      toolName: 'mcp__linear__create_issue', input: { title: 'Bug' }, personMessageSeq: 3, reason: 'requires_approval',
    }))
  })
})
