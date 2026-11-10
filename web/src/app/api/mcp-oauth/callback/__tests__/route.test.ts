/**
 * GEN-1171: the MCP OAuth callback renews an existing connection in place
 * (a reconnect: no disconnect first, its tool choices kept, its mark cleared)
 * instead of failing on the duplicate name, and keeps the client secret a
 * server issued so a refresh can send it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>
const store = vi.hoisted(() => ({ state: [] as Row[], servers: [] as Row[], inserts: [] as Row[], updates: [] as Array<{ payload: Row; id: unknown }> }))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'external_mcp_oauth_state') {
        const chain: Record<string, unknown> = {
          delete: () => chain,
          eq: () => chain,
          gt: () => chain,
          select: async () => ({ data: store.state.splice(0), error: null }),
        }
        return chain
      }
      let payload: Row | null = null
      const filters: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Row) => ((payload = p), chain),
        insert: async (row: Row) => (store.inserts.push(row), { error: null }),
        eq: (k: string, v: unknown) => ((filters[k] = v), chain),
        then: (ok: (v: unknown) => unknown) => {
          if (payload) {
            store.updates.push({ payload, id: filters.id })
            return Promise.resolve({ error: null }).then(ok)
          }
          return Promise.resolve({ data: store.servers.filter((s) => s.user_id === filters.user_id), error: null }).then(ok)
        },
      }
      return chain
    },
  }),
}))
vi.mock('@/lib/crypto/credentials', () => ({
  encryptCredential: (v: string) => `enc:${v}`,
  decryptCredentialOrNull: (v: string | null | undefined) => (v ? `plain:${v}` : null),
}))
vi.mock('@/lib/mcp-client/oauth', () => ({
  exchangeCodeForTokens: vi.fn(async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })),
}))
vi.mock('@/lib/mcp-client', () => ({ listTools: vi.fn(async () => [{ name: 'list_projects' }, { name: 'execute_sql' }]) }))
// No session in these: the web completion is bound by the flow's cookie (account-linking-csrf.test.ts covers the binding).
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))

const { GET } = await import('../route')
const { mcpBindCookie } = await import('@/lib/mcp-client/oauth-binding')

function stateRow(over: Row = {}): Row {
  return {
    state: 's1',
    user_id: 'u1',
    workspace_id: 'w1',
    display_name: 'Supabase',
    server_url: 'https://mcp.supabase.com/mcp',
    transport: 'streamable_http',
    authorization_endpoint: 'https://api.supabase.com/v1/oauth/authorize',
    token_endpoint: 'https://api.supabase.com/v1/oauth/token',
    registration_endpoint: 'https://api.supabase.com/v1/oauth/register',
    client_id: 'c1',
    client_secret: null,
    scopes: [],
    redirect_uri: 'https://nativeintelligence.dev/api/mcp-oauth/callback',
    code_verifier: 'v',
    ...over,
  }
}

/** The provider's redirect back to the browser that started the flow (its bind cookie rides along). */
const callback = () => {
  const bind = mcpBindCookie('s1')
  return GET(new NextRequest('https://nativeintelligence.dev/api/mcp-oauth/callback?code=c&state=s1', { headers: { cookie: `${bind.name}=${bind.value}` } }))
}
const popup = (res: Response) => new URL(res.headers.get('location') ?? '').searchParams

beforeEach(() => {
  vi.stubEnv('OAUTH_STATE_SECRET', 'test-state-secret')
  store.state = [stateRow()]
  store.servers = []
  store.inserts = []
  store.updates = []
})

describe('GET /api/mcp-oauth/callback', () => {
  it('a new connection inserts a row', async () => {
    const res = await callback()
    expect(popup(res).get('success')).toBe('true')
    expect(store.inserts).toHaveLength(1)
    expect(store.updates).toHaveLength(0)
  })

  it('a reconnect renews the expired row in place: new tokens, mark cleared, its own URL and tool choices untouched', async () => {
    store.servers = [
      {
        id: 'srv-1',
        user_id: 'u1',
        display_name: 'Supabase',
        server_url: 'https://mcp.supabase.com/mcp?read_only=true',
        allowed_tools: ['list_projects'],
        reauth_required_at: '2026-10-27T04:00:00Z',
      },
    ]
    const res = await callback()
    expect(popup(res).get('success')).toBe('true')
    expect(popup(res).get('name')).toBe('Supabase')
    expect(store.inserts).toHaveLength(0)
    expect(store.updates).toHaveLength(1)
    const { payload, id } = store.updates[0]
    expect(id).toBe('srv-1')
    expect(payload).toMatchObject({
      access_token_encrypted: 'enc:at',
      refresh_token_encrypted: 'enc:rt',
      reauth_required_at: null,
      last_error: null,
      tools_cache: [{ name: 'list_projects' }, { name: 'execute_sql' }],
    })
    // execute_sql stays new (hidden) until the person adds it; the read-only URL stays.
    for (const kept of ['allowed_tools', 'disabled_tools', 'require_approval_tools', 'approval_free_tools', 'display_name', 'server_url', 'transport']) {
      expect(payload).not.toHaveProperty(kept)
    }
  })

  it('a reconnected row whose allow-list was never seeded is seeded now, as refresh-tools does', async () => {
    store.state = [stateRow({ display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp' })]
    store.servers = [{ id: 'srv-2', user_id: 'u1', display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp', allowed_tools: null, require_approval_tools: [] }]
    await callback()
    const { payload } = store.updates[0]
    expect(payload.allowed_tools).toEqual(['list_projects', 'execute_sql'])
    // A server we don't know: what isn't a plain read asks first (decision 23).
    expect(payload.require_approval_tools).toEqual(['execute_sql'])
  })

  it('the same name for another server is never overwritten: it inserts, and the slug index refuses it as before', async () => {
    store.state = [stateRow({ display_name: 'Acme', server_url: 'https://mcp.acme.dev/v2/mcp' })]
    store.servers = [{ id: 'srv-2', user_id: 'u1', display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp', allowed_tools: ['run_query'] }]
    await callback()
    expect(store.updates).toHaveLength(0)
    expect(store.inserts).toHaveLength(1)
  })

  it('another account of the same app under another name still gets its own row', async () => {
    store.state = [stateRow({ display_name: 'Supabase (client)' })]
    store.servers = [{ id: 'srv-1', user_id: 'u1', display_name: 'Supabase', server_url: 'https://mcp.supabase.com/mcp', reauth_required_at: null }]
    await callback()
    expect(store.inserts).toHaveLength(1)
    expect(store.updates).toHaveLength(0)
  })

  it('keeps the client secret the server issued at registration, encrypted, for refreshes', async () => {
    store.state = [stateRow({ client_secret: 'enc-secret' })]
    await callback()
    expect((store.inserts[0].oauth_metadata as Row).client_secret_encrypted).toBe('enc-secret')
    store.state = [stateRow()]
    store.inserts = []
    await callback()
    expect(store.inserts[0].oauth_metadata as Row).not.toHaveProperty('client_secret_encrypted')
  })
})
