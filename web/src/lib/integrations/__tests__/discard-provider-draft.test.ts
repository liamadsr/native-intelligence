/**
 * Mail's Discard on a draft in a thread (discardProviderDraft). The draft is
 * named by its MESSAGE id, as the thread view shows it, and both ids are
 * untrusted:
 *  - it is deleted only when the mailbox that holds the thread says the
 *    message is a draft on that thread (at Outlook, outside Deleted Items), and
 *    natively: Gmail's drafts.delete by the draft's own id (found through the
 *    drafts list), Graph's DELETE. A Gmail draft edited since it was loaded has
 *    a new message id: not found, and not deleted unread;
 *  - once it is gone, the thread is read again, in each workspace that lists
 *    it: what is left keeps the row, and a thread that was nothing but the
 *    draft leaves Mail (`threadRemains` false); a drafting pass's row for the
 *    draft is dismissed; the work items that delivered it stop waiting. None of
 *    that can fail the discard.
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

import { discardProviderDraft } from '@/lib/integrations/email'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'
const WS = 'f6000000-0000-4000-8000-000000000001'
const OTHER_WS = 'f6000000-0000-4000-8000-000000000002'
const PASS_ROW = 'd7000000-0000-4000-8000-000000000001'

interface Reply {
  status: number
  body?: unknown
}
let calls: Array<{ method: string; url: string; auth: string | undefined }> = []
let gmailDraftMessage: Reply
let draftPages: Array<{ drafts: Array<{ id: string; message: { id: string } }>; nextPageToken?: string }>
let deleteStatus: number
/** Gmail threads as Gmail holds them after the delete, by id (absent: 404). */
let gmailThreads: Record<string, Reply>
let graphDraftMessage: Reply
let deletedItems: Reply
let conversation: Reply

const respond = ({ status, body }: Reply) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as unknown as Response

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({ method, url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
  if (method === 'DELETE') return respond({ status: deleteStatus })
  if (url.startsWith(`${GMAIL}/messages/`)) return respond(gmailDraftMessage)
  if (url.startsWith(`${GMAIL}/drafts?`)) {
    const page = new URL(url).searchParams.get('pageToken')
    return respond({ status: 200, body: draftPages[page ? Number(page.slice(1)) : 0] })
  }
  if (url.startsWith(`${GMAIL}/threads/`)) {
    const id = decodeURIComponent(url.slice(`${GMAIL}/threads/`.length).split('?')[0])
    return respond(gmailThreads[id] ?? { status: 404 })
  }
  if (url.startsWith(`${GRAPH}/mailFolders/deleteditems`)) return respond(deletedItems)
  if (url.startsWith(`${GRAPH}/messages/`)) return respond(graphDraftMessage)
  if (url.startsWith(`${GRAPH}/messages?`)) return respond(conversation)
  return respond({ status: 404 })
})

const deletes = () => calls.filter((c) => c.method === 'DELETE')
const path = (c: { method: string; url: string }) => `${c.method} ${c.url.split('?')[0]}`

const gmailMessage = (id: string, labelIds: string[], from: string) => ({
  id,
  threadId: 'thr-1',
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

function seedGmailThread() {
  fake.seed('email_thread_index', [
    {
      id: 'idx-1', workspace_id: WS, user_id: 'user-1', account_id: 'acct-work', provider: 'google',
      provider_thread_id: 'thr-1', provider_message_id: 'm-draft', folder: 'drafts', is_draft: true, message_count: 2,
    },
    // The same mailbox listed in another workspace.
    {
      id: 'idx-2', workspace_id: OTHER_WS, user_id: 'user-1', account_id: 'acct-work', provider: 'google',
      provider_thread_id: 'thr-1', provider_message_id: 'm-draft', folder: 'inbox', is_draft: true, message_count: 2,
    },
  ])
  fake.seed('tracked_job', [
    { id: 'job-agent', status: 'needs_review', deliverables: [{ type: 'email_draft', id: 'm-draft' }] },
    { id: 'job-pass', status: 'needs_review', deliverables: [{ type: 'email_draft', id: PASS_ROW }] },
    { id: 'job-other', status: 'needs_review', deliverables: [{ type: 'email_draft', id: 'm-other' }] },
  ])
  fake.seed('email_draft', [
    { id: PASS_ROW, workspace_id: WS, user_id: 'user-1', provider_draft_id: 'm-draft', status: 'pending_review' },
    { id: 'd7000000-0000-4000-8000-000000000002', workspace_id: WS, user_id: 'user-1', provider_draft_id: 'm-other', status: 'pending_review' },
  ])
}
const jobs = () => Object.fromEntries(fake.rows('tracked_job').map((j) => [j.id, j.status]))

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fake = makeFakeSupabase()
  for (const k of Object.keys(tokens)) delete tokens[k]
  for (const k of Object.keys(accountTokens)) delete accountTokens[k]
  tokens.google = { token: 'g-default-tok', email: 'liam@gmail.com' }
  tokens.microsoft = { token: 'm-default-tok', email: 'liam@outlook.com' }
  accountTokens['acct-work'] = { token: 'work-tok', email: 'liam@dial8.ai', accountId: 'acct-work' }
  calls = []
  gmailDraftMessage = { status: 200, body: { id: 'm-draft', threadId: 'thr-1', labelIds: ['DRAFT'] } }
  draftPages = [
    { drafts: [{ id: 'r-1', message: { id: 'm-1' } }], nextPageToken: 'p1' },
    { drafts: [{ id: 'r-7', message: { id: 'm-draft' } }] },
  ]
  deleteStatus = 204
  gmailThreads = { 'thr-1': { status: 200, body: { id: 'thr-1', snippet: 'Does Tuesday work?', messages: [SIMON] } } }
  graphDraftMessage = { status: 404 }
  deletedItems = { status: 200, body: { id: 'folder-deleted' } }
  conversation = { status: 200, body: { value: [] } }
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  warn.mockRestore()
})

describe('discardProviderDraft — Gmail', () => {
  it('deletes a draft the mailbox holds on the thread, by its draft id, with the thread’s own account', async () => {
    seedGmailThread()
    await expect(discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toEqual({ ok: true, threadRemains: true })
    expect(calls.slice(0, 4).map(path)).toEqual([
      `GET ${GMAIL}/messages/m-draft`,
      `GET ${GMAIL}/drafts`,
      `GET ${GMAIL}/drafts`,
      `DELETE ${GMAIL}/drafts/r-7`,
    ])
    expect(calls.every((c) => c.auth === 'Bearer work-tok')).toBe(true)
  })

  it('the thread is read again without the draft, in each workspace that lists it', async () => {
    seedGmailThread()
    await discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(calls.filter((c) => c.url.startsWith(`${GMAIL}/threads/thr-1`))).toHaveLength(2)
    for (const row of fake.rows('email_thread_index')) {
      expect(row).toMatchObject({ provider_message_id: 'm-simon', is_draft: false })
    }
  })

  it('a thread that was nothing but the draft leaves Mail', async () => {
    seedGmailThread()
    gmailThreads = {}
    await expect(discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toEqual({ ok: true, threadRemains: false })
    expect(fake.rows('email_thread_index')).toEqual([])
  })

  it('a thread Gmail won’t read back keeps its row for the next sync; the discard stands', async () => {
    seedGmailThread()
    gmailThreads = { 'thr-1': { status: 500 } }
    await expect(discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toEqual({ ok: true, threadRemains: true })
    expect(fake.rows('email_thread_index').map((r) => r.provider_message_id)).toEqual(['m-draft', 'm-draft'])
  })

  it('a drafting pass’s row for the draft is dismissed, and the work items that delivered it stop waiting', async () => {
    seedGmailThread()
    await discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    // Dismissed: the pass's row is deleted (and its hold with it); the other draft waits.
    expect(fake.rows('email_draft').map((r) => r.status)).toEqual(['pending_review'])
    expect(jobs()).toEqual({ 'job-agent': 'done', 'job-pass': 'done', 'job-other': 'needs_review' })
  })

  it.each([
    ['gone from the mailbox', () => (gmailDraftMessage = { status: 404 })],
    ['not a draft', () => (gmailDraftMessage = { status: 200, body: { id: 'm-draft', threadId: 'thr-1', labelIds: ['INBOX'] } })],
    ['a draft on another thread', () => (gmailDraftMessage = { status: 200, body: { id: 'm-draft', threadId: 'thr-2', labelIds: ['DRAFT'] } })],
    ['edited since it was loaded (no draft holds this message now)', () => (draftPages = [{ drafts: [{ id: 'r-7', message: { id: 'm-draft-v2' } }] }])],
  ])('a message %s is not found: nothing is deleted or settled', async (_label, arrange) => {
    seedGmailThread()
    arrange()
    await expect(discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(deletes()).toEqual([])
    expect(fake.rows('email_thread_index').map((r) => r.provider_message_id)).toEqual(['m-draft', 'm-draft'])
    expect(fake.rows('email_draft')[0].status).toBe('pending_review')
    expect(jobs()['job-agent']).toBe('needs_review')
  })

  it('a draft already gone when the delete lands counts as discarded', async () => {
    seedGmailThread()
    deleteStatus = 404
    await expect(discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')).resolves.toMatchObject({ ok: true })
    expect(jobs()['job-agent']).toBe('done')
  })

  it('a refused delete is an error, and nothing is settled', async () => {
    seedGmailThread()
    deleteStatus = 500
    await expect(discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')).rejects.toThrow('Gmail draft delete error: 500')
    expect(fake.rows('email_thread_index').map((r) => r.provider_message_id)).toEqual(['m-draft', 'm-draft'])
    expect(jobs()['job-agent']).toBe('needs_review')
  })

  it.each([
    ['a draft id that walks out of /drafts/', 'thr-1', '../../labels'],
    ['a thread id with a query in it', 'thr-1?x=1', 'm-draft'],
  ])('%s is refused before any lookup or provider call', async (_label, threadId, draftId) => {
    seedGmailThread()
    await expect(discardProviderDraft('user-1', WS, threadId, draftId)).resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('discardProviderDraft — Outlook', () => {
  const DRAFT = 'AAMkAD/draft+1=='
  const graphMessage = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    conversationId: 'conv-1',
    subject: 'Pricing',
    from: { emailAddress: { name: 'Simon Åkerlund', address: 'simon@harborline.io' } },
    toRecipients: [{ emailAddress: { address: 'liam@dial8.ai' } }],
    bodyPreview: 'Can you send the numbers?',
    isRead: true,
    receivedDateTime: '2026-09-23T14:40:00Z',
    isDraft: false,
    parentFolderId: 'folder-inbox',
    ...over,
  })
  beforeEach(() => {
    accountTokens['acct-outlook'] = { token: 'outlook-tok', email: 'liam@dial8.ai', accountId: 'acct-outlook' }
    fake.seed('email_thread_index', [
      {
        id: 'idx-o', workspace_id: WS, user_id: 'user-1', account_id: 'acct-outlook', provider: 'microsoft',
        provider_thread_id: 'conv-1', provider_message_id: DRAFT, folder: 'drafts', is_draft: true, message_count: 2,
      },
    ])
    fake.seed('tracked_job', [{ id: 'job-agent', status: 'needs_review', deliverables: [{ type: 'email_draft', id: DRAFT }] }])
    graphDraftMessage = { status: 200, body: { isDraft: true, conversationId: 'conv-1', parentFolderId: 'folder-drafts' } }
    conversation = { status: 200, body: { value: [graphMessage('o-simon')] } }
  })

  it('deletes a message Graph confirms is a draft on the conversation, by its URL-encoded id; the conversation stays', async () => {
    await expect(discardProviderDraft('user-1', WS, 'conv-1', DRAFT)).resolves.toEqual({ ok: true, threadRemains: true })
    expect(calls.slice(0, 3).map(path)).toEqual([
      `GET ${GRAPH}/messages/AAMkAD%2Fdraft%2B1%3D%3D`,
      `GET ${GRAPH}/mailFolders/deleteditems`,
      `DELETE ${GRAPH}/messages/AAMkAD%2Fdraft%2B1%3D%3D`,
    ])
    expect(calls.every((c) => c.auth === 'Bearer outlook-tok')).toBe(true)
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ provider_message_id: 'o-simon', is_draft: false })
    expect(jobs()['job-agent']).toBe('done')
  })

  it.each([
    ['not a draft', { isDraft: false, conversationId: 'conv-1', parentFolderId: 'folder-inbox' }],
    ['on another conversation', { isDraft: true, conversationId: 'conv-2', parentFolderId: 'folder-drafts' }],
    ['already in Deleted Items (discarded, or superseded)', { isDraft: true, conversationId: 'conv-1', parentFolderId: 'folder-deleted' }],
  ])('a message %s is not found, and not deleted', async (_label, body) => {
    graphDraftMessage = { status: 200, body }
    await expect(discardProviderDraft('user-1', WS, 'conv-1', DRAFT)).resolves.toEqual({ ok: false, reason: 'not_found' })
    expect(deletes()).toEqual([])
    expect(jobs()['job-agent']).toBe('needs_review')
  })

  it('a refused delete is an error, and nothing is settled', async () => {
    deleteStatus = 403
    await expect(discardProviderDraft('user-1', WS, 'conv-1', DRAFT)).rejects.toThrow('Outlook draft delete error: 403')
    expect(fake.rows('email_thread_index')[0]).toMatchObject({ provider_message_id: DRAFT, is_draft: true })
  })
})

describe('discardProviderDraft — a draft with a send scheduled, discarded by hand', () => {
  it('cancels the waiting schedule naming it, so no "wasn’t sent" notice comes later', async () => {
    seedGmailThread()
    fake.seed('email_scheduled_send', [{ id: 's-1', user_id: 'user-1', provider_draft_id: 'r-7', status: 'scheduled', to_emails: ['simon@harborline.io'], subject: 'Re' }])
    await discardProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    expect(fake.rows('email_scheduled_send')[0]).toMatchObject({ status: 'cancelled', to_emails: null, subject: null })
  })
})
