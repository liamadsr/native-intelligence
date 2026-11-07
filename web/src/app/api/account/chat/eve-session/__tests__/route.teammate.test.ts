/**
 * POST /api/account/chat/eve-session — the TEAMMATE-chat path (bots v2, Phase 1).
 *
 * Pins:
 *   - mint { teammateId }: the usage gate still runs first; the teammate is
 *     resolved on the CALLER's client (RLS) and the thread got-or-created; the
 *     token is minted for the TEAMMATE's workspace (not the caller's current
 *     one) with a `teammateId` claim and no agentId (the persona is resolved
 *     server-side at spec time, never via the RLS agentId check — and the
 *     body's conversationId/agentId are ignored); the response carries the
 *     workspace the client sends as x-workspace-id;
 *   - a skill picked in the full composer (bots v4): checked on the caller's
 *     RLS client, the teammate's workspace's own or a system one, then signed
 *     in; any other is a 400 with no token;
 *   - a primer only for an EXISTING thread;
 *   - a teammate the caller can't see → 404 (no token); a thread in another
 *     workspace → 409; a device token → 403; a lookup error → 500;
 *   - thread { teammateId }: the same checks, no usage gate, no token.
 * The helpers themselves (RLS visibility, membership, the upsert) are pinned
 * in src/lib/chat/__tests__/teammate-chat.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The idle-compaction signal is covered in route.idle-compaction.test.ts: no Inngest here.
vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))

const supabaseMock = { from: vi.fn() }
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: supabaseMock, user: { id: 'user-1' }, workspaceId: 'ws-CURRENT' }),
}))

const mintChatRunToken = vi.fn((_c: unknown) => 'signed.token')
vi.mock('@/lib/chat/chat-run-token', () => ({
  mintChatRunToken: (c: unknown) => mintChatRunToken(c),
  internalSecret: () => 'test-secret',
}))
const checkUsageLimits = vi.fn(async (_u: string): Promise<void> => undefined)
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: (u: string) => checkUsageLimits(u) }))
vi.mock('@/lib/chat/chat-run-credential', () => ({ sealRunCredential: () => 'sealed' }))
const renderConversationPrimer = vi.fn(async (..._a: unknown[]): Promise<string | null> => '<conversation-so-far/>')
vi.mock('@/lib/chat/conversation-history', () => ({
  renderConversationPrimer: (...a: unknown[]) => renderConversationPrimer(...a),
}))

const TEAMMATE = { id: 'tm-1', workspaceId: 'ws-TEAMMATE', name: 'Writer', isSystem: false, systemKey: null }
const resolveVisibleTeammate = vi.fn(async (..._a: unknown[]): Promise<unknown> => TEAMMATE)
const ensureTeammateThread = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 'conv-tm', eveSessionId: 'wrun_tm', created: false }))
vi.mock('@/lib/chat/teammate-chat', () => ({
  resolveVisibleTeammate: (...a: unknown[]) => resolveVisibleTeammate(...a),
  ensureTeammateThread: (...a: unknown[]) => ensureTeammateThread(...a),
}))

import { POST } from '../route'
import type { NextRequest } from 'next/server'

const req = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  resolveVisibleTeammate.mockImplementation(async () => TEAMMATE)
  ensureTeammateThread.mockImplementation(async () => ({ id: 'conv-tm', eveSessionId: 'wrun_tm', created: false }))
})

describe('mint — teammate chat', () => {
  it('mints for the TEAMMATE’s workspace with a teammateId claim, ignoring the body’s conversation/agent', async () => {
    const res = await POST(
      req({ action: 'mint', teammateId: 'tm-1', conversationId: 'someone-elses', agentId: 'ag-x' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      token: 'signed.token',
      conversationId: 'conv-tm',
      eveSessionId: 'wrun_tm',
      workspaceId: 'ws-TEAMMATE',
    })
    expect(mintChatRunToken).toHaveBeenCalledWith({
      conversationId: 'conv-tm',
      workspaceId: 'ws-TEAMMATE',
      userId: 'user-1',
      teammateId: 'tm-1',
    })
    // Resolved on the caller's RLS client, the thread for this user + teammate.
    expect(resolveVisibleTeammate).toHaveBeenCalledWith(supabaseMock, 'user-1', 'tm-1')
    expect(ensureTeammateThread).toHaveBeenCalledWith(supabaseMock, { userId: 'user-1', teammate: TEAMMATE })
    // No RLS recipe check for the persona (a system teammate's recipe is invisible under RLS).
    expect(supabaseMock.from).not.toHaveBeenCalledWith('recipe')
  })

  it('runs the usage gate first: a blocked user gets no thread and no token', async () => {
    checkUsageLimits.mockImplementationOnce(async () => {
      throw new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 })
    })
    const res = await POST(req({ action: 'mint', teammateId: 'tm-1' }))
    expect(res.status).toBe(429)
    expect(resolveVisibleTeammate).not.toHaveBeenCalled()
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('a primer only for an EXISTING thread', async () => {
    const existing = await (await POST(req({ action: 'mint', teammateId: 'tm-1', wantHistory: true }))).json()
    expect(existing.historyPrimer).toBe('<conversation-so-far/>')
    expect(renderConversationPrimer).toHaveBeenCalledWith(supabaseMock, {
      conversationId: 'conv-tm',
      userId: 'user-1',
      workspaceId: 'ws-TEAMMATE',
    })
    ensureTeammateThread.mockImplementationOnce(async () => ({ id: 'conv-new', eveSessionId: null, created: true }))
    renderConversationPrimer.mockClear()
    const created = await (await POST(req({ action: 'mint', teammateId: 'tm-1', wantHistory: true }))).json()
    expect(created).toMatchObject({ conversationId: 'conv-new', eveSessionId: null, historyPrimer: null })
    expect(renderConversationPrimer).not.toHaveBeenCalled()
  })

  it('a teammate the caller cannot see → 404, no thread, no token', async () => {
    resolveVisibleTeammate.mockImplementationOnce(async () => null)
    const res = await POST(req({ action: 'mint', teammateId: 'tm-private' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('TEAMMATE_NOT_FOUND')
    expect(ensureTeammateThread).not.toHaveBeenCalled()
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('a thread in another workspace → 409; a lookup error → 500', async () => {
    ensureTeammateThread.mockImplementationOnce(async () => null)
    expect((await POST(req({ action: 'mint', teammateId: 'tm-1' }))).status).toBe(409)
    resolveVisibleTeammate.mockImplementationOnce(async () => {
      throw new Error('db down')
    })
    expect((await POST(req({ action: 'mint', teammateId: 'tm-1' }))).status).toBe(500)
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('a device token is refused (a teammate chat is an in-app conversation)', async () => {
    const res = await POST(req({ action: 'mint', teammateId: 'tm-1' }, { Authorization: 'Bearer d8d_abc' }))
    expect(res.status).toBe(403)
    expect(resolveVisibleTeammate).not.toHaveBeenCalled()
  })

  it('without a teammateId the ordinary mint is unchanged (no teammate claim, no workspace in the body)', async () => {
    supabaseMock.from.mockImplementation(() => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'insert']) c[m] = () => c
      c.maybeSingle = async () => ({ data: null, error: null })
      c.single = async () => ({ data: { id: 'conv-plain' }, error: null })
      return c
    })
    const json = await (await POST(req({ action: 'mint' }))).json()
    expect(json).toEqual({ token: 'signed.token', conversationId: 'conv-plain', eveSessionId: null })
    expect(mintChatRunToken).toHaveBeenCalledWith({ conversationId: 'conv-plain', workspaceId: 'ws-CURRENT', userId: 'user-1' })
    expect(resolveVisibleTeammate).not.toHaveBeenCalled()
  })
})

describe('thread — open a teammate chat before the first send', () => {
  it('answers the thread, its workspace and the teammate — no usage gate, no token', async () => {
    const res = await POST(req({ action: 'thread', teammateId: 'tm-1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      conversationId: 'conv-tm',
      workspaceId: 'ws-TEAMMATE',
      eveSessionId: 'wrun_tm',
      teammate: { id: 'tm-1', name: 'Writer' },
    })
    expect(checkUsageLimits).not.toHaveBeenCalled()
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('needs a teammateId, and refuses one the caller cannot see', async () => {
    expect((await POST(req({ action: 'thread' }))).status).toBe(400)
    resolveVisibleTeammate.mockImplementationOnce(async () => null)
    expect((await POST(req({ action: 'thread', teammateId: 'tm-x' }))).status).toBe(404)
  })
})

describe('mint — a skill picked in a teammate chat’s full composer (bots v4)', () => {
  /** The caller's RLS read of the skill: `row` is what it sees (null: nothing). */
  function skillRead(row: Record<string, unknown> | null) {
    const reads: Array<[string, unknown]> = []
    supabaseMock.from.mockImplementation((table: string) => {
      expect(table).toBe('recipe')
      const chain = {
        select: () => chain,
        eq: (col: string, v: unknown) => (reads.push([col, v]), chain),
        maybeSingle: async () => ({ data: row, error: null }),
      }
      return chain
    })
    return reads
  }

  it('signs in a skill of the teammate’s workspace, checked on the caller’s client', async () => {
    const reads = skillRead({ id: 'sk-1', workspace_id: 'ws-TEAMMATE', is_system: false })
    const res = await POST(req({ action: 'mint', teammateId: 'tm-1', skillId: 'sk-1' }))
    expect(res.status).toBe(200)
    expect(reads).toEqual([['id', 'sk-1'], ['category', 'skill']])
    expect(mintChatRunToken).toHaveBeenCalledWith({
      conversationId: 'conv-tm',
      workspaceId: 'ws-TEAMMATE',
      userId: 'user-1',
      teammateId: 'tm-1',
      skillId: 'sk-1',
    })
  })

  it('a system skill is fine too', async () => {
    skillRead({ id: 'sk-sys', workspace_id: null, is_system: true })
    expect((await POST(req({ action: 'mint', teammateId: 'tm-1', skillId: 'sk-sys' }))).status).toBe(200)
    expect(mintChatRunToken).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'sk-sys' }))
  })

  it('another workspace’s skill, or one the caller can’t see, is a 400 with no token', async () => {
    skillRead({ id: 'sk-2', workspace_id: 'ws-CURRENT', is_system: false })
    const other = await POST(req({ action: 'mint', teammateId: 'tm-1', skillId: 'sk-2' }))
    expect(other.status).toBe(400)
    skillRead(null)
    const unseen = await POST(req({ action: 'mint', teammateId: 'tm-1', skillId: 'sk-3' }))
    expect(unseen.status).toBe(400)
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })
})

