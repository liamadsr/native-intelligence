/**
 * GET /api/oauth/status: `reauth_required_at` on each account row.
 *  - A flagged account returns its timestamp; a healthy one returns null.
 *  - Before migration 348 the column is absent: the route selects '*', so the
 *    key is simply missing from the row, and the field reads null.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: async () => ({ user: { id: 'u-1' } }),
}))

const base = {
  capability: 'calendar',
  display_name: 'Google Calendar',
  color: '#000',
  is_enabled: true,
  is_primary: false,
}

const data: Record<string, unknown[]> = {
  connected_account: [
    { ...base, id: 'acct-flagged', provider: 'google', account_email: 'a@acme.com', reauth_required_at: '2026-10-15T12:00:00.000Z' },
    { ...base, id: 'acct-healthy', provider: 'google', account_email: 'b@acme.com', reauth_required_at: null },
    // A row from a database without the column: the key is absent.
    { ...base, id: 'acct-pre-348', provider: 'microsoft', account_email: 'c@acme.com' },
  ],
  email_account_preference: [],
  calendar_account_preference: [],
  email_sync_state: [],
  connected_account_workspace: [],
  user_oauth_tokens: [],
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

describe('GET /api/oauth/status — reauth_required_at', () => {
  it('returns the flag per account, and null when the column is absent', async () => {
    const res = await GET(new Request('http://x/api/oauth/status'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accounts: Array<{ id: string; reauth_required_at: string | null; missing_scopes: string[] }>
    }
    const byId = new Map(body.accounts.map((a) => [a.id, a]))

    expect(byId.get('acct-flagged')!.reauth_required_at).toBe('2026-10-15T12:00:00.000Z')
    expect(byId.get('acct-healthy')!.reauth_required_at).toBeNull()
    expect(byId.get('acct-pre-348')).toHaveProperty('reauth_required_at', null)
    // The other fields are untouched.
    expect(Array.isArray(byId.get('acct-flagged')!.missing_scopes)).toBe(true)
  })
})
