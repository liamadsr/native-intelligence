/**
 * Tests for GET /api/oauth/status — focused on the `scopes` addition that gates
 * the HubSpot "reconnect to enable meeting logging" banner. Invariants:
 *  - Each enriched account carries a `scopes` string[] resolved from
 *    user_oauth_tokens (joined by account_id).
 *  - When an account has multiple token rows, the MOST RECENTLY updated one wins
 *    (the route orders updated_at DESC and keeps the first per account).
 *  - An account with no token row gets `scopes: []`.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => ({ user: { id: 'u-1' } }),
}))

// Table-driven supabase fake: each `.from(table)` resolves the rows this test
// supplies. The route awaits the builder directly (no `.maybeSingle()`) for the
// list queries, so `then` returns the rows; `.is()` / `.order()` are chainable.
const data: Record<string, unknown[]> = {
  connected_account: [
    {
      id: 'acct-hubspot',
      provider: 'hubspot',
      capability: 'crm',
      account_email: 'ops@acme.com',
      display_name: 'HubSpot',
      color: '#FF7A59',
      is_enabled: true,
      is_primary: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'acct-no-token',
      provider: 'github',
      capability: 'github',
      account_email: 'dev@acme.com',
      display_name: 'GitHub',
      color: '#000',
      is_enabled: true,
      is_primary: false,
      created_at: '2026-01-02T00:00:00Z',
    },
  ],
  email_account_preference: [],
  calendar_account_preference: [],
  email_sync_state: [],
  connected_account_workspace: [],
  // Ordered updated_at DESC (as the route's query requests) — the fake below
  // ignores .order(), so these are pre-sorted newest-first to model it.
  user_oauth_tokens: [
    // Newer row for the HubSpot account — includes the write scope. This one wins.
    {
      account_id: 'acct-hubspot',
      scopes: ['oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write'],
      updated_at: '2026-07-01T00:00:00Z',
    },
    // Older row for the HubSpot account — read-only scopes.
    {
      account_id: 'acct-hubspot',
      scopes: ['oauth', 'crm.objects.contacts.read'],
      updated_at: '2026-06-01T00:00:00Z',
    },
  ],
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const rows = data[table] ?? []
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.is = () => chain
      chain.in = () => chain
      chain.order = () => chain
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve)
      return chain
    },
  }),
}))

import { GET } from '../route'

function findAccount(body: { accounts: Array<{ id: string; scopes: string[] }> }, id: string) {
  return body.accounts.find((a) => a.id === id)!
}

describe('GET /api/oauth/status — scopes', () => {
  it('attaches the most-recent token scopes per account', async () => {
    const res = await GET(new Request('http://x/api/oauth/status'))
    const body = await res.json()

    const hubspot = findAccount(body, 'acct-hubspot')
    // The newer token row (with the write scope) wins over the older one.
    expect(hubspot.scopes).toContain('crm.objects.contacts.write')
    expect(hubspot.scopes).toEqual([
      'oauth',
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
    ])
  })

  it('returns an empty scopes array for an account with no token row', async () => {
    const res = await GET(new Request('http://x/api/oauth/status'))
    const body = await res.json()

    const github = findAccount(body, 'acct-no-token')
    expect(github.scopes).toEqual([])
  })
})
