/**
 * updateProviderDraft (bots v3 Phase 5, revise_email_draft): a draft in the
 * mailbox is rewritten IN PLACE and never sent.
 *
 *  - Gmail: only when the mailbox says the message is a draft on that thread;
 *    `drafts.update` (PUT) by the draft's own id, on the draft's thread, with
 *    what the revision leaves out (recipients, subject) taken from the draft,
 *    and Gmail's new message id returned. Never drafts.send.
 *  - Graph: PATCH the message (it keeps its id). Never /send.
 *  - a draft a plain-text rewrite would strip (Gmail attachments or inline
 *    images, an Outlook HTML body): `rich`, nothing written;
 *  - a message that is no draft on the thread (sent, edited since): not found,
 *    nothing written. A revision that isn't a well-formed draft: invalid,
 *    nothing written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
const tokens: Record<string, { token: string; email: string | null } | null> = {}
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async (_u: string, provider: string) => tokens[provider] ?? null),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async () => null),
}))
const reindex = vi.fn(async () => new Map())
vi.mock('@/lib/email/provider-drafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/provider-drafts')>()),
  reindexThreadAfterDraft: (...a: unknown[]) => reindex(...(a as [])),
}))

import { updateProviderDraft } from '@/lib/integrations/email'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'
const WS = 'a3000000-0000-4000-8000-000000000001'

interface Reply {
  status: number
  body?: unknown
}
let calls: Array<{ method: string; url: string; body: string | undefined }> = []
let gmailMessage: Reply
let graphMessage: Reply
let putStatus: number

const respond = ({ status, body }: Reply) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as unknown as Response

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
  if (url.startsWith(`${GMAIL}/messages/`)) return respond(gmailMessage)
  if (url.startsWith(`${GMAIL}/drafts?`)) return respond({ status: 200, body: { drafts: [{ id: 'r-7', message: { id: 'm-draft' } }] } })
  if (method === 'PUT' && url.startsWith(`${GMAIL}/drafts/`)) {
    return respond({ status: putStatus, body: { id: 'r-7', message: { id: 'm-draft-2', threadId: 'thr-1' } } })
  }
  if (url.startsWith(`${GRAPH}/mailFolders/deleteditems`)) return respond({ status: 200, body: { id: 'folder-deleted' } })
  if (method === 'PATCH' && url.startsWith(`${GRAPH}/messages/`)) return respond({ status: 200, body: {} })
  if (url.startsWith(`${GRAPH}/messages/`)) return respond(graphMessage)
  return respond({ status: 404 })
})

const writes = () => calls.filter((c) => c.method !== 'GET')

beforeEach(() => {
  fake = makeFakeSupabase()
  for (const k of Object.keys(tokens)) delete tokens[k]
  calls = []
  putStatus = 200
  reindex.mockClear()
  gmailMessage = {
    status: 200,
    body: {
      id: 'm-draft',
      threadId: 'thr-1',
      labelIds: ['DRAFT'],
      payload: {
        headers: [
          { name: 'From', value: 'Liam <liam@dial8.ai>' },
          { name: 'To', value: 'Simon <simon@harborline.io>' },
          { name: 'Bcc', value: 'ops@dial8.ai' },
          { name: 'Subject', value: 'Re: Exploratory Meeting' },
          { name: 'In-Reply-To', value: '<abc@mail.gmail.com>' },
          { name: 'References', value: '<abc@mail.gmail.com>' },
        ],
      },
    },
  }
  graphMessage = { status: 404 }
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

function seedThread(provider: 'google' | 'microsoft') {
  fake.seed('email_thread_index', [
    { id: 'idx-1', workspace_id: WS, user_id: 'user-1', account_id: null, provider, provider_thread_id: 'thr-1', provider_message_id: 'm-draft', is_draft: true },
  ])
}

describe('updateProviderDraft — Gmail', () => {
  beforeEach(() => {
    tokens.google = { token: 'g-tok', email: 'liam@dial8.ai' }
    seedThread('google')
  })

  it('PUTs drafts.update by the draft’s own id, keeps what the revision leaves out, and returns the new message id; never sends', async () => {
    const out = await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'Dear Simon,\nThank you.' })
    expect(out).toMatchObject({ ok: true, messageId: 'm-draft-2', edits: { to: ['simon@harborline.io'], subject: 'Re: Exploratory Meeting', body: 'Dear Simon,\nThank you.' } })
    const put = writes()
    expect(put.map((c) => `${c.method} ${c.url}`)).toEqual([`PUT ${GMAIL}/drafts/r-7`])
    const sent = JSON.parse(put[0].body!)
    expect(sent.message.threadId).toBe('thr-1')
    const raw = Buffer.from(sent.message.raw, 'base64url').toString('utf8')
    expect(raw).toContain('To: simon@harborline.io')
    expect(raw).toContain('Bcc: ops@dial8.ai')
    expect(raw).toContain('In-Reply-To: <abc@mail.gmail.com>')
    expect(raw).toContain('Dear Simon,')
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false)
    expect(reindex).toHaveBeenCalledOnce()
  })

  it('a message that is no draft on the thread is not found, and nothing is written', async () => {
    gmailMessage = { status: 200, body: { id: 'm-draft', threadId: 'thr-1', labelIds: ['SENT'] } }
    expect(await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'x' })).toEqual({ ok: false, reason: 'not_found' })
    expect(writes()).toEqual([])
  })

  it('a revision that isn’t a well-formed draft is invalid, and nothing is written', async () => {
    expect(await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'x', to: ['Simon <simon@harborline.io>\r\nBcc: x@y.z'] })).toEqual({ ok: false, reason: 'invalid' })
    expect(writes()).toEqual([])
  })

  it('a draft with attachments or inline images is refused (rich), and nothing is written', async () => {
    const payload = (gmailMessage.body as { payload: { headers: Array<{ name: string; value: string }> } }).payload
    payload.headers.push({ name: 'Content-Type', value: 'multipart/mixed; boundary="b1"' })
    expect(await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'x' })).toEqual({ ok: false, reason: 'rich' })
    payload.headers.pop()
    ;(payload as { mimeType?: string }).mimeType = 'multipart/related'
    expect(await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'x' })).toEqual({ ok: false, reason: 'rich' })
    expect(writes()).toEqual([])
    // The read asks for the Content-Type header.
    expect(calls.find((c) => c.url.startsWith(`${GMAIL}/messages/`))?.url).toContain('metadataHeaders=Content-Type')
  })

  it('ids that aren’t provider ids are not found before any call', async () => {
    expect(await updateProviderDraft('user-1', WS, '../thr', 'm-draft', { body: 'x' })).toEqual({ ok: false, reason: 'not_found' })
    expect(calls).toEqual([])
  })
})

describe('updateProviderDraft — Outlook', () => {
  beforeEach(() => {
    tokens.microsoft = { token: 'm-tok', email: 'liam@outlook.com' }
    seedThread('microsoft')
    graphMessage = {
      status: 200,
      body: {
        isDraft: true,
        conversationId: 'thr-1',
        parentFolderId: 'folder-drafts',
        subject: 'Re: Q3',
        toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }],
        ccRecipients: [],
      },
    }
  })

  it('PATCHes the message in place (it keeps its id) and never sends', async () => {
    const out = await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'Formal.', subject: 'Re: Q3 plan' })
    expect(out).toMatchObject({ ok: true, messageId: 'm-draft', edits: { to: ['ana@acme.com'], subject: 'Re: Q3 plan' } })
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual([`PATCH ${GRAPH}/messages/m-draft`])
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ subject: 'Re: Q3 plan', body: { contentType: 'Text', content: 'Formal.' } })
    expect(calls.some((c) => c.url.endsWith('/send'))).toBe(false)
  })

  it('an HTML body (written or edited in Outlook) is refused (rich), and nothing is written', async () => {
    ;(graphMessage.body as Record<string, unknown>).body = { contentType: 'html', content: '<p>Hi</p><div>Sig</div>' }
    expect(await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'Formal.' })).toEqual({ ok: false, reason: 'rich' })
    expect(writes()).toEqual([])
  })

  it('flattened (send later’s edit), an HTML draft is written as text, exactly as Send with edits writes it', async () => {
    ;(graphMessage.body as Record<string, unknown>).body = { contentType: 'html', content: '<p>Hi</p><div>Sig</div>' }
    const out = await updateProviderDraft('user-1', WS, 'thr-1', 'm-draft', { body: 'Formal.' }, { flatten: true })
    expect(out).toMatchObject({ ok: true, messageId: 'm-draft' })
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ body: { contentType: 'Text', content: 'Formal.' } })
  })
})
