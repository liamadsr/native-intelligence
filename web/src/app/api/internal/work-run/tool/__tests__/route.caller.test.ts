/**
 * The work-run tool route, principal by principal (trust layer P2, S3): a
 * work run's own turns and a turn the main agent relayed into its chat are
 * unattended, a follow-up chat turn is the person. A relayed turn keeps an
 * attended-only tool only when it is the run's bot's real follow-through
 * grant. And the run's own turns record the outside text they read
 * (agent_run.outside_reads, migration 374): every outside-text tool, mail only
 * from a sender the person doesn't know.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-work-run-caller-secret-abcdef'
const executeSpy = vi.fn(async (): Promise<unknown> => ({ ok: true }))
const stubTool = { description: 'stub', inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) }, execute: executeSpy }
vi.mock('@/lib/ai/tools', () => ({
  createTools: () => ({ list_actions: stubTool, revise_email_draft: stubTool, list_bot_work: stubTool, get_attachment_content: stubTool, read_email: stubTool }),
}))
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/tool-discovery')>()),
  createSearchToolsTool: () => ({ ...stubTool, description: 'search' }),
}))
// A run chat's ceiling holding two attended-only tools; the bot is granted only revise_email_draft.
vi.mock('@/lib/agent-run/run-work-spec-rebuild', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-run/run-work-spec-rebuild')>()),
  ceilingForWorkRunTurn: async () => new Set(['list_actions', 'revise_email_draft', 'list_bot_work', 'get_attachment_content', 'read_email']),
}))
vi.mock('@/lib/chat/follow-through', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/follow-through')>()),
  resolveFollowThrough: async () => new Set(['revise_email_draft']),
}))
vi.mock('@/lib/work/touch', () => ({
  recordToolCallTouches: vi.fn(async () => 0),
  resolveWorkItemIdForAgentRun: vi.fn(async () => null),
  entitiesFiledByWork: vi.fn(async () => new Set()),
}))
vi.mock('@/lib/work/review-actions', () => ({ REVIEW_ROUTED_TOOLS: new Set(), reviewActionIdsForWork: async () => [] }))
const known = vi.hoisted(() => ({ addresses: new Set<string>(['dana@acme.com']) }))
vi.mock('@/lib/agent-events/known-senders', () => ({
  knownSenders: async (_db: unknown, args: { addresses: Iterable<string> }) => new Set([...args.addresses].filter((a) => known.addresses.has(a))),
}))
const rpc = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: Record<string, unknown> }> }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'or', 'limit']) c[m] = () => c
      c.maybeSingle = async () => ({
        data: table === 'agent_run'
          ? { id: 'run-1', workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'attempt', ai_team_member_id: 'bot-mail', teammate: null, chat_ceiling: null, action_id: null }
          : null,
        error: null,
      })
      c.then = (resolve: (v: unknown) => void) => resolve({ data: table === 'connected_account' ? [{ account_email: 'me@dial8.ai' }] : [], error: null })
      return c
    }
    return {
      from: (table: string) => chain(table),
      rpc: async (fn: string, args: Record<string, unknown>) => (rpc.calls.push({ fn, args }), { data: null, error: null }),
    }
  },
}))

import { POST } from '@/app/api/internal/work-run/tool/route'
import { mintAgentRunToken, AGENT_RUN_SECRET_HEADER, AGENT_RUN_TOKEN_HEADER, type AgentRunTokenClaims } from '@/lib/agent-run/agent-run-token'

function req(toolName: string, extra: Partial<Omit<AgentRunTokenClaims, 'exp'>> = {}) {
  const token = mintAgentRunToken({ agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', ...extra })
  return new Request('http://localhost/api/internal/work-run/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [AGENT_RUN_SECRET_HEADER]: SECRET, [AGENT_RUN_TOKEN_HEADER]: token },
    body: JSON.stringify({ toolName, input: {} }),
  })
}

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  executeSpy.mockClear()
  executeSpy.mockImplementation(async () => ({ ok: true }))
  rpc.calls.length = 0
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
})

describe('work-run tool route: the caller, per principal', () => {
  it('a follow-up chat turn (the person) runs every attended-only tool its ceiling holds', async () => {
    for (const tool of ['revise_email_draft', 'list_bot_work']) expect((await POST(req(tool, { chat: true }))).status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(2)
  })

  it('a relayed chat turn is unattended: it keeps the bot’s real grant and nothing else', async () => {
    expect((await POST(req('revise_email_draft', { chat: true, relay: true }))).status).toBe(200)
    const refused = await POST(req('list_bot_work', { chat: true, relay: true }))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'CALLER_NOT_ALLOWED', caller: 'agent_unattended' })
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('the run’s own turns, even with a ceiling that drifted to hold one, never run an attended-only tool without a grant', async () => {
    const refused = await POST(req('list_bot_work'))
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe('CALLER_NOT_ALLOWED')
  })
})

describe('work-run tool route: the outside text a run’s own turns read (migration 374)', () => {
  it('an attachment’s content is noted once per call; a workspace read is not', async () => {
    await POST(req('get_attachment_content'))
    await POST(req('list_actions'))
    expect(rpc.calls).toEqual([{ fn: 'agent_run_note_outside_read', args: { p_run_id: 'run-1', p_workspace_id: 'ws-1', p_tool: 'get_attachment_content' } }])
  })

  it('mail counts only from a sender the person doesn’t know (their own mailbox is known)', async () => {
    executeSpy.mockImplementation(async () => ({ messages: [{ from: 'Dana <dana@acme.com>' }, { from: 'me@dial8.ai' }] }))
    await POST(req('read_email'))
    expect(rpc.calls).toEqual([])
    executeSpy.mockImplementation(async () => ({ messages: [{ from: 'Dana <dana@acme.com>' }, { from: 'Mallory <m@evil.example>' }] }))
    await POST(req('read_email'))
    expect(rpc.calls.map((c) => c.args.p_tool)).toEqual(['read_email'])
  })

  it('a follow-up chat turn records nothing (the person is there; memory is taught at settle)', async () => {
    await POST(req('get_attachment_content', { chat: true }))
    expect(rpc.calls).toEqual([])
  })
})
