/**
 * One thread indexed as its provider holds it now (src/lib/crm/email-sync.ts):
 * the row the sync writes for a thread, which a discarded draft's thread is
 * written by too, so the conversation keeps its row instead of vanishing.
 *
 *  - Gmail (indexGmailThread): the thread's row in this workspace, updated in
 *    place or added, by its last message: folder from its labels, is_draft,
 *    sender, count. 'gone' when Gmail has no such thread or no message in it;
 *    'unreadable' when it would not say. Neither writes anything.
 *  - Outlook (indexOutlookThread): one conversation read on its own, Deleted
 *    Items left out (a deleted draft lands there, still a draft), by its
 *    newest remaining message; is_draft from Graph. 'gone' when only Deleted
 *    Items hold it.
 *  - The sync still indexes each thread it reads through them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))

const accounts = vi.hoisted(() => ({
  all: [] as Array<{ token: string; email: string; provider: string; accountId: string }>,
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => null),
  getAllValidTokens: vi.fn(async () => accounts.all),
}))

import { indexGmailThread, indexOutlookThread, syncEmailThreads } from '@/lib/crm/email-sync'
import type { SupabaseClient } from '@supabase/supabase-js'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'
const WS = 'f6000000-0000-4000-8000-000000000001'

interface Reply {
  status: number
  body?: unknown
}
let urls: string[] = []
let gmailList: Reply
let gmailThreads: Record<string, Reply>
let deletedItems: Reply
let graphList: Reply
let graphConversation: Reply

const respond = ({ status, body }: Reply) => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} })
const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input)
  urls.push(url)
  if (url.startsWith(`${GMAIL}/threads?`)) return respond(gmailList)
  if (url.startsWith(`${GMAIL}/threads/`)) {
    const id = decodeURIComponent(url.slice(`${GMAIL}/threads/`.length).split('?')[0])
    return respond(gmailThreads[id] ?? { status: 404 })
  }
  if (url.startsWith(`${GRAPH}/mailFolders/deleteditems`)) return respond(deletedItems)
  if (url.startsWith(`${GRAPH}/messages?`)) {
    return respond(new URL(url).searchParams.has('$filter') && url.includes('conversationId') ? graphConversation : graphList)
  }
  return respond({ status: 404 })
})

const gmailMessage = (id: string, labelIds: string[], from: string, internalDate: string) => ({
  id,
  labelIds,
  internalDate,
  payload: {
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: from.includes('simon') ? 'liam@dial8.ai' : 'simon@harborline.io' },
      { name: 'Subject', value: 'Exploratory Meeting' },
    ],
  },
})
const SIMON = gmailMessage('m-simon', ['INBOX', 'UNREAD'], 'Simon Åkerlund <simon@harborline.io>', '1790200000000')
const REPLY = gmailMessage('m-reply', ['SENT'], 'Liam Alizadeh <liam@dial8.ai>', '1790300000000')
const DRAFT = gmailMessage('m-draft', ['DRAFT'], 'Liam Alizadeh <liam@dial8.ai>', '1790300000000')

const graphMessage = (id: string, receivedDateTime: string, over: Record<string, unknown> = {}) => ({
  id,
  conversationId: 'conv-1',
  subject: 'Exploratory Meeting',
  from: { emailAddress: { name: 'Simon Åkerlund', address: 'simon@harborline.io' } },
  toRecipients: [{ emailAddress: { address: 'liam@dial8.ai' } }],
  bodyPreview: 'Sorry, 11 am does not work.',
  isRead: false,
  receivedDateTime,
  isDraft: false,
  parentFolderId: 'folder-inbox',
  ...over,
})

/** A message as the sync's listing returns it: its $select asks for neither isDraft nor parentFolderId. */
const listed = (id: string, receivedDateTime: string, over: Record<string, unknown> = {}) => {
  const m: Record<string, unknown> = graphMessage(id, receivedDateTime, over)
  delete m.isDraft
  delete m.parentFolderId
  return m
}

const target = (over: Record<string, unknown> = {}) => ({
  accessToken: 'tok',
  userEmail: 'liam@dial8.ai',
  userId: 'user-1',
  workspaceId: WS,
  threadId: 'thr-1',
  accountId: 'acct-work',
  ...over,
})
const db = () => fake as unknown as SupabaseClient
const rows = () => fake.rows('email_thread_index')

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fake = makeFakeSupabase()
  accounts.all = []
  urls = []
  gmailList = { status: 200, body: { threads: [] } }
  gmailThreads = {}
  deletedItems = { status: 200, body: { id: 'folder-deleted' } }
  graphList = { status: 200, body: { value: [] } }
  graphConversation = { status: 200, body: { value: [] } }
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  log.mockRestore()
  vi.unstubAllGlobals()
})

describe('indexGmailThread', () => {
  it('updates the thread’s row in place, by its last message as Gmail holds it now', async () => {
    fake.seed('email_thread_index', [
      { id: 'idx-1', workspace_id: WS, user_id: 'user-1', provider: 'google', provider_thread_id: 'thr-1', provider_message_id: 'm-gone', is_draft: true, folder: 'drafts' },
    ])
    gmailThreads['thr-1'] = { status: 200, body: { id: 'thr-1', snippet: 'Next week works.', messages: [SIMON, REPLY] } }
    await expect(indexGmailThread(db(), target())).resolves.toBe('indexed')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      id: 'idx-1',
      account_id: 'acct-work',
      provider_message_id: 'm-reply',
      is_draft: false,
      folder: 'sent',
      from_email: 'liam@dial8.ai',
      needs_reply: false,
      is_unread: false,
      message_count: 2,
      last_message_at: new Date(1790300000000).toISOString(),
    })
    // No stored mail: no subject, preview, display name or recipient list on the row.
    for (const col of ['subject', 'snippet', 'from_name', 'to_emails', 'cc_emails']) expect(rows()[0]).not.toHaveProperty(col)
    expect(rows()[0].participant_emails).toEqual(expect.arrayContaining(['simon@harborline.io', 'liam@dial8.ai']))
  })

  it('adds the row when this workspace has none', async () => {
    gmailThreads['thr-1'] = { status: 200, body: { id: 'thr-1', messages: [SIMON] } }
    await indexGmailThread(db(), target())
    expect(rows()).toEqual([
      expect.objectContaining({ workspace_id: WS, user_id: 'user-1', provider: 'google', provider_thread_id: 'thr-1', folder: 'inbox', needs_reply: true }),
    ])
  })

  it('a thread whose last message is a draft is a draft, filed in Drafts', async () => {
    gmailThreads['thr-1'] = { status: 200, body: { id: 'thr-1', messages: [SIMON, DRAFT] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ provider_message_id: 'm-draft', is_draft: true, folder: 'drafts' })
  })

  it.each([
    ['Gmail has no such thread', { status: 404 }, 'gone'],
    ['it holds no message', { status: 200, body: { id: 'thr-1', messages: [] } }, 'gone'],
    ['Gmail would not say', { status: 500 }, 'unreadable'],
  ])('%s: %j is %s, and nothing is written', async (_label, reply, outcome) => {
    fake.seed('email_thread_index', [{ id: 'idx-1', workspace_id: WS, user_id: 'user-1', provider_thread_id: 'thr-1', is_draft: true }])
    gmailThreads['thr-1'] = reply as Reply
    await expect(indexGmailThread(db(), target())).resolves.toBe(outcome)
    expect(rows()).toEqual([{ id: 'idx-1', workspace_id: WS, user_id: 'user-1', provider_thread_id: 'thr-1', is_draft: true }])
  })

  it('asks for the thread by its URL-encoded id', async () => {
    await indexGmailThread(db(), target({ threadId: 'thr/1' }))
    expect(urls[0].split('?')[0]).toBe(`${GMAIL}/threads/thr%2F1`)
  })

  it.each(['no_reply@example.com', 'do_not_reply@example.com', 'no.reply+updates@example.com',
    'service@no-reply.example.com', 'mailer-daemon@example.com', 'postmaster@example.com', 'notifications@example.com'])
  ('marks the automated reply destination %s ineligible at indexing', async address => {
    gmailThreads['thr-1'] = { status: 200, body: { messages: [gmailMessage('auto', ['INBOX'], address, '1790200000000')] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: 'notification' })
  })

  it.each(['no_reply@example.com', 'do_not_reply@example.com', 'notifications@example.com'])
  ('keeps a human Reply-To on %s eligible for the later reply decision', async sender => {
    const message = gmailMessage('forwarded', ['INBOX'], sender, '1790200000000')
    message.payload.headers.push({ name: 'Reply-To', value: '"Doe, Jane" <jane@example.com>' })
    gmailThreads['thr-1'] = { status: 200, body: { messages: [message] } }
    await indexGmailThread(db(), target())
    expect(new URL(urls[0]).searchParams.getAll('metadataHeaders')).toContain('Reply-To')
    expect(rows()[0]).toMatchObject({ needs_reply: true, auto_classified: 'personal', from_email: sender })
  })

  it('uses an explicit no-reply Reply-To over a human sender', async () => {
    const message = gmailMessage('directed', ['INBOX'], 'Jane <jane@example.com>', '1790200000000')
    message.payload.headers.push({ name: 'Reply-To', value: 'no_reply@example.com' })
    gmailThreads['thr-1'] = { status: 200, body: { messages: [message] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: 'notification' })
  })

  it('does not use an automated-looking display name to suppress a human address', async () => {
    gmailThreads['thr-1'] = { status: 200, body: { messages: [gmailMessage('person', ['INBOX'],
      '"notifications@example.com" <jane@example.com>', '1790200000000')] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: true, auto_classified: 'personal', from_email: 'jane@example.com' })
  })

  it.each(['receipts@example.com', 'billing@example.com', 'invoice@example.com', 'Stripe <invoice+statements@stripe.com>', 'auto-confirm@amazon.com'])
  ('a transactional sender (%s) stays transactional and needs no reply (GEN-1164)', async sender => {
    gmailThreads['thr-1'] = { status: 200, body: { messages: [gmailMessage('receipt', ['INBOX'], sender, '1790200000000')] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: 'transactional' })
  })

  it('a transactional sender the person has written to in the thread is eligible again', async () => {
    const mine = gmailMessage('mine', ['SENT'], 'Liam <liam@dial8.ai>', '1790100000000')
    gmailThreads['thr-1'] = { status: 200, body: { messages: [mine, gmailMessage('reply', ['INBOX'], 'billing@example.com', '1790200000000')] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: true, auto_classified: 'transactional' })
  })

  it('a List-Unsubscribe newsletter needs no reply, even with a human Reply-To', async () => {
    const message = gmailMessage('newsletter', ['INBOX'], 'no_reply@example.com', '1790200000000')
    message.payload.headers.push({ name: 'Reply-To', value: 'author@example.com' }, { name: 'List-Unsubscribe', value: '<https://example.com/unsubscribe>' })
    gmailThreads['thr-1'] = { status: 200, body: { messages: [message] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: 'newsletter' })
  })

  it('asks Gmail for the automated-mail headers', async () => {
    gmailThreads['thr-1'] = { status: 200, body: { messages: [gmailMessage('m', ['INBOX'], 'jane@example.com', '1790200000000')] } }
    await indexGmailThread(db(), target())
    expect(new URL(urls[0]).searchParams.getAll('metadataHeaders')).toEqual(expect.arrayContaining([
      'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond', 'X-Auto-Response-Suppress', 'List-Unsubscribe', 'List-Id']))
  })

  it.each([
    ['Auto-Submitted', 'auto-replied', 'notification'],
    ['Precedence', 'bulk', 'notification'],
    ['X-Autoreply', 'yes', 'notification'],
    ['X-Auto-Response-Suppress', 'All', 'notification'],
    ['List-Id', '<team.example.com>', 'newsletter'],
  ])('a %s: %s message from a person needs no reply (%s)', async (name, value, category) => {
    const message = gmailMessage('auto', ['INBOX'], 'Jane <jane@example.com>', '1790200000000')
    message.payload.headers.push({ name, value })
    gmailThreads['thr-1'] = { status: 200, body: { messages: [message] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: category })
  })

  it('Auto-Submitted: no is a person writing', async () => {
    const message = gmailMessage('person', ['INBOX'], 'Jane <jane@example.com>', '1790200000000')
    message.payload.headers.push({ name: 'Auto-Submitted', value: 'no' })
    gmailThreads['thr-1'] = { status: 200, body: { messages: [message] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: true, auto_classified: 'personal' })
  })

  it.each(['gustonoreply@gusto.com', 'reply+0f06a1b2c3d4e5f60718293a4b5c6d7e@reply.github.com', 'alerts@bank.example.com'])
  ('marks %s ineligible at indexing', async address => {
    gmailThreads['thr-1'] = { status: 200, body: { messages: [gmailMessage('auto', ['INBOX'], address, '1790200000000')] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: 'notification' })
  })

  it('a notification address the person has written to in the thread stays eligible', async () => {
    const address = 'reply+0f06a1b2c3d4e5f60718293a4b5c6d7e@reply.github.com'
    gmailThreads['thr-1'] = { status: 200, body: { messages: [
      gmailMessage('n1', ['INBOX'], address, '1790100000000'),
      gmailMessage('mine', ['SENT'], 'Liam <liam@dial8.ai>', '1790150000000'),
      gmailMessage('n2', ['INBOX'], address, '1790200000000'),
    ] } }
    await indexGmailThread(db(), target())
    expect(rows()[0]).toMatchObject({ needs_reply: true, auto_classified: 'personal' })
  })
})

describe('indexOutlookThread', () => {
  it('leaves Deleted Items out and indexes the conversation by its newest message left', async () => {
    fake.seed('email_thread_index', [
      { id: 'idx-o', workspace_id: WS, user_id: 'user-1', provider: 'microsoft', provider_thread_id: "conv-'1", provider_message_id: 'o-draft', is_draft: true },
    ])
    graphConversation = {
      status: 200,
      body: {
        value: [
          graphMessage('o-first', '2026-09-20T09:00:00Z'),
          graphMessage('o-draft-moved', '2026-09-24T05:02:00Z', { isDraft: true, parentFolderId: 'folder-deleted' }),
          graphMessage('o-simon', '2026-09-23T14:40:00Z'),
        ],
      },
    }
    await expect(indexOutlookThread(db(), target({ threadId: "conv-'1" }))).resolves.toBe('indexed')
    expect(rows()[0]).toMatchObject({ provider_message_id: 'o-simon', is_draft: false, message_count: 2, needs_reply: true, from_email: 'simon@harborline.io' })
    const params = new URL(urls.find((u) => u.startsWith(`${GRAPH}/messages?`))!).searchParams
    expect(params.get('$filter')).toBe("conversationId eq 'conv-''1'")
  })

  it('a draft still waiting in the conversation keeps it a draft', async () => {
    graphConversation = {
      status: 200,
      body: {
        value: [
          graphMessage('o-simon', '2026-09-23T14:40:00Z'),
          graphMessage('o-draft', '2026-09-24T05:02:00Z', { isDraft: true, parentFolderId: 'folder-drafts' }),
        ],
      },
    }
    await indexOutlookThread(db(), target({ threadId: 'conv-1' }))
    expect(rows()[0]).toMatchObject({ provider_message_id: 'o-draft', is_draft: true })
  })

  it('gone when only Deleted Items hold the conversation; nothing is written', async () => {
    graphConversation = { status: 200, body: { value: [graphMessage('o-draft-moved', '2026-09-24T05:02:00Z', { parentFolderId: 'folder-deleted' })] } }
    await expect(indexOutlookThread(db(), target({ threadId: 'conv-1' }))).resolves.toBe('gone')
    expect(rows()).toEqual([])
  })

  it.each([
    ['the conversation cannot be listed', () => { graphConversation = { status: 500 } }],
    ['the Deleted Items folder cannot be told apart', () => { deletedItems = { status: 403 } }],
  ])('unreadable when %s; nothing is written', async (_label, arrange) => {
    graphConversation = { status: 200, body: { value: [graphMessage('o-simon', '2026-09-23T14:40:00Z')] } }
    arrange()
    await expect(indexOutlookThread(db(), target({ threadId: 'conv-1' }))).resolves.toBe('unreadable')
    expect(rows()).toEqual([])
  })

  it.each(['no_reply@example.com', 'do_not_reply@example.com', 'service@no-reply.example.com'])
  ('marks Outlook %s ineligible using the shared address policy', async address => {
    graphConversation = { status: 200, body: { value: [graphMessage('auto', '2026-10-03T12:00:00Z',
      { from: { emailAddress: { address } } })] } }
    await indexOutlookThread(db(), target({ threadId: 'conv-1' }))
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: 'notification' })
  })

  it('requests Outlook Reply-To and keeps a forwarded human request eligible', async () => {
    graphConversation = { status: 200, body: { value: [graphMessage('forwarded', '2026-10-03T12:00:00Z',
      { from: { emailAddress: { address: 'no_reply@example.com' } },
        replyTo: [{ emailAddress: { address: 'jane@example.com' } }] })] } }
    await indexOutlookThread(db(), target({ threadId: 'conv-1' }))
    const messageUrl = new URL(urls.find(url => url.startsWith(`${GRAPH}/messages?`))!)
    expect(messageUrl.searchParams.get('$select')!.split(',')).toContain('replyTo')
    expect(rows()[0]).toMatchObject({ needs_reply: true, auto_classified: 'personal', from_email: 'no_reply@example.com' })
  })

  it('asks Graph for the headers and holds an out-of-office (Auto-Submitted) back', async () => {
    graphConversation = { status: 200, body: { value: [graphMessage('oof', '2026-10-03T12:00:00Z',
      { internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] })] } }
    await indexOutlookThread(db(), target({ threadId: 'conv-1' }))
    const messageUrl = new URL(urls.find(url => url.startsWith(`${GRAPH}/messages?`))!)
    expect(messageUrl.searchParams.get('$select')!.split(',')).toContain('internetMessageHeaders')
    expect(rows()[0]).toMatchObject({ needs_reply: false, auto_classified: 'notification', from_email: 'simon@harborline.io' })
  })
})

describe('the sync indexes each thread it reads through them', () => {
  it('Gmail: every thread Gmail lists is indexed; one Gmail no longer has is skipped, not counted', async () => {
    accounts.all = [{ token: 'g-tok', email: 'liam@dial8.ai', provider: 'google', accountId: 'acct-work' }]
    gmailList = { status: 200, body: { threads: [{ id: 't1' }, { id: 't2' }] } }
    gmailThreads.t1 = { status: 200, body: { id: 't1', messages: [SIMON] } }
    await expect(syncEmailThreads('user-1', WS, true)).resolves.toEqual({ synced: 1 })
    expect(rows()).toEqual([expect.objectContaining({ provider_thread_id: 't1', account_id: 'acct-work', folder: 'inbox' })])
  })

  it('Outlook: each conversation among the listed messages is indexed by its newest; the listing leaves is_draft alone', async () => {
    accounts.all = [{ token: 'm-tok', email: 'liam@dial8.ai', provider: 'microsoft', accountId: 'acct-outlook' }]
    fake.seed('email_thread_index', [
      { id: 'idx-o', workspace_id: WS, user_id: 'user-1', provider: 'microsoft', provider_thread_id: 'conv-1', is_draft: true },
    ])
    graphList = {
      status: 200,
      body: {
        value: [
          listed('o-2', '2026-09-24T05:02:00Z'),
          listed('o-1', '2026-09-23T14:40:00Z'),
          listed('o-9', '2026-09-22T10:00:00Z', { conversationId: 'conv-2' }),
        ],
      },
    }
    await expect(syncEmailThreads('user-1', WS, true)).resolves.toEqual({ synced: 2 })
    const byThread = Object.fromEntries(rows().map((r) => [r.provider_thread_id, r]))
    expect(byThread['conv-1']).toMatchObject({ id: 'idx-o', provider_message_id: 'o-2', message_count: 2, is_draft: true })
    expect(byThread['conv-2']).toMatchObject({ provider_message_id: 'o-9', account_id: 'acct-outlook' })
    expect(byThread['conv-2']).not.toHaveProperty('is_draft')
    const listUrl = new URL(urls.find((u) => u.startsWith(`${GRAPH}/messages?`))!)
    expect(listUrl.searchParams.get('$select')?.split(',')).not.toContain('isDraft')
  })
})

describe('a mailbox linked to several workspaces: each keeps its own current copy', () => {
  const WS2 = 'f6000000-0000-4000-8000-000000000002'
  const copies = () =>
    rows()
      .map((r) => [r.workspace_id, r.folder, r.linked_contact_id] as const)
      .sort(([a], [b]) => String(a).localeCompare(String(b)))

  beforeEach(() => {
    fake.seed('connected_account_workspace', [
      { account_id: 'acct-work', workspace_id: WS },
      { account_id: 'acct-work', workspace_id: WS2 },
    ])
    fake.seed('contact', [
      { id: 'simon-here', workspace_id: WS, email: 'simon@harborline.io' },
      { id: 'simon-there', workspace_id: WS2, email: 'simon@harborline.io' },
    ])
  })

  it("Gmail: the copy one workspace has is updated, the other gets its own, each linked to its own workspace's contact", async () => {
    fake.seed('email_thread_index', [
      { id: 'idx-1', workspace_id: WS, user_id: 'user-1', provider: 'google', provider_thread_id: 'thr-1', folder: 'drafts' },
    ])
    gmailThreads['thr-1'] = { status: 200, body: { id: 'thr-1', messages: [SIMON] } }
    await expect(indexGmailThread(db(), target())).resolves.toBe('indexed')
    expect(copies()).toEqual([
      [WS, 'inbox', 'simon-here'],
      [WS2, 'inbox', 'simon-there'],
    ])
    expect(rows().find((r) => r.workspace_id === WS)?.id).toBe('idx-1')
  })

  it('Outlook: the conversation is written into both', async () => {
    graphConversation = { status: 200, body: { value: [graphMessage('o-simon', '2026-09-23T14:40:00Z')] } }
    await indexOutlookThread(db(), target({ threadId: 'conv-1' }))
    expect(copies()).toEqual([
      [WS, undefined, 'simon-here'],
      [WS2, undefined, 'simon-there'],
    ])
  })

  it('the sync, run from either workspace, writes every thread it reads into both', async () => {
    accounts.all = [{ token: 'g-tok', email: 'liam@dial8.ai', provider: 'google', accountId: 'acct-work' }]
    gmailList = { status: 200, body: { threads: [{ id: 't1' }] } }
    gmailThreads.t1 = { status: 200, body: { id: 't1', messages: [SIMON] } }
    await syncEmailThreads('user-1', WS2, true)
    expect(copies()).toEqual([
      [WS, 'inbox', 'simon-here'],
      [WS2, 'inbox', 'simon-there'],
    ])
  })

  it('named workspaces only: a discarded draft re-reads one copy at a time', async () => {
    fake.seed('email_thread_index', [
      { id: 'idx-1', workspace_id: WS, user_id: 'user-1', provider: 'google', provider_thread_id: 'thr-1', folder: 'drafts' },
      { id: 'idx-2', workspace_id: WS2, user_id: 'user-1', provider: 'google', provider_thread_id: 'thr-1', folder: 'drafts' },
    ])
    gmailThreads['thr-1'] = { status: 200, body: { id: 'thr-1', messages: [SIMON] } }
    await indexGmailThread(db(), target({ workspaceIds: [WS2] }))
    expect(copies()).toEqual([
      [WS, 'drafts', undefined],
      [WS2, 'inbox', 'simon-there'],
    ])
  })
})
