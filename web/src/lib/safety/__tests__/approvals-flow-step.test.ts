/**
 * A loop step's held call (F4, door 'flow_step'): the run stands in for the
 * conversation (5 pending per run), a pending call is reused only within its
 * run, the card is editable (the person's own values for the fields shown),
 * the accept re-checks that the step still calls that tool on that
 * connection, runs it once on that exact connection, and tells the parked
 * run; Skip, expiry and the kill switch tell it too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'draft d_7 queued' }], isError: false })),
  settled: vi.fn(async () => undefined),
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
vi.mock('@/lib/flows/flow-step-notify', () => ({ notifyFlowStepSettled: mocks.settled }))

import { APPROVAL_PENDING_MAX_PER_CONVERSATION, acceptableEdit, approvalCeilingPermits, approveToolCall, createToolApproval, denyToolCall, expireLapsedApprovals, expirePendingApprovals, inputHash, type NewApproval } from '../approvals'

const USER = 'user-1'
const WS = 'ws-1'
const CONN = 'aaaaaaaa-0000-4000-8000-000000000001'
const owner = { callerClass: 'person' as const, userId: USER }
let db: FakeSupabase

const step = (runId = 'run-1', input: Record<string, unknown> = { content: 'We shipped SSO', publish_at: 'next-free-slot' }, actionId = 'queue', manual = false): NewApproval => ({
  door: 'flow_step', userId: USER, workspaceId: WS, toolName: 'mcp__typefully__create_draft', sideEffect: 'external-write', input,
  flowRunId: runId, reason: 'public_content',
  context: { flowStep: { flow_id: 'flow-1', action_id: actionId, flow_run_id: runId, connection: CONN, tool: 'create_draft', rule: 'public_content', public_content: true, ...(manual ? { manual: true as const, fired_by: USER } : {}) } },
  card: { title: "Add to Typefully queue: next free slot: 'We shipped SSO'", why: 'A loop stopped here for your yes.' },
})

async function raise(a: NewApproval = step()) {
  const created = await createToolApproval(db as never, a)
  if (!created.ok) throw new Error(created.error)
  return { created, card: db.rows('attention_item').find((r) => r.id === created.cardId) as { workspace_id: string; payload: unknown } }
}

beforeEach(() => {
  // project: an update's select returns the columns it names, as PostgREST does.
  db = makeFakeSupabase({ project: true })
  db.seed('member', [{ id: 'member-1', user_id: USER, workspace_id: WS }])
  db.seed('flow', [{ id: 'flow-1', workspace_id: WS, created_by: USER, enabled: true, actions: [{ id: 'queue', type: 'call_tool', config: { connection: CONN, tool: 'create_draft', input: {} } }] }])
  db.seed('connected_mcp_server', [{
    id: CONN, user_id: USER, display_name: 'Typefully', server_url: 'https://mcp.typefully.com/mcp', is_enabled: true,
    disabled_tools: [], allowed_tools: ['create_draft'], require_approval_tools: [], approval_free_tools: [],
    tools_cache: [{ name: 'create_draft', inputSchema: { type: 'object', properties: { content: { type: 'string' }, publish_at: { type: 'string' } }, required: ['content'] } }],
  }])
  mocks.callTool.mockClear()
  mocks.settled.mockClear()
})

describe('holding a loop step', () => {
  it('records its run, and its card is editable and marked public content', async () => {
    const { created, card } = await raise()
    expect(db.rows('tool_approval')[0]).toMatchObject({ door: 'flow_step', flow_run_id: 'run-1', status: 'pending' })
    expect(card.payload).toMatchObject({ approval_id: created.approvalId, door: 'flow_step', editable: true, public_content: true })
  })

  it('5 pending per run (the run stands in for the conversation); another run has its own', async () => {
    for (let i = 0; i < APPROVAL_PENDING_MAX_PER_CONVERSATION; i++) await raise(step('run-1', { content: `post ${i}` }, `step-${i}`))
    const sixth = await createToolApproval(db as never, step('run-1', { content: 'post 6' }, 'step-6'))
    expect(sixth).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
    expect((await createToolApproval(db as never, step('run-2', { content: 'post 6' }))).ok).toBe(true)
  })

  it('the same call is reused only within its own run (another run would never hear the answer)', async () => {
    const a = await raise(step('run-1'))
    const again = await createToolApproval(db as never, step('run-1'))
    expect(again).toMatchObject({ ok: true, reused: true, approvalId: a.created.approvalId })
    const other = await createToolApproval(db as never, step('run-2'))
    expect(other.ok && other.approvalId).not.toBe(a.created.approvalId)
  })
})

describe('the owner\'s Accept', () => {
  it('runs the stored call once on the exact connection, keeps its raw text, and tells the run', async () => {
    const { card } = await raise()
    const out = await approveToolCall(db as never, owner, card)
    expect(out).toMatchObject({ ok: true, status: 'executed', success: true })
    expect(mocks.callTool).toHaveBeenCalledWith(db, CONN, 'create_draft', { content: 'We shipped SSO', publish_at: 'next-free-slot' }, USER)
    expect(db.rows('tool_approval')[0]).toMatchObject({ status: 'approved', result: { success: true, text: 'draft d_7 queued' } })
    expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ door: 'flow_step', flow_run_id: 'run-1' }), 'approved')
  })

  it('an Edit runs what the person typed, recorded before it runs; the hash follows', async () => {
    const { card } = await raise()
    const edited = { content: 'We shipped SSO and SCIM', publish_at: 'next-free-slot' }
    const out = await approveToolCall(db as never, owner, card, { editedInput: edited })
    expect(out.ok).toBe(true)
    expect(mocks.callTool).toHaveBeenCalledWith(db, CONN, 'create_draft', edited, USER)
    expect(db.rows('tool_approval')[0]).toMatchObject({ input: edited, input_hash: inputHash(edited) })
  })

  it('an edit that adds or drops a field, or any edit on another door, is refused and nothing runs', async () => {
    const { card } = await raise()
    const out = await approveToolCall(db as never, owner, card, { editedInput: { content: 'x' } })
    expect(out).toMatchObject({ ok: false, code: 'EDIT_REFUSED' })
    expect(db.rows('tool_approval')[0]).toMatchObject({ status: 'pending' })
    expect(mocks.callTool).not.toHaveBeenCalled()
    expect(acceptableEdit({ a: 1 }, { a: 2 })).toEqual({ a: 2 })
    expect(acceptableEdit({ a: 1 }, { a: 2, publish_at: 'now' })).toBeNull()
  })

  it('a step that changed since (another tool, another connection) or a tool switched off: refused, the run is told it failed', async () => {
    const { card } = await raise()
    db.rows('flow')[0].actions = [{ id: 'queue', type: 'call_tool', config: { connection: CONN, tool: 'publish_draft', input: {} } }]
    const out = await approveToolCall(db as never, owner, card)
    expect(out).toMatchObject({ ok: false, code: 'TOOL_OUT_OF_CEILING' })
    expect(mocks.callTool).not.toHaveBeenCalled()
    expect(mocks.settled).toHaveBeenCalledWith(expect.anything(), 'failed')
  })

  it('only the owner approves', async () => {
    const { card } = await raise()
    const out = await approveToolCall(db as never, { callerClass: 'agent_unattended', userId: USER }, card)
    expect(out).toMatchObject({ ok: false, code: 'APPROVAL_PERSON_ONLY' })
    expect(mocks.callTool).not.toHaveBeenCalled()
  })
})

describe('Skip, expiry and the kill switch tell the parked run', () => {
  it('Skip (dismiss) → denied', async () => {
    const { card } = await raise()
    await denyToolCall(db as never, owner, card)
    expect(db.rows('tool_approval')[0].status).toBe('denied')
    expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ door: 'flow_step' }), 'denied')
  })

  it('a lapsed card → expired; the kill switch → paused', async () => {
    await raise(step('run-1'))
    db.rows('tool_approval')[0].expires_at = new Date(Date.now() - 1000).toISOString()
    await expireLapsedApprovals(db as never)
    expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ door: 'flow_step' }), 'expired')
    mocks.settled.mockClear()
    await raise(step('run-2', { content: 'other' }))
    await expirePendingApprovals(db as never, WS)
    expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ door: 'flow_step' }), 'paused')
  })
})

describe('review fixes (S4, S5, S9)', () => {
  it('S4: a loop switched off while its card waited runs nothing on Accept', async () => {
    const { card } = await raise()
    db.rows('flow')[0].enabled = false
    const out = await approveToolCall(db as never, owner, card)
    expect(out).toMatchObject({ ok: false, code: 'TOOL_OUT_OF_CEILING' })
    expect(mocks.callTool).not.toHaveBeenCalled()
  })

  it('S9: an edit that does not fit the tool is refused BEFORE the claim: the card and the run keep waiting', async () => {
    const { card } = await raise()
    const out = await approveToolCall(db as never, owner, card, { editedInput: { content: 42, publish_at: 'next-free-slot' } })
    expect(out).toMatchObject({ ok: false, code: 'EDIT_REFUSED' })
    expect(db.rows('tool_approval')[0]).toMatchObject({ status: 'pending' })
    expect(mocks.settled).not.toHaveBeenCalled()
    expect(mocks.callTool).not.toHaveBeenCalled()
  })

  it('S5: a skill run\'s staged write re-reads the step\'s CURRENT connections and the loop\'s on/off, then the schema', async () => {
    db.rows('flow')[0].actions = [{ id: 'post', type: 'run_skill', config: { skill_id: 's', mode: 'act', connections: [CONN] } }]
    const staged: NewApproval = {
      door: 'skill_run', userId: USER, workspaceId: WS, toolName: 'mcp__typefully__create_draft', sideEffect: 'unclassified',
      input: { content: 'x', publish_at: 'now' }, skillId: 'skill-1', flowRunId: 'run-9', reason: 'public_content',
      context: { mode: 'act', mcp: { connection: CONN, tool: 'create_draft', connections: [CONN], flow_id: 'flow-1', action_id: 'post' } },
      card: { title: 't', why: 'w' },
    }
    // The step no longer names the connection: the card's own list doesn't count.
    db.rows('flow')[0].actions = [{ id: 'post', type: 'run_skill', config: { skill_id: 's', mode: 'act', connections: [] } }]
    const first = await raise(staged)
    expect(await approveToolCall(db as never, owner, first.card)).toMatchObject({ ok: false, code: 'TOOL_OUT_OF_CEILING' })
    // Named again, and the loop on: it runs, on that exact connection.
    db.rows('flow')[0].actions = [{ id: 'post', type: 'run_skill', config: { skill_id: 's', mode: 'act', connections: [CONN] } }]
    const second = await raise({ ...staged, input: { content: 'y', publish_at: 'now' } })
    expect(await approveToolCall(db as never, owner, second.card)).toMatchObject({ ok: true, success: true })
    expect(mocks.callTool).toHaveBeenCalledWith(db, CONN, 'create_draft', { content: 'y', publish_at: 'now' }, USER)
    // A bad input never reaches the app.
    mocks.callTool.mockClear()
    const third = await raise({ ...staged, input: { publish_at: 'now' } })
    expect(await approveToolCall(db as never, owner, third.card)).toMatchObject({ ok: true, success: false })
    expect(mocks.callTool).not.toHaveBeenCalled()
  })
})

describe('verification fixes (S3 remainder, R1)', () => {
  it('S3: a retried run re-rendering the same step reuses its pending card, whatever the input', async () => {
    const first = await raise(step('run-1', { content: 'first render' }))
    const again = await createToolApproval(db as never, step('run-1', { content: 'second render' }))
    expect(again).toMatchObject({ ok: true, reused: true, approvalId: first.created.approvalId })
    expect(db.rows('tool_approval')).toHaveLength(1)
  })

  it('R1: a Test\'s card (manual) is answered with the loop still off; any other card on an off loop is refused', async () => {
    db.rows('flow')[0].enabled = false
    const test = await raise(step('run-t', undefined, 'queue', true))
    expect(await approveToolCall(db as never, owner, test.card)).toMatchObject({ ok: true, success: true })
    const fired = await raise(step('run-f', { content: 'other' }))
    expect(await approveToolCall(db as never, owner, fired.card)).toMatchObject({ ok: false, code: 'TOOL_OUT_OF_CEILING' })
  })
})

describe('N1: a native card a flow step\'s skill run raised checks its loop', () => {
  const row = (loopStep: Record<string, unknown>) => ({
    door: 'skill_run' as const, workspace_id: WS, user_id: USER, tool: 'create_calendar_event', skill_id: 'skill-1',
    context: { mode: 'act' as const, loopStep: loopStep as never },
  })
  it('refused once the loop is off, unless the run was a Test', async () => {
    db.seed('recipe', [{ id: 'skill-1', category: 'skill', workspace_id: WS, is_system: false, agent_config: {} }])
    expect(await approvalCeilingPermits(db as never, row({ flow_id: 'flow-1', action_id: 'queue' }))).toBe(true)
    db.rows('flow')[0].enabled = false
    expect(await approvalCeilingPermits(db as never, row({ flow_id: 'flow-1', action_id: 'queue' }))).toBe(false)
    expect(await approvalCeilingPermits(db as never, row({ flow_id: 'flow-1', action_id: 'queue', manual: true }))).toBe(true)
  })
})
