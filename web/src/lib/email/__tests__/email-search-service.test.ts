/**
 * searchEmails goes to the provider only (no stored mail, 2026-10-15): each
 * mailbox the workspace may read, in parallel, with its OWN token, merged one
 * row per thread, newest first. Graph's $search never carries $orderby (Graph
 * refuses the pair); a filter-only Outlook query uses $filter and $orderby.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; provider: string; account_email: string | null }>,
  mailboxes: {} as Record<string, { provider: 'google' | 'microsoft'; token: string } | null>,
  owned: [] as string[],
}))
vi.mock('../account-scope', () => ({ readableWorkspaceEmailAccounts: async () => h.accounts }))
vi.mock('../thread-mailbox', () => ({
  ownedMailbox: async (_u: string, accountId: string) => {
    h.owned.push(accountId)
    const m = h.mailboxes[accountId]
    return m ? { ...m, email: null, accountId } : null
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('search reads no table') } }))

import { searchEmails } from '../email-search-service'

let urls: string[]
const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response

beforeEach(() => {
  urls = []
  h.owned = []
  h.accounts = [
    { id: 'acct-g', provider: 'google', account_email: 'me@gmail.com' },
    { id: 'acct-o', provider: 'microsoft', account_email: 'me@work.com' },
  ]
  h.mailboxes = { 'acct-g': { provider: 'google', token: 'g' }, 'acct-o': { provider: 'microsoft', token: 'o' } }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    if (url.includes('gmail') && url.includes('/messages?')) return respond({ messages: [{ id: 'gm1' }] })
    if (url.includes('gmail')) {
      return respond({ id: 'gm1', threadId: 'gt1', snippet: 'pricing ok', internalDate: String(Date.parse('2026-10-14T10:00:00Z')), labelIds: ['INBOX'],
        payload: { headers: [{ name: 'Subject', value: 'Pricing' }, { name: 'From', value: 'Sam <sam@x.com>' }] } })
    }
    return respond({ value: [{ id: 'om1', conversationId: 'ot1', subject: 'Renewal', from: { emailAddress: { name: 'Ana', address: 'Ana@Y.com' } }, receivedDateTime: '2026-10-15T10:00:00Z', isRead: false, bodyPreview: 'renew' }] })
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('searchEmails — live, every readable mailbox', () => {
  it('asks each mailbox with its own token and merges newest first', async () => {
    const out = await searchEmails('u1', 'ws-1', { query: 'pricing' })
    expect(out.source).toBe('provider')
    expect(h.owned.sort()).toEqual(['acct-g', 'acct-o'])
    expect(out.results.map((r) => [r.threadId, r.account])).toEqual([['ot1', 'me@work.com'], ['gt1', 'me@gmail.com']])
    expect(out.results[1]).toMatchObject({ subject: 'Pricing', from: { name: 'Sam', email: 'sam@x.com' }, folder: 'inbox' })
  })

  it('Graph $search never carries $orderby; a filter-only query filters and orders', async () => {
    await searchEmails('u1', 'ws-1', { query: 'renewal' })
    const graph = new URL(urls.find((u) => u.includes('graph'))!)
    expect(graph.searchParams.get('$search')).toBe('"renewal"')
    expect(graph.searchParams.get('$orderby')).toBeNull()
    urls = []
    await searchEmails('u1', 'ws-1', { query: '', after: '2026-10-01T00:00:00Z' })
    const filtered = new URL(urls.find((u) => u.includes('graph'))!)
    expect(filtered.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-10-01T00:00:00.000Z')
    expect(filtered.searchParams.get('$orderby')).toBe('receivedDateTime desc')
  })

  it('a mailbox that cannot be read is skipped; no criteria searches nothing', async () => {
    h.mailboxes['acct-o'] = null
    expect((await searchEmails('u1', 'ws-1', { query: 'x' })).results.map((r) => r.threadId)).toEqual(['gt1'])
    urls = []
    expect((await searchEmails('u1', 'ws-1', { query: '  ' })).results).toEqual([])
    expect(urls).toEqual([])
  })
})
