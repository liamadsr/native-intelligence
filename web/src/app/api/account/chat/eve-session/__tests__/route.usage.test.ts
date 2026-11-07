/**
 * POST /api/account/chat/eve-session `{ action: 'usage' }`: the usage check
 * alone. The transport asks it when a turn it sent was cancelled with no
 * answer and no Stop (eve 0.68+: the usage-limit-gate hook cancels a blocked
 * turn) and before an ask_user answer resumes a held turn. Pins: 200 when
 * allowed, and the check's own 429 / 503 Response passed through as-is (so
 * the client's /api 429 watch opens the usage-limit dialog); no row, no token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const state: { db: FakeSupabase | null } = { db: null }
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: state.db, user: { id: 'user-1' }, workspaceId: 'ws-1' }),
}))
const mintChatRunToken = vi.fn((_c: unknown) => 'signed.token')
vi.mock('@/lib/chat/chat-run-token', () => ({
  mintChatRunToken: (c: unknown) => mintChatRunToken(c),
  internalSecret: () => 'test-secret',
}))
const checkUsageLimits = vi.fn(async (_u: string, _s?: AbortSignal, _o?: { chatgptPlan?: boolean }): Promise<void> => undefined)
vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: (u: string, s?: AbortSignal, o?: { chatgptPlan?: boolean }) => checkUsageLimits(u, s, o),
}))

import { POST } from '../route'
import type { NextRequest } from 'next/server'

const req = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  state.db = makeFakeSupabase({ project: true })
})

describe("{ action: 'usage' }", () => {
  it('answers 200 when the caller may run AI, and makes nothing', async () => {
    const res = await POST(req({ action: 'usage' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // The same opt-in as the mint: a free ChatGPT user's chat runs on their plan.
    expect(checkUsageLimits).toHaveBeenCalledWith('user-1', undefined, { chatgptPlan: true })
    expect(mintChatRunToken).not.toHaveBeenCalled()
    expect(state.db!.rows('chat_conversations')).toEqual([])
  })

  it('passes the usage check’s 429 and 503 straight through', async () => {
    const limit = Response.json({ error: 'Usage limit exceeded', reason: 'monthly allowance reached' }, { status: 429 })
    checkUsageLimits.mockRejectedValueOnce(limit)
    expect(await POST(req({ action: 'usage' }))).toBe(limit)
    const down = Response.json({ error: 'Usage check unavailable', code: 'BILLING_UNAVAILABLE' }, { status: 503 })
    checkUsageLimits.mockRejectedValueOnce(down)
    expect(await POST(req({ action: 'usage' }))).toBe(down)
  })
})
