/**
 * POST /api/account/email/send and save-draft with what Mail's composer
 * adds: files (checked, or nothing is sent or saved) and, for a draft, the
 * message a reply answers. sendEmail and saveDraftToProvider are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({ sendEmail: vi.fn(), saveDraftToProvider: vi.fn() }))
vi.mock('@/lib/crm/email-client', () => lib)
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

const { POST: SEND } = await import('../route')
const { POST: SAVE } = await import('../../save-draft/route')

const req = (body: unknown) => new Request('http://x/api/account/email/send', { method: 'POST', body: JSON.stringify(body) }) as never
const FILE = { name: 'plan.pdf', mime_type: 'application/pdf', content_base64: Buffer.from('made up').toString('base64') }
const base = { to: ['dana@harborline.example'], subject: 'Re: Plan', body_html: '<p>Yes</p>', thread_id: 'thr-1', in_reply_to_message_id: 'm-1', account_id: 'acct-1' }

beforeEach(() => {
  vi.clearAllMocks()
  lib.sendEmail.mockResolvedValue({ message_id: 'sent-1', thread_id: 'thr-1', rfc_message_id: null })
  lib.saveDraftToProvider.mockResolvedValue({ draft_id: 'd-1', thread_id: 'thr-1' })
})

describe('send', () => {
  it('passes the files on, checked, with the reply’s threading and mailbox', async () => {
    const res = await SEND(req({ ...base, attachments: [FILE] }))
    expect(res.status).toBe(200)
    expect(lib.sendEmail).toHaveBeenCalledWith('user-1', 'ws-1', expect.objectContaining({
      thread_id: 'thr-1',
      in_reply_to_message_id: 'm-1',
      account_id: 'acct-1',
      attachments: [{ name: 'plan.pdf', mimeType: 'application/pdf', contentBase64: FILE.content_base64 }],
    }))
  })

  it('no files: none passed', async () => {
    await SEND(req(base))
    expect(lib.sendEmail.mock.calls[0][2]).not.toHaveProperty('attachments')
  })

  it('a malformed file sends nothing', async () => {
    const res = await SEND(req({ ...base, attachments: [{ ...FILE, mime_type: 'text/plain\r\nBcc: x@evil.test' }] }))
    expect(res.status).toBe(400)
    expect(lib.sendEmail).not.toHaveBeenCalled()
  })
})

describe('save-draft', () => {
  it('a reply draft names the message it answers, and carries its files', async () => {
    const res = await SAVE(req({ ...base, attachments: [FILE] }))
    expect(res.status).toBe(200)
    expect(lib.saveDraftToProvider).toHaveBeenCalledWith('user-1', expect.objectContaining({
      thread_id: 'thr-1',
      in_reply_to_message_id: 'm-1',
      account_id: 'acct-1',
      attachments: [expect.objectContaining({ name: 'plan.pdf' })],
    }))
  })

  it('a reply with no thread, or a message id that is not one, saves nothing', async () => {
    expect((await SAVE(req({ ...base, thread_id: undefined }))).status).toBe(400)
    expect((await SAVE(req({ ...base, in_reply_to_message_id: 'not an id!' }))).status).toBe(400)
    expect(lib.saveDraftToProvider).not.toHaveBeenCalled()
  })
})
