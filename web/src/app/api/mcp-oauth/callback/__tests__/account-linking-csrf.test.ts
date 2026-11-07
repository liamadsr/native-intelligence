/**
 * MCP connector account-linking CSRF (security review 2026-10-31). The attack:
 * an attacker, signed in as themselves, starts an MCP connect, sends the
 * provider's consent link to a victim, and the victim's connector tokens are
 * stored under the attacker. These run the REAL start, callback and claim
 * routes against an in-memory database that honors their filters.
 *
 * Covered:
 *   - web: the callback completes only for the browser that started (its bind
 *     cookie) or the row's own signed-in person; the victim's browser has
 *     neither, so nothing is exchanged or stored;
 *   - desktop: the callback never completes, never consumes the row, and only
 *     deep-links the code back; the claim completes only with the flow's claim
 *     secret AND the row's own session, at most once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  user: 'attacker',
  session: null as string | null,
  stateRows: [] as Row[],
  servers: [] as Row[],
  exchanges: 0,
  seq: 0,
}))

/** A chain that collects eq/gt filters and answers at its terminal call. */
function filtering(rows: () => Row[], onDelete?: (hit: Row[]) => void) {
  const eqs: Array<[string, unknown]> = []
  const gts: Array<[string, string]> = []
  let deleting = false
  const match = () => rows().filter((r) => eqs.every(([k, v]) => r[k] === v) && gts.every(([k, v]) => String(r[k]) > v))
  const chain: Record<string, unknown> = {
    eq: (k: string, v: unknown) => (eqs.push([k, v]), chain),
    gt: (k: string, v: string) => (gts.push([k, v]), chain),
    limit: () => chain,
    maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
    select: () => {
      if (!deleting) return chain
      const hit = match()
      onDelete?.(hit)
      return Promise.resolve({ data: hit, error: null })
    },
    delete: () => ((deleting = true), chain),
    // A delete awaited without .select() (the start route's stale-row cleanup).
    then: (ok: (v: unknown) => unknown) => {
      if (deleting) onDelete?.(match())
      return Promise.resolve({ data: null, error: null }).then(ok)
    },
  }
  return chain
}

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'external_mcp_oauth_state') {
        const chain = filtering(
          () => h.stateRows,
          (hit) => (h.stateRows = h.stateRows.filter((r) => !hit.includes(r))),
        )
        // created_at: the column's default, now().
        chain.insert = async (row: Row) => (h.stateRows.push({ created_at: new Date().toISOString(), ...row }), { error: null })
        return chain
      }
      // connected_mcp_server
      const filters: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: () => chain,
        eq: (k: string, v: unknown) => ((filters[k] = v), chain),
        insert: async (row: Row) => (h.servers.push({ id: `srv-${++h.seq}`, ...row }), { error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: h.servers.filter((s) => s.user_id === filters.user_id), error: null }).then(ok),
      }
      return chain
    },
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.session ? { id: h.session } : null } }) } }),
}))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ user: { id: h.user }, workspaceId: `ws-${h.user}`, supabase: {} }),
}))
vi.mock('@/lib/mcp-client/url-guard', () => ({ assertSafeMcpUrl: (u: string) => ({ ok: true, url: new URL(u) }) }))
vi.mock('@/lib/mcp-client/url-guard-dns', () => ({ assertPublicHost: async () => ({ ok: true }) }))
vi.mock('@/lib/crypto/credentials', () => ({
  encryptCredential: (v: string) => `enc:${v}`,
  encryptCredentialOrNull: (v: string | null) => (v ? `enc:${v}` : null),
  decryptCredentialOrNull: (v: string | null | undefined) => (v ? `plain:${v}` : null),
}))
vi.mock('@/lib/mcp-client', () => ({ listTools: vi.fn(async () => [{ name: 'list_issues' }]) }))
vi.mock('@/lib/mcp-client/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp-client/oauth')>()),
  discoverOAuthForServer: async () => ({
    authorizationServer: {
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      registration_endpoint: 'https://auth.example.com/register',
    },
    scopes: ['read'],
  }),
  registerClient: async () => ({ client_id: 'client-1', client_secret: undefined }),
  exchangeCodeForTokens: vi.fn(async () => {
    h.exchanges++
    return { access_token: 'victim-access', refresh_token: 'victim-refresh', expires_in: 3600 }
  }),
}))

const { POST: start } = await import('@/app/api/account/mcp-servers/oauth/start/route')
const { GET: callback } = await import('../route')
const { POST: claim } = await import('@/app/api/account/mcp-servers/oauth/claim/route')

/** Start a connect as `user` through the REAL start route. */
async function startAs(user: string, source?: 'web' | 'desktop') {
  h.user = user
  const res = await start(
    new NextRequest('https://dial8.ai/api/account/mcp-servers/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'dial8.ai' },
      body: JSON.stringify({ display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', ...(source ? { source } : {}) }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { authorize_url: string; state?: string; claim_secret?: string }
  const state = new URL(body.authorize_url).searchParams.get('state')!
  const setCookie = res.headers.get('set-cookie')
  // "name=value; Path=…": what the starting browser would send back.
  const cookie = setCookie ? setCookie.split(';')[0] : null
  return { ...body, state, cookie }
}

/** The provider redirecting a browser back to the callback. */
function providerReturn(state: string, opts: { cookie?: string | null; error?: string } = {}) {
  const qs = opts.error ? `error=${opts.error}&state=${encodeURIComponent(state)}` : `code=victim-code&state=${encodeURIComponent(state)}`
  return callback(
    new NextRequest(`https://dial8.ai/api/mcp-oauth/callback?${qs}`, { headers: opts.cookie ? { cookie: opts.cookie } : {} }),
  )
}

function claimAs(user: string, body: Row) {
  h.user = user
  return claim(
    new NextRequest('https://dial8.ai/api/account/mcp-servers/oauth/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const popup = (res: Response) => new URL(res.headers.get('location')!).searchParams

/** The deep link a desktop callback's page opens (its script's target). */
async function deepLinkOf(res: Response): Promise<string> {
  const html = await res.text()
  const m = html.match(/window\.location\.href = ("[^"]*")/)
  expect(m, 'the page opens a deep link').toBeTruthy()
  return JSON.parse(m![1].replace(/\\u003c/g, '<'))
}

beforeEach(() => {
  vi.stubEnv('OAUTH_STATE_SECRET', 'test-state-secret')
  h.user = 'attacker'
  h.session = null
  h.stateRows = []
  h.servers = []
  h.exchanges = 0
})
afterEach(() => vi.unstubAllEnvs())

describe('web: the victim completing an attacker-started connect', () => {
  it('the start sets the flow\'s httpOnly bind cookie and never returns the state', async () => {
    const started = await startAs('alice')
    expect(started.cookie).toMatch(/^mcp_oauth_[A-Za-z0-9_-]{16}=/)
    expect(started.state).not.toMatch(/^desk\./)
    expect((started as { claim_secret?: string }).claim_secret).toBeUndefined()
  })

  it("THE ATTACK: the victim's browser (their own session, no bind cookie) is refused; nothing exchanged or stored", async () => {
    const started = await startAs('attacker')
    h.session = 'victim'
    const res = await providerReturn(started.state)
    expect(popup(res).get('success')).toBe('false')
    expect(h.exchanges).toBe(0)
    expect(h.servers).toHaveLength(0)
  })

  it('a forged cookie of the right name but a wrong value is refused', async () => {
    const started = await startAs('attacker')
    const name = started.cookie!.split('=')[0]
    const res = await providerReturn(started.state, { cookie: `${name}=forged` })
    expect(popup(res).get('success')).toBe('false')
    expect(h.servers).toHaveLength(0)
  })

  it('the browser that started it connects, under its own account', async () => {
    const started = await startAs('alice')
    const res = await providerReturn(started.state, { cookie: started.cookie })
    expect(popup(res).get('success')).toBe('true')
    expect(h.exchanges).toBe(1)
    expect(h.servers).toHaveLength(1)
    expect(h.servers[0].user_id).toBe('alice')
    // The spent cookie is cleared.
    expect(res.headers.get('set-cookie')).toMatch(/mcp_oauth_[A-Za-z0-9_-]{16}=;/)
  })

  it("a session alone never stands in for the cookie, even the row's own (a subdomain could toss its owner's session)", async () => {
    const started = await startAs('attacker')
    // The attacker's own session cookie, tossed into the victim's browser.
    h.session = 'attacker'
    expect(popup(await providerReturn(started.state)).get('success')).toBe('false')
    expect(h.exchanges).toBe(0)
    expect(h.servers).toHaveLength(0)
  })

  it('in production the binding cookie is __Host- (no subdomain can set it): Secure, Path=/, no Domain', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const started = await startAs('alice')
    const name = started.cookie!.split('=')[0]
    expect(name).toMatch(/^__Host-mcp_oauth_[A-Za-z0-9_-]{16}$/)
    const res = await start(
      new NextRequest('https://dial8.ai/api/account/mcp-servers/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'dial8.ai' },
        body: JSON.stringify({ display_name: 'Notion', server_url: 'https://mcp.notion.com/mcp' }),
      }),
    )
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toMatch(/^__Host-/)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/Path=\//)
    expect(setCookie).not.toMatch(/Domain=/i)
  })
})

describe('the start route: one live flow per server, but an abandoned one gives way', () => {
  it('a second start within seconds (a double click) is refused', async () => {
    await startAs('alice', 'desktop')
    h.user = 'alice'
    const res = await start(
      new NextRequest('https://dial8.ai/api/account/mcp-servers/oauth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'dial8.ai' },
        body: JSON.stringify({ display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', source: 'desktop' }),
      }),
    )
    expect(res.status).toBe(429)
  })

  it('an older live flow (the prompt dismissed, the window reloaded) is replaced, not a 10-minute block', async () => {
    const first = await startAs('alice', 'desktop')
    h.stateRows[0].created_at = new Date(Date.now() - 60_000).toISOString()
    const second = await startAs('alice', 'desktop')
    expect(second.state).not.toBe(first.state)
    expect(h.stateRows.map((r) => r.state)).toEqual([second.state])
  })
})

describe('desktop: the callback never completes, and only the initiator can claim', () => {
  it('the start answers the window with a desk. state and its claim secret, and sets no cookie', async () => {
    const started = await startAs('alice', 'desktop')
    expect(started.state).toMatch(/^desk\./)
    expect(started.claim_secret).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(started.cookie).toBeNull()
  })

  it('the callback deep-links the code back, leaving the row for the claim; nothing exchanged', async () => {
    const started = await startAs('alice', 'desktop')
    const res = await providerReturn(started.state)
    expect(res.headers.get('content-type')).toContain('text/html')
    const loc = await deepLinkOf(res)
    expect(loc.startsWith('dial8desktop://mcp-oauth/complete?')).toBe(true)
    const link = new URL(loc)
    expect(link.searchParams.get('code')).toBe('victim-code')
    expect(link.searchParams.get('state')).toBe(started.state)
    expect(loc).not.toContain(started.claim_secret!)
    expect(h.stateRows).toHaveLength(1)
    expect(h.exchanges).toBe(0)
  })

  it('a provider error deep-links back to the window that waits for it', async () => {
    const started = await startAs('alice', 'desktop')
    const loc = await deepLinkOf(await providerReturn(started.state, { error: 'access_denied' }))
    expect(loc.startsWith('dial8desktop://mcp-oauth/error?')).toBe(true)
    expect(new URL(loc).searchParams.get('state')).toBe(started.state)
  })

  it("THE ATTACK: the victim's app has the code but not the attacker's secret, and isn't the attacker → refused", async () => {
    const started = await startAs('attacker', 'desktop')
    const res = await claimAs('victim', { code: 'victim-code', state: started.state, claim_secret: 'not-it' })
    expect(res.status).toBe(403)
    expect(h.exchanges).toBe(0)
    expect(h.servers).toHaveLength(0)
    // A wrong secret never consumes the row.
    expect(h.stateRows).toHaveLength(1)
  })

  it('the right secret but another signed-in person → refused, nothing stored', async () => {
    const started = await startAs('alice', 'desktop')
    const res = await claimAs('mallory', { code: 'victim-code', state: started.state, claim_secret: started.claim_secret })
    expect(res.status).toBe(403)
    expect(h.servers).toHaveLength(0)
  })

  it('the initiator with their secret connects, once', async () => {
    const started = await startAs('alice', 'desktop')
    const ok = await claimAs('alice', { code: 'victim-code', state: started.state, claim_secret: started.claim_secret })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ success: true, name: 'Linear', tool_count: 1 })
    expect(h.servers).toHaveLength(1)
    expect(h.servers[0].user_id).toBe('alice')
    expect(h.stateRows).toHaveLength(0)
    const again = await claimAs('alice', { code: 'victim-code', state: started.state, claim_secret: started.claim_secret })
    expect(again.status).toBe(403)
    expect(h.servers).toHaveLength(1)
  })

  it('a web flow is never claimable, and a desktop flow never completes through the web path', async () => {
    const web = await startAs('alice')
    expect((await claimAs('alice', { code: 'c', state: web.state, claim_secret: 'x' })).status).toBe(400)
    // (One flow per server at a time: the start route refuses a second while one is live.)
    h.stateRows = []
    // Stripping the desk. prefix names no row at all.
    const desk = await startAs('alice', 'desktop')
    const stripped = desk.state.slice('desk.'.length)
    h.session = 'alice'
    expect(popup(await providerReturn(stripped)).get('success')).toBe('false')
    expect(h.servers).toHaveLength(0)
  })
})
