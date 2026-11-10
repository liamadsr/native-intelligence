/**
 * The chat tool route with the REAL reviewer (L5). Only Jev (runDecision) and
 * the approval writer are stubbed. Under ACTION_REVIEW_MODE=blocking:
 *   - allow: the call runs;
 *   - deny: nothing runs, the model reads APPROVAL_REQUIRED and the person's
 *     card says why;
 *   - Jev unavailable: attended, the call fails closed to the person's card;
 *   - a home turn (the agent on its own) reaches the gate: what leaves Native Intelligence
 *     is the person's card first, and the reviewer decides the rest;
 *   - a chat-native tool is refused NEEDS_PERSON, never carded;
 *   - the kill switch (ACTION_REVIEW_MODE=shadow) runs the call as before.
 * Under the default (unset), the person's own typed turn is shadow: a call the
 * reviewer would hold runs, as before L5. The default blocks the Mac body
 * alone (src/lib/chat/__tests__/chat-gate-review-modes.test.ts and
 * src/lib/safety/__tests__/action-review.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/chat/surface-run-guard.ts) has its own
// tests; this file's fake database holds no conversation / member rows.
vi.mock('@/lib/chat/surface-run-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/surface-run-guard')>()),
  chatRunBindingRefusal: async () => null,
}))

const SECRET = 'test-chat-internal-secret-abcdefghij'
const jev = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: jev.decide }))
const approvals = vi.hoisted(() => ({ create: vi.fn(async (..._a: unknown[]) => ({ ok: true, approvalId: 'appr-9', cardId: 'card-9' })) }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: approvals.create }))
const native = vi.hoisted(() => ({ start: vi.fn(async () => ({ status: 'started', run_id: 'run-1', reused: false })) }))
vi.mock('@/lib/chat/start-helper', () => ({ startChatHelper: native.start, stopChatHelper: vi.fn(), shadowHelperChoice: vi.fn() }))
vi.mock('@/lib/bots/bot-relay', () => ({ sendBotMessage: vi.fn(), waitForBotReply: vi.fn() }))
const links = vi.hoisted(() => ({ ask: vi.fn(async (..._a: unknown[]) => ({ success: true, peer_name: 'Sarah' })) }))
vi.mock('@/lib/agent-links/exchange', () => ({ askAgent: links.ask }))
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
vi.mock('@/lib/ai/tools', () => ({ createTools: () => ({ list_actions: stubTool, delete_action: stubTool, push_action_to_jira: stubTool }) }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }) }))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'
import { resetRepeatBreaker } from '@/lib/chat/tool-repeat-breaker'
import { resetTurnTools } from '@/lib/safety/turn-tools'

const allow = { status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } }
const deny = { status: 'accepted', inferenceId: 'inf-b', value: { allow: false, probability: 0.1 } }

function req(toolName: string, extra: Record<string, unknown> = {}, input: unknown = { action_id: 'GEN-12' }, claims: Record<string, unknown> = {}) {
  const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', ...claims })
  return new Request('http://localhost/api/internal/chat/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input, turnId: 'turn-1', sessionId: 'sess-1', callId: 'call-1', ...extra }),
  })
}
const output = async (res: Response) => ((await res.json()) as { output: Record<string, unknown> }).output

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  jev.decide.mockReset().mockResolvedValue(allow)
  approvals.create.mockClear()
  executeSpy.mockClear()
  native.start.mockClear()
  resetRepeatBreaker()
  resetTurnTools()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
  vi.unstubAllEnvs()
})

describe('chat tool route, ACTION_REVIEW_MODE=blocking', () => {
  beforeEach(() => {
    vi.stubEnv('ACTION_REVIEW_MODE', 'blocking')
  })

  it('allow: the person asked, the call runs', async () => {
    const res = await POST(req('delete_action', { personMessages: ['Delete GEN-12'], personMessageSeq: 3 }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(jev.decide.mock.calls[0][2]).toMatchObject({ mode: 'enforce' })
  })

  it('deny: nothing runs; the model reads APPROVAL_REQUIRED and the person gets a card that says why', async () => {
    jev.decide.mockResolvedValue(deny)
    const res = await POST(req('delete_action', { personMessages: ['What is GEN-12 about?'], personMessageSeq: 3 }))
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await output(res)).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-9', message: expect.stringContaining('right under your message') })
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      door: 'chat', toolName: 'delete_action', conversationId: 'conv-1', reason: 'not_asked', decisionId: 'inf-b',
      card: expect.objectContaining({ why: expect.stringContaining("you didn't ask for that in this conversation") }),
    }))
  })

  it('Jev unavailable, the person here: fails closed to their card, which says the check could not run', async () => {
    jev.decide.mockRejectedValue(new Error('gateway down'))
    const res = await POST(req('delete_action', { personMessages: ['Delete GEN-12'], personMessageSeq: 3 }))
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await output(res)).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reason: 'unavailable', card: expect.objectContaining({ why: expect.stringContaining("safety check couldn't run just now") }),
    }))
  })

  it('a home turn acts on its own (Liam, 2026-10-26): no read-only refusal; under blocking the reviewer still decides, and with no words to check a delete is the person\'s card', async () => {
    const res = await POST(req('delete_action', {}, { action_id: 'GEN-12' }, { server: 'home_turn', homeTurnReason: 'event' }))
    expect(res.status).toBe(200)
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await output(res)).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toolName: 'delete_action', reason: 'no_request' }))
  })

  it('a home turn\'s call that leaves Native Intelligence is the person\'s card in their home thread, never a refusal, and they are pinged', async () => {
    const res = await POST(req('push_action_to_jira', {}, { action_id: 'GEN-12' }, { server: 'home_turn', homeTurnReason: 'helper_report' }))
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await output(res)).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toolName: 'push_action_to_jira', reason: 'home_turn', reachPerson: true }))
  })

  it.each(['guest_ask', 'digest'])('a %s home turn stays read-only: a delete is refused before any review, never run or carded', async (reason) => {
    const res = await POST(req('delete_action', {}, { action_id: 'GEN-12' }, { server: 'home_turn', homeTurnReason: reason }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('SERVER_TURN_READ_ONLY')
    expect(executeSpy).not.toHaveBeenCalled()
    expect(approvals.create).not.toHaveBeenCalled()
  })

  it('a Slack DM\'s helper start goes through the reviewer like the app\'s: a block refuses it NEEDS_PERSON', async () => {
    jev.decide.mockResolvedValue(deny)
    const res = await POST(req('start_helper', { personMessages: ['hi'], personMessageSeq: 1 }, { task: 'Draft the weekly update' }, { server: 'channel_turn', surface: 'slack' }))
    expect(native.start).not.toHaveBeenCalled()
    expect(await output(res)).toMatchObject({ code: 'NEEDS_PERSON', approval_id: null })
  })

  it('a text starts a helper without the hold every risky call from a text gets: fenced in startChatHelper (the generic helper only)', async () => {
    jev.decide.mockResolvedValue(deny)
    const res = await POST(req('start_helper', { personMessages: ['research Acme'], personMessageSeq: 1 }, { task: 'Research Acme' }, { server: 'channel_turn', surface: 'sms' }))
    expect(res.status).toBe(200)
    expect(native.start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ server: 'channel_turn', surface: 'sms' }), expect.anything(), { task: 'Research Acme' })
    expect(approvals.create).not.toHaveBeenCalled()
    expect(jev.decide).not.toHaveBeenCalled()
  })

  it('a chat-native tool is refused NEEDS_PERSON, never carded', async () => {
    jev.decide.mockResolvedValue(deny)
    const res = await POST(req('start_helper', { personMessages: ['hi'], personMessageSeq: 1 }, { task: 'Draft the weekly update' }))
    expect(native.start).not.toHaveBeenCalled()
    expect(await output(res)).toMatchObject({ code: 'NEEDS_PERSON', approval_id: null })
    expect(approvals.create).not.toHaveBeenCalled()
  })

  it('a read is never reviewed', async () => {
    jev.decide.mockResolvedValue(deny)
    await POST(req('list_actions', {}, {}))
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(jev.decide).not.toHaveBeenCalled()
  })
})

describe('chat tool route, the default (unset)', () => {
  it('a typed turn’s call the reviewer would hold runs, with no card (the person’s own turns are shadow)', async () => {
    jev.decide.mockResolvedValue(deny)
    const res = await POST(req('delete_action', { personMessages: ['What is GEN-12 about?'], personMessageSeq: 3 }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(approvals.create).not.toHaveBeenCalled()
  })
})

describe('chat tool route, the kill switch (ACTION_REVIEW_MODE=shadow)', () => {
  it('a call the reviewer would hold runs, as before L5', async () => {
    vi.stubEnv('ACTION_REVIEW_MODE', 'shadow')
    jev.decide.mockResolvedValue(deny)
    const res = await POST(req('delete_action', { personMessages: ['What is GEN-12 about?'], personMessageSeq: 3 }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(approvals.create).not.toHaveBeenCalled()
  })
})

describe('a message to another person\'s agent waits for the person\'s yes, and the model is told where', () => {
  it.each([
    ['the app', {}, 'right under your message', false],
    ['a text', { server: 'channel_turn', surface: 'sms' }, 'a text with a code', false],
    ['a Slack DM', { server: 'channel_turn', surface: 'slack' }, 'Approve and Decline buttons', false],
    ['a background update', { server: 'home_turn', homeTurnReason: 'agent_answer' }, 'card in their home thread', true],
  ] as const)('from %s: checked, then held as the person\'s card (never sent here)', async (_label, claims, where, home) => {
    const res = await POST(req('ask_agent', { personMessages: ['Ask Sarah when she is free'], personMessageSeq: 2 }, { to: 'Sarah', message: 'When are you free Thursday?' }, claims))
    expect(links.ask).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ check: true }), expect.objectContaining({ to: 'Sarah' }))
    const out = await output(res)
    expect(out).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-9', message: expect.stringContaining(where) })
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toolName: 'ask_agent', reason: 'agent_message' }))
    expect(approvals.create.mock.calls.at(-1)?.[1]).toEqual(home ? expect.objectContaining({ reachPerson: true }) : expect.not.objectContaining({ reachPerson: true }))
  })
})
