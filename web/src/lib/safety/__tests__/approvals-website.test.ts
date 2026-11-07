/**
 * A website change's merge card through the approvals (roadmap track E): it
 * asks in the owner's home thread with what changed and the preview, and the
 * reach router texts it with its code; the owner's yes runs
 * merge_website_change (never a registry tool) after the change's own
 * re-check; a no or a lapse settles the change. The website module is
 * mocked: ../../website/__tests__/flow.test.ts covers it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  home: vi.fn(async () => ({ written: true, conversationId: 'home-conv' })),
  createTools: vi.fn(() => ({})),
  permits: vi.fn(async () => true),
  confirm: vi.fn(async () => ({ success: true, merged: true, message: 'Done' })),
  settle: vi.fn(async () => {}),
}))
vi.mock('@/lib/ai/tools', () => ({ createTools: mocks.createTools }))
vi.mock('@/lib/mcp-client/adapter', () => ({ createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }), executeExternalMcpCall: vi.fn() }))
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
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: vi.fn(async () => 1) }))
const reach = vi.hoisted(() => ({ request: vi.fn(async () => {}), pending: [] as Promise<unknown>[] }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: reach.request }))
vi.mock('../approval-turn', () => ({ requestApprovalTurn: vi.fn(async () => {}) }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  deferLogWrite: (work: Promise<unknown>) => void reach.pending.push(work),
}))
vi.mock('@/lib/website/approval', () => ({
  websiteApprovalPermits: mocks.permits,
  mergeWebsiteChange: mocks.confirm,
  settleWebsiteApproval: mocks.settle,
}))

import { approvalCeilingPermits, approveToolCall, askHomeText, createToolApproval, denyToolCall, executeStoredCall, expireLapsedApprovals, type NewApproval } from '../approvals'

const OWNER = 'user-owner'
const WS = 'ws-site'
const HEAD = 'a'.repeat(40)
const owner = { callerClass: 'person_remote' as const, userId: OWNER }
let db: FakeSupabase

const merge: NewApproval = {
  door: 'chat',
  userId: OWNER,
  workspaceId: WS,
  toolName: 'merge_website_change',
  sideEffect: 'external-write',
  input: { change: 'Update the hours', what_changes: 'The homepage now says 8 to 6.', pull_request: 'https://github.com/jane/site/pull/8' },
  context: { website: { changeId: 'chg-1', headSha: HEAD, summary: 'The homepage now says 8 to 6.', previewUrl: 'https://site-git-x.vercel.app/' } },
  reason: 'website_change',
  card: { title: 'Put this live on your website? Update the hours', why: 'The homepage now says 8 to 6. Approving puts it live.' },
}

async function raise(approval: NewApproval = merge) {
  const created = await createToolApproval(db as never, approval)
  if (!created.ok) throw new Error(created.error)
  const card = db.rows('attention_item').find((row) => row.id === created.cardId)! as { workspace_id: string; payload: unknown }
  return { created, card }
}

beforeEach(() => {
  db = makeFakeSupabase({ project: true })
  db.seed('member', [{ id: 'member-1', user_id: OWNER, workspace_id: WS }])
  for (const m of Object.values(mocks)) m.mockClear()
  mocks.permits.mockResolvedValue(true)
  reach.request.mockClear()
  reach.pending.length = 0
})

describe("the owner's merge card", () => {
  it('asks in their home thread with what changed and the preview, and is routed to their phone', async () => {
    const { created } = await raise()
    expect(mocks.home).toHaveBeenCalledOnce()
    expect((mocks.home.mock.calls[0] as unknown[])[1]).toMatchObject({ parts: [{ type: 'text', text: 'Your website change is ready: The homepage now says 8 to 6. See it before it goes live: https://site-git-x.vercel.app/ Nothing is live until you approve it.' }, expect.anything()] })
    await Promise.all(reach.pending)
    expect(reach.request).toHaveBeenCalledWith({ userId: OWNER, workspaceId: WS, conversationId: 'home-conv' }, `approval:${created.approvalId}`)
  })

  it('without a preview it says so plainly', () => {
    expect(askHomeText({ ...merge, context: { website: { changeId: 'chg-1', headSha: HEAD } } })).toBe('Your website change is ready. Nothing is live until you approve it.')
  })
})

describe('the yes', () => {
  it("re-checks the change itself, then merges it: never through createTools", async () => {
    const { card } = await raise()
    expect(await approveToolCall(db as never, owner, card)).toMatchObject({ ok: true, success: true })
    expect(mocks.permits).toHaveBeenCalledWith(db, expect.objectContaining({ tool: 'merge_website_change', context: expect.objectContaining({ website: expect.objectContaining({ changeId: 'chg-1' }) }) }))
    expect(mocks.confirm).toHaveBeenCalledWith(db, { userId: OWNER, workspaceId: WS, changeId: 'chg-1', headSha: HEAD })
    expect(mocks.createTools).not.toHaveBeenCalled()
  })

  it('a change no longer waiting refuses the yes: nothing is merged', async () => {
    mocks.permits.mockResolvedValue(false)
    const { card } = await raise()
    expect(await approveToolCall(db as never, owner, card)).toMatchObject({ ok: false, code: 'TOOL_OUT_OF_CEILING' })
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('a website context only ever runs merge_website_change, and only on the chat door', async () => {
    expect(await executeStoredCall(db as never, { workspace_id: WS, user_id: OWNER, tool: 'delete_action', input: {}, conversation_id: null, door: 'chat', context: { website: { changeId: 'chg-1', headSha: HEAD } }, skill_id: null })).toMatchObject({ success: false })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(await approvalCeilingPermits(db as never, { door: 'skill_run', workspace_id: WS, user_id: OWNER, tool: 'merge_website_change', skill_id: 's', context: { website: { changeId: 'chg-1', headSha: HEAD } } })).toBe(false)
  })

  it("the tool is no registry tool: without its website context it can't be approved into running", async () => {
    expect(await approvalCeilingPermits(db as never, { door: 'chat', workspace_id: WS, user_id: OWNER, tool: 'merge_website_change', skill_id: null, context: {} })).toBe(false)
  })
})

describe('the no, and no answer', () => {
  it('a no settles the change as denied', async () => {
    const { card } = await raise()
    await denyToolCall(db as never, owner, card)
    expect(mocks.settle).toHaveBeenCalledWith(db, { id: expect.any(String), workspace_id: WS, context: expect.objectContaining({ website: expect.objectContaining({ changeId: 'chg-1' }) }) }, 'denied')
  })

  it('a lapsed card settles it as expired', async () => {
    const { created } = await raise()
    const row = db.rows('tool_approval').find((r) => r.id === created.approvalId)!
    row.expires_at = new Date(Date.now() - 60_000).toISOString()
    expect(await expireLapsedApprovals(db as never)).toBe(1)
    expect(mocks.settle).toHaveBeenCalledWith(db, { id: expect.any(String), workspace_id: WS, context: expect.objectContaining({ website: expect.objectContaining({ changeId: 'chg-1' }) }) }, 'expired')
  })

  it('any other approval settles no website change', async () => {
    const { card } = await raise({ ...merge, toolName: 'delete_action', sideEffect: 'delete', context: {} })
    await denyToolCall(db as never, owner, card)
    expect(mocks.settle).not.toHaveBeenCalled()
  })
})
