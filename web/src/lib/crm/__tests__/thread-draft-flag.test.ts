/**
 * The thread view marks a draft by what the provider says of each message:
 * Gmail's DRAFT label, Graph's isDraft (which the thread query must ask for).
 * That flag is what puts Send on an agent's reply in Mail's thread pane.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))

const accountTokens: Record<string, { token: string; email: string; accountId: string }> = {
  'acct-g': { token: 'g-tok', email: 'liam@dial8.ai', accountId: 'acct-g' },
  'acct-m': { token: 'm-tok', email: 'liam@dial8.ai', accountId: 'acct-m' },
}
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => null),
  getValidTokenForAccount: vi.fn(async (accountId: string) => accountTokens[accountId] ?? null),
}))

import { fetchFullEmailThreadForClient } from '@/lib/crm/email-client'

const WS = 'f6000000-0000-4000-8000-000000000001'
const text = (s: string) => Buffer.from(s).toString('base64url')
const gmailMessage = (id: string, labelIds: string[], from: string, body: string) => ({
  id,
  internalDate: '1790000000000',
  labelIds,
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: 'simon@harborline.io' },
      { name: 'Subject', value: 'Exploratory Meeting' },
    ],
    body: { data: text(body) },
  },
})
const graphMessage = (id: string, isDraft: boolean, parentFolderId: string) => ({
  id,
  conversationId: 'conv-1',
  from: { emailAddress: { name: 'Liam Alizadeh', address: 'liam@dial8.ai' } },
  toRecipients: [{ emailAddress: { address: 'simon@harborline.io' } }],
  subject: 'Exploratory Meeting',
  receivedDateTime: '2026-09-24T05:02:00Z',
  body: { contentType: 'text', content: 'Hi Simon' },
  isRead: true,
  isDraft,
  parentFolderId,
  hasAttachments: false,
})

let urls: string[] = []
let deletedItemsStatus = 200
const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input)
  urls.push(url)
  if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/thr-1')) {
    return {
      ok: true,
      json: async () => ({
        id: 'thr-1',
        messages: [
          gmailMessage('m-simon', ['INBOX'], 'Simon Åkerlund <simon@harborline.io>', 'Sorry, 11 am does not work.'),
          gmailMessage('m-draft', ['DRAFT'], 'Liam Alizadeh <liam@dial8.ai>', 'Let’s target next week instead.'),
        ],
      }),
    } as unknown as Response
  }
  if (url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems')) {
    return { ok: deletedItemsStatus === 200, status: deletedItemsStatus, json: async () => ({ id: 'folder-deleted' }) } as unknown as Response
  }
  if (url.startsWith('https://graph.microsoft.com/v1.0/me/messages?')) {
    return {
      ok: true,
      json: async () => ({
        value: [
          graphMessage('o-1', false, 'folder-inbox'),
          graphMessage('o-2', true, 'folder-drafts'),
          // A revision the agent replaced: Graph's DELETE left it in Deleted Items, still a draft.
          graphMessage('o-3', true, 'folder-deleted'),
        ],
      }),
    } as unknown as Response
  }
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
})

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('email_thread_index', [
    { id: 'idx-g', workspace_id: WS, user_id: 'user-1', provider: 'google', account_id: 'acct-g', provider_thread_id: 'thr-1', is_unread: false },
    { id: 'idx-m', workspace_id: WS, user_id: 'user-1', provider: 'microsoft', account_id: 'acct-m', provider_thread_id: 'conv-1', is_unread: false },
  ])
  urls = []
  deletedItemsStatus = 200
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchFullEmailThreadForClient — which messages are drafts', () => {
  it('Gmail: the message carrying the DRAFT label, and no other', async () => {
    const thread = await fetchFullEmailThreadForClient('user-1', WS, 'thr-1')
    expect(thread.messages.map((m) => [m.id, m.isDraft])).toEqual([
      ['m-simon', false],
      ['m-draft', true],
    ])
  })

  it('Outlook: asks Graph for isDraft and marks the draft it names, but not one sitting in Deleted Items', async () => {
    const thread = await fetchFullEmailThreadForClient('user-1', WS, 'conv-1')
    const list = urls.find((u) => u.startsWith('https://graph.microsoft.com/v1.0/me/messages?'))!
    expect(new URL(list).searchParams.get('$select')?.split(',')).toEqual(expect.arrayContaining(['isDraft', 'parentFolderId']))
    expect(thread.messages.map((m) => [m.id, m.isDraft])).toEqual([
      ['o-1', false],
      ['o-2', true],
      ['o-3', false],
    ])
  })

  it('Outlook: when the Deleted Items folder cannot be told apart, no message is offered as a draft', async () => {
    deletedItemsStatus = 503
    const thread = await fetchFullEmailThreadForClient('user-1', WS, 'conv-1')
    expect(thread.messages.map((m) => m.isDraft)).toEqual([false, false, false])
  })
})
