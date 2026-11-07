/**
 * POST /api/account/chat/eve-persist — a finished turn restarts the
 * conversation's idle-compaction timer (src/lib/chat/idle-compaction-signal.ts):
 * tenancy from the VERIFIED token, ids only (never the caller's Bearer or the
 * token's sealed credential); a refused persist signals nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-abcdefghij'

vi.mock('@/lib/chat/persist-eve-turn', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat/persist-eve-turn')>('@/lib/chat/persist-eve-turn')
  return { ...actual, persistEveTurn: async () => ({ written: true, conversationId: 'conv-1', activityFired: true }) }
})
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: () => {} }))
const requireWorkspaceMock = vi.fn()
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: () => requireWorkspaceMock() }))
const signalChatSessionActivity = vi.fn()
vi.mock('@/lib/chat/idle-compaction-signal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat/idle-compaction-signal')>('@/lib/chat/idle-compaction-signal')
  return { ...actual, signalChatSessionActivity: (a: unknown) => signalChatSessionActivity(a) }
})

import { POST } from '../route'
import { mintChatRunToken, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'
import type { NextRequest } from 'next/server'

const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.c2ln`
const req = (token: string, bearer?: string) =>
  new Request('http://localhost/api/account/chat/eve-persist', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [CHAT_RUN_TOKEN_HEADER]: token,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ messageId: 'm-1', parts: [{ type: 'text', text: 'hi' }] }),
  }) as unknown as NextRequest

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  signalChatSessionActivity.mockClear()
  requireWorkspaceMock.mockReset()
  requireWorkspaceMock.mockResolvedValue({ supabase: {}, user: { id: 'user-1' }, workspaceId: 'ws-1' })
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('eve-persist → idle-compaction signal', () => {
  it('signals the token’s conversation with ids only: no Bearer, no sealed credential', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', cred: 'sealed-at-mint' })
    expect((await POST(req(token, jwt))).status).toBe(200)
    expect(signalChatSessionActivity).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      source: 'turn',
    })
  })

  it('a refused persist (another user’s token) signals nothing', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-2' })
    expect((await POST(req(token))).status).toBe(403)
    expect(signalChatSessionActivity).not.toHaveBeenCalled()
  })
})
