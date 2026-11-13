/**
 * Mail's Send on a draft in a thread (sendProviderDraft). The draft sits in the
 * provider mailbox (an agent's `create_email_draft`, a drafting pass's, or the
 * user's own), named by its MESSAGE id as the thread view shows it:
 *  - it is sent only when the mailbox that holds the thread says the message is
 *    a draft on that thread (an edited draft has a new message id, so what goes
 *    out is always what was reviewed), and natively: Gmail's drafts.send by the
 *    draft's own id (found through the drafts list), Graph's /send;
 *  - the ids are untrusted: anything that is not a provider id is refused
 *    before any lookup or provider call;
 *  - once sent, the thread leaves Drafts, answered; a drafting pass's row for
 *    the draft is marked sent; the work items that delivered it (an agent by
 *    the provider id, a pass by its row) stop waiting; the recipients'
 *    timelines log it. None of that bookkeeping can fail the send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))

const tokens: Record<string, { token: string; email: string | null } | null> = {}
const accountTokens: Record<string, { token: string; email: string | null; accountId: string } | undefined> = {}
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async (_u: string, provider: string) => tokens[provider] ?? null),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async (accountId: string) => accountTokens[accountId] ?? null),
}))

import { sendProviderDraft } from '@/lib/integrations/email'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'
const WS = 'f6000000-0000-4000-8000-000000000001'
const OTHER_WS = 'f6000000-0000-4000-8000-000000000002'
const PASS_ROW = 'd7000000-0000-4000-8000-000000000001'

interface Reply {
  status: number
  body?: unknown
}
interface Call {
  method: string
  url: string
  body: unknown
  auth: string | undefined
}

let calls: Call[] = []
let gmailMessage: Reply
let gmailDraftPages: Array<{ drafts: unknown[]; nextPageToken?: string }>
let gmailSend: Reply
let graphMessage: Reply
let graphSend: Reply
let graphDeletedItems: Reply
let graphPatch: Reply

const reply = ({ status, body }: Reply) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  }) as unknown as Response

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({
    method,
    url,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
  })
  if (url.startsWith(`${GMAIL}/messages/`)) return reply(gmailMessage)
  if (url.startsWith(`${GMAIL}/drafts?`)) {
    const token = new URL(url).searchParams.get('pageToken')
    return reply({ status: 200, body: gmailDraftPages[token ? Number(token.slice(1)) : 0] })
  }
  if (url === `${GMAIL}/drafts/send` && method === 'POST') return reply(gmailSend)
  if (url.startsWith(`${GRAPH}/mailFolders/deleteditems`)) return reply(graphDeletedItems)
  if (url.startsWith(`${GRAPH}/messages/`) && method === 'PATCH') return reply(graphPatch)
  if (url.startsWith(`${GRAPH}/messages/`) && url.endsWith('/send') && method === 'POST') return reply(graphSend)
  if (url.startsWith(`${GRAPH}/messages/`) && method === 'GET') return reply(graphMessage)
  return reply({ status: 404 })
})

const sends = () => calls.filter((c) => c.method === 'POST')

function seedGmailThread() {
  fake.seed('email_thread_index', [
    {
      id: 'idx-1', workspace_id: WS, user_id: 'user-1', account_id: 'acct-work', provider: 'google',
      provider_thread_id: 'thr-1', provider_message_id: 'm-draft', folder: 'drafts', is_draft: true,
      needs_reply: true, last_message_at: '2026-09-24T05:02:00.000Z',
    },
    // The same mailbox listed in another workspace, where the sync filed it in the Inbox.
    {
      id: 'idx-2', workspace_id: OTHER_WS, user_id: 'user-1', account_id: 'acct-work', provider: 'google',
      provider_thread_id: 'thr-1', provider_message_id: 'm-draft', folder: 'inbox', is_draft: true, needs_reply: true,
    },
  ])
  fake.seed('tracked_job', [
    { id: 'job-agent', status: 'needs_review', deliverables: [{ type: 'email_draft', id: 'm-draft', label: 'Re: Exploratory meeting' }] },
    { id: 'job-pass', status: 'needs_review', deliverables: [{ type: 'email_draft', id: PASS_ROW, label: 'Re: Exploratory meeting' }] },
    { id: 'job-other', status: 'needs_review', deliverables: [{ type: 'email_draft', id: 'm-other', label: 'Other' }] },
  ])
  fake.seed('email_draft', [
    { id: PASS_ROW, workspace_id: WS, user_id: 'user-1', provider_draft_id: 'm-draft', status: 'pending_review' },
    { id: 'd7000000-0000-4000-8000-000000000002', workspace_id: WS, user_id: 'user-1', provider_draft_id: 'm-other', status: 'pending_review' },
  ])
  fake.seed('contact', [{ id: 'c-simon', workspace_id: WS, email: 'simon@harborline.io', full_name: 'Simon Åkerlund' }])
}

beforeEach(() => {
  fake = makeFakeSupabase({ rpc: { update_contact_interaction_stats: () => ({ data: null, error: null }) } })
  for (const k of Object.keys(tokens)) delete tokens[k]
  for (const k of Object.keys(accountTokens)) delete accountTokens[k]
  tokens.google = { token: 'g-default-tok', email: 'liam@gmail.com' }
  tokens.microsoft = { token: 'm-default-tok', email: 'liam@outlook.com' }
  accountTokens['acct-work'] = { token: 'work-tok', email: 'liam@dial8.ai', accountId: 'acct-work' }
  calls = []
  gmailMessage = {
    status: 200,
    body: {
      id: 'm-draft',
      threadId: 'thr-1',
      labelIds: ['DRAFT'],
      payload: {
        headers: [
          { name: 'To', value: '"Simon Åkerlund" <simon@harborline.io>' },
          { name: 'Subject', value: 'Re: Exploratory Meeting between Simon Åkerlund and Liam Alizadeh' },
        ],
      },
    },
  }
  gmailDraftPages = [
    { drafts: [{ id: 'r-1', message: { id: 'm-1', threadId: 'thr-9' } }], nextPageToken: 'p1' },
    { drafts: [{ id: 'r-7', message: { id: 'm-draft', threadId: 'thr-1' } }] },
  ]
  gmailSend = { status: 200, body: { id: 'm-sent', threadId: 'thr-1', labelIds: ['SENT'] } }
  graphMessage = { status: 404 }
  graphSend = { status: 202 }
  graphDeletedItems = { status: 200, body: { id: 'folder-deleted' } }
  graphPatch = { status: 200, body: {} }
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendProviderDraft — Gmail', () => {
  it('sends the reviewed draft natively, by its draft id, from the mailbox that holds the thread', async () => {
    seedGmailThread()
    const result = await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(result).toEqual({ ok: true, threadId: 'thr-1', messageId: 'm-sent' })
    // Checked as a draft on this thread, its draft id found on the list's second page, then sent.
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `GET ${GMAIL}/messages/m-draft`,
      `GET ${GMAIL}/drafts`,
      `GET ${GMAIL}/drafts`,
      `POST ${GMAIL}/drafts/send`,
    ])
    expect(sends()).toEqual([{ method: 'POST', url: `${GMAIL}/drafts/send`, body: { id: 'r-7' }, auth: 'Bearer work-tok' }])
    // The thread's own account, never the user's default mailbox.
    expect(calls.every((c) => c.auth === 'Bearer work-tok')).toBe(true)
  })

  it('the thread leaves Drafts, answered (a row of it filed elsewhere keeps its folder)', async () => {
    seedGmailThread()
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    const [here, elsewhere] = fake.rows('email_thread_index')
    expect(here).toMatchObject({ folder: 'sent', is_draft: false, needs_reply: false })
    expect(here.last_message_at).not.toBe('2026-09-24T05:02:00.000Z')
    expect(elsewhere).toMatchObject({ folder: 'inbox', is_draft: false, needs_reply: false })
  })

  it('a draft sent to oneself is filed where the sync would file it (the Inbox)', async () => {
    seedGmailThread()
    gmailSend = { status: 200, body: { id: 'm-sent', threadId: 'thr-1', labelIds: ['SENT', 'INBOX', 'UNREAD'] } }
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ folder: 'inbox' })
  })

  it('the work items that delivered it stop waiting: an agent’s by the provider id, a drafting pass’s by its row, now gone', async () => {
    seedGmailThread()
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    const jobs = Object.fromEntries(fake.rows('tracked_job').map((j) => [j.id, j.status]))
    expect(jobs).toEqual({ 'job-agent': 'done', 'job-pass': 'done', 'job-other': 'needs_review' })
    // Sent: the pass's row is deleted (nothing lingers); the other draft waits.
    expect(fake.rows('email_draft').map((r) => r.provider_draft_id)).toEqual(['m-other'])
  })

  it('the holding pattern: the hold goes sending during the send, then is deleted (its drafts cascade)', async () => {
    seedGmailThread()
    fake.seed('email_hold', [{ id: 'hold-1', user_id: 'user-1', status: 'held' }])
    fake.rows('email_draft')[0].hold_id = 'hold-1'
    const statuses: unknown[] = []
    const from = fake.from
    fake.from = (table: string) => {
      if (table !== 'email_hold') statuses.push(fake.rows('email_hold')[0]?.status ?? 'gone')
      return from(table)
    }
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(statuses).toContain('sending')
    expect(fake.rows('email_hold')).toHaveLength(0)
  })

  it('a draft edited in Gmail (a new message id no row names) still releases its thread\'s hold on send', async () => {
    seedGmailThread()
    fake.seed('email_hold', [{ id: 'hold-1', user_id: 'user-1', status: 'held' }])
    const row = fake.rows('email_draft')[0]
    row.hold_id = 'hold-1'
    row.provider_draft_id = 'm-old-before-gmail-edit'
    row.provider_thread_id = 'thr-1'
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(fake.rows('email_hold')).toHaveLength(0)
  })

  it('a failed send puts the hold back to held', async () => {
    seedGmailThread()
    fake.seed('email_hold', [{ id: 'hold-1', user_id: 'user-1', status: 'held' }])
    fake.rows('email_draft')[0].hold_id = 'hold-1'
    gmailSend = { status: 500, body: { error: 'backend' } }
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')).rejects.toThrow()
    expect(fake.rows('email_hold')[0]).toMatchObject({ status: 'held' })
    expect(fake.rows('email_draft')).toHaveLength(2)
  })

  it('logs the send on each recipient contact’s timeline', async () => {
    seedGmailThread()
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(fake.rows('contact_interaction')).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        contact_id: 'c-simon',
        interaction_type: 'email_sent',
        reference_type: 'email_thread',
        reference_id: 'thr-1',
        // A template and a pointer: the row is readable by the whole workspace, so never the subject.
        title: 'Email to Simon Åkerlund',
      }),
    ])
    expect(fake.rpcCalls.map((c) => c.fn)).toEqual(['update_contact_interaction_stats'])
  })

  it.each([
    ['a message that is not a draft', () => { (gmailMessage.body as { labelIds: string[] }).labelIds = ['SENT'] }],
    ['a draft on another thread', () => { (gmailMessage.body as { threadId: string }).threadId = 'thr-2' }],
    ['a draft edited or sent elsewhere (its message id is gone)', () => { gmailMessage = { status: 404 } }],
    ['a message the drafts list does not hold', () => { gmailDraftPages = [{ drafts: [] }] }],
  ])('%s is not sent, and nothing is settled', async (_label, arrange) => {
    seedGmailThread()
    arrange()
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(sends()).toEqual([])
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ folder: 'drafts', is_draft: true })
    expect(fake.rows('tracked_job').every((j) => j.status === 'needs_review')).toBe(true)
    expect(fake.rows('email_draft')[0]).toMatchObject({ status: 'pending_review' })
  })

  it('a draft with no recipients is refused before any send', async () => {
    seedGmailThread()
    ;(gmailMessage.body as { payload: { headers: unknown[] } }).payload.headers = [{ name: 'Subject', value: 'Notes' }]
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toEqual({ ok: false, reason: 'no_recipients' })
    expect(sends()).toEqual([])
  })

  it('a draft copied to someone (no To) still sends', async () => {
    seedGmailThread()
    ;(gmailMessage.body as { payload: { headers: unknown[] } }).payload.headers = [{ name: 'Cc', value: 'ops@harborline.io' }]
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toMatchObject({ ok: true })
    expect(fake.rows('contact_interaction')).toEqual([])
  })

  it('a drafts list longer than it reads is an error, never “no such draft”; nothing is sent', async () => {
    seedGmailThread()
    gmailDraftPages = Array.from({ length: 12 }, (_, i) => ({
      drafts: [{ id: `r-${i}`, message: { id: `m-${i}`, threadId: 'thr-9' } }],
      nextPageToken: `p${i + 1}`,
    }))
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')).rejects.toThrow('Gmail drafts list runs past 10 pages')
    expect(sends()).toEqual([])
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ folder: 'drafts', is_draft: true })
  })

  it('a provider failure throws and settles nothing', async () => {
    seedGmailThread()
    gmailSend = { status: 500, body: { error: 'backend' } }
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')).rejects.toThrow('Gmail draft send error: 500')
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ folder: 'drafts', is_draft: true })
    expect(fake.rows('tracked_job').every((j) => j.status === 'needs_review')).toBe(true)
  })

  it('bookkeeping that fails never fails the send (the rest still settles)', async () => {
    seedGmailThread()
    const from = fake.from
    fake.from = (table: string) => {
      if (table === 'email_draft') throw new Error('email_draft unavailable')
      return from(table)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toMatchObject({ ok: true, messageId: 'm-sent' })
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ folder: 'sent', is_draft: false })
    expect(fake.rows('tracked_job').find((j) => j.id === 'job-agent')?.status).toBe('done')
    expect(fake.rows('contact_interaction')).toHaveLength(1)
    warn.mockRestore()
  })

  it('a thread indexed without an account uses the user’s token for its provider', async () => {
    fake.seed('email_thread_index', [
      { id: 'idx-9', workspace_id: WS, user_id: 'user-1', account_id: null, provider: 'google', provider_thread_id: 'thr-1', folder: 'drafts', is_draft: true },
    ])
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(sends()[0].auth).toBe('Bearer g-default-tok')
  })

  it.each([
    ['../drafts/r-7', 'thr-1'],
    ['..', 'thr-1'],
    ['m-draft?format=raw', 'thr-1'],
    ['m-draft#x', 'thr-1'],
    ['', 'thr-1'],
    ['a'.repeat(513), 'thr-1'],
    ['m-draft', '../../threads/x'],
    ['m-draft', ''],
  ])('refuses draft id %j on thread %j before any lookup or provider call', async (draftId, threadId) => {
    seedGmailThread()
    await expect(sendProviderDraft('user-1', WS, threadId, draftId)).resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fake.calls).toEqual([])
  })
})

describe('sendProviderDraft — Gmail, edited before sending', () => {
  const EDITS = {
    to: ['simon@harborline.io', 'ada@harborline.io'],
    cc: ['ops@harborline.io'],
    subject: 'Re: Next week',
    body: 'Hi Simon,\n\nTuesday at 2 pm works <3.',
  }
  const headers = (list: Array<[string, string]>) => {
    ;(gmailMessage.body as { payload: { headers: unknown[] } }).payload.headers = list.map(([name, value]) => ({ name, value }))
  }
  /** The MIME message the draft send carried. */
  const sentRaw = () => Buffer.from((sends()[0].body as { message: { raw: string } }).message.raw, 'base64url').toString('utf8')

  beforeEach(() => {
    seedGmailThread()
    fake.seed('contact', [{ id: 'c-ada', workspace_id: WS, email: 'ada@harborline.io' }])
    headers([
      ['From', 'Liam Alizadeh <liam@dial8.ai>'],
      ['To', 'Simon Åkerlund <simon@harborline.io>'],
      ['Bcc', 'crm@dial8.ai'],
      ['Subject', 'Re: Exploratory Meeting'],
      ['In-Reply-To', '<CA+simon@mail.gmail.com>'],
      ['References', '<CA+first@mail.gmail.com> <CA+simon@mail.gmail.com>'],
    ])
  })

  it('sends the edited message in the draft send, on the draft’s thread, keeping its sender, Bcc and reply headers', async () => {
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', EDITS)).resolves.toMatchObject({ ok: true, messageId: 'm-sent' })
    expect(sends()).toEqual([expect.objectContaining({ url: `${GMAIL}/drafts/send` })])
    expect(sends()[0].body).toEqual({ id: 'r-7', message: { threadId: 'thr-1', raw: expect.any(String) } })
    const raw = sentRaw()
    for (const line of [
      'From: "Liam Alizadeh" <liam@dial8.ai>',
      'To: simon@harborline.io, ada@harborline.io',
      'Cc: ops@harborline.io',
      'Bcc: crm@dial8.ai',
      'Subject: Re: Next week',
      'In-Reply-To: <CA+simon@mail.gmail.com>',
      'References: <CA+first@mail.gmail.com> <CA+simon@mail.gmail.com>',
    ]) {
      expect(raw).toContain(`${line}\r\n`)
    }
    expect(raw).toContain('Hi Simon,\n\nTuesday at 2 pm works <3.')
    expect(raw).toContain('Tuesday at 2 pm works &lt;3.')
  })

  it('a Bcc in the edits replaces the draft’s; [] takes it off; left out, the draft keeps it', async () => {
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', { ...EDITS, bcc: ['legal@dial8.ai', 'ops@dial8.ai'] })
    let raw = sentRaw()
    expect(raw).toContain('Bcc: legal@dial8.ai, ops@dial8.ai\r\n')
    expect(raw).not.toContain('crm@dial8.ai')

    calls = []
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', { ...EDITS, bcc: [] })
    raw = sentRaw()
    expect(raw).not.toContain('Bcc:')

    calls = []
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', EDITS)
    expect(sentRaw()).toContain('Bcc: crm@dial8.ai\r\n')
  })

  it('the recipients’ timelines log the send as edited (template titles, never the subject)', async () => {
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', EDITS)
    const titles = fake.rows('contact_interaction').map((r) => [r.contact_id, r.title])
    expect(titles.map(([id]) => id)).toEqual(['c-simon', 'c-ada'])
    expect(JSON.stringify(titles)).not.toContain('Next week')
  })

  it('a sender with a non-ASCII name goes out as an encoded word; a draft without a From, from the mailbox’s address', async () => {
    headers([['From', 'Liäm Alizadeh <liam@dial8.ai>']])
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', EDITS)
    expect(sentRaw()).toContain(`From: =?UTF-8?B?${Buffer.from('Liäm Alizadeh').toString('base64')}?= <liam@dial8.ai>\r\n`)

    calls = []
    headers([])
    fake.rows('email_thread_index')[0].is_draft = true
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', EDITS)
    expect(sentRaw()).toContain('From: liam@dial8.ai\r\n')
  })

  it('edits that are not well formed never reach a provider', async () => {
    await expect(
      sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', { ...EDITS, to: ['Simon <simon@harborline.io>\r\nBcc: x@evil.test'] }),
    ).rejects.toThrow('Draft edits are not well formed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendProviderDraft — Outlook', () => {
  const DRAFT = 'AAMkAD/draft+1=='
  beforeEach(() => {
    accountTokens['acct-outlook'] = { token: 'outlook-tok', email: 'liam@dial8.ai', accountId: 'acct-outlook' }
    fake.seed('email_thread_index', [
      { id: 'idx-o', workspace_id: WS, user_id: 'user-1', account_id: 'acct-outlook', provider: 'microsoft', provider_thread_id: 'conv-1', provider_message_id: DRAFT, folder: 'drafts', is_draft: true },
    ])
    fake.seed('tracked_job', [{ id: 'job-agent', status: 'needs_review', deliverables: [{ type: 'email_draft', id: DRAFT }] }])
    graphMessage = {
      status: 200,
      body: {
        isDraft: true,
        conversationId: 'conv-1',
        parentFolderId: 'folder-drafts',
        subject: 'Re: Pricing',
        toRecipients: [{ emailAddress: { address: 'simon@harborline.io' } }],
      },
    }
  })

  it('sends a message Graph confirms is a draft on the conversation, by its URL-encoded id', async () => {
    await expect(sendProviderDraft('user-1', WS, 'conv-1', DRAFT)).resolves.toEqual({ ok: true, threadId: 'conv-1', messageId: null })
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `GET ${GRAPH}/messages/AAMkAD%2Fdraft%2B1%3D%3D`,
      `GET ${GRAPH}/mailFolders/deleteditems`,
      `POST ${GRAPH}/messages/AAMkAD%2Fdraft%2B1%3D%3D/send`,
    ])
    expect(calls.every((c) => c.auth === 'Bearer outlook-tok')).toBe(true)
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ folder: 'sent', is_draft: false })
    expect(fake.rows('tracked_job')[0].status).toBe('done')
  })

  it.each([
    ['not a draft', { isDraft: false, conversationId: 'conv-1', parentFolderId: 'folder-drafts' }],
    ['on another conversation', { isDraft: true, conversationId: 'conv-2', parentFolderId: 'folder-drafts' }],
    ['a draft in Deleted Items (discarded, or superseded by a revision)', { isDraft: true, conversationId: 'conv-1', parentFolderId: 'folder-deleted' }],
  ])('a message that is %s is not sent', async (_label, body) => {
    graphMessage = { status: 200, body: { ...body, toRecipients: [{ emailAddress: { address: 'simon@harborline.io' } }] } }
    await expect(sendProviderDraft('user-1', WS, 'conv-1', DRAFT)).resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(sends()).toEqual([])
    expect(fake.rows('tracked_job')[0].status).toBe('needs_review')
  })

  it('an edited draft is updated to the edits, then sent', async () => {
    const edits = { to: ['simon@harborline.io'], cc: ['ops@harborline.io'], subject: 'Re: Pricing, revised', body: 'Hi Simon,\n\nRevised numbers below.' }
    await expect(sendProviderDraft('user-1', WS, 'conv-1', DRAFT, edits)).resolves.toMatchObject({ ok: true })
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `GET ${GRAPH}/messages/AAMkAD%2Fdraft%2B1%3D%3D`,
      `GET ${GRAPH}/mailFolders/deleteditems`,
      `PATCH ${GRAPH}/messages/AAMkAD%2Fdraft%2B1%3D%3D`,
      `POST ${GRAPH}/messages/AAMkAD%2Fdraft%2B1%3D%3D/send`,
    ])
    expect(calls[2].body).toEqual({
      subject: 'Re: Pricing, revised',
      body: { contentType: 'Text', content: 'Hi Simon,\n\nRevised numbers below.' },
      toRecipients: [{ emailAddress: { address: 'simon@harborline.io' } }],
      ccRecipients: [{ emailAddress: { address: 'ops@harborline.io' } }],
    })
  })

  it('a Bcc in the edits goes in the update; without one, the update leaves the draft’s Bcc alone', async () => {
    const edits = { to: ['simon@harborline.io'], cc: [], subject: 'Re', body: 'x' }
    await sendProviderDraft('user-1', WS, 'conv-1', DRAFT, { ...edits, bcc: ['crm@harborline.io'] })
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
      bccRecipients: [{ emailAddress: { address: 'crm@harborline.io' } }],
    })

    calls = []
    await sendProviderDraft('user-1', WS, 'conv-1', DRAFT, edits)
    expect(calls.find((c) => c.method === 'PATCH')!.body).not.toHaveProperty('bccRecipients')
  })

  it.each([
    ['gone by the update (404): not sent', { status: 404 }, 'resolves'],
    ['refused (500): an error, nothing sent', { status: 500 }, 'rejects'],
  ])('an update to an edited draft %s', async (_label, patch, outcome) => {
    graphPatch = patch
    const run = sendProviderDraft('user-1', WS, 'conv-1', DRAFT, { to: ['simon@harborline.io'], cc: [], subject: 'Re', body: 'x' })
    if (outcome === 'resolves') await expect(run).resolves.toEqual({ ok: false, reason: 'not_found' })
    else await expect(run).rejects.toThrow('Outlook draft update error: 500')
    expect(sends()).toEqual([])
    expect(fake.rows('tracked_job')[0].status).toBe('needs_review')
  })

  it('without the Deleted Items folder to tell a discarded draft apart, nothing is sent', async () => {
    graphDeletedItems = { status: 503 }
    await expect(sendProviderDraft('user-1', WS, 'conv-1', DRAFT)).rejects.toThrow('Outlook Deleted Items folder unavailable')
    expect(sends()).toEqual([])
    expect(fake.rows('tracked_job')[0].status).toBe('needs_review')
  })

  it('a thread indexed without an account uses the Outlook token, not the first Gmail one', async () => {
    fake.rows('email_thread_index')[0].account_id = null
    await sendProviderDraft('user-1', WS, 'conv-1', DRAFT)
    expect(sends()[0].auth).toBe('Bearer m-default-tok')
  })
})

describe('sendProviderDraft — pinned to one mailbox (a scheduled send)', () => {
  it('sends from the account named, not the thread’s index (a new message’s thread is not indexed yet)', async () => {
    fake.seed('connected_account', [{ id: 'acct-side', user_id: 'user-1', provider: 'google', capability: 'email' }])
    accountTokens['acct-side'] = { token: 'side-tok', email: 'me@fernhill.example', accountId: 'acct-side' }
    const result = await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', null, { accountId: 'acct-side' })
    expect(result).toEqual({ ok: true, threadId: 'thr-1', messageId: 'm-sent' })
    expect(calls.every((c) => c.auth === 'Bearer side-tok')).toBe(true)
  })

  it('refuses an account that is not the user’s, or not a mail account: nothing is read or sent', async () => {
    fake.seed('connected_account', [
      { id: 'acct-theirs', user_id: 'user-2', provider: 'google', capability: 'email' },
      { id: 'acct-cal', user_id: 'user-1', provider: 'google', capability: 'calendar' },
    ])
    accountTokens['acct-theirs'] = { token: 'their-tok', email: 'them@harborline.example', accountId: 'acct-theirs' }
    accountTokens['acct-cal'] = { token: 'cal-tok', email: 'me@fernhill.example', accountId: 'acct-cal' }
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', null, { accountId: 'acct-theirs' })).rejects.toThrow('No email integration connected')
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', null, { accountId: 'acct-cal' })).rejects.toThrow('No email integration connected')
    expect(calls).toEqual([])
  })
})
