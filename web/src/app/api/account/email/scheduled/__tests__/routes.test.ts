/**
 * Send later's routes: workspace auth first; create refuses a time in the
 * past, bad recipients and a mailbox that is not the caller's, and passes the
 * caller's own ids on; list reads the caller's own rows on their session;
 * cancel, send-now and dismiss act only on the caller's own row (404
 * otherwise) and only in the state each needs (409 otherwise). The browser
 * never gets a draft's provider id. Made-up people and companies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => auth.result }))

const lib = vi.hoisted(() => ({
  scheduleNewMessage: vi.fn(),
  scheduleExistingDraft: vi.fn(),
  cancelScheduledSend: vi.fn(),
  dismissScheduledSend: vi.fn(),
  ownScheduledSend: vi.fn(),
  sendScheduledEmail: vi.fn(),
}))
vi.mock('@/lib/email/scheduled-send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/scheduled-send')>()
  return { ...actual, ...lib }
})
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn() }))
vi.mock('@/lib/crm/email-client', () => ({ saveDraftToProvider: vi.fn() }))
vi.mock('@/lib/integrations/email', () => ({ pinnedMailbox: vi.fn(), sendProviderDraft: vi.fn(), updateProviderDraft: vi.fn() }))

const { GET, POST } = await import('../route')
const { POST: CANCEL } = await import('../[id]/cancel/route')
const { POST: SEND_NOW } = await import('../[id]/send-now/route')
const { DELETE: DISMISS } = await import('../[id]/route')

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const params = (id = ID) => ({ params: Promise.resolve({ id }) })
const req = (body: unknown) => new Request('http://x/api/account/email/scheduled', { method: 'POST', body: JSON.stringify(body) })
const future = () => new Date(Date.now() + 86_400_000).toISOString()
const ROW = {
  id: ID,
  workspace_id: 'ws-1',
  user_id: 'user-1',
  account_id: 'acct-1',
  provider: 'google',
  provider_draft_id: 'r-5551234',
  thread_id: null,
  to_emails: ['dana@harborline.example'],
  subject: 'Q4 renewal',
  send_at: future(),
  status: 'scheduled',
  error: null,
  sent_at: null,
  created_at: new Date().toISOString(),
}
const compose = (over: Record<string, unknown> = {}) => ({
  account_id: 'acct-1',
  to: ['dana@harborline.example'],
  subject: 'Q4 renewal',
  body_html: '<p>Hi Dana</p>',
  send_at: future(),
  ...over,
})

let listQuery: { calls: Array<[string, unknown]>; data: unknown[] }

beforeEach(() => {
  vi.clearAllMocks()
  listQuery = { calls: [], data: [] }
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
    q[m] = (a: string, b: unknown) => (listQuery.calls.push([`${m}:${a}`, b]), q)
  }
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: listQuery.data, error: null }).then(ok)
  auth.result = { user: { id: 'user-1' }, workspaceId: 'ws-1', supabase: { from: () => q } }
})

describe('POST /api/account/email/scheduled (create)', () => {
  it('schedules a new message from the caller’s own mailbox, and answers without the draft’s id', async () => {
    lib.scheduleNewMessage.mockResolvedValue({ ok: true, row: ROW })
    const res = await POST(req(compose({ cc: [' lee@harborline.example'] })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.scheduled).toMatchObject({ id: ID, status: 'scheduled', subject: 'Q4 renewal' })
    expect(body.scheduled).not.toHaveProperty('provider_draft_id')
    expect(body.scheduled).not.toHaveProperty('user_id')
    expect(lib.scheduleNewMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', workspaceId: 'ws-1', accountId: 'acct-1', cc: ['lee@harborline.example'] }))
  })

  it('refuses a time in the past, or not a time, before anything is saved', async () => {
    for (const send_at of [new Date(Date.now() - 60_000).toISOString(), 'soon', undefined]) {
      const res = await POST(req(compose({ send_at })))
      expect(res.status).toBe(400)
    }
    expect(lib.scheduleNewMessage).not.toHaveBeenCalled()
  })

  it('refuses a mailbox that is not the caller’s (400), as sendEmail does', async () => {
    lib.scheduleNewMessage.mockResolvedValue({ ok: false, reason: 'account', message: 'Pick one of your own connected mailboxes to send from.' })
    const res = await POST(req(compose({ account_id: 'acct-someone-else' })))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Pick one of your own connected mailboxes to send from.' })
  })

  it('refuses no mailbox, no recipient, a smuggled header and no subject', async () => {
    for (const over of [{ account_id: undefined }, { to: [] }, { to: ['dana@harborline.example\r\nBcc: x@evil.test'] }, { subject: '' }]) {
      expect((await POST(req(compose(over)))).status).toBe(400)
    }
    expect(lib.scheduleNewMessage).not.toHaveBeenCalled()
  })

  it('schedules a draft on a thread with its edits; a draft no longer there is a 404', async () => {
    lib.scheduleExistingDraft.mockResolvedValueOnce({ ok: true, row: { ...ROW, thread_id: 'thr-9' } })
    const edits = { to: ['dana@harborline.example'], cc: [], subject: 'Re: Q4', body: 'Tuesday works.' }
    expect((await POST(req({ thread_id: 'thr-9', draft_id: 'msg-1', edits, send_at: future() }))).status).toBe(200)
    expect(lib.scheduleExistingDraft).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', workspaceId: 'ws-1', threadId: 'thr-9', draftMessageId: 'msg-1', edits }))
    lib.scheduleExistingDraft.mockResolvedValueOnce({ ok: false, reason: 'not_found', message: 'This draft is no longer in your mailbox.' })
    expect((await POST(req({ thread_id: 'thr-9', draft_id: 'msg-1', send_at: future() }))).status).toBe(404)
  })

  it('answers 401 without a session, and touches nothing', async () => {
    auth.result = new Response('{}', { status: 401 })
    expect((await POST(req(compose()))).status).toBe(401)
    expect(lib.scheduleNewMessage).not.toHaveBeenCalled()
  })
})

describe('GET /api/account/email/scheduled (list)', () => {
  it('reads the caller’s own rows in this workspace that the folder lists, soonest first', async () => {
    listQuery.data = [{ id: ID, status: 'scheduled' }]
    const res = await GET()
    expect(await res.json()).toEqual({ scheduled: [{ id: ID, status: 'scheduled' }] })
    expect(listQuery.calls).toEqual(
      expect.arrayContaining([
        ['eq:user_id', 'user-1'],
        ['eq:workspace_id', 'ws-1'],
        ['in:status', ['scheduled', 'sending', 'failed']],
        ['order:send_at', { ascending: true }],
      ]),
    )
    const select = listQuery.calls.find(([m]) => m.startsWith('select:'))![0]
    expect(select).not.toContain('provider_draft_id')
  })
})

describe('cancel, send now, dismiss: the caller’s own row only', () => {
  it('cancel: ok, someone else’s or unknown is 404, one already going is 409', async () => {
    lib.cancelScheduledSend.mockResolvedValueOnce({ ok: true })
    expect((await CANCEL(new Request('http://x'), params())).status).toBe(200)
    expect(lib.cancelScheduledSend).toHaveBeenCalledWith('user-1', 'ws-1', ID)
    lib.cancelScheduledSend.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await CANCEL(new Request('http://x'), params())).status).toBe(404)
    lib.cancelScheduledSend.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    expect((await CANCEL(new Request('http://x'), params())).status).toBe(409)
    expect((await CANCEL(new Request('http://x'), params('not-a-uuid'))).status).toBe(400)
  })

  it('send now: sends the caller’s own waiting row, pinned to them', async () => {
    lib.ownScheduledSend.mockResolvedValue(ROW)
    lib.sendScheduledEmail.mockResolvedValue('sent')
    const res = await SEND_NOW(new Request('http://x'), params())
    expect(res.status).toBe(200)
    expect(lib.sendScheduledEmail).toHaveBeenCalledWith(ID, { userId: 'user-1', immediate: true })
  })

  it('send now: someone else’s row is 404 and nothing is sent; one already sent is 409', async () => {
    lib.ownScheduledSend.mockResolvedValueOnce(null)
    expect((await SEND_NOW(new Request('http://x'), params())).status).toBe(404)
    lib.ownScheduledSend.mockResolvedValueOnce({ ...ROW, status: 'sent' })
    expect((await SEND_NOW(new Request('http://x'), params())).status).toBe(409)
    expect(lib.sendScheduledEmail).not.toHaveBeenCalled()
  })

  it('send now: a send that fails answers with the row’s reason', async () => {
    lib.ownScheduledSend.mockResolvedValueOnce(ROW).mockResolvedValueOnce({ ...ROW, status: 'failed', error: 'The draft was no longer in your mailbox: it was sent or deleted.' })
    lib.sendScheduledEmail.mockResolvedValue('failed')
    const res = await SEND_NOW(new Request('http://x'), params())
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'The draft was no longer in your mailbox: it was sent or deleted.' })
  })

  it('dismiss: a failed row of the caller’s; anything else 404 or 409', async () => {
    lib.dismissScheduledSend.mockResolvedValueOnce({ ok: true })
    expect((await DISMISS(new Request('http://x'), params())).status).toBe(200)
    lib.dismissScheduledSend.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await DISMISS(new Request('http://x'), params())).status).toBe(404)
    lib.dismissScheduledSend.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    expect((await DISMISS(new Request('http://x'), params())).status).toBe(409)
  })
})
