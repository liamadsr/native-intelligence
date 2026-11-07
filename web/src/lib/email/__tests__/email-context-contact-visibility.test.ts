/**
 * searchEmailsWithContext (search tool, enrich_emails) always reads on the
 * SERVICE-ROLE client, where the contact table's RLS does not hide another
 * member's private contact. The sender → contact enrichment fences each row
 * through contact_visible_to(contact, caller) and fails closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ hidden: new Set<string>(), rpcUsers: [] as string[] }))

const CONTACTS = [
  { id: 'ct-private', full_name: 'Ana Private', email: 'ana@private.com', relationship_type: 'lead', company: null },
  { id: 'ct-shared', full_name: 'Sam Shared', email: 'sam@shared.com', relationship_type: 'customer', company: null },
]

function chain(table: string) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not']) c[m] = () => c
  const data = table === 'contact' ? CONTACTS : []
  c.single = async () => ({ data: null, error: null })
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve)
  return c
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: Record<string, string>) => {
      if (fn === 'contact_visible_to') {
        h.rpcUsers.push(args.p_user_id)
        return { data: !h.hidden.has(args.p_contact_id), error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } }
    },
  }),
}))

// The mail itself is searched live (no stored mail): stubbed here.
vi.mock('../email-search-service', () => ({
  searchEmails: async () => ({
    source: 'provider',
    results: [
      { threadId: 't-1', subject: 'Hi', from: { name: 'Ana', email: 'ana@private.com' }, snippet: '', date: '2026-09-01', isUnread: false, folder: '', matchSource: 'provider' },
      { threadId: 't-2', subject: 'Yo', from: { name: 'Sam', email: 'sam@shared.com' }, snippet: '', date: '2026-09-02', isUnread: false, folder: '', matchSource: 'provider' },
    ],
  }),
}))

const { searchEmailsWithContext } = await import('../email-context-service')

describe('searchEmailsWithContext — sender contact enrichment is fenced', () => {
  beforeEach(() => {
    h.hidden = new Set(['ct-private'])
    h.rpcUsers = []
  })

  it("never attaches another member's private contact; the visible one still enriches", async () => {
    const results = await searchEmailsWithContext('user-1', 'ws-1', 'hi', 10)
    const byThread = Object.fromEntries(results.map((r) => [r.threadId, r]))
    expect(byThread['t-1'].contact).toBeUndefined()
    expect(byThread['t-2'].contact).toMatchObject({ id: 'ct-shared', fullName: 'Sam Shared' })
    expect(JSON.stringify(results)).not.toContain('Ana Private')
    expect(new Set(h.rpcUsers)).toEqual(new Set(['user-1']))
  })
})
