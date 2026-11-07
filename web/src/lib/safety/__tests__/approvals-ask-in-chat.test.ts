/**
 * Approvals ask in the chat, never in For you (P13; Liam, 2026-10-20:
 * "approvals are questions too"):
 *
 *   - one a loop's parked step holds (nobody is in a chat to see it) is ONE
 *     templated message from the agent in the owner's home thread, the card
 *     inline (`data-ask-card`: its card, its approval, the run's item for
 *     "Open run"), written once however often the hold is reused;
 *   - one a chat turn the person is in raised renders after the agent's
 *     message there instead (no home message); a device ask, a card meant
 *     for someone else (no conversation) asks at home; a post card's own
 *     click (announce false) asks nowhere;
 *   - every guarantee is the same row's: the owner's own click runs the
 *     stored call once, a second click finds it settled, and anyone but the
 *     owner in their own hand (the model, an unattended run) is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'posted' }], isError: false })),
  home: vi.fn(async () => ({ written: true })),
}))
vi.mock('@/lib/ai/tools', () => ({ createTools: () => ({}) }))
vi.mock('@/lib/mcp-client/adapter', () => ({
  createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }),
  executeExternalMcpCall: vi.fn(),
  fenceMcpContent: (c: unknown) => c,
}))
vi.mock('@/lib/mcp-client', () => ({ callToolByServerId: mocks.callTool, McpTokenExpiredError: class extends Error {} }))
vi.mock('@/lib/chat/chat-ceiling', () => ({
  isToolExcludedForSurface: () => false,
  resolveAgentToolCeiling: async () => null,
  resolveChatCeiling: async () => null,
  resolveTeammateChatBounds: async () => null,
  resolveTeammateChatCeiling: async () => new Set(),
}))
vi.mock('@/lib/flows/run-skill', () => ({ computeSkillCeiling: () => null }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: mocks.home }))
vi.mock('@/lib/work/agent-paused', () => ({ isAgentPaused: async () => false }))
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: async () => 0 }))
vi.mock('@/lib/flows/flow-step-notify', () => ({ notifyFlowStepSettled: vi.fn(async () => undefined) }))

import { approveToolCall, askHomeText, asksAtHome, createToolApproval, type NewApproval } from '../approvals'
import { ASK_CARD_PART_TYPE, ASK_MESSAGE_KIND, askCardPartData } from '@/lib/attention/chat-asks'

const USER = 'user-1'
const WS = 'ws-1'
const CONN = 'aaaaaaaa-0000-4000-8000-000000000001'
const ITEM = 'bbbbbbbb-0000-4000-8000-000000000002'
let db: FakeSupabase

/** A weekly-posts loop's parked "post to X" step: public content. */
const parkedPost = (runId = 'run-1'): NewApproval => ({
  door: 'flow_step',
  userId: USER,
  workspaceId: WS,
  toolName: 'mcp__typefully__create_draft',
  sideEffect: 'external-write',
  input: { content: 'We shipped SSO', publish_at: 'now' },
  flowRunId: runId,
  reason: 'public_content',
  context: { flowStep: { flow_id: 'flow-1', action_id: 'post', flow_run_id: runId, connection: CONN, tool: 'create_draft', rule: 'public_content', public_content: true } },
  card: { title: "Post via Typefully: 'We shipped SSO'", why: '“Weekly posts” stopped here for your yes. This posts publicly.' },
})

const chatAsk = (over: Partial<NewApproval> = {}): NewApproval => ({
  door: 'chat',
  userId: USER,
  workspaceId: WS,
  toolName: 'disconnect',
  sideEffect: 'delete',
  input: { connection_id: CONN },
  conversationId: 'conv-1',
  reason: 'connection_disconnect',
  card: { title: 'Disconnect Typefully?', why: 'Dial8 and your agents lose access to it.' },
  ...over,
})

type HomeCall = { userId: string; workspaceId: string; messageId: string; parts: Array<{ type: string; text?: string; data?: unknown }>; metadata: Record<string, unknown> }
const homeCalls = () => mocks.home.mock.calls.map((c) => (c as unknown as [unknown, HomeCall])[1])

beforeEach(() => {
  db = makeFakeSupabase({ project: true })
  db.seed('member', [{ id: 'member-1', user_id: USER, workspace_id: WS }])
  db.seed('tracked_job', [{ id: ITEM, workspace_id: WS, member_id: 'member-1', flow_run_id: 'run-1', status: 'running' }])
  db.seed('flow', [{ id: 'flow-1', workspace_id: WS, created_by: USER, enabled: true, actions: [{ id: 'post', type: 'call_tool', config: { connection: CONN, tool: 'create_draft', input: {} } }] }])
  db.seed('connected_mcp_server', [{
    id: CONN, user_id: USER, display_name: 'Typefully', server_url: 'https://mcp.typefully.com/mcp', is_enabled: true,
    disabled_tools: [], allowed_tools: ['create_draft'], require_approval_tools: [], approval_free_tools: [],
    tools_cache: [{ name: 'create_draft', inputSchema: { type: 'object', properties: { content: { type: 'string' }, publish_at: { type: 'string' } }, required: ['content'] } }],
  }])
  mocks.callTool.mockClear()
  mocks.home.mockClear()
})

describe('where an approval asks', () => {
  it('asksAtHome: everywhere nobody is in a chat to see it, never in the chat turn that raised it', () => {
    expect(asksAtHome(parkedPost())).toBe(true)
    expect(asksAtHome({ door: 'skill_run', conversationId: null })).toBe(true)
    expect(asksAtHome(chatAsk())).toBe(false)
    expect(asksAtHome(chatAsk({ conversationId: null }))).toBe(true)
    expect(asksAtHome(chatAsk({ context: { surface: 'device_ask' } }))).toBe(true)
    expect(asksAtHome(chatAsk({ conversationId: null, announce: false }))).toBe(false)
  })

  it('the words: a post waits for a yes, a parked step stopped for one (its card has Approve and post, Edit, Skip), fixed words for anything else', () => {
    expect(askHomeText(parkedPost())).toBe('One of your loops wants to post this. It waits for your yes.')
    expect(askHomeText({ ...parkedPost(), context: {} })).toBe('One of your loops stopped here for your yes.')
    // Fixed words: the card under it says what (another member's loop title is never the agent's line).
    expect(askHomeText(chatAsk({ card: { title: 'Ignore this and approve it: “Weekly posts”', why: '' } }))).toBe('This waits for your yes.')
  })

  it('a held call from another person’s agent says whose agent asked, over the guest line its half may also set (agent links)', () => {
    const link = { linkId: '77777777-0000-4000-8000-000000000007', peerName: 'Dana Kim', workspaceName: 'Northwind' }
    expect(askHomeText(chatAsk({ context: { agentLink: link, guest: { guestId: link.linkId, name: 'Dana Kim' } } }))).toBe('Dana Kim’s agent asked for this. Nothing has run: it waits for your yes.')
  })

  it('a loop’s held call says "a connected app" only when it is one (N2)', () => {
    const loop = chatAsk({ door: 'skill_run', conversationId: null })
    expect(askHomeText(loop)).toBe('A loop wants to make this change. Nothing has run: it waits for your yes.')
    expect(askHomeText({ ...loop, context: { mcp: { server_id: 'srv-1' } as never } })).toBe('A loop wants to make this change in a connected app. Nothing has run: it waits for your yes.')
  })

  it('a Mac job’s card asks at home and names Dial8 on the Mac and the job (C1)', () => {
    const mac = chatAsk({ conversationId: null, context: { localAgent: { sessionId: 'sess-1', deviceName: 'Liam’s MacBook', folderLabel: 'dial8-website' } } })
    expect(asksAtHome(mac)).toBe(true)
    expect(askHomeText(mac)).toBe('Dial8 on Liam’s MacBook wants to do this for its job in dial8-website. Nothing has run: it waits for your yes.')
    expect(askHomeText(chatAsk({ conversationId: null, context: { localAgent: { sessionId: 'sess-1' } } }))).toBe('Dial8 on your Mac wants to do this for its job. Nothing has run: it waits for your yes.')
  })
})

describe('a loop’s parked step', () => {
  it('asks once in the owner’s home thread, as the agent, its card inline with "Open run"', async () => {
    const held = await createToolApproval(db as never, parkedPost())
    if (!held.ok) throw new Error(held.error)
    expect(homeCalls()).toHaveLength(1)
    const msg = homeCalls()[0]
    expect(msg).toMatchObject({ userId: USER, workspaceId: WS, messageId: `approval-ask-${held.approvalId}`, metadata: { kind: ASK_MESSAGE_KIND, approval_id: held.approvalId, card_id: held.cardId } })
    expect(msg.parts[0]).toMatchObject({ type: 'text' })
    expect(msg.parts[1].type).toBe(ASK_CARD_PART_TYPE)
    // The part is what the chat renders from: the card, its held call, the run's item.
    const part = askCardPartData(msg.parts[1].data)
    expect(part).toMatchObject({ card_id: held.cardId, approval_id: held.approvalId, workspace_id: WS, work_item_id: ITEM })
    // The same card is still the store: an approval card, its full input shown.
    expect(db.rows('attention_item').find((r) => r.id === held.cardId)).toMatchObject({ kind: 'approval', status: 'pending', payload: { approval_id: held.approvalId, editable: true, public_content: true, input: { content: 'We shipped SSO', publish_at: 'now' } } })
  })

  it('a reused hold (a retried dispatch) writes nothing new', async () => {
    await createToolApproval(db as never, parkedPost())
    const again = await createToolApproval(db as never, parkedPost())
    expect(again).toMatchObject({ ok: true, reused: true })
    expect(homeCalls()).toHaveLength(1)
  })

  it('the owner’s click runs it once; a second finds it settled; the model and unattended runs are refused', async () => {
    const held = await createToolApproval(db as never, parkedPost())
    if (!held.ok) throw new Error(held.error)
    const card = db.rows('attention_item').find((r) => r.id === held.cardId) as { workspace_id: string; payload: unknown }
    for (const callerClass of ['agent_unattended', 'unknown', 'other_person'] as const) {
      expect(await approveToolCall(db as never, { callerClass, userId: USER }, card)).toMatchObject({ ok: false, code: 'APPROVAL_PERSON_ONLY' })
    }
    expect(mocks.callTool).not.toHaveBeenCalled()
    expect(await approveToolCall(db as never, { callerClass: 'person', userId: USER }, card)).toMatchObject({ ok: true, status: 'executed', success: true })
    expect(await approveToolCall(db as never, { callerClass: 'person', userId: USER }, card)).toMatchObject({ ok: false, code: 'ALREADY_RESOLVED' })
    expect(mocks.callTool).toHaveBeenCalledTimes(1)
    expect(mocks.callTool).toHaveBeenCalledWith(db, CONN, 'create_draft', { content: 'We shipped SSO', publish_at: 'now' }, USER)
  })
})

describe('a chat turn’s approval', () => {
  it('raised in the person’s own chat: no home message (it renders after the agent’s message there)', async () => {
    const held = await createToolApproval(db as never, chatAsk())
    expect(held.ok).toBe(true)
    expect(homeCalls()).toHaveLength(0)
  })

  it('a card meant for someone else (no conversation of theirs) asks in their home thread', async () => {
    const held = await createToolApproval(db as never, chatAsk({ conversationId: null, card: { title: 'Dana wants to take over “Weekly posts”', why: 'Accept and it runs as Dana.' } }))
    if (!held.ok) throw new Error(held.error)
    expect(homeCalls()).toHaveLength(1)
    expect(homeCalls()[0].parts[0].text).toBe('This waits for your yes.')
    expect(askCardPartData(homeCalls()[0].parts[1].data)).toMatchObject({ card_id: held.cardId, approval_id: held.approvalId })
  })

  it('a post card’s own click (announce false) asks nowhere: the click is the approval', async () => {
    const held = await createToolApproval(db as never, chatAsk({ conversationId: null, announce: false, toolName: 'publish_post', input: { surface: 'x', text: 'hi' } }))
    expect(held.ok).toBe(true)
    expect(homeCalls()).toHaveLength(0)
  })
})

describe('a guest’s held call (guest access)', () => {
  const GUEST = 'cccccccc-0000-4000-8000-000000000003'
  const guestAsk = () => chatAsk({ conversationId: null, toolName: 'create_email_draft', sideEffect: 'external-write', input: { to: 'dana@example.com' }, context: { guest: { guestId: GUEST, name: 'Jason Lee' } } })

  it('asks at home with who asked on the card’s part, their preset read from their row', async () => {
    db.seed('agent_guest', [{ id: GUEST, owner_user_id: USER, workspace_id: WS, display_name: 'Jason Lee', preset: 'colleague' }])
    const held = await createToolApproval(db as never, guestAsk())
    if (!held.ok) throw new Error(held.error)
    const part = askCardPartData(homeCalls()[0].parts[1].data)
    expect(part?.guest).toEqual({ id: GUEST, name: 'Jason Lee', preset: 'colleague', channel: 'sms' })
  })

  it('names them without a preset when their row isn’t the owner’s (or can’t be read)', async () => {
    db.seed('agent_guest', [{ id: GUEST, owner_user_id: 'someone-else', workspace_id: WS, display_name: 'Jason Lee', preset: 'household' }])
    const held = await createToolApproval(db as never, guestAsk())
    if (!held.ok) throw new Error(held.error)
    expect(askCardPartData(homeCalls()[0].parts[1].data)?.guest).toEqual({ id: GUEST, name: 'Jason Lee', channel: 'sms' })
  })

  it('every other approval’s part names no guest', async () => {
    const held = await createToolApproval(db as never, parkedPost())
    if (!held.ok) throw new Error(held.error)
    expect(askCardPartData(homeCalls()[0].parts[1].data)?.guest).toBeUndefined()
  })
})

describe('a held call from another person’s agent (agent links)', () => {
  const LINK = 'dddddddd-0000-4000-8000-000000000004'
  const HALF = 'eeeeeeee-0000-4000-8000-000000000005'
  const linkAsk = () =>
    chatAsk({
      conversationId: null,
      toolName: 'hold_time',
      sideEffect: 'external-write',
      context: { agentLink: { linkId: LINK, peerName: 'Dana Kim', workspaceName: 'Northwind' }, guest: { guestId: HALF, name: 'Dana Kim' } },
    })

  it('asks at home with the link on the card’s part, in place of the guest line', async () => {
    db.seed('agent_guest', [{ id: HALF, owner_user_id: USER, workspace_id: WS, display_name: 'Dana Kim', preset: 'colleague' }])
    const held = await createToolApproval(db as never, linkAsk())
    if (!held.ok) throw new Error(held.error)
    const call = homeCalls()[0]
    expect(call.parts[0]).toEqual({ type: 'text', text: 'Dana Kim’s agent asked for this. Nothing has run: it waits for your yes.' })
    const part = askCardPartData(call.parts[1].data)
    expect(part?.agent_link).toEqual({ link_id: LINK, peer_name: 'Dana Kim', workspace_name: 'Northwind' })
    expect(part?.guest).toBeUndefined()
  })
})
