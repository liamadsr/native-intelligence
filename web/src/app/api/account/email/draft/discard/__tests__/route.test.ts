/**
 * POST /api/account/email/draft/discard: Mail's Discard on a draft in a thread.
 * Workspace auth first; both ids required as strings before anything is
 * deleted; a draft the mailbox no longer holds is a 404 (the pane reloads);
 * whether the thread is still in Mail comes back as `thread_remains`; a
 * provider failure is a 500 with a plain message (never the provider's raw
 * error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => auth.result }))

const email = vi.hoisted(() => ({ discardProviderDraft: vi.fn() }))
vi.mock('@/lib/integrations/email', () => ({ discardProviderDraft: email.discardProviderDraft }))

const { POST } = await import('../route')

const req = (body: unknown) =>
  new Request('http://x/api/account/email/draft/discard', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { user: { id: 'user-1' }, workspaceId: 'ws-1', supabase: {} }
})

describe('POST /api/account/email/draft/discard', () => {
  it('discards the draft from the caller’s workspace, and says whether the thread remains', async () => {
    email.discardProviderDraft.mockResolvedValue({ ok: true, threadRemains: true })
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ thread_id: 'thr-1', thread_remains: true })
    expect(email.discardProviderDraft).toHaveBeenCalledWith('user-1', 'ws-1', 'thr-1', 'm-draft')

    email.discardProviderDraft.mockResolvedValue({ ok: true, threadRemains: false })
    expect(await (await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))).json()).toEqual({
      thread_id: 'thr-1',
      thread_remains: false,
    })
  })

  it('an unauthenticated caller gets the auth response and nothing is discarded', async () => {
    auth.result = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(401)
    expect(email.discardProviderDraft).not.toHaveBeenCalled()
  })

  it.each([
    ['no draft id', { thread_id: 'thr-1' }],
    ['no thread id', { draft_id: 'm-draft' }],
    ['ids that are not strings', { thread_id: 7, draft_id: ['m-draft'] }],
    ['a body that is not JSON', 'not json'],
  ])('%s is a 400 and nothing is discarded', async (_label, body) => {
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_REQUEST')
    expect(email.discardProviderDraft).not.toHaveBeenCalled()
  })

  it('a draft the mailbox no longer holds is a 404 that says so', async () => {
    email.discardProviderDraft.mockResolvedValue({ ok: false, reason: 'not_found' })
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/no longer in your mailbox/)
  })

  it('a provider failure is a 500 with a plain message, the detail only in the log', async () => {
    email.discardProviderDraft.mockRejectedValue(new Error('Gmail draft delete error: 500'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not discard the draft', code: 'INTERNAL' })
    expect(logged).toHaveBeenCalledWith('[email] draft discard failed:', 'Gmail draft delete error: 500')
    logged.mockRestore()
  })
})
