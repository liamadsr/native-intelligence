/**
 * Server-checked approvals (A5 slice 3, review fixes): a held call is a
 * tool_approval row plus an approval card carrying the FULL input; the
 * person's accept runs the STORED call exactly once, as them, after the
 * membership, kill-switch, input-hash and ceiling re-checks, under the door's
 * own createTools fence; the result reaches the home thread with any outside
 * text fenced; dismiss denies it; the kill switch expires loop and MCP-door
 * approvals only; pending approvals are deduped and capped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  execute: vi.fn(async (input: unknown) => ({ success: true, message: 'Deleted GEN-12', input })),
  createToolsOptions: [] as unknown[],
  external: vi.fn(async () => ({ success: true, content: [{ type: 'text', text: 'created' }] })),
  externalMeta: new Map<string, unknown>(),
  home: vi.fn(async () => ({ written: true, conversationId: 'home-conv' })),
  chatCeiling: null as Set<string> | null,
  paused: false,
}))
vi.mock('@/lib/ai/tools', () => ({
  createTools: (...args: unknown[]) => {
    mocks.createToolsOptions.push(args[4])
    return { delete_action: { inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: mocks.execute } }
  },
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  createExternalMcpTools: async () => ({ tools: {}, meta: mocks.externalMeta, servers: [] }),
  executeExternalMcpCall: mocks.external,
}))
vi.mock('@/lib/chat/chat-ceiling', () => ({
  isToolExcludedForSurface: (tool: string, surface: string | undefined) => surface === 'device_ask' && tool === 'mcp_confirm_call',
  resolveAgentToolCeiling: async () => null,
  resolveChatCeiling: async () => mocks.chatCeiling,
  resolveTeammateChatBounds: async () => null,
  resolveTeammateChatCeiling: async () => new Set(),
}))
vi.mock('@/lib/flows/run-skill', () => ({ computeSkillCeiling: () => null }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: mocks.home }))
vi.mock('@/lib/work/agent-paused', () => ({ isAgentPaused: async () => mocks.paused }))
const inbox = vi.hoisted(() => ({ record: vi.fn(async (inputs: unknown[]) => inputs.length), pending: [] as Promise<unknown>[] }))
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: inbox.record }))
const reach = vi.hoisted(() => ({ request: vi.fn(async () => {}) }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: reach.request }))
// The agent's turn once a call ran (approval-turn.ts, 445): never a real Inngest send here.
const turn = vi.hoisted(() => ({ request: vi.fn(async () => {}) }))
vi.mock('../approval-turn', () => ({ requestApprovalTurn: turn.request }))
// A guest's held call, settled: the guest is told (src/lib/guests/guest-approvals.ts), never a real send here.
const guests = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }))
vi.mock('@/lib/guests/guest-approvals', () => ({ notifyGuestOfSettledCalls: guests.notify }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  deferLogWrite: (work: Promise<unknown>) => void inbox.pending.push(work),
}))

import {
  APPROVAL_INPUT_MAX_BYTES, APPROVAL_PENDING_MAX_PER_CONVERSATION, APPROVAL_PENDING_MAX_PER_MAC_JOB, approvalCeilingPermits, approveToolCall, canonicalJson, capResult,
  createToolApproval, denyToolCall, expireLapsedApprovals, expirePendingApprovals, inputHash, storedToolOptions, UNATTENDED_TOOL_OPTIONS, type NewApproval,
} from '../approvals'

const USER = 'user-1'
/** The person's own click, as settle-card builds it (caller.ts Approver). */
const owner = (userId: string) => ({ callerClass: 'person' as const, userId })
const WS = 'ws-1'
let db: FakeSupabase
const held: NewApproval = {
  door: 'chat', userId: USER, workspaceId: WS, toolName: 'delete_action', sideEffect: 'delete',
  input: { action_id: 'GEN-12' }, conversationId: 'conv-1', context: { agentId: 'agent-1' },
  decisionId: 'inf-1', reason: 'not_asked', personMessageSeq: 4,
  card: { title: 'Approve delete_action?', why: 'This deletes something (delete_action), once, with exactly the inputs below.' },
}

async function raise(approval: NewApproval = held) {
  const created = await createToolApproval(db as never, approval)
  if (!created.ok) throw new Error(created.error)
  const card = db.rows('attention_item').find((row) => row.id === created.cardId)!
  return { created, card: card as { workspace_id: string; payload: unknown } }
}

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('member', [{ id: 'member-1', user_id: USER, workspace_id: WS }])
  db.seed('recipe', [{ id: 'skill-1', category: 'skill', workspace_id: WS, is_system: false, agent_config: {} }])
  mocks.execute.mockClear()
  mocks.createToolsOptions.length = 0
  mocks.external.mockClear()
  mocks.externalMeta.clear()
  mocks.home.mockClear()
  mocks.chatCeiling = null
  mocks.paused = false
  inbox.record.mockClear()
  inbox.pending.length = 0
  turn.request.mockClear()
  guests.notify.mockClear()
})

describe('createToolApproval', () => {
  it('holds the call and puts a card carrying the FULL input in the person\'s queue', async () => {
    const input = { action_id: 'GEN-12', note: 'x'.repeat(2000), nested: { b: 1, a: 2 } }
    const { created } = await raise({ ...held, input })
    const [row] = db.rows('tool_approval')
    expect(row).toMatchObject({
      workspace_id: WS, member_id: 'member-1', user_id: USER, door: 'chat', conversation_id: 'conv-1', tool: 'delete_action',
      side_effect: 'delete', input, input_hash: inputHash(input), context: { agentId: 'agent-1' }, decision_id: 'inf-1',
      reason: 'not_asked', person_message_seq: 4, card_id: created.cardId, status: 'pending',
    })
    const [card] = db.rows('attention_item')
    expect(card).toMatchObject({ kind: 'approval', member_id: 'member-1', title: 'Approve delete_action?',
      payload: { approval_id: created.approvalId, tool: 'delete_action', input } })
    expect(card).not.toHaveProperty('proposal_id')
  })

  it('a new card raises ONE work.approval row in the person\'s inbox (its door, its pointer), routed by the rules; a reused one raises none', async () => {
    const { created } = await raise({ ...held, door: 'skill_run' })
    await Promise.all(inbox.pending)
    expect(inbox.record).toHaveBeenCalledOnce()
    const [[inputs]] = inbox.record.mock.calls as unknown as [[Array<Record<string, unknown>>]]
    expect(inputs).toEqual([
      expect.objectContaining({
        workspaceId: WS,
        userId: USER,
        kind: 'work.approval',
        refType: 'tool_approval',
        refId: created.approvalId,
        facts: { title: 'Approve delete_action?', door: 'skill_run' },
        dedupeKey: `approval:${created.approvalId}`,
        expiresAt: expect.any(String),
      }),
    ])
    // Nobody is in a chat to see it: the ask in the home thread is routed to the person (src/lib/reach/route.ts), keyed on the approval.
    expect(reach.request).toHaveBeenCalledWith({ userId: USER, workspaceId: WS, conversationId: 'home-conv' }, `approval:${created.approvalId}`)
    inbox.record.mockClear()
    reach.request.mockClear()
    // The same call again reuses the card: no second row, no second ping.
    expect(await createToolApproval(db as never, { ...held, door: 'skill_run' })).toMatchObject({ ok: true, reused: true })
    expect(inbox.record).not.toHaveBeenCalled()
    expect(reach.request).not.toHaveBeenCalled()
  })

  it('refuses an input too large to show in full, and says why', async () => {
    const result = await createToolApproval(db as never, { ...held, input: { body: 'x'.repeat(APPROVAL_INPUT_MAX_BYTES + 1) } })
    expect(result).toMatchObject({ ok: false, code: 'INPUT_TOO_LARGE', error: expect.stringMatching(/too large to show/) })
    expect(db.rows('tool_approval')).toEqual([])
  })

  it('reuses a pending approval for the same tool and input (canonical: key order does not matter)', async () => {
    const first = await raise({ ...held, input: { a: 1, b: 2 } })
    const again = await createToolApproval(db as never, { ...held, input: { b: 2, a: 1 } })
    expect(again).toMatchObject({ ok: true, approvalId: first.created.approvalId, reused: true })
    expect(db.rows('tool_approval')).toHaveLength(1)
    expect(db.rows('attention_item')).toHaveLength(1)
  })

  it('reuses the same call’s card only within the same chat or Mac job (N7)', async () => {
    const first = await raise()
    // Another chat raising the same call gets its own card: the first answers someone else.
    const otherChat = await createToolApproval(db as never, { ...held, conversationId: 'conv-2' })
    expect(otherChat).toMatchObject({ ok: true })
    expect(otherChat).not.toHaveProperty('reused')
    const mac = (sessionId: string): NewApproval => ({ ...held, conversationId: null, context: { localAgent: { sessionId } } })
    const job = await createToolApproval(db as never, mac('sess-1'))
    expect(job).toMatchObject({ ok: true })
    expect(job.ok && job.approvalId).not.toBe(first.created.approvalId)
    expect(await createToolApproval(db as never, mac('sess-1'))).toMatchObject({ ok: true, reused: true })
    const otherJob = await createToolApproval(db as never, mac('sess-2'))
    expect(otherJob).toMatchObject({ ok: true })
    expect(otherJob).not.toHaveProperty('reused')
    // The same chat still reuses its own.
    expect(await createToolApproval(db as never, held)).toMatchObject({ ok: true, approvalId: first.created.approvalId, reused: true })
  })

  it("a quote reply's card is reused only while its words are the same (roadmap F3): other words make a new card", async () => {
    const quote = (card_hash: string): NewApproval => ({ ...held, toolName: 'send_quote', input: { quote_id: 'q-1' }, context: { quoteReply: { kind: 'send', quote_id: 'q-1', card_hash } } })
    const first = await createToolApproval(db as never, quote('h1'))
    expect(first).toMatchObject({ ok: true })
    expect(await createToolApproval(db as never, quote('h1'))).toMatchObject({ ok: true, approvalId: first.ok && first.approvalId, reused: true })
    const changed = await createToolApproval(db as never, quote('h2'))
    expect(changed).toMatchObject({ ok: true })
    expect(changed).not.toHaveProperty('reused')
    expect(changed.ok && changed.approvalId).not.toBe(first.ok && first.approvalId)
  })

  it('caps pending approvals per conversation, with a clear refusal', async () => {
    for (let i = 0; i < APPROVAL_PENDING_MAX_PER_CONVERSATION; i++) await raise({ ...held, input: { action_id: `GEN-${i}` } })
    expect(await createToolApproval(db as never, { ...held, input: { action_id: 'GEN-99' } })).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
  })

  it('caps a home turn’s cards apart from the person’s own in the same thread: what the agent raised on its own never crowds out their asks', async () => {
    const home: NewApproval = { ...held, reachPerson: true }
    reach.request.mockClear()
    for (let i = 0; i < APPROVAL_PENDING_MAX_PER_CONVERSATION; i++) await raise({ ...home, input: { action_id: `GEN-${i}` } })
    expect(db.rows('tool_approval')[0]).toMatchObject({ context: { homeTurn: true } })
    // Its card is inline in the home turn's own message, which that turn routes: no route of its own.
    expect(reach.request).not.toHaveBeenCalled()
    expect(await createToolApproval(db as never, { ...home, input: { action_id: 'GEN-99' } })).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING', error: expect.stringContaining('on your own') })
    // The person's own ask in the same thread still gets its card, and has its own count.
    expect(await createToolApproval(db as never, { ...held, input: { action_id: 'GEN-99' } })).toMatchObject({ ok: true })
    // A home-turn mark riding in a copied context is dropped: only reachPerson sets it.
    await raise({ ...held, input: { action_id: 'GEN-98' }, context: { homeTurn: true } })
    expect(db.rows('tool_approval').at(-1)?.context).not.toHaveProperty('homeTurn')
  })

  it('caps a Mac job’s pending approvals per job: its cards have no conversation of their own (C1)', async () => {
    const mac = (sessionId: string): NewApproval => ({ ...held, conversationId: null, context: { localAgent: { sessionId, deviceName: 'Liam’s MacBook', folderLabel: 'native-intelligence' } } })
    for (let i = 0; i < APPROVAL_PENDING_MAX_PER_MAC_JOB; i++) await raise({ ...mac('sess-1'), input: { action_id: `GEN-${i}` } })
    expect(db.rows('tool_approval')[0]).toMatchObject({ conversation_id: null, context: { localAgent: { sessionId: 'sess-1' } } })
    expect(await createToolApproval(db as never, { ...mac('sess-1'), input: { action_id: 'GEN-99' } })).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING', error: expect.stringContaining('job on the Mac') })
    // Another job on the same Mac has its own count.
    expect(await createToolApproval(db as never, { ...mac('sess-2'), input: { action_id: 'GEN-99' } })).toMatchObject({ ok: true })
  })

  it('raises nothing for someone who is not a member of the workspace', async () => {
    expect(await createToolApproval(db as never, { ...held, userId: 'stranger' })).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(db.rows('tool_approval')).toEqual([])
  })

  it('fails when the card cannot be written, and marks the held row failed (never a card-less pending approval)', async () => {
    db.failNextInsert('attention_item', { message: 'boom' })
    expect(await createToolApproval(db as never, held)).toMatchObject({ ok: false, code: 'WRITE_FAILED' })
    expect(db.rows('tool_approval')[0].status).toBe('failed')
  })
})

describe('approveToolCall', () => {
  it('runs the stored call once, as the person, and posts a templated result with the tool\'s text fenced', async () => {
    const { created, card } = await raise()
    const outcome = await approveToolCall(db as never, owner(USER), card)
    expect(outcome).toMatchObject({ ok: true, status: 'executed', success: true })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.execute.mock.calls[0][0]).toEqual({ action_id: 'GEN-12' })
    const [row] = db.rows('tool_approval')
    expect(row).toMatchObject({ status: 'approved', result: expect.objectContaining({ message: 'Deleted GEN-12' }) })
    const post = (mocks.home.mock.calls[0] as unknown[])[1] as { messageId: string; parts: Array<{ text: string }> }
    expect(post.messageId).toBe(`approval-${created.approvalId}`)
    expect(post.parts[0].text).toMatch(/^Done: `delete_action` ran after you approved it\./)
    expect(post.parts[0].text).toContain('[UNTRUSTED TOOL CONTENT')
    expect(post.parts[0].text).toContain('Deleted GEN-12')
  })

  it('never runs twice: a second accept is ALREADY_RESOLVED', async () => {
    const { card } = await raise()
    await approveToolCall(db as never, owner(USER), card)
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, status: 409, code: 'ALREADY_RESOLVED' })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('an expired approval is marked expired and never runs', async () => {
    const { card } = await raise()
    db.rows('tool_approval')[0].expires_at = new Date(Date.now() - 1000).toISOString()
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, code: 'EXPIRED' })
    expect(db.rows('tool_approval')[0].status).toBe('expired')
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('someone else\'s approval is not found', async () => {
    const { card } = await raise()
    expect(await approveToolCall(db as never, owner('user-2'), card)).toMatchObject({ ok: false, status: 404 })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('a person who left gets nothing run; the audit row says failed, and the home line says why', async () => {
    const { card } = await raise()
    db.rows('member').splice(0)
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, status: 403, code: 'NOT_A_MEMBER' })
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(db.rows('tool_approval')[0].status).toBe('failed')
    expect(mocks.home).toHaveBeenCalledWith(db, expect.objectContaining({ parts: [{ type: 'text', text: expect.stringMatching(/^I didn't run `delete_action`/) }] }))
  })

  it('a tool switched off since never runs (the ceiling, now)', async () => {
    const { card } = await raise()
    mocks.chatCeiling = new Set(['list_actions'])
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, code: 'TOOL_OUT_OF_CEILING' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('a stored input that no longer matches its hash never runs', async () => {
    const { card } = await raise()
    db.rows('tool_approval')[0].input = { action_id: 'GEN-13' }
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, code: 'INPUT_CHANGED' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('a loop or MCP-door call does not run while the agent is paused; the person\'s own chat ask still does', async () => {
    mocks.paused = true
    const loop = await raise({ ...held, door: 'skill_run', conversationId: null, skillId: 'skill-1', input: { action_id: 'GEN-1' } })
    expect(await approveToolCall(db as never, owner(USER), loop.card)).toMatchObject({ ok: false, code: 'AGENT_PAUSED' })
    const chat = await raise({ ...held, input: { action_id: 'GEN-2' } })
    expect(await approveToolCall(db as never, owner(USER), chat.card)).toMatchObject({ ok: true })
  })

  it('an external tool runs through its server only while it is still connected', async () => {
    const { card } = await raise({ ...held, toolName: 'mcp__linear__create_issue', sideEffect: 'unclassified', input: { title: 'Bug' } })
    mocks.externalMeta.set('mcp__linear__create_issue', { serverId: 's' })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: true, success: true })
    expect(mocks.external).toHaveBeenCalledWith(db, USER, 'mcp__linear__create_issue', { title: 'Bug' })
  })

  it('a card with no held call is refused', async () => {
    expect(await approveToolCall(db as never, owner(USER), { workspace_id: WS, payload: {} })).toMatchObject({ ok: false, code: 'APPROVAL_MISSING' })
  })

  it('a call that ran asks for the agent\'s turn, after its result is stored (445), failed or not', async () => {
    const { created, card } = await raise()
    let atRequest: Record<string, unknown> | null = null
    turn.request.mockImplementationOnce(async () => {
      atRequest = { ...db.rows('tool_approval')[0] }
    })
    await approveToolCall(db as never, owner(USER), card)
    expect(turn.request).toHaveBeenCalledTimes(1)
    // The plan reads the stored result: it is there before the request, which never holds up the Accept (deferred).
    expect(atRequest).toMatchObject({ executed_at: expect.any(String), result: expect.objectContaining({ message: 'Deleted GEN-12' }) })
    expect(inbox.pending.length).toBeGreaterThan(0)
    expect(turn.request).toHaveBeenCalledWith(expect.objectContaining({ id: created.approvalId, door: 'chat', conversation_id: 'conv-1', user_id: USER, workspace_id: WS }))

    mocks.execute.mockResolvedValueOnce({ success: false, error: 'no such action' } as never)
    const failed = await raise({ ...held, input: { action_id: 'GEN-99' } })
    expect(await approveToolCall(db as never, owner(USER), failed.card)).toMatchObject({ ok: true, success: false })
    expect(turn.request).toHaveBeenCalledTimes(2)
  })

  it('a call that never ran asks for no turn: refused at the re-check, or already resolved', async () => {
    const { card } = await raise()
    db.rows('member').splice(0)
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, code: 'ALREADY_RESOLVED' })
    expect(turn.request).not.toHaveBeenCalled()
  })
})

describe('an approved loop call keeps the run\'s fence', () => {
  it('skill_run: strict workspace, no private captures, unattended, actions filed as suggestions (nothing confirmable)', async () => {
    const { card } = await raise({ ...held, door: 'skill_run', conversationId: null, skillId: 'skill-1',
      context: { tools: { ...UNATTENDED_TOOL_OPTIONS, origin: { actor: 'agent', depth: 2, run_id: 'skill-1' } } } })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: true })
    const options = mocks.createToolsOptions[0] as Record<string, unknown> & { actionRules: { filedByRun: (ids: string[]) => Promise<Set<string>> } }
    expect(options).toMatchObject({ strictWorkspace: true, omitPrivateCaptures: true, unattended: true,
      actionRules: { unattended: true, fileActionsAsSuggested: true }, origin: { actor: 'agent', depth: 2, run_id: 'skill-1' } })
    // Every action it touched counts as filed by the run: it can never confirm one.
    expect(await options.actionRules.filedByRun(['A-1', 'b-2'])).toEqual(new Set(['a-1', 'b-2']))
  })

  it('the replay tells the tools it is one (approvedCall), with a flow card\'s check (F1); nothing else ever sets it', async () => {
    const flow = { kind: 'enable' as const, flow_id: 'flow-1', definition_hash: 'h' }
    const { card } = await raise({ ...held, context: { flow } })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: true })
    const options = mocks.createToolsOptions[0] as { approvedCall?: { approvalId: string; tool: string; flow?: unknown } }
    expect(options.approvedCall).toMatchObject({ tool: 'delete_action', flow })
    expect(typeof options.approvedCall?.approvalId).toBe('string')
    // storedToolOptions (what a door records) never carries it.
    expect(storedToolOptions({ door: 'chat', context: { flow }, conversation_id: 'c', skill_id: null })).not.toHaveProperty('approvedCall')
  })

  it("the replay carries a connection card's check too (F2: disconnect, a loosened tool access)", async () => {
    const connection = { kind: 'disconnect' as const, connection_id: 'acc-1', state_hash: 'h' }
    const { card } = await raise({ ...held, context: { connection } })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: true })
    const options = mocks.createToolsOptions[0] as { approvedCall?: { connection?: unknown; flow?: unknown } }
    expect(options.approvedCall).toMatchObject({ connection })
    expect(options.approvedCall).not.toHaveProperty('flow')
  })

  it("the replay carries a document delete card's check (GEN-1169: the revision the card showed)", async () => {
    const document = { kind: 'delete' as const, document_id: 'doc-1', revision: 3 }
    const { card } = await raise({ ...held, context: { document } })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: true })
    const options = mocks.createToolsOptions[0] as { approvedCall?: { document?: unknown; flow?: unknown; connection?: unknown } }
    expect(options.approvedCall).toMatchObject({ document })
    expect(options.approvedCall).not.toHaveProperty('flow')
    expect(options.approvedCall).not.toHaveProperty('connection')
  })

  it("the replay carries an outreach launch card's check (roadmap D1/D2: the copy's hash and who the card named)", async () => {
    const outreach = { kind: 'sequence' as const, id: 'seq-1', content_hash: 'h', recipient_ids: ['enr-1'] }
    const { card } = await raise({ ...held, context: { outreach } })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: true })
    const options = mocks.createToolsOptions[0] as { approvedCall?: { outreach?: unknown; document?: unknown } }
    expect(options.approvedCall).toMatchObject({ outreach })
    expect(options.approvedCall).not.toHaveProperty('document')
    expect(storedToolOptions({ door: 'chat', context: { outreach }, conversation_id: 'c', skill_id: null })).not.toHaveProperty('approvedCall')
  })

  it("the replay carries a quote reply card's check (roadmap F3: which quote, and its words' hash)", async () => {
    const quoteReply = { kind: 'send' as const, quote_id: 'q-1', card_hash: 'h' }
    const { card } = await raise({ ...held, context: { quoteReply } })
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: true })
    const options = mocks.createToolsOptions[0] as { approvedCall?: { quoteReply?: unknown; outreach?: unknown } }
    expect(options.approvedCall).toMatchObject({ quoteReply })
    expect(options.approvedCall).not.toHaveProperty('outreach')
    expect(storedToolOptions({ door: 'chat', context: { quoteReply }, conversation_id: 'c', skill_id: null })).not.toHaveProperty('approvedCall')
  })

  it('a loop row (or a historic retired-door row) with no fence recorded gets the unattended fence anyway (fail closed); a chat row keeps the person\'s', () => {
    expect(storedToolOptions({ door: 'mcp' as never, context: {}, conversation_id: null, skill_id: null })).toMatchObject({ strictWorkspace: true, omitPrivateCaptures: true, unattended: true })
    expect(storedToolOptions({ door: 'skill_run', context: { tools: { strictWorkspace: false } }, conversation_id: null, skill_id: 's' })).toMatchObject({ strictWorkspace: true })
    expect(storedToolOptions({ door: 'chat', context: {}, conversation_id: 'c', skill_id: null })).not.toHaveProperty('strictWorkspace')
  })

  it("a guest's or a linked agent's held call replays reading no grant (omitGrants), stored or not; the person's own never", () => {
    const guest = { guestId: 'g-1', name: 'Kai' }
    const agentLink = { linkId: 'l-1' } as never
    // Recorded with the call (guest-tools.ts guestApprovalContext).
    expect(storedToolOptions({ door: 'chat', context: { guest, tools: { omitGrants: true } }, conversation_id: null, skill_id: null })).toMatchObject({ omitGrants: true })
    // Fail closed: a guest's or a linked agent's row from before the flag, or one that says false.
    expect(storedToolOptions({ door: 'chat', context: { guest, tools: { origin: { actor: 'agent', depth: 1 } } }, conversation_id: null, skill_id: null })).toMatchObject({ omitGrants: true })
    expect(storedToolOptions({ door: 'chat', context: { guest, tools: { omitGrants: false } }, conversation_id: null, skill_id: null })).toMatchObject({ omitGrants: true })
    expect(storedToolOptions({ door: 'chat', context: { agentLink }, conversation_id: null, skill_id: null })).toMatchObject({ omitGrants: true })
    // The person's own held call reads their grants as their turn did.
    expect(storedToolOptions({ door: 'chat', context: {}, conversation_id: 'c', skill_id: null })).not.toHaveProperty('omitGrants')
    expect(storedToolOptions({ door: 'skill_run', context: {}, conversation_id: null, skill_id: 's' })).not.toHaveProperty('omitGrants')
  })
})

describe('approvalCeilingPermits', () => {
  const row = { door: 'chat' as const, workspace_id: WS, user_id: USER, skill_id: null, context: {} }
  it('refuses a name that is neither a registry tool nor one of the person\'s external tools', async () => {
    expect(await approvalCeilingPermits(db as never, { ...row, tool: 'made_up_tool' })).toBe(false)
    expect(await approvalCeilingPermits(db as never, { ...row, tool: 'mcp__gone__tool' })).toBe(false)
    expect(await approvalCeilingPermits(db as never, { ...row, tool: 'delete_action' })).toBe(true)
  })

  it('a Mac job’s card is checked like the chat’s at accept time (its marker is not a surface)', async () => {
    const context = { localAgent: { sessionId: 'sess-1', deviceName: 'Mac', folderLabel: 'repo' }, tools: { strictWorkspace: true } }
    expect(await approvalCeilingPermits(db as never, { ...row, context, tool: 'delete_action' })).toBe(true)
    expect(await approvalCeilingPermits(db as never, { ...row, context, tool: 'made_up_tool' })).toBe(false)
  })

  it('a historic row from the retired mcp door is refused, whatever its tool', async () => {
    mocks.externalMeta.set('mcp__linear__create_issue', { serverId: 's' })
    for (const tool of ['settle_card', 'mcp__linear__create_issue', 'delete_action']) {
      expect(await approvalCeilingPermits(db as never, { ...row, door: 'mcp' as never, tool })).toBe(false)
    }
  })

  it("a guest's held call (guest access): only while the guest is active and still holds the tool", async () => {
    const guest = { id: 'g1', owner_user_id: USER, workspace_id: WS, display_name: 'Sam', phone_e164: '+15551234567', preset: 'household', tools: ['create_calendar_event', 'message_owner'], ask_before: ['payments'], notes: null, state: 'active', invite_expires_at: null, requested_at: null, activated_at: null, removed_at: null, opted_out_at: null, last_inbound_at: null, created_at: '2026-10-20T00:00:00.000Z' }
    db.seed('agent_guest', [guest])
    const context = { guest: { guestId: 'g1', name: 'Sam' } }
    expect(await approvalCeilingPermits(db as never, { ...row, context, tool: 'create_calendar_event' })).toBe(true)
    // A tool the owner never gave them, or one they took away since.
    expect(await approvalCeilingPermits(db as never, { ...row, context, tool: 'delete_action' })).toBe(false)
    // Someone else's guest, or a removed one.
    expect(await approvalCeilingPermits(db as never, { ...row, user_id: 'user-2', context, tool: 'create_calendar_event' })).toBe(false)
    db.rows('agent_guest')[0].state = 'removed'
    expect(await approvalCeilingPermits(db as never, { ...row, context, tool: 'create_calendar_event' })).toBe(false)
  })

  it('the chat door applies its surface\'s exclusions', async () => {
    mocks.externalMeta.set('mcp_confirm_call', {})
    expect(await approvalCeilingPermits(db as never, { ...row, tool: 'delete_action', context: { surface: 'device_ask' } })).toBe(true)
  })
})

// PROD 11-02: Liam approved Jess's two calendar changes at 8:05, and she never heard.
describe("a guest's held call (guest access)", () => {
  const guestHeld = (action: string): NewApproval => ({ ...held, conversationId: null, reason: 'guest_text', input: { action_id: action }, context: { guest: { guestId: 'g-1', name: 'Jess (Wife)' } } })
  const permits = async () => true
  // A settle's update returns the columns it selects, as PostgREST does (the fake's `project`).
  beforeEach(() => {
    db = makeFakeSupabase({ project: true })
    db.seed('member', [{ id: 'member-1', user_id: USER, workspace_id: WS }])
  })
  const told = async () => {
    await Promise.all(inbox.pending)
    return guests.notify.mock.calls.map((call) => (call as unknown[])[1])
  }

  it('the guest hears how it ended: once it ran, or a re-check refused it, or the person declined it', async () => {
    const ran = await raise(guestHeld('RAN'))
    await approveToolCall(db as never, owner(USER), ran.card, { permits })
    expect(await told()).toEqual([[ran.created.approvalId]])

    const declined = await raise(guestHeld('NO'))
    await denyToolCall(db as never, owner(USER), declined.card)
    expect((await told()).at(-1)).toEqual([declined.created.approvalId])

    const refused = await raise(guestHeld('LEFT'))
    db.rows('member').splice(0)
    expect(await approveToolCall(db as never, owner(USER), refused.card, { permits })).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect((await told()).at(-1)).toEqual([refused.created.approvalId])
  })

  it('and when its card lapsed unanswered', async () => {
    const lapsed = await raise(guestHeld('LATE'))
    const row = db.rows('tool_approval').find((r) => r.id === lapsed.created.approvalId)!
    row.expires_at = new Date(Date.now() - 60_000).toISOString()
    expect(await expireLapsedApprovals(db as never)).toBe(1)
    expect(await told()).toEqual([[lapsed.created.approvalId]])
  })

  it("the person's own call tells no guest", async () => {
    const { card } = await raise()
    await approveToolCall(db as never, owner(USER), card)
    await denyToolCall(db as never, owner(USER), (await raise({ ...held, input: { action_id: 'X' } })).card)
    expect(await told()).toEqual([])
  })
})

describe('denyToolCall', () => {
  it('denies a pending approval, which then never runs', async () => {
    const { card } = await raise()
    await denyToolCall(db as never, owner(USER), card)
    expect(db.rows('tool_approval')[0].status).toBe('denied')
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, code: 'ALREADY_RESOLVED' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})

describe('expireLapsedApprovals (a held call whose wait is over is expired, not left pending)', () => {
  const lapse = (id: string) => {
    const row = db.rows('tool_approval').find((r) => r.id === id)!
    row.expires_at = new Date(Date.now() - 60_000).toISOString()
    const card = db.rows('attention_item').find((r) => r.id === row.card_id)!
    card.expires_at = row.expires_at
  }
  const status = (table: string, id: string) => db.rows(table).find((r) => r.id === id)?.status

  it('expires every lapsed pending row and its card; live, answered and other rows stay as they are', async () => {
    const old = await raise({ ...held, input: { action_id: 'OLD' } })
    const live = await raise({ ...held, input: { action_id: 'LIVE' } })
    const answered = await raise({ ...held, input: { action_id: 'DONE' } })
    lapse(old.created.approvalId)
    lapse(answered.created.approvalId)
    db.rows('tool_approval').find((r) => r.id === answered.created.approvalId)!.status = 'denied'
    expect(await expireLapsedApprovals(db as never)).toBe(1)
    expect(status('tool_approval', old.created.approvalId)).toBe('expired')
    expect(status('attention_item', old.created.cardId)).toBe('expired')
    expect(status('tool_approval', live.created.approvalId)).toBe('pending')
    expect(status('attention_item', live.created.cardId)).toBe('pending')
    expect(status('tool_approval', answered.created.approvalId)).toBe('denied')
    // Idempotent.
    expect(await expireLapsedApprovals(db as never)).toBe(0)
  })

  it('scopes to one card when asked (the card the person clicked)', async () => {
    const a = await raise({ ...held, input: { action_id: 'A' } })
    const b = await raise({ ...held, input: { action_id: 'B' } })
    lapse(a.created.approvalId)
    lapse(b.created.approvalId)
    expect(await expireLapsedApprovals(db as never, { cardId: a.created.cardId })).toBe(1)
    expect(status('tool_approval', a.created.approvalId)).toBe('expired')
    expect(status('tool_approval', b.created.approvalId)).toBe('pending')
  })

  it('raising a new approval first expires the person\'s lapsed ones, so they no longer count against the caps', async () => {
    const old = await raise({ ...held, input: { action_id: 'OLD' } })
    lapse(old.created.approvalId)
    await raise({ ...held, input: { action_id: 'NEW' } })
    expect(status('tool_approval', old.created.approvalId)).toBe('expired')
    expect(status('attention_item', old.created.cardId)).toBe('expired')
  })

  it('accepting a lapsed approval expires its card too, and nothing runs', async () => {
    const { created, card } = await raise()
    lapse(created.approvalId)
    expect(await approveToolCall(db as never, owner(USER), card)).toMatchObject({ ok: false, code: 'EXPIRED' })
    expect(status('tool_approval', created.approvalId)).toBe('expired')
    expect(status('attention_item', created.cardId)).toBe('expired')
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})

describe('expirePendingApprovals (the kill switch)', () => {
  it('expires a workspace’s pending loop approvals (and any historic retired-door row) and their cards, never the person’s own chat asks', async () => {
    const loop = await raise({ ...held, door: 'skill_run', conversationId: null, skillId: 'skill-1', input: { action_id: 'L' } })
    const mcp = await raise({ ...held, door: 'mcp' as never, conversationId: null, input: { action_id: 'M' } })
    const chat = await raise({ ...held, input: { action_id: 'C' } })
    await expirePendingApprovals(db as never, WS)
    const status = (id: string) => db.rows('tool_approval').find((r) => r.id === id)?.status
    expect(status(loop.created.approvalId)).toBe('expired')
    expect(status(mcp.created.approvalId)).toBe('expired')
    expect(status(chat.created.approvalId)).toBe('pending')
    const cardStatus = (id: string) => db.rows('attention_item').find((r) => r.id === id)?.status
    expect(cardStatus(loop.created.cardId)).toBe('expired')
    expect(cardStatus(chat.created.cardId)).toBe('pending')
  })

  it('throws on a failed read so the Inngest step retries', async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ neq: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }) }
    await expect(expirePendingApprovals(broken as never, WS)).rejects.toThrow(/down/)
  })
})

describe('canonicalJson', () => {
  it('sorts keys at every depth, so equal inputs hash equal', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":2},"b":1}')
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }))
  })
})

describe('the card’s Always allow offer (mcp-client/always-allow.ts)', () => {
  const external: NewApproval = {
    ...held,
    toolName: 'mcp__linear__create_issue',
    sideEffect: 'unclassified',
    input: { title: 'Bug' },
    reason: 'requires_approval',
    card: { title: 'Approve mcp__linear__create_issue?', why: 'Linear asks for your approval before this runs.' },
  }

  it('stored with the held call (its context) and flagged on the card, so the server never takes the browser’s word', async () => {
    const { created, card } = await raise({ ...external, alwaysAllow: { serverId: 'srv-1', tool: 'create_issue' } })
    const row = db.rows('tool_approval').find((r) => r.id === (created as { approvalId: string }).approvalId)!
    expect(row.context).toMatchObject({ agentId: 'agent-1', alwaysAllow: { serverId: 'srv-1', tool: 'create_issue' } })
    expect(card.payload).toMatchObject({ always_allow: true })
  })

  it('an offer riding in a copied context is dropped: only NewApproval.alwaysAllow sets one', async () => {
    const { created, card } = await raise({ ...external, context: { agentId: 'agent-1', alwaysAllow: { serverId: 'srv-x', tool: 'drop_db' } } })
    const row = db.rows('tool_approval').find((r) => r.id === (created as { approvalId: string }).approvalId)!
    expect(row.context).toEqual({ agentId: 'agent-1' })
    expect(card.payload).not.toHaveProperty('always_allow')
  })

  it('absent: no offer stored, no flag on the card (a reviewer-held or always-ask call)', async () => {
    const { created, card } = await raise(external)
    const row = db.rows('tool_approval').find((r) => r.id === (created as { approvalId: string }).approvalId)!
    expect(row.context).not.toHaveProperty('alwaysAllow')
    expect(card.payload).not.toHaveProperty('always_allow')
  })
})

describe('capResult (GEN-1172)', () => {
  it('keeps a result that fits whole', () => {
    const result = { success: true, content: [{ type: 'text', text: 'ok' }] }
    expect(capResult(result)).toBe(result)
  })

  it('a result too long to keep whole keeps its success flags beside the preview', () => {
    const failed = capResult({ success: false, isError: true, content: [{ type: 'text', text: 'e'.repeat(20_000) }] }) as Record<string, unknown>
    expect(failed).toMatchObject({ truncated: true, success: false, isError: true })
    expect(String(failed.preview)).toHaveLength(8_000)
    expect(capResult({ rows: 'r'.repeat(20_000) })).not.toHaveProperty('success')
  })
})
