import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The MCP OAuth steps that send a browser to a client's redirect_uri
 * (GET /api/mcp/oauth/authorize, POST /api/mcp/oauth/deny): never before the
 * client is known and the URI is one it registered (RFC 6749 §4.1.2.1).
 * /api/mcp/… is a path a sign-in may resume, so an unchecked redirect_uri
 * here is an open redirect.
 */

const CLIENT = { client_id: 'c1', redirect_uris: ['https://client.example/cb'], client_name: 'Client' }

const m = vi.hoisted(() => ({
  client: null as Record<string, unknown> | null,
  user: { id: 'u1' } as { id: string } | null,
  authed: true,
  authCode: null as Record<string, unknown> | null,
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: m.client, error: null }) }) }),
      insert: async (row: Record<string, unknown>) => {
        m.authCode = row
        return { error: null }
      },
    }),
  }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }) }))
vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => (m.authed ? { user: { id: 'u1' } } : new Response('no', { status: 401 })),
}))

const { GET: authorize } = await import('../authorize/route')
const { POST: deny } = await import('../deny/route')
const { POST: approve } = await import('../approve/route')

const authorizeUrl = (params: Record<string, string>) => new Request(`https://nativeintelligence.dev/api/mcp/oauth/authorize?${new URLSearchParams(params)}`)
const denyRequest = (body: unknown) => new Request('https://nativeintelligence.dev/api/mcp/oauth/deny', { method: 'POST', body: JSON.stringify(body) })
const location = (res: Response) => res.headers.get('location')

beforeEach(() => {
  m.client = { ...CLIENT }
  m.user = { id: 'u1' }
  m.authed = true
  process.env.NEXT_PUBLIC_APP_URL = 'https://nativeintelligence.dev'
})

describe('GET /api/mcp/oauth/authorize', () => {
  it('never redirects to a redirect_uri no registered client named: a 400, no Location', async () => {
    const evil = 'https://evil.example/phish'
    const cases: Array<[Record<string, string>, Record<string, unknown> | null, string]> = [
      [{ redirect_uri: evil }, CLIENT, 'invalid_request'], // no client_id, the exploit as reported
      [{ client_id: 'c1' }, CLIENT, 'invalid_request'],
      [{ client_id: 'unknown', redirect_uri: evil, code_challenge: 'x' }, null, 'invalid_client'],
      [{ client_id: 'c1', redirect_uri: evil, code_challenge: 'x' }, CLIENT, 'invalid_redirect_uri'],
      [{ client_id: 'c1', redirect_uri: evil }, CLIENT, 'invalid_redirect_uri'], // no challenge: still checked first
      [{ client_id: 'c1', redirect_uri: evil, code_challenge: 'x', code_challenge_method: 'plain' }, CLIENT, 'invalid_redirect_uri'],
    ]
    for (const [params, client, code] of cases) {
      m.client = client
      const res = await authorize(authorizeUrl(params))
      expect(res.status, JSON.stringify(params)).toBe(400)
      expect(location(res), JSON.stringify(params)).toBeNull()
      expect((await res.json()).error, JSON.stringify(params)).toBe(code)
    }
  })

  it("never bounces a later error to the client either: a registered URI isn't a trusted one (RFC 9700 4.11.2)", async () => {
    // /register is open: anyone can register https://evil.example/x and use
    // a malformed request to send a signed-in browser there, no consent shown.
    for (const user of [{ id: 'u1' }, null]) {
      m.user = user
      const noChallenge = await authorize(authorizeUrl({ client_id: 'c1', redirect_uri: CLIENT.redirect_uris[0], state: 's1' }))
      expect(noChallenge.status).toBe(400)
      expect(location(noChallenge)).toBeNull()
      expect((await noChallenge.json()).error).toBe('invalid_request')
      const plain = await authorize(authorizeUrl({ client_id: 'c1', redirect_uri: CLIENT.redirect_uris[0], code_challenge: 'x', code_challenge_method: 'plain' }))
      expect(plain.status).toBe(400)
      expect(location(plain)).toBeNull()
    }
  })

  it('refuses a script-bearing redirect_uri even when the client registered it', async () => {
    m.client = { ...CLIENT, redirect_uris: ['javascript:alert(1)'] }
    const res = await authorize(authorizeUrl({ client_id: 'c1', redirect_uri: 'javascript:alert(1)', code_challenge: 'x' }))
    expect(res.status).toBe(400)
    expect(location(res)).toBeNull()
    expect((await deny(denyRequest({ client_id: 'c1', redirect_uri: 'javascript:alert(1)' }))).status).toBe(400)
  })

  it('a valid request goes on to the login page or the consent page, on this site', async () => {
    const params = { client_id: 'c1', redirect_uri: CLIENT.redirect_uris[0], code_challenge: 'x' }
    m.user = null
    expect(location(await authorize(authorizeUrl(params)))).toMatch(/^https:\/\/nativeintelligence\.dev\/login\?redirect=/)
    m.user = { id: 'u1' }
    expect(location(await authorize(authorizeUrl(params)))).toMatch(/^https:\/\/nativeintelligence\.dev\/mcp\/authorize\?/)
  })
})

describe('a 127.0.0.1 or [::1] callback, which a route handler reads as localhost', () => {
  const V4 = 'http://127.0.0.1:53682/callback'
  const V6 = 'http://[::1]:53683/callback'
  // On Vercel a route handler gets a NextRequest, whose url turns the first
  // loopback IP after the scheme into localhost; a plain Request doesn't.
  const nextAuthorize = (query: string) => new NextRequest(`https://nativeintelligence.dev/api/mcp/oauth/authorize?${query}`)

  beforeEach(() => {
    m.client = { ...CLIENT, redirect_uris: [V4, V6] }
  })

  it('the consent page gets exactly the URI the client registered (and an error is a 400 here)', async () => {
    const cases: Array<[string, string]> = [
      [`redirect_uri=${encodeURIComponent(V4)}`, V4],
      [`redirect_uri=${V6}`, V6], // unencoded brackets get the rewrite too
    ]
    for (const [query, registered] of cases) {
      const request = nextAuthorize(`client_id=c1&${query}&state=s1`)
      expect(new URL(request.url).searchParams.get('redirect_uri'), query).toMatch(/^http:\/\/localhost:/)
      const error = await authorize(request)
      expect(error.status, query).toBe(400)
      expect(location(error), query).toBeNull()
      const consent = new URL(location(await authorize(nextAuthorize(`client_id=c1&${query}&code_challenge=x`)))!)
      expect(consent.origin + consent.pathname, query).toBe('https://nativeintelligence.dev/mcp/authorize')
      expect(consent.searchParams.get('redirect_uri'), query).toBe(registered)
    }
  })

  it('still refuses another scheme, port or path: a 400, no Location', async () => {
    for (const asked of ['http://localhost:53699/callback', 'http://localhost:53682/other', 'http://localhost:53682/callback/x', 'https://localhost:53682/callback', 'http://localhost:53682/callback?x=1']) {
      const res = await authorize(nextAuthorize(`client_id=c1&redirect_uri=${encodeURIComponent(asked)}&code_challenge=x`))
      expect(res.status, asked).toBe(400)
      expect(location(res), asked).toBeNull()
    }
    m.client = { ...CLIENT }
    const res = await authorize(nextAuthorize(`client_id=c1&redirect_uri=${encodeURIComponent('http://localhost/cb')}&code_challenge=x`))
    expect(res.status).toBe(400)
  })

  it('an https or upper-case-scheme 127.0.0.1 callback, which Next.js rewrites the same way', async () => {
    const registered = ['https://127.0.0.1:8443/cb', 'HTTP://127.0.0.1:53684/cb']
    m.client = { ...CLIENT, redirect_uris: registered }
    for (const uri of registered) {
      const at = new URL(location(await authorize(nextAuthorize(`client_id=c1&redirect_uri=${encodeURIComponent(uri)}&code_challenge=x&state=s1`)))!)
      expect(at.pathname, uri).toBe('/mcp/authorize')
      expect(at.searchParams.get('redirect_uri'), uri).toBe(uri)
    }
  })

  it('a signed-out request resumes after sign-in and still reaches the consent page with the registered URI', async () => {
    m.user = null
    const login = new URL(location(await authorize(nextAuthorize(`client_id=c1&redirect_uri=${encodeURIComponent(V4)}&code_challenge=x`)))!)
    expect(login.pathname).toBe('/login')
    const resume = login.searchParams.get('redirect')!
    m.user = { id: 'u1' }
    const consent = new URL(location(await authorize(new NextRequest(resume)))!)
    expect(consent.pathname).toBe('/mcp/authorize')
    expect(consent.searchParams.get('redirect_uri')).toBe(V4)
  })

  it('approve binds the code to the registered URI and sends the browser there', async () => {
    for (const asked of [V4, 'http://localhost:53682/callback']) {
      m.authCode = null
      const res = await approve(new Request('https://nativeintelligence.dev/api/mcp/oauth/approve', {
        method: 'POST',
        body: JSON.stringify({ client_id: 'c1', redirect_uri: asked, code_challenge: 'x', state: 's1' }),
      }))
      expect(res.status, asked).toBe(200)
      expect((await res.json()).redirect_url, asked).toMatch(/^http:\/\/127\.0\.0\.1:53682\/callback\?code=/)
      expect((m.authCode as Record<string, unknown> | null)?.redirect_uri, asked).toBe(V4) // set by the insert mock
    }
    const unregistered = await approve(new Request('https://nativeintelligence.dev/api/mcp/oauth/approve', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'c1', redirect_uri: 'http://localhost:53699/callback', code_challenge: 'x' }),
    }))
    expect(unregistered.status).toBe(400)
  })

  it('deny answers the registered URI too', async () => {
    for (const asked of [V4, 'http://localhost:53682/callback']) {
      const res = await deny(denyRequest({ client_id: 'c1', redirect_uri: asked, state: 's1' }))
      expect(res.status, asked).toBe(200)
      expect((await res.json()).redirect_url, asked).toMatch(/^http:\/\/127\.0\.0\.1:53682\/callback\?error=access_denied/)
    }
  })
})

describe('POST /api/mcp/oauth/deny', () => {
  it("answers the client's registered redirect_uri with access_denied", async () => {
    const res = await deny(denyRequest({ client_id: 'c1', redirect_uri: CLIENT.redirect_uris[0], state: 's1' }))
    expect(res.status).toBe(200)
    const at = new URL((await res.json()).redirect_url)
    expect(at.origin + at.pathname).toBe('https://client.example/cb')
    expect(at.searchParams.get('error')).toBe('access_denied')
    expect(at.searchParams.get('state')).toBe('s1')
  })

  it('never answers a URI the client did not register, or for an unknown client, or a signed-out caller', async () => {
    expect((await deny(denyRequest({ client_id: 'c1', redirect_uri: 'https://evil.example/phish' }))).status).toBe(400)
    m.client = null
    expect((await deny(denyRequest({ client_id: 'nope', redirect_uri: 'https://evil.example/phish' }))).status).toBe(400)
    m.client = { ...CLIENT }
    expect((await deny(denyRequest({ redirect_uri: CLIENT.redirect_uris[0] }))).status).toBe(400)
    m.authed = false
    expect((await deny(denyRequest({ client_id: 'c1', redirect_uri: CLIENT.redirect_uris[0] }))).status).toBe(401)
  })
})
