/**
 * The skill-run tool route's connected-app branch (F4): an mcp__ name runs
 * only when the TOKEN's connections hold it (skill-run-connections.ts), after
 * the trust authority, the kill switch, the go-ahead flag and a dry run; a
 * chat turn never reaches it (its own ceiling). The token's new claims are
 * shape-checked: a bad one is no token at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECRET = 'test-internal-secret-connections'
const state = vi.hoisted(() => ({
  paused: false,
  entries: new Map<string, unknown>(),
  ran: [] as Array<{ name: string; input: unknown }>,
  bindingRefusal: null as Response | null,
}))
vi.mock('@/lib/flows/skill-run-binding', () => ({ skillRunBindingRefusal: async () => state.bindingRefusal }))
vi.mock('@/lib/work/agent-paused', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/work/agent-paused')>()),
  checkAgentPaused: async () => state.paused,
}))
vi.mock('@/lib/work/touch', () => ({ recordToolCallTouches: vi.fn(async () => undefined), entitiesFiledByWork: vi.fn(async () => new Set()) }))
vi.mock('@/lib/work/review-actions', () => ({ REVIEW_ROUTED_TOOLS: new Set(), reviewActionIdsForWork: async () => [] }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: () => { throw new Error('no db in this test') } }) }))
vi.mock('@/lib/ai/tools', () => ({ createTools: () => ({}) }))
vi.mock('@/lib/flows/skill-run-chat-ceiling', () => ({ resolveSkillRunChatCeiling: async () => new Set(['list_actions']) }))
vi.mock('@/lib/flows/skill-run-connections', () => ({
  runConnectionTools: async (_db: unknown, claims: { connections?: string[]; chat?: unknown }) => (claims.chat || !claims.connections?.length ? new Map() : state.entries),
  runConnectionTool: async (_db: unknown, _claims: unknown, entry: { name: string; requiresApproval: boolean }, input: unknown) => {
    state.ran.push({ name: entry.name, input })
    return { status: 200, output: { success: true, ran: entry.name } }
  },
}))

import { POST } from '@/app/api/internal/skill-run/tool/route'
import { mintRunToken, RUN_SKILL_SECRET_HEADER, RUN_SKILL_TOKEN_HEADER, verifyRunToken, type RunTokenClaims } from '@/lib/flows/skill-run-token'

const CONN = 'aaaaaaaa-0000-4000-8000-000000000001'
const base = {
  workspaceId: 'ws-1', runAsUserId: 'user-1', skillId: 'skill-1', mode: 'act' as const, hasCapture: false,
  outputContract: 'prose' as const, model: 'm', connections: [CONN], flowStep: { flowId: 'flow-1', actionId: 'post', flowRunId: 'run-1' },
}
function req(toolName: string, extra: Partial<Omit<RunTokenClaims, 'exp'>> = {}, input: unknown = { content: 'x' }) {
  return new Request('http://localhost/api/internal/skill-run/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [RUN_SKILL_SECRET_HEADER]: SECRET, [RUN_SKILL_TOKEN_HEADER]: mintRunToken({ ...base, ...extra }) },
    body: JSON.stringify({ toolName, input }),
  })
}

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  state.paused = false
  state.ran.length = 0
  state.entries = new Map([['mcp__typefully__create_draft', { name: 'mcp__typefully__create_draft', requiresApproval: true }]])
  state.bindingRefusal = null
})

describe('the connected-app branch', () => {
  it('a tool the token\'s connections hold runs through runConnectionTool', async () => {
    const res = await POST(req('mcp__typefully__create_draft'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ output: { success: true, ran: 'mcp__typefully__create_draft' } })
  })

  it('a token that fails the DB binding is refused before anything runs (gate 3)', async () => {
    state.bindingRefusal = Response.json({ error: 'unbound', code: 'RUN_TOKEN_UNBOUND' }, { status: 403 })
    const res = await POST(req('mcp__typefully__create_draft'))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'RUN_TOKEN_UNBOUND' })
    expect(state.ran).toHaveLength(0)
  })

  it('any other mcp__ name, or a token with no connections, is out of the ceiling', async () => {
    expect((await POST(req('mcp__other__tool'))).status).toBe(403)
    expect((await POST(req('mcp__typefully__create_draft', { connections: undefined }))).status).toBe(403)
    expect(state.ran).toEqual([])
  })

  it('the kill switch and the go-ahead flag stop it first; a dry run echoes a write', async () => {
    state.paused = true
    expect((await (await POST(req('mcp__typefully__create_draft'))).json()).output.code).toBe('AGENT_PAUSED')
    state.paused = false
    const noYes = await (await POST(req('mcp__typefully__create_draft', {}, { content: 'x', confirmed_with_user: true }))).json()
    expect(noYes.output.success).toBe(false)
    const dry = await (await POST(req('mcp__typefully__create_draft', { dryRun: true, flowStep: undefined }))).json()
    expect(JSON.stringify(dry.output)).toMatch(/test|dry|would/i)
    expect(state.ran).toEqual([])
  })

  it('a chat turn never reaches it (the bot\'s own ceiling refuses an mcp__ name it lacks)', async () => {
    const res = await POST(req('mcp__typefully__create_draft', { chat: { teammateId: 'bot-1' }, flowStep: undefined }))
    expect(res.status).toBe(403)
    expect(state.ran).toEqual([])
  })
})

describe('the token\'s F4 claims', () => {
  it('connections are uuids (at most 5); a flow step names its flow and step, never on a chat turn or a dry run', () => {
    const verify = (extra: Record<string, unknown>) => verifyRunToken(mintRunToken({ ...base, ...extra } as never))
    expect(verify({})).not.toBeNull()
    expect(verify({ connections: ['not-a-uuid'] })).toBeNull()
    expect(verify({ connections: Array(6).fill(CONN) })).toBeNull()
    expect(verify({ flowStep: { flowId: 'f' } })).toBeNull()
    expect(verify({ chat: { teammateId: 'bot' } })).toBeNull()
    expect(verify({ dryRun: true })).toBeNull()
    expect(verify({ dryRun: true, flowStep: undefined })).not.toBeNull()
  })
})
