/**
 * Earned autonomy's record at the two functions every card's answer goes
 * through (docs/plans/earned-autonomy.md §1): approveToolCall writes
 * approved, or approved_edited with the edit ratio; denyToolCall writes
 * dismissed; the expiry sweep writes expired; a refused accept writes failed.
 * Off (EARNED_AUTONOMY empty), nothing is written and nothing else changes.
 * The setup is approvals-flow-step.test.ts's (a loop step's held call, the
 * one door whose card can carry the person's edit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

import { APPROVAL_PENDING_MAX_PER_CONVERSATION, acceptableEdit, approvalCeilingPermits, approveToolCall, createToolApproval, denyToolCall, expireLapsedApprovals, expirePendingApprovals, inputHash, type NewApproval } from '@/lib/safety/approvals'

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
  db = makeFakeSupabase({ project: true, bulkUpsert: true })
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


const settle = () => new Promise((r) => setTimeout(r, 0))
const outcomes = () => db.rows('autonomy_outcome') as Array<Record<string, unknown>>

describe('earned autonomy records each settled card', () => {
  beforeEach(() => {
    vi.stubEnv('EARNED_AUTONOMY', 'record')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('an Accept as shown → approved, for the approver, with the kind code computed', async () => {
    const { created, card } = await raise()
    await approveToolCall(db as never, owner, card)
    await settle()
    expect(outcomes()).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        user_id: USER,
        source: 'tool_approval',
        source_id: created.approvalId,
        outcome: 'approved',
        tool: 'mcp__typefully__create_draft',
        channel: 'app',
        audience: 'none',
        kind_key: 'mcp__typefully__create_draft|app:typefully|none',
        edit_ratio: null,
      }),
    ])
  })

  it('an Accept with the person\'s edit → approved_edited, its ratio measured against what the card showed', async () => {
    const { card } = await raise()
    await approveToolCall(db as never, owner, card, { editedInput: { content: 'We shipped SSO and SCIM today', publish_at: 'next-free-slot' } })
    await settle()
    const [row] = outcomes()
    expect(row).toMatchObject({ outcome: 'approved_edited' })
    expect(row.edit_ratio as number).toBeGreaterThan(0)
    expect(row.edit_ratio as number).toBeLessThanOrEqual(1)
  })

  it('Skip → dismissed', async () => {
    const { card } = await raise()
    await denyToolCall(db as never, owner, card)
    await settle()
    expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'dismissed', user_id: USER, tool: 'mcp__typefully__create_draft' })])
  })

  it('a lapsed card → expired', async () => {
    await raise()
    db.rows('tool_approval')[0].expires_at = new Date(Date.now() - 1000).toISOString()
    await expireLapsedApprovals(db as never)
    await settle()
    expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'expired' })])
  })

  it('an Accept the re-check refuses → failed (neutral), and the call never ran', async () => {
    const { card } = await raise()
    db.rows('flow')[0].enabled = false
    const out = await approveToolCall(db as never, owner, card)
    await settle()
    expect(out.ok).toBe(false)
    expect(mocks.callTool).not.toHaveBeenCalled()
    expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'failed' })])
  })

  it('a second write of the same settle is dropped (idempotent on source, id and outcome)', async () => {
    const { card } = await raise()
    await denyToolCall(db as never, owner, card)
    await denyToolCall(db as never, owner, card)
    await settle()
    expect(outcomes()).toHaveLength(1)
  })

  it('a write that fails (725 not applied yet) never fails the card', async () => {
    const { card } = await raise()
    const realFrom = db.from.bind(db)
    ;(db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === 'autonomy_outcome') throw new Error('relation "autonomy_outcome" does not exist')
      return realFrom(t)
    }
    const out = await approveToolCall(db as never, owner, card)
    await settle()
    expect(out).toMatchObject({ ok: true, status: 'executed' })
  })
})

describe('a Dismiss in an action\'s undo window is its Undo (phase 3)', () => {
  beforeEach(() => vi.stubEnv('EARNED_AUTONOMY', 'graduate'))
  afterEach(() => vi.unstubAllEnvs())

  it('the action is undone, the outcome is undone (not dismissed), and the kind is back to ask', async () => {
    const { created, card } = await raise()
    db.seed('autonomy_kind', [{ id: 'k1', workspace_id: WS, user_id: USER, kind_key: 'mcp__typefully__create_draft|app:typefully|none', level: 'tell' }])
    db.seed('autonomy_action', [{ id: 'act-1', workspace_id: WS, user_id: USER, approval_id: created.approvalId, kind_key: 'mcp__typefully__create_draft|app:typefully|none', tool: 'mcp__typefully__create_draft', status: 'scheduled' }])
    await denyToolCall(db as never, owner, card)
    await settle()
    expect(db.rows('autonomy_action')[0]).toMatchObject({ status: 'undone' })
    expect(outcomes().map((o) => o.outcome)).toEqual(['undone'])
    expect(db.rows('autonomy_kind')[0]).toMatchObject({ level: 'ask' })
  })

  it('the runner\'s own accept records nothing itself (it records ran)', async () => {
    const { card } = await raise()
    await approveToolCall(db as never, owner, card, { autonomousActionId: 'act-1' })
    await settle()
    expect(outcomes()).toEqual([])
  })

  it('a loop step run on its own: the call runs once and the parked run carries on, as after an Accept (phase 4)', async () => {
    const { card } = await raise()
    const out = await approveToolCall(db as never, owner, card, { autonomousActionId: 'act-1' })
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    expect(mocks.callTool).toHaveBeenCalledTimes(1)
    expect(mocks.settled).toHaveBeenCalledWith(expect.objectContaining({ door: 'flow_step', flow_run_id: 'run-1' }), 'approved')
  })
})

describe('earned autonomy off (EARNED_AUTONOMY empty, the default)', () => {
  it('writes nothing on accept, skip or expiry', async () => {
    vi.stubEnv('EARNED_AUTONOMY', '')
    const a = await raise(step('run-1'))
    await approveToolCall(db as never, owner, a.card)
    const b = await raise(step('run-2', { content: 'other' }))
    await denyToolCall(db as never, owner, b.card)
    await settle()
    expect(outcomes()).toEqual([])
    expect(db.calls.some((c) => c.table === 'autonomy_outcome')).toBe(false)
    vi.unstubAllEnvs()
  })
})
