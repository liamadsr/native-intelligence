/**
 * sendEmail with `provider_draft_id` (the chat card's Send on an agent's
 * draft): the email goes out as a new message, then the draft it replaces is
 * deleted the way a discard is (deleteProviderDraft). At Gmail that means by
 * the draft's own id, found through the drafts list (Gmail's draft endpoints
 * never take the message id the card holds), at the mailbox that holds the
 * draft, and only an indexed draft of this user. Once Gmail confirms, the
 * thread keeps its row, indexed again with the reply just sent as its last
 * message. Nothing in the cleanup can fail the send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))

const tokens: Record<string, { token: string; email: string | null } | null> = {}
const accountTokens: Record<string, { token: string; email: string | null; accountId: string } | undefined> = {}
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async (_u: string, provider: string) => tokens[provider] ?? null),
  getValidTokenForAccount: vi.fn(async (accountId: string) => accountTokens[accountId] ?? null),
}))

import { sendEmail } from '@/lib/crm/email-client'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const WS = 'f6000000-0000-4000-8000-000000000001'

let calls: Array<{ method: string; url: string; auth: string | undefined }> = []
let draftPages: Array<{ drafts: Array<{ id: string; message: { id: string } }>; nextPageToken?: string }>
let deleteStatus = 204

const respond = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({ method, url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
  if (method === 'POST' && url === `${GMAIL}/messages/send`) return respond(200, { id: 'm-sent', threadId: 'thr-1' })
  if (method === 'GET' && url.startsWith(`${GMAIL}/drafts?`)) {
    const page = new URL(url).searchParams.get('pageToken')
    return respond(200, draftPages[page ? Number(page.slice(1)) : 0])
  }
  if (method === 'DELETE' && url.startsWith(`${GMAIL}/drafts/`)) return respond(deleteStatus)
  // The thread as Gmail holds it after the send: Simon's message, then the reply just sent.
  if (method === 'GET' && url.startsWith(`${GMAIL}/threads/thr-1?`)) {
    return respond(200, {
      id: 'thr-1',
      snippet: 'No worries at all.',
      messages: [
        gmailMessage('m-simon', ['INBOX'], 'Simon Åkerlund <simon@harborline.io>', '1790200000000'),
        gmailMessage('m-sent', ['SENT'], 'Liam Alizadeh <liam@dial8.ai>', '1790300000000'),
      ],
    })
  }
  return respond(404)
})

function gmailMessage(id: string, labelIds: string[], from: string, internalDate: string) {
  return {
    id,
    labelIds,
    internalDate,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: from.includes('simon') ? 'liam@dial8.ai' : 'simon@harborline.io' },
        { name: 'Subject', value: 'Re: Exploratory Meeting' },
      ],
    },
  }
}

const draftRow = (over: Record<string, unknown> = {}) => ({
  id: 'idx-draft',
  workspace_id: WS,
  user_id: 'user-1',
  account_id: 'acct-work',
  provider: 'google',
  provider_thread_id: 'thr-1',
  provider_message_id: 'm-draft',
  folder: 'drafts',
  is_draft: true,
  ...over,
})

const send = (providerDraftId: string) =>
  sendEmail('user-1', WS, {
    to: ['simon@harborline.io'],
    subject: 'Re: Exploratory Meeting',
    body_html: '<p>No worries at all.</p>',
    thread_id: 'thr-1',
    provider_draft_id: providerDraftId,
  })

const sendCalls = () => calls.filter((c) => c.url === `${GMAIL}/messages/send`)
const cleanupCalls = () => calls.filter((c) => c.url.startsWith(`${GMAIL}/drafts`))

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fake = makeFakeSupabase()
  tokens.google = { token: 'send-tok', email: 'liam@dial8.ai' }
  tokens.microsoft = null
  for (const k of Object.keys(accountTokens)) delete accountTokens[k]
  accountTokens['acct-work'] = { token: 'work-tok', email: 'liam@dial8.ai', accountId: 'acct-work' }
  calls = []
  draftPages = [
    { drafts: [{ id: 'r-1', message: { id: 'm-other' } }], nextPageToken: 'p1' },
    { drafts: [{ id: 'r-7', message: { id: 'm-draft' } }] },
  ]
  deleteStatus = 204
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  vi.unstubAllGlobals()
})

describe('sendEmail — the provider draft it replaces', () => {
  it('sends, then deletes the Gmail draft by its draft id at the mailbox that holds it; the thread keeps its row, with the sent reply last', async () => {
    fake.seed('email_thread_index', [draftRow()])
    await expect(send('m-draft')).resolves.toMatchObject({ message_id: 'm-sent', thread_id: 'thr-1' })
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]} ${c.auth}`)).toEqual([
      `POST ${GMAIL}/messages/send Bearer send-tok`,
      `GET ${GMAIL}/drafts Bearer work-tok`,
      `GET ${GMAIL}/drafts Bearer work-tok`,
      `DELETE ${GMAIL}/drafts/r-7 Bearer work-tok`,
      `GET ${GMAIL}/threads/thr-1 Bearer work-tok`,
    ])
    expect(fake.rows('email_thread_index')).toEqual([
      expect.objectContaining({
        id: 'idx-draft',
        provider_message_id: 'm-sent',
        is_draft: false,
        folder: 'sent',
        from_email: 'liam@dial8.ai',
        needs_reply: false,
        message_count: 2,
      }),
    ])
  })

  it('a message no Gmail draft holds any more: the send stands, nothing is deleted at Gmail, the thread is re-indexed', async () => {
    fake.seed('email_thread_index', [draftRow()])
    draftPages = [{ drafts: [{ id: 'r-1', message: { id: 'm-other' } }] }]
    await expect(send('m-draft')).resolves.toMatchObject({ message_id: 'm-sent' })
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
    expect(fake.rows('email_thread_index')).toEqual([
      expect.objectContaining({ id: 'idx-draft', provider_message_id: 'm-sent', is_draft: false }),
    ])
  })

  it('a DELETE Gmail refuses never fails the send, and the draft keeps its row', async () => {
    fake.seed('email_thread_index', [draftRow()])
    deleteStatus = 500
    await expect(send('m-draft')).resolves.toMatchObject({ message_id: 'm-sent' })
    expect(fake.rows('email_thread_index')).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('[email] Gmail draft not deleted: 500')
  })

  it('an id that is not an indexed draft of this user deletes nothing at the provider', async () => {
    fake.seed('email_thread_index', [draftRow({ user_id: 'user-2' }), draftRow({ id: 'idx-sent', is_draft: false })])
    await expect(send('m-draft')).resolves.toMatchObject({ message_id: 'm-sent' })
    expect(sendCalls()).toHaveLength(1)
    expect(cleanupCalls()).toEqual([])
    expect(fake.rows('email_thread_index')).toHaveLength(2)
  })

  it.each(['../messages/m-1', 'm-draft/../../threads/thr-1', 'm-draft?x=1'])(
    'the id %j never reaches a provider URL',
    async (id) => {
      fake.seed('email_thread_index', [draftRow({ provider_message_id: id })])
      await expect(send(id)).resolves.toMatchObject({ message_id: 'm-sent' })
      expect(calls.map((c) => c.url)).toEqual([`${GMAIL}/messages/send`])
      expect(fake.rows('email_thread_index')).toHaveLength(1)
    },
  )

  it('with no provider draft, sending touches no draft', async () => {
    fake.seed('email_thread_index', [draftRow()])
    await sendEmail('user-1', WS, { to: ['simon@harborline.io'], subject: 'Hello', body_html: '<p>Hi</p>' })
    expect(cleanupCalls()).toEqual([])
    expect(fake.rows('email_thread_index')).toHaveLength(1)
  })
})
