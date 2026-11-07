/**
 * Mail's list search goes to the provider and its hits are the results
 * (live-thread-search.ts): the folder is the provider's own (Gmail `in:`,
 * Graph's folder-scoped search), a page is 50 hits per mailbox, the cursor
 * carries each mailbox's page token, Gmail's HTML-escaped snippet is decoded,
 * and an account filter only narrows the readable mailboxes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('search reads no table') } }))
vi.mock('../account-scope', () => ({ readableWorkspaceEmailAccounts: async () => [] }))
vi.mock('../thread-mailbox', () => ({ ownedMailbox: async () => null }))

import { decodeSearchCursor, encodeSearchCursor, gmailSearchQuery, graphSearchUrl, searchThreadsLive, SEARCH_PAGE } from '../live-thread-search'

const accounts = [
  { id: 'acct-g', provider: 'google' as const, account_email: 'me@gmail.com' },
  { id: 'acct-o', provider: 'microsoft' as const, account_email: 'me@work.com' },
]
const mailboxes: Record<string, { provider: 'google' | 'microsoft'; token: string; email: null; accountId: string }> = {
  'acct-g': { provider: 'google', token: 'g', email: null, accountId: 'acct-g' },
  'acct-o': { provider: 'microsoft', token: 'o', email: null, accountId: 'acct-o' },
}
const deps = { accounts: async () => accounts, mailbox: async (_u: string, id: string) => mailboxes[id] ?? null }

let urls: string[]
let batchBodies: string[]
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

function gmailBatchReply(ids: string[]): string {
  const parts = ids.map((id, i) => {
    const msg = {
      id,
      threadId: `thr-${id}`,
      snippet: 'Can&#39;t make it &amp; sorry',
      labelIds: i === 0 ? ['INBOX', 'UNREAD', 'STARRED'] : ['INBOX'],
      internalDate: String(Date.parse('2026-01-0' + (i + 1) + 'T00:00:00Z')),
      payload: { headers: [{ name: 'Subject', value: `Meeting ${id}` }, { name: 'From', value: '"Sarah Lee" <Sarah@x.com>' }, { name: 'Date', value: 'x' }] },
    }
    return `--batch_abc\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(msg)}\r\n`
  })
  return parts.join('') + '--batch_abc--'
}

beforeEach(() => {
  urls = []
  batchBodies = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url)
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
      const token = new URL(url).searchParams.get('pageToken')
      if (token === 'g-2') return json({ messages: [{ id: 'g9', threadId: 'thr-g9' }] })
      // Two hits on one thread: the thread is listed once, by its newest hit.
      return json({ messages: [{ id: 'g1', threadId: 'thr-g1' }, { id: 'g1b', threadId: 'thr-g1' }, { id: 'g2', threadId: 'thr-g2' }], nextPageToken: 'g-2' })
    }
    if (url.startsWith('https://gmail.googleapis.com/batch')) {
      const body = String(init?.body ?? '')
      batchBodies.push(body)
      const ids = [...body.matchAll(/messages\/([^?]+)\?/g)].map((m) => m[1])
      return { ok: true, status: 200, text: async () => gmailBatchReply(ids) } as unknown as Response
    }
    if (url.includes('/mailFolders/deleteditems?$select=id')) return json({ id: 'f-deleted' })
    if (url.includes('/mailFolders/junkemail?$select=id')) return json({ id: 'f-junk' })
    if (url.startsWith('https://graph.microsoft.com/')) {
      return json({
        value: [
          { id: 'o1', conversationId: 'conv-1', subject: 'Meeting with Acme', bodyPreview: 'See you then', from: { emailAddress: { name: 'Bo', address: 'Bo@acme.com' } }, receivedDateTime: '2026-01-05T00:00:00Z', isRead: false, hasAttachments: true, flag: { flagStatus: 'flagged' } },
          { id: 'o2', conversationId: 'conv-1', subject: 'older on the same thread', receivedDateTime: '2026-01-04T00:00:00Z', isRead: true },
          { id: 'o3', conversationId: 'conv-2', subject: 'Read meeting', receivedDateTime: '2025-01-04T00:00:00Z', isRead: true, parentFolderId: 'f-inbox' },
          { id: 'o4', conversationId: 'conv-trash', subject: 'Deleted meeting', receivedDateTime: '2026-01-06T00:00:00Z', isRead: true, parentFolderId: 'f-deleted' },
          { id: 'o5', conversationId: 'conv-junk', subject: 'Junk meeting', receivedDateTime: '2026-01-06T00:00:00Z', isRead: true, parentFolderId: 'f-junk' },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc',
      })
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  }))
})

describe('searchThreadsLive', () => {
  it('returns every hit from every mailbox, newest first, with the provider headers (no index involved)', async () => {
    const page = await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'all' }, deps)
    expect(page.hits.map((h) => [h.accountId, h.threadId])).toEqual([
      ['acct-o', 'conv-1'],
      ['acct-g', 'thr-g2'],
      ['acct-g', 'thr-g1'],
      ['acct-o', 'conv-2'],
    ])
    const gmail = page.hits.find((h) => h.threadId === 'thr-g1')!
    expect(gmail).toMatchObject({ messageId: 'g1', subject: 'Meeting g1', snippet: "Can't make it & sorry", fromName: 'Sarah Lee', fromEmail: 'sarah@x.com', isUnread: true, isStarred: true, folder: 'inbox' })
    const graph = page.hits.find((h) => h.threadId === 'conv-1')!
    expect(graph).toMatchObject({ messageId: 'o1', subject: 'Meeting with Acme', fromEmail: 'bo@acme.com', isUnread: true, isStarred: true, hasAttachments: true })
  })

  it('asks Gmail with the folder in q and 50 a page, and Graph in the folder itself', async () => {
    await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox', unreadOnly: true }, deps)
    const gmail = new URL(urls.find((u) => u.includes('gmail.googleapis.com/gmail/v1/users/me/messages?'))!)
    expect(gmail.searchParams.get('q')).toBe('meeting in:inbox is:unread')
    expect(gmail.searchParams.get('maxResults')).toBe(String(SEARCH_PAGE))
    const graph = new URL(urls.find((u) => u.startsWith('https://graph.microsoft.com/'))!)
    expect(graph.pathname).toBe('/v1.0/me/mailFolders/inbox/messages')
    expect(graph.searchParams.get('$search')).toBe('"meeting"')
    // One metadata batch for Gmail's distinct threads (newest hit each), no per-hit reads.
    expect(batchBodies).toHaveLength(1)
    expect([...batchBodies[0].matchAll(/messages\/([^?]+)\?/g)].map((m) => m[1])).toEqual(['g1', 'g2'])
  })

  it('Graph applies the unread switch itself ($search takes no $filter)', async () => {
    const page = await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox', unreadOnly: true, accountIds: ['acct-o'] }, deps)
    expect(page.hits.map((h) => h.threadId)).toEqual(['conv-1'])
  })

  it('All searches the whole mailbox but Deleted Items and Junk, as Gmail does: no Gmail folder term, Graph across folders minus those two', async () => {
    const page = await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'all' }, deps)
    expect(new URL(urls.find((u) => u.includes('/gmail/v1/users/me/messages?'))!).searchParams.get('q')).toBe('meeting')
    expect(new URL(urls.find((u) => u.startsWith('https://graph.microsoft.com/'))!).pathname).toBe('/v1.0/me/messages')
    const graph = page.hits.filter((h) => h.accountId === 'acct-o').map((h) => h.threadId)
    expect(graph).toEqual(['conv-1', 'conv-2'])
  })

  it('a folder search on Graph is scoped already: no folder lookups', async () => {
    const page = await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox', accountIds: ['acct-o'] }, deps)
    expect(urls.some((u) => u.includes('$select=id'))).toBe(false)
    // The mock answers every folder alike; scoping is Graph's, so nothing is dropped here.
    expect(page.hits.map((h) => h.threadId)).toContain('conv-trash')
  })

  it('pages on: the cursor carries each mailbox token, and the next page asks only those mailboxes', async () => {
    const first = await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox' }, deps)
    expect(decodeSearchCursor(first.cursor)).toEqual({
      'acct-g': 'g-2',
      'acct-o': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc',
    })
    urls = []
    const second = await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox', cursor: encodeSearchCursor({ 'acct-g': 'g-2' }) }, deps)
    expect(second.hits.map((h) => h.threadId)).toEqual(['thr-g9'])
    expect(second.cursor).toBeNull()
    expect(urls.some((u) => u.startsWith('https://graph.microsoft.com/'))).toBe(false)
    expect(new URL(urls[0]).searchParams.get('pageToken')).toBe('g-2')
  })

  it('never follows a Graph page token anywhere but Graph, and a cursor it did not write ends the search', async () => {
    await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox', accountIds: ['acct-o'], cursor: encodeSearchCursor({ 'acct-o': 'https://evil.example/steal' }) }, deps)
    expect(urls.every((u) => u.startsWith('https://graph.microsoft.com/'))).toBe(true)
    urls = []
    const page = await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox', cursor: 'not-a-cursor!!' }, deps)
    expect(page.hits).toEqual([])
    expect(urls).toEqual([])
  })

  it('an account filter narrows the readable mailboxes, never widens them', async () => {
    await searchThreadsLive('u1', 'ws1', { query: 'meeting', folder: 'inbox', accountIds: ['acct-g', 'someone-else'] }, deps)
    expect(urls.some((u) => u.startsWith('https://graph.microsoft.com/'))).toBe(false)
    expect(urls.some((u) => u.includes('gmail.googleapis.com'))).toBe(true)
  })

  it('a one-letter search asks nothing', async () => {
    expect((await searchThreadsLive('u1', 'ws1', { query: 'm', folder: 'inbox' }, deps)).hits).toEqual([])
    expect(urls).toEqual([])
  })
})

describe('provider queries', () => {
  it('Gmail: each Mail folder as Gmail names it, plus the switches', () => {
    expect(gmailSearchQuery({ query: 'meeting', folder: 'sent' })).toBe('meeting in:sent')
    expect(gmailSearchQuery({ query: 'meeting', folder: 'starred', hasAttachments: true, from: 'bo@acme.com' })).toBe('meeting is:starred has:attachment from:bo@acme.com')
    expect(gmailSearchQuery({ query: 'meeting', folder: 'archive' })).toBe('meeting -in:inbox -in:sent -in:drafts -in:spam -in:trash')
  })

  it('Graph: the well-known folder, or every folder', () => {
    expect(new URL(graphSearchUrl({ query: 'a "b"', folder: 'trash' }, 50)).pathname).toBe('/v1.0/me/mailFolders/deleteditems/messages')
    expect(new URL(graphSearchUrl({ query: 'a "b"', folder: 'trash' }, 50)).searchParams.get('$search')).toBe('"a b"')
    expect(new URL(graphSearchUrl({ query: 'x', folder: 'starred' }, 50)).pathname).toBe('/v1.0/me/messages')
  })
})
