/**
 * POST /api/account/chat/eve-session — a conversation FOCUSED on an area
 * (one-agent plan S3, migration 318): an area face's page chat. Over the
 * shared fake (`project` mode). Pins:
 *   - the ordinary mint with `focusArea` makes a new conversation stamped
 *     with it, and signs `focusArea` into a MAIN-agent token: no teammate,
 *     no `teammateIn`, no agent;
 *   - a focus is fixed: an existing conversation keeps its own focus (or
 *     none), whatever the body says, and later sends sign the row's;
 *   - a value that isn't an area key is a 400 naming the keys, nothing made;
 *   - `{ action: 'focus' }` gets the caller's latest conversation focused on
 *     the area here, else makes one, with no token and no usage gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The idle-compaction signal is covered in route.idle-compaction.test.ts: no Inngest here.
vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { offOverrides } from '@/test/editions'

const state: { db: FakeSupabase | null } = { db: null }
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: state.db, user: { id: 'user-1' }, workspaceId: 'ws-1' }),
}))
const mintChatRunToken = vi.fn((_c: unknown) => 'signed.token')
vi.mock('@/lib/chat/chat-run-token', () => ({
  mintChatRunToken: (c: unknown) => mintChatRunToken(c),
  internalSecret: () => 'test-secret',
}))
const checkUsageLimits = vi.fn(async (_u: string): Promise<void> => undefined)
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: (u: string) => checkUsageLimits(u) }))
vi.mock('@/lib/chat/chat-run-credential', () => ({ sealRunCredential: () => 'sealed' }))
vi.mock('@/lib/chat/conversation-history', () => ({ renderConversationPrimer: async () => null }))

import { POST } from '../route'
import type { NextRequest } from 'next/server'

const req = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

const conversations = () => state.db!.rows('chat_conversations')
const claims = () => mintChatRunToken.mock.calls.map((c) => c[0] as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  const db = makeFakeSupabase({ project: true })
  db.seed('chat_conversations', [
    { id: 'conv-plain', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: null, updated_at: '2026-10-01T00:00:00Z' },
    { id: 'conv-mail-old', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: 's-old', agent_teammate_id: null, focus_area: 'mail', updated_at: '2026-10-01T00:00:00Z' },
    { id: 'conv-mail-new', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: 's-new', agent_teammate_id: null, focus_area: 'mail', updated_at: '2026-10-05T00:00:00Z' },
    { id: 'conv-mail-elsewhere', user_id: 'user-1', workspace_id: 'ws-2', eve_session_id: null, agent_teammate_id: null, focus_area: 'mail', updated_at: '2026-10-09T00:00:00Z' },
    { id: 'conv-mail-theirs', user_id: 'user-2', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: 'mail', updated_at: '2026-10-09T00:00:00Z' },
  ])
  db.seed('recipe', [])
  state.db = db
})

describe('mint — a focused conversation (one-agent S3)', () => {
  it('a first send makes a conversation stamped with the area, and a main-agent token carrying it', async () => {
    const res = await POST(req({ action: 'mint', conversationId: null, focusArea: 'captures' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ token: 'signed.token', focusArea: 'captures' })
    const made = conversations().find((c) => c.id === body.conversationId)!
    expect(made).toMatchObject({ user_id: 'user-1', workspace_id: 'ws-1', focus_area: 'captures' })
    const [signed] = claims()
    expect(signed).toMatchObject({ conversationId: body.conversationId, workspaceId: 'ws-1', userId: 'user-1', focusArea: 'captures' })
    for (const key of ['teammateId', 'teammateIn', 'agentId']) expect(signed).not.toHaveProperty(key)
  })

  it('a focus is fixed: an existing conversation signs its own, whatever the body says', async () => {
    await POST(req({ action: 'mint', conversationId: 'conv-mail-new', focusArea: 'crm' }))
    await POST(req({ action: 'mint', conversationId: 'conv-plain', focusArea: 'crm' }))
    const [focused, plain] = claims()
    expect(focused).toMatchObject({ conversationId: 'conv-mail-new', focusArea: 'mail' })
    expect(plain).toMatchObject({ conversationId: 'conv-plain' })
    expect(plain).not.toHaveProperty('focusArea')
    expect(conversations().find((c) => c.id === 'conv-plain')!.focus_area).toBeNull()
  })

  it('a value that isn’t an area is a 400 naming the keys, and nothing is made', async () => {
    const before = conversations().length
    const res = await POST(req({ action: 'mint', conversationId: null, focusArea: 'inbox' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('focusArea must be one of calendar, actions, captures')
    expect(conversations()).toHaveLength(before)
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })
})

describe("{ action: 'focus' } — an area face's page chat", () => {
  it('opens the caller’s latest conversation focused on the area here, with no token and no usage gate', async () => {
    const res = await POST(req({ action: 'focus', focusArea: 'mail' }))
    expect(await res.json()).toEqual({ conversationId: 'conv-mail-new', workspaceId: 'ws-1', eveSessionId: 's-new', focusArea: 'mail' })
    expect(mintChatRunToken).not.toHaveBeenCalled()
    expect(checkUsageLimits).not.toHaveBeenCalled()
  })

  it('makes one when there is none (never another workspace’s or another person’s)', async () => {
    const res = await POST(req({ action: 'focus', focusArea: 'prospecting' }))
    const body = await res.json()
    expect(body).toMatchObject({ workspaceId: 'ws-1', eveSessionId: null, focusArea: 'prospecting' })
    expect(conversations().find((c) => c.id === body.conversationId)).toMatchObject({ user_id: 'user-1', workspace_id: 'ws-1', focus_area: 'prospecting' })
  })

  it('refuses a value that isn’t an area', async () => {
    expect((await POST(req({ action: 'focus', focusArea: 'nope' }))).status).toBe(400)
  })
})

describe('a focus on an area that is switched off (S3 review)', () => {
  // Every feature is on by default, so the workspace switches Evals off itself.
  const evalsOff = () =>
    state.db!.seed('workspace', [{ id: 'ws-1', settings: { feature_overrides: offOverrides(['evals']) } }])

  it('the mint and the page chat refuse it with the fix, and make nothing', async () => {
    evalsOff()
    const before = conversations().length
    const minted = await POST(req({ action: 'mint', conversationId: null, focusArea: 'evals' }))
    expect(minted.status).toBe(400)
    const body = await minted.json()
    expect(body.code).toBe('AREA_OFF')
    expect(body.error).toContain('Evals is switched off in this workspace')
    expect(body.error).toContain('Settings → Features')
    const page = await POST(req({ action: 'focus', focusArea: 'evals' }))
    expect(page.status).toBe(400)
    expect((await page.json()).code).toBe('AREA_OFF')
    expect(conversations()).toHaveLength(before)
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('on (the default, no overrides), it focuses as any other area', async () => {
    const res = await POST(req({ action: 'mint', conversationId: null, focusArea: 'evals' }))
    expect(res.status).toBe(200)
    expect(claims()[0]).toMatchObject({ focusArea: 'evals' })
  })

  it('a conversation focused before its area went off keeps its focus', async () => {
    evalsOff()
    state.db!.seed('chat_conversations', [
      { id: 'conv-evals', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: null, agent_teammate_id: null, focus_area: 'evals', updated_at: '2026-10-01T00:00:00Z' },
    ])
    const res = await POST(req({ action: 'mint', conversationId: 'conv-evals' }))
    expect(res.status).toBe(200)
    expect(claims()[0]).toMatchObject({ conversationId: 'conv-evals', focusArea: 'evals' })
  })
})
