/**
 * POST /api/account/email/draft/send: Mail's Send on a draft in a thread.
 * Workspace auth first; both ids required as strings before anything is sent;
 * edits, when sent, checked before anything goes out; a draft the mailbox no
 * longer holds is a 404 (the pane reloads), one with no recipients a 400, a
 * provider failure a 500 with a plain message (never the provider's raw error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => auth.result }))

const email = vi.hoisted(() => ({ sendProviderDraft: vi.fn() }))
vi.mock('@/lib/integrations/email', () => ({ sendProviderDraft: email.sendProviderDraft }))

const { POST } = await import('../route')

const req = (body: unknown) =>
  new Request('http://x/api/account/email/draft/send', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { user: { id: 'user-1' }, workspaceId: 'ws-1', supabase: {} }
})

describe('POST /api/account/email/draft/send', () => {
  it('sends the draft from the caller’s workspace and returns the sent message', async () => {
    email.sendProviderDraft.mockResolvedValue({ ok: true, threadId: 'thr-1', messageId: 'm-sent' })
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ thread_id: 'thr-1', message_id: 'm-sent' })
    expect(email.sendProviderDraft).toHaveBeenCalledWith('user-1', 'ws-1', 'thr-1', 'm-draft', null)
  })

  it('edits made before sending are passed on, addresses trimmed', async () => {
    email.sendProviderDraft.mockResolvedValue({ ok: true, threadId: 'thr-1', messageId: 'm-sent' })
    const edits = { to: [' simon@harborline.io'], cc: [], subject: 'Re: Next week', body: 'Tuesday works.' }
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft', edits }))
    expect(res.status).toBe(200)
    expect(email.sendProviderDraft).toHaveBeenCalledWith('user-1', 'ws-1', 'thr-1', 'm-draft', {
      to: ['simon@harborline.io'],
      cc: [],
      subject: 'Re: Next week',
      body: 'Tuesday works.',
    })
  })

  it.each([
    ['a recipient with a header smuggled in', { to: ['simon@harborline.io\r\nBcc: x@evil.test'], cc: [], subject: 'Re', body: 'x' }],
    ['no recipient', { to: [], cc: [], subject: 'Re', body: 'x' }],
    ['no body', { to: ['simon@harborline.io'], cc: [], subject: 'Re' }],
    ['edits that are not an object', 'Tuesday works.'],
  ])('%s in the edits is a 400 and nothing is sent', async (_label, edits) => {
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft', edits }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Check the recipients, the subject and the message', code: 'BAD_REQUEST' })
    expect(email.sendProviderDraft).not.toHaveBeenCalled()
  })

  it('an unauthenticated caller gets the auth response and nothing is sent', async () => {
    auth.result = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(401)
    expect(email.sendProviderDraft).not.toHaveBeenCalled()
  })

  it.each([
    ['no draft id', { thread_id: 'thr-1' }],
    ['no thread id', { draft_id: 'm-draft' }],
    ['ids that are not strings', { thread_id: 7, draft_id: ['m-draft'] }],
    ['a body that is not JSON', 'not json'],
  ])('%s is a 400 and nothing is sent', async (_label, body) => {
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_REQUEST')
    expect(email.sendProviderDraft).not.toHaveBeenCalled()
  })

  it('a draft the mailbox no longer holds is a 404 that says so', async () => {
    email.sendProviderDraft.mockResolvedValue({ ok: false, reason: 'not_found' })
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/no longer in your mailbox/)
  })

  it('a draft with no recipients is a 400 that says so', async () => {
    email.sendProviderDraft.mockResolvedValue({ ok: false, reason: 'no_recipients' })
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This draft has no recipients')
  })

  it('a provider failure is a 500 with a plain message, the detail only in the log', async () => {
    email.sendProviderDraft.mockRejectedValue(new Error('Gmail draft send error: 500 - {"error":"backend"}'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(req({ thread_id: 'thr-1', draft_id: 'm-draft' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not send the email', code: 'INTERNAL' })
    expect(logged).toHaveBeenCalledWith('[email] draft send failed:', 'Gmail draft send error: 500 - {"error":"backend"}')
    logged.mockRestore()
  })
})
