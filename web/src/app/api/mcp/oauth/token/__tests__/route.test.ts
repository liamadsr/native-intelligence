/**
 * POST /api/mcp/oauth/token — single-use codes, refresh rotation races, and
 * malformed JSON bodies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  // What each terminal resolves to, keyed by `${table}:${op}`.
  results: new Map<string, unknown>(),
  insertSpy: vi.fn(),
}))

function chain(table: string, op: string) {
  const c: Record<string, unknown> = {}
  const self = () => c
  c.eq = self
  c.select = () => {
    // .update(...).select('code') — the claim / rotation result
    return chain(table, `${op}+select`)
  }
  c.single = () => Promise.resolve(hoisted.results.get(`${table}:${op}`) ?? { data: null, error: null })
  c.then = (cb: (v: unknown) => unknown) =>
    Promise.resolve(hoisted.results.get(`${table}:${op}`) ?? { data: null, error: null }).then(cb)
  return c
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => chain(table, 'select'),
      update: () => chain(table, 'update'),
      insert: (row: unknown) => {
        hoisted.insertSpy(table, row)
        return Promise.resolve({ error: null })
      },
    }),
  }),
}))

vi.mock('@/lib/mcp/auth', () => ({
  generateToken: () => 'tok',
  hashToken: (t: string) => `h(${t})`,
  verifyPkce: () => true,
}))

const { POST } = await import('@/app/api/mcp/oauth/token/route')

function jsonReq(body: string) {
  return new Request('http://localhost/api/mcp/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

const authCode = {
  code: 'c1',
  user_id: 'u1',
  client_id: 'cl',
  redirect_uri: 'https://x/cb',
  code_challenge: 'cc',
  scopes: ['mcp'],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
}

beforeEach(() => {
  hoisted.results.clear()
  hoisted.insertSpy.mockReset()
})

describe('POST /api/mcp/oauth/token', () => {
  it.each(['{', 'null', '[]'])('answers 400 invalid_request for the JSON body %s', async (body) => {
    const res = await POST(jsonReq(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('mints tokens when this request claims the code', async () => {
    hoisted.results.set('mcp_auth_code:select', { data: authCode, error: null })
    hoisted.results.set('mcp_auth_code:update+select', { data: [{ code: 'c1' }], error: null })
    const res = await POST(
      jsonReq(JSON.stringify({ grant_type: 'authorization_code', code: 'c1', client_id: 'cl', code_verifier: 'v' })),
    )
    expect(res.status).toBe(200)
    expect(hoisted.insertSpy).toHaveBeenCalledTimes(1)
  })

  it('takes a loopback callback in either form, since /authorize reads 127.0.0.1 as localhost', async () => {
    hoisted.results.set('mcp_auth_code:select', { data: { ...authCode, redirect_uri: 'http://localhost:53682/cb' }, error: null })
    hoisted.results.set('mcp_auth_code:update+select', { data: [{ code: 'c1' }], error: null })
    const exchange = (redirect_uri: string) =>
      POST(jsonReq(JSON.stringify({ grant_type: 'authorization_code', code: 'c1', client_id: 'cl', code_verifier: 'v', redirect_uri })))
    expect((await exchange('http://127.0.0.1:53682/cb')).status).toBe(200)
    for (const other of ['http://127.0.0.1:53699/cb', 'http://127.0.0.1:53682/other', 'https://x/cb']) {
      const res = await exchange(other)
      expect(res.status, other).toBe(400)
      expect(await res.json(), other).toMatchObject({ error: 'invalid_grant' })
    }
  })

  it('refuses (invalid_grant) and mints nothing when a concurrent request already claimed the code', async () => {
    hoisted.results.set('mcp_auth_code:select', { data: authCode, error: null })
    hoisted.results.set('mcp_auth_code:update+select', { data: [], error: null })
    const res = await POST(
      jsonReq(JSON.stringify({ grant_type: 'authorization_code', code: 'c1', client_id: 'cl', code_verifier: 'v' })),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
  })

  it('refuses a refresh whose token was rotated by a concurrent refresh', async () => {
    hoisted.results.set('mcp_oauth_token:select', {
      data: { id: 't1', scopes: ['mcp'], expires_at: new Date(Date.now() + 60_000).toISOString() },
      error: null,
    })
    hoisted.results.set('mcp_oauth_token:update+select', { data: [], error: null })
    const res = await POST(jsonReq(JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'r', client_id: 'cl' })))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
  })
})
