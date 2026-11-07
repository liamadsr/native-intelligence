/**
 * deleteProviderDraft takes an id a model (create_email_draft's
 * previous_draft_id) or the chat card chose. It must only ever DELETE a draft
 * this user has indexed, at that draft's own provider and mailbox, and the id
 * can never walk out of `/drafts/` or `/me/messages/` (Outlook's email token
 * holds Mail.ReadWrite, so `messages/../events/X` would delete a calendar
 * event).
 *
 * The id is the draft's MESSAGE id. Graph deletes a draft by it; Gmail deletes
 * by the draft's own id (`r-…`), found through the drafts list. Only once the
 * provider confirms the draft is gone (deleted, a 404, or at Gmail no draft
 * holding the message) are its index rows settled, and a draft's row is its
 * THREAD's row: a reply draft's conversation is read again and keeps its row,
 * indexed as the sync would; only a thread that was nothing but the draft
 * loses it. A refusal, or a thread the provider won't read back, leaves the
 * row as it was.
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

import { deleteProviderDraft, deleteProviderDraftReport } from '@/lib/integrations/email'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'
const WS = 'f6000000-0000-4000-8000-000000000001'
const OTHER_WS = 'f6000000-0000-4000-8000-000000000002'

interface Reply {
  status: number
  body?: unknown
}
let calls: Array<{ method: string; url: string; auth: string | undefined }> = []
/** The drafts list, page by page (a page's `nextPageToken` is `p<index of the next page>`). */
let draftPages: Array<{ drafts: Array<{ id: string; message: { id: string } }>; nextPageToken?: string }>
let listStatus = 200
let deleteStatus = 204
let deleteThrows = false
/** Gmail threads as Gmail holds them after the delete, by id (absent: 404). */
let gmailThreads: Record<string, Reply> = {}
let deletedItems: Reply
let conversation: Reply

const respond = ({ status, body }: Reply) => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} })

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({ method, url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
  if (method === 'DELETE') {
    if (deleteThrows) throw new TypeError('fetch failed')
    return respond({ status: deleteStatus })
  }
  if (url.startsWith(`${GMAIL}/drafts?`)) {
    const page = new URL(url).searchParams.get('pageToken')
    return respond({ status: listStatus, body: draftPages[page ? Number(page.slice(1)) : 0] })
  }
  if (url.startsWith(`${GMAIL}/threads/`)) {
    const id = decodeURIComponent(url.slice(`${GMAIL}/threads/`.length).split('?')[0])
    return respond(gmailThreads[id] ?? { status: 404 })
  }
  if (url.startsWith(`${GRAPH}/mailFolders/deleteditems`)) return respond(deletedItems)
  if (url.startsWith(`${GRAPH}/messages?`)) return respond(conversation)
  return respond({ status: 404 })
})

const gmailMessage = (id: string, labelIds: string[], from: string) => ({
  id,
  labelIds,
  internalDate: '1790200000000',
  payload: {
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: 'liam@dial8.ai' },
      { name: 'Subject', value: 'Exploratory Meeting' },
    ],
  },
})
const SIMON = gmailMessage('m-simon', ['INBOX'], 'Simon Åkerlund <simon@harborline.io>')

/** The thread's row, pointing at the draft (as the sync and the email tools leave it). */
const draftRow = (over: Record<string, unknown> = {}) => ({
  id: 'idx-1',
  workspace_id: WS,
  user_id: 'user-1',
  account_id: null,
  provider: 'google',
  provider_thread_id: 'thr-1',
  provider_message_id: '18f0a1b2c3d4',
  folder: 'drafts',
  is_draft: true,
  needs_reply: false,
  message_count: 2,
  ...over,
})
const row = (id = 'idx-1') => fake.rows('email_thread_index').find((r) => r.id === id)

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fake = makeFakeSupabase()
  for (const k of Object.keys(accountTokens)) delete accountTokens[k]
  tokens.google = { token: 'g-tok', email: 'liam@dial8.ai' }
  tokens.microsoft = { token: 'm-tok', email: 'liam@dial8.ai' }
  calls = []
  draftPages = [
    { drafts: [{ id: 'r-1', message: { id: '18f0000000000001' } }], nextPageToken: 'p1' },
    { drafts: [{ id: 'r-5294633396826133224', message: { id: '18f0a1b2c3d4' } }] },
  ]
  listStatus = 200
  deleteStatus = 204
  deleteThrows = false
  gmailThreads = { 'thr-1': { status: 200, body: { id: 'thr-1', snippet: 'Sorry, 11 am does not work.', messages: [SIMON] } } }
  deletedItems = { status: 200, body: { id: 'folder-deleted' } }
  conversation = { status: 200, body: { value: [] } }
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  vi.unstubAllGlobals()
})

const deletedAt = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url)

describe('deleteProviderDraft — which draft, where', () => {
  it('deletes an indexed Outlook draft at Graph, URL-encoded, looked up for this user only', async () => {
    fake.seed('email_thread_index', [draftRow({ provider: 'microsoft', provider_message_id: 'AAMkAD/abc+def==' })])
    await deleteProviderDraft('user-1', 'AAMkAD/abc+def==')
    expect(deletedAt()).toEqual([`${GRAPH}/messages/AAMkAD%2Fabc%2Bdef%3D%3D`])
    expect(fake.calls[0]).toEqual({
      table: 'email_thread_index',
      op: 'select',
      filters: [
        ['user_id', 'user-1'],
        ['provider_message_id', 'AAMkAD/abc+def=='],
        ['is_draft', true],
      ],
    })
  })

  it("uses the draft row's provider, not whichever token exists first", async () => {
    fake.seed('email_thread_index', [draftRow({ provider: 'microsoft', provider_message_id: 'AAMkADdraft' })])
    await deleteProviderDraft('user-1', 'AAMkADdraft')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.url.startsWith('https://graph.microsoft.com/'))).toBe(true)
  })

  it('deletes a Gmail draft by its own draft id, found through the drafts list, never by the message id', async () => {
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `GET ${GMAIL}/drafts`,
      `GET ${GMAIL}/drafts`,
      `DELETE ${GMAIL}/drafts/r-5294633396826133224`,
      `GET ${GMAIL}/threads/thr-1`,
    ])
  })

  it('uses the token of the account the row names, not the user’s default mailbox', async () => {
    accountTokens['acct-work'] = { token: 'work-tok', email: 'liam@dial8.ai', accountId: 'acct-work' }
    fake.seed('email_thread_index', [draftRow({ account_id: 'acct-work' })])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(calls).toHaveLength(4)
    expect(calls.every((c) => c.auth === 'Bearer work-tok')).toBe(true)
  })

  it('a row naming an account with no token asks no other mailbox, and stays as it was', async () => {
    fake.seed('email_thread_index', [draftRow({ account_id: 'acct-gone' })])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(row()).toMatchObject({ is_draft: true, folder: 'drafts' })
    expect(warn).toHaveBeenCalledWith('[email] draft not deleted: no token for its google mailbox')
  })

  it('makes no provider call and changes no row when the id is not an indexed draft of this user', async () => {
    fake.seed('email_thread_index', [draftRow({ user_id: 'user-2' }), draftRow({ id: 'idx-2', is_draft: false })])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fake.rows('email_thread_index')).toHaveLength(2)
  })

  it.each([
    '../events/AAMkADevent',
    '..',
    '.',
    '%2e%2e/events/X',
    'abc/../../mailFolders/inbox',
    'abc?$select=id',
    'abc#frag',
    '',
    'a'.repeat(513),
  ])('refuses the id %j before any lookup or provider call', async (id) => {
    fake.seed('email_thread_index', [draftRow({ provider: 'microsoft', provider_message_id: id })])
    await deleteProviderDraft('user-1', id)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fake.calls).toEqual([])
  })

  it('refuses a non-string id', async () => {
    await deleteProviderDraft('user-1', { toString: () => 'x' } as unknown as string)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fake.calls).toEqual([])
  })
})

describe('deleteProviderDraft — the thread the draft was on', () => {
  it('a discarded reply draft leaves its conversation listed, re-indexed from what Gmail holds now', async () => {
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(fake.rows('email_thread_index')).toHaveLength(1)
    expect(row()).toMatchObject({
      provider_thread_id: 'thr-1',
      provider_message_id: 'm-simon',
      is_draft: false,
      folder: 'inbox',
      from_email: 'simon@harborline.io',
      needs_reply: true,
      message_count: 1,
    })
  })

  it('the holding pattern: a deleted draft (the chat card discard) releases its review row and hold, even when the mailbox finds nothing', async () => {
    fake.seed('email_hold', [{ id: 'hold-1', user_id: 'user-1' }])
    fake.seed('email_draft', [
      { id: 'row-1', user_id: 'user-1', hold_id: 'hold-1', status: 'pending_review', provider_draft_id: '18f0a1b2c3d4' },
      { id: 'own-1', user_id: 'user-1', hold_id: null, status: 'pending_review', provider_draft_id: '18f0a1b2c3d4' },
      { id: 'other', user_id: 'user-2', hold_id: null, status: 'pending_review', provider_draft_id: '18f0a1b2c3d4' },
    ])
    expect((await deleteProviderDraft('user-1', '18f0a1b2c3d4')).sort()).toEqual(['own-1', 'row-1'])
    expect(fake.rows('email_hold')).toEqual([])
    // row-1 goes with its hold (ON DELETE CASCADE, not simulated here); own-1 is deleted itself.
    expect(fake.rows('email_draft').map((d) => d.id)).toEqual(['row-1', 'other'])
  })

  it('the discard route’s report: rows and hold released even when the mailbox keeps the draft (no token), mailboxDeleted false', async () => {
    fake.seed('email_thread_index', [draftRow({ account_id: 'acct-gone' })])
    fake.seed('email_hold', [{ id: 'hold-1', user_id: 'user-1' }])
    fake.seed('email_draft', [{ id: 'own-1', user_id: 'user-1', hold_id: null, status: 'pending_review', provider_draft_id: '18f0a1b2c3d4' }])
    const out = await deleteProviderDraftReport('user-1', '18f0a1b2c3d4', { reviewed: true })
    expect(out).toMatchObject({ released: ['own-1'], mailboxDeleted: false, mailboxError: null })
    expect(fake.rows('email_draft')).toEqual([])
  })

  it('the discard route’s report: a mailbox that deletes it says mailboxDeleted true', async () => {
    fake.seed('email_thread_index', [draftRow()])
    expect((await deleteProviderDraftReport('user-1', '18f0a1b2c3d4')).mailboxDeleted).toBe(true)
  })

  it('a draft that was the whole thread (Gmail no longer has the thread): its row goes', async () => {
    gmailThreads = {}
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(fake.rows('email_thread_index')).toEqual([])
  })

  it('each workspace that lists the mailbox keeps its own row of the thread', async () => {
    fake.seed('email_thread_index', [draftRow(), draftRow({ id: 'idx-2', workspace_id: OTHER_WS, folder: 'inbox' })])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(deletedAt()).toHaveLength(1)
    expect(fake.rows('email_thread_index').map((r) => [r.id, r.workspace_id, r.provider_message_id, r.is_draft, r.folder])).toEqual([
      ['idx-1', WS, 'm-simon', false, 'inbox'],
      ['idx-2', OTHER_WS, 'm-simon', false, 'inbox'],
    ])
  })

  it('a thread Gmail will not read back keeps its row as it was, for the next sync', async () => {
    gmailThreads = { 'thr-1': { status: 500 } }
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(deletedAt()).toHaveLength(1)
    expect(row()).toMatchObject({ provider_message_id: '18f0a1b2c3d4', is_draft: true, folder: 'drafts' })
    expect(warn).toHaveBeenCalledWith(
      '[email] draft deleted, but google would not read its thread again; its row waits for the next sync',
    )
  })

  it('a message no Gmail draft holds (sent or discarded already): nothing is deleted at Gmail, the thread is re-indexed', async () => {
    fake.seed('email_thread_index', [draftRow({ provider_message_id: '18f0ffffffffffff' })])
    await deleteProviderDraft('user-1', '18f0ffffffffffff')
    expect(deletedAt()).toEqual([])
    expect(row()).toMatchObject({ provider_message_id: 'm-simon', is_draft: false })
  })

  it('a Gmail draft deleted meanwhile (its DELETE 404s) is gone: the thread is re-indexed', async () => {
    deleteStatus = 404
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(deletedAt()).toEqual([`${GMAIL}/drafts/r-5294633396826133224`])
    expect(row()).toMatchObject({ provider_message_id: 'm-simon', is_draft: false })
  })

  it.each([400, 403, 500])('a Gmail DELETE refused with %i leaves the row as it was, and says so', async (status) => {
    deleteStatus = status
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(calls.some((c) => c.url.includes('/threads/'))).toBe(false)
    expect(row()).toMatchObject({ provider_message_id: '18f0a1b2c3d4', is_draft: true })
    expect(warn).toHaveBeenCalledWith(`[email] Gmail draft not deleted: ${status}`)
  })

  it('a Gmail drafts list that fails deletes nothing and leaves the row', async () => {
    listStatus = 403
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(deletedAt()).toEqual([])
    expect(row()).toMatchObject({ is_draft: true })
    expect(warn).toHaveBeenCalledWith('[email] Gmail draft not deleted:', 'Gmail drafts list error: 403')
  })

  it('a Gmail drafts list longer than it reads is not taken for “no such draft”: the row stays', async () => {
    draftPages = Array.from({ length: 12 }, (_, i) => ({
      drafts: [{ id: `r-${i}`, message: { id: `18f1${String(i).padStart(12, '0')}` } }],
      nextPageToken: `p${i + 1}`,
    }))
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(calls.filter((c) => c.url.startsWith(`${GMAIL}/drafts?`))).toHaveLength(10)
    expect(deletedAt()).toEqual([])
    expect(row()).toMatchObject({ is_draft: true })
  })

  it('a DELETE that never reaches the provider leaves the row', async () => {
    deleteThrows = true
    fake.seed('email_thread_index', [draftRow()])
    await deleteProviderDraft('user-1', '18f0a1b2c3d4')
    expect(row()).toMatchObject({ is_draft: true })
    expect(warn).toHaveBeenCalledWith('[email] Gmail draft not deleted:', 'fetch failed')
  })
})

describe('deleteProviderDraft — an Outlook conversation', () => {
  const DRAFT = 'AAMkADdraft'
  const graphMessage = (id: string, receivedDateTime: string, over: Record<string, unknown> = {}) => ({
    id,
    conversationId: 'conv-1',
    subject: 'Exploratory Meeting',
    from: { emailAddress: { name: 'Simon Åkerlund', address: 'simon@harborline.io' } },
    toRecipients: [{ emailAddress: { address: 'liam@dial8.ai' } }],
    bodyPreview: 'Sorry, 11 am does not work.',
    isRead: true,
    receivedDateTime,
    isDraft: false,
    parentFolderId: 'folder-inbox',
    ...over,
  })
  const outlookRow = () =>
    draftRow({ provider: 'microsoft', provider_thread_id: 'conv-1', provider_message_id: DRAFT, folder: 'inbox' })

  it('a discarded reply draft (now in Deleted Items) leaves the conversation listed, by its latest message still there', async () => {
    conversation = {
      status: 200,
      body: {
        value: [
          graphMessage('o-simon', '2026-09-23T14:40:00Z'),
          graphMessage('o-draft-moved', '2026-09-24T05:02:00Z', {
            isDraft: true,
            parentFolderId: 'folder-deleted',
            from: { emailAddress: { address: 'liam@dial8.ai' } },
          }),
        ],
      },
    }
    fake.seed('email_thread_index', [outlookRow()])
    await deleteProviderDraft('user-1', DRAFT)
    expect(row()).toMatchObject({
      provider_message_id: 'o-simon',
      is_draft: false,
      from_email: 'simon@harborline.io',
      needs_reply: true,
      message_count: 1,
    })
    const list = calls.find((c) => c.url.startsWith(`${GRAPH}/messages?`))!
    const params = new URL(list.url).searchParams
    expect(params.get('$filter')).toBe("conversationId eq 'conv-1'")
    expect(params.get('$select')?.split(',')).toEqual(expect.arrayContaining(['isDraft', 'parentFolderId']))
  })

  it('a draft that was the whole conversation (only Deleted Items hold it): its row goes', async () => {
    conversation = {
      status: 200,
      body: { value: [graphMessage('o-draft-moved', '2026-09-24T05:02:00Z', { isDraft: true, parentFolderId: 'folder-deleted' })] },
    }
    fake.seed('email_thread_index', [outlookRow()])
    await deleteProviderDraft('user-1', DRAFT)
    expect(fake.rows('email_thread_index')).toEqual([])
  })

  it('without the Deleted Items folder to tell them apart, the conversation keeps its row as it was', async () => {
    deletedItems = { status: 500 }
    conversation = { status: 200, body: { value: [graphMessage('o-simon', '2026-09-23T14:40:00Z')] } }
    fake.seed('email_thread_index', [outlookRow()])
    await deleteProviderDraft('user-1', DRAFT)
    expect(row()).toMatchObject({ provider_message_id: DRAFT, is_draft: true })
  })

  it('an Outlook DELETE that 404s is gone (the conversation is re-indexed); one refused leaves the row', async () => {
    conversation = { status: 200, body: { value: [graphMessage('o-simon', '2026-09-23T14:40:00Z')] } }
    fake.seed('email_thread_index', [outlookRow()])
    deleteStatus = 500
    await deleteProviderDraft('user-1', DRAFT)
    expect(row()).toMatchObject({ provider_message_id: DRAFT, is_draft: true })
    expect(warn).toHaveBeenCalledWith('[email] Outlook draft not deleted: 500')

    deleteStatus = 404
    await deleteProviderDraft('user-1', DRAFT)
    expect(row()).toMatchObject({ provider_message_id: 'o-simon', is_draft: false })
  })
})
