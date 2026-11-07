/**
 * A mail card in the chat lists through this route with `readable=1`, so it
 * shows (and counts) exactly what `show` and `read_card` do: only the
 * person's ENABLED mailboxes linked here (readableWorkspaceEmailAccounts),
 * searched the same way. Without the flag the Mail page lists as before, a
 * disabled linked mailbox included.
 *
 * A search's results are the provider's hits (no stored mail: the index holds
 * 30 days of pointers): an indexed hit keeps its index row with the live
 * header merged in, an unindexed one (older mail) is listed from the hit
 * alone, and the folder and paging are the provider's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let db = makeFakeSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => Object.assign(db, { auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-a' }))
vi.mock('@/lib/email/account-scope', () => ({
  // The junction links both mailboxes here; only one is enabled.
  getWorkspaceEmailAccountIds: async () => ['acct-on', 'acct-off'],
  readableWorkspaceEmailAccounts: async () => [{ id: 'acct-on', provider: 'google', account_email: 'me@acme.com' }],
}))

// Search runs at the provider (no stored mail).
type Opts = { query: string; folder: string; accountIds?: readonly string[] | null; cursor?: string | null; unreadOnly?: boolean }
const searched: Opts[] = []
const hit = (accountId: string, threadId: string, subject: string, date: string) => ({
  accountId, provider: 'google' as const, threadId, messageId: `${threadId}-m`, subject, snippet: `about ${subject}`,
  fromName: 'Sarah', fromEmail: 's@x.com', date, isUnread: true, isStarred: false, hasAttachments: false, folder: 'inbox',
})
vi.mock('@/lib/email/live-thread-search', () => ({
  searchThreadsLive: async (_u: string, _w: string, opts: Opts) => {
    searched.push(opts)
    if (!opts.query.toLowerCase().includes('meeting')) return { hits: [], cursor: null, accounts: [] }
    if (opts.cursor === 'page-2') return { hits: [hit('acct-on', 't-older', 'Meeting notes 2025', '2025-03-01T00:00:00Z')], cursor: null, accounts: [] }
    return {
      // t-on is indexed here; t-old is older than the index (never indexed).
      hits: [hit('acct-on', 't-on', 'Meeting invite', '2026-10-08T00:00:00Z'), hit('acct-on', 't-old', 'Meeting recap', '2026-06-01T00:00:00Z')],
      cursor: 'page-2',
      accounts: [],
    }
  },
}))

const { GET } = await import('../route')
import type { NextRequest } from 'next/server'

const row = (id: string, account_id: string, subject: string) => ({
  id, provider_thread_id: id, account_id, subject, snippet: '', from_name: 'Sarah', from_email: 's@x.com',
  user_id: 'u1', workspace_id: 'ws-a', folder: 'inbox', last_message_at: '2026-10-08T00:00:00Z',
})

async function get(query: string, folder = 'inbox') {
  const res = await GET(new Request(`http://x/api/account/email/threads?folder=${folder}${query}`) as unknown as NextRequest)
  return res.json()
}

async function list(query: string) {
  const body = await get(query)
  return { ids: (body.threads as Array<{ id: string }>).map((t) => t.id).sort(), total: body.total }
}

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('email_thread_index', [row('t-on', 'acct-on', 'Acme inc renewal'), row('t-off', 'acct-off', 'Acme inc old')])
})

describe('GET /api/account/email/threads?readable=1 (a mail card)', () => {
  it('lists only the enabled mailboxes show counts; the page still lists both', async () => {
    expect(await list('&readable=1')).toEqual({ ids: ['t-on'], total: 1 })
    expect(await list('')).toEqual({ ids: ['t-off', 't-on'], total: 2 })
  })

  it('a card searches only the mailboxes show reads; the page asks for every mailbox linked here', async () => {
    await get(`&readable=1&search=meeting`)
    expect(searched.at(-1)).toMatchObject({ query: 'meeting', folder: 'inbox', accountIds: ['acct-on'] })
    await get(`&search=meeting`)
    expect(searched.at(-1)!.accountIds).toEqual(['acct-on', 'acct-off'])
  })
})

describe('GET /api/account/email/threads?search= (provider results)', () => {
  it('lists every provider hit, newest first: an indexed one on its index row, an older unindexed one from the hit', async () => {
    const body = await get(`&search=meeting`)
    const [indexed, older] = body.threads as Array<Record<string, unknown>>
    expect(indexed).toMatchObject({ id: 't-on', provider_thread_id: 't-on', subject: 'Meeting invite', snippet: 'about Meeting invite', live: true, indexed: true, is_unread: true })
    expect(older).toMatchObject({
      id: 'live:acct-on:t-old', provider_thread_id: 't-old', account_id: 'acct-on', subject: 'Meeting recap',
      from_email: 's@x.com', from_name: 'Sarah', last_message_at: '2026-06-01T00:00:00Z', live: true, indexed: false, folder: 'inbox',
    })
    expect(body.has_more).toBe(true)
    expect(body.cursor).toBe('page-2')
  })

  it('pages on with the provider cursor', async () => {
    const body = await get(`&search=meeting&cursor=page-2&page=2`)
    expect((body.threads as Array<{ id: string }>).map((t) => t.id)).toEqual(['live:acct-on:t-older'])
    expect(body.has_more).toBe(false)
  })

  it('the folder is the provider\'s: All passes through, and an index row in another folder still lists', async () => {
    db = makeFakeSupabase()
    db.seed('email_thread_index', [{ ...row('t-on', 'acct-on', 'x'), folder: 'archive' }])
    const body = await get(`&search=meeting`, 'all')
    expect(searched.at(-1)!.folder).toBe('all')
    expect((body.threads as Array<{ id: string }>).map((t) => t.id)).toEqual(['t-on', 'live:acct-on:t-old'])
  })

  it('a search the provider finds nothing for lists nothing', async () => {
    expect(await list(`&search=${encodeURIComponent('nobody')}`)).toEqual({ ids: [], total: 0 })
  })

  it('index-only filters keep only the indexed rows that match', async () => {
    db = makeFakeSupabase()
    db.seed('email_thread_index', [{ ...row('t-on', 'acct-on', 'x'), needs_reply: true }])
    expect(await list(`&search=meeting&needs_reply=true`)).toEqual({ ids: ['t-on'], total: 1 })
  })
})
