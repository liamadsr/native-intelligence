/**
 * POST /api/account/chat/eve-session — a teammate chat's turn about one of the
 * caller's own items (bots v3 1d). The ref is checked on the CALLER's client
 * (acceptTeammateAbout) in the teammate's workspace; only then are its ids
 * signed into the token (aboutWorkItemId / aboutCardId). A refused one mints
 * without it and says so (`about: false`); a body with no ref is unchanged;
 * the ordinary (non-teammate) mint never signs one. A SYSTEM teammate (the
 * Assistant, an area face: one face, always-on-agent §2c) gets no new thread
 * and no send: its old thread is read only.
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
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: async () => undefined }))
vi.mock('@/lib/chat/chat-run-credential', () => ({ sealRunCredential: () => 'sealed' }))
vi.mock('@/lib/chat/conversation-history', () => ({ renderConversationPrimer: async () => null }))
const WRITER = { id: 'tm-1', workspaceId: 'ws-TEAMMATE', name: 'Writer', isSystem: false, systemKey: null }
const TEAMMATE: { current: { id: string; workspaceId: string; name: string; isSystem: boolean; systemKey: string | null } } = { current: WRITER }
const ensureTeammateThread = vi.fn(async (..._a: unknown[]) => ({ id: 'conv-tm', eveSessionId: null, created: false }))
const findTeammateThread = vi.fn(async (..._a: unknown[]): Promise<unknown> => null)
vi.mock('@/lib/chat/teammate-chat', () => ({
  resolveVisibleTeammate: async () => TEAMMATE.current,
  ensureTeammateThread: (...a: unknown[]) => ensureTeammateThread(...a),
  findTeammateThread: (...a: unknown[]) => findTeammateThread(...a),
}))
const acceptTeammateAbout = vi.fn(async (..._a: unknown[]): Promise<unknown> => null)
vi.mock('@/lib/chat/teammate-about', () => ({ acceptTeammateAbout: (...a: unknown[]) => acceptTeammateAbout(...a) }))

import { POST } from '../route'
import type { NextRequest } from 'next/server'

const JOB = '77777777-7777-4777-8777-777777777777'
const CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000011'

const req = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  TEAMMATE.current = WRITER
  acceptTeammateAbout.mockImplementation(async (_s, ref) => ref)
  findTeammateThread.mockImplementation(async () => null)
})

describe('a system teammate (one face): no new thread, no send', () => {
  const ASSISTANT = { id: 'tm-as', workspaceId: 'ws-TEAMMATE', name: 'Assistant', isSystem: true, systemKey: 'assistant' }

  it('a mint (a send) to it is refused as read-only, with no token and no thread made', async () => {
    TEAMMATE.current = ASSISTANT
    const res = await POST(req({ action: 'mint', teammateId: 'tm-as' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'SYSTEM_TEAMMATE_READ_ONLY' })
    expect(mintChatRunToken).not.toHaveBeenCalled()
    expect(ensureTeammateThread).not.toHaveBeenCalled()
  })

  it('opening its thread finds an old one, read-only, and never makes one', async () => {
    TEAMMATE.current = { ...ASSISTANT, id: 'tm-mail', name: 'Mail', systemKey: 'mail' }
    const none = await POST(req({ action: 'thread', teammateId: 'tm-mail' }))
    expect(none.status).toBe(404)
    expect(await none.json()).toMatchObject({ code: 'SYSTEM_TEAMMATE_NO_THREAD' })
    findTeammateThread.mockImplementationOnce(async () => ({ id: 'conv-old', eveSessionId: 'sess-old', created: false }))
    const old = await POST(req({ action: 'thread', teammateId: 'tm-mail' }))
    expect(old.status).toBe(200)
    expect(await old.json()).toMatchObject({ conversationId: 'conv-old', workspaceId: 'ws-TEAMMATE', teammate: { id: 'tm-mail' } })
    expect(ensureTeammateThread).not.toHaveBeenCalled()
  })

  it('another teammate still gets its thread made', async () => {
    const res = await POST(req({ action: 'thread', teammateId: 'tm-1' }))
    expect(res.status).toBe(200)
    expect(ensureTeammateThread).toHaveBeenCalledTimes(1)
  })
})

describe('mint — a teammate chat about one of the caller’s items', () => {
  it('checks the item on the caller’s client in the teammate’s workspace, then signs its id', async () => {
    const res = await POST(req({ action: 'mint', teammateId: 'tm-1', about: { workItemId: JOB, text: 'never sent on' } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ token: 'signed.token', about: true })
    expect(acceptTeammateAbout).toHaveBeenCalledWith(supabaseMock, { workItemId: JOB }, { workspaceId: 'ws-TEAMMATE', teammateId: 'tm-1' })
    expect(mintChatRunToken).toHaveBeenCalledWith({
      conversationId: 'conv-tm',
      workspaceId: 'ws-TEAMMATE',
      userId: 'user-1',
      teammateId: 'tm-1',
      aboutWorkItemId: JOB,
    })
  })

  it('a card ref signs aboutCardId', async () => {
    await POST(req({ action: 'mint', teammateId: 'tm-1', about: { cardId: CARD } }))
    expect(mintChatRunToken).toHaveBeenCalledWith(expect.objectContaining({ aboutCardId: CARD }))
    expect(mintChatRunToken.mock.calls[0][0]).not.toHaveProperty('aboutWorkItemId')
  })

  it('an item that isn’t the caller’s mints without it, and says so', async () => {
    acceptTeammateAbout.mockImplementationOnce(async () => null)
    const res = await POST(req({ action: 'mint', teammateId: 'tm-1', about: { workItemId: JOB } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ about: false })
    const claims = mintChatRunToken.mock.calls[0][0] as Record<string, unknown>
    expect(claims).not.toHaveProperty('aboutWorkItemId')
    expect(claims).not.toHaveProperty('aboutCardId')
  })

  it('no ref (or a malformed one): nothing checked, no about in the answer', async () => {
    const res = await POST(req({ action: 'mint', teammateId: 'tm-1', about: { workItemId: 'not-a-uuid' } }))
    expect(await res.json()).not.toHaveProperty('about')
    expect(mintChatRunToken.mock.calls[0][0]).not.toHaveProperty('aboutWorkItemId')
  })

  it('the ordinary mint never signs one', async () => {
    supabaseMock.from.mockImplementation(() => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.insert = () => c
      c.maybeSingle = async () => ({ data: null })
      c.single = async () => ({ data: { id: 'conv-new' }, error: null })
      return c
    })
    await POST(req({ action: 'mint', about: { workItemId: JOB } }))
    expect(acceptTeammateAbout).not.toHaveBeenCalled()
    expect(mintChatRunToken.mock.calls[0][0]).not.toHaveProperty('aboutWorkItemId')
  })
})
