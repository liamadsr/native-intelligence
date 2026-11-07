/**
 * The shared chat gate (chat-tool-dispatch.ts chatGate, which the chat tool
 * route and the Mac body's tool route both call) with the REAL reviewer, under
 * ACTION_REVIEW_MODE's default (L5): everything that runs today stays shadow,
 * the Mac body is enforced. Only Jev and the approval writer are stubbed.
 *   - a typed main-chat turn, a relayed turn: the call runs, no card;
 *   - a call from the Dial8 agent on the Mac (mustEnforce, its job named):
 *     held, its card at home;
 *   - blocking: the typed turn is held too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jev = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: jev.decide }))
const approvals = vi.hoisted(() => ({ create: vi.fn(async (..._a: unknown[]) => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })) }))
vi.mock('@/lib/safety/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/approvals')>()), createToolApproval: approvals.create }))

import { chatGate, type ToolDispatchContext } from '@/lib/chat/chat-tool-dispatch'

const deny = { status: 'accepted', inferenceId: 'inf-b', value: { allow: false, probability: 0.1 } }
const ctx = (over: Partial<ToolDispatchContext> = {}): ToolDispatchContext => ({
  supabase: {} as never,
  userId: 'user-1',
  workspaceId: 'ws-1',
  conversationId: 'conv-1',
  caller: 'person',
  approvalContext: {},
  keyScope: 'user-1',
  ...over,
})
const scope = { sessionId: 'sess-1', turnId: 'turn-1', personMessages: ['What is GEN-12 about?'], personMessageSeq: 2 }

beforeEach(() => {
  jev.decide.mockReset().mockResolvedValue(deny)
  approvals.create.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the default mode at the shared chat gate', () => {
  it('a typed main-chat turn and a relayed turn stay shadow: the call runs, no card', async () => {
    for (const caller of ['person', 'agent_unattended'] as const) {
      const run = vi.fn(async () => 'ran')
      expect(await chatGate(ctx({ caller }), 'delete_action', { action_id: 'GEN-12' }, scope, run), caller).toEqual({ held: false, value: 'ran' })
      expect(run).toHaveBeenCalledTimes(1)
    }
    expect(approvals.create).not.toHaveBeenCalled()
  })

  it('a call from the Dial8 agent on the Mac is held, its card at home naming the Mac', async () => {
    const run = vi.fn(async () => 'ran')
    const mac = ctx({
      caller: 'person_remote',
      cardConversationId: null,
      keyScope: 'mac:sess-9',
      approvalContext: { localAgent: { sessionId: 'sess-9', deviceName: 'Liam’s MacBook', folderLabel: 'dial8-website' } },
      reviewOverride: { mustEnforce: true },
    })
    const gated = await chatGate(mac, 'delete_action', { action_id: 'GEN-12' }, scope, run)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(approvals.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      conversationId: null,
      card: expect.objectContaining({ title: 'Approve delete_action from Dial8 on Liam’s MacBook?' }),
    }))
  })

  it('a Mac context with no mustEnforce is still held: its job named in the approval is enough (S6)', async () => {
    const run = vi.fn(async () => 'ran')
    const gated = await chatGate(ctx({ caller: 'person_remote', cardConversationId: null, approvalContext: { localAgent: { sessionId: 'sess-9' } } }), 'delete_action', { action_id: 'GEN-12' }, scope, run)
    expect(gated).toMatchObject({ held: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('blocking: the typed turn is held too', async () => {
    vi.stubEnv('ACTION_REVIEW_MODE', 'blocking')
    const run = vi.fn(async () => 'ran')
    expect(await chatGate(ctx(), 'delete_action', { action_id: 'GEN-12' }, scope, run)).toMatchObject({ held: true })
    expect(run).not.toHaveBeenCalled()
  })
})
