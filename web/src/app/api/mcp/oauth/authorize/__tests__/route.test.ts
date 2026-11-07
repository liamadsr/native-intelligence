import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/mcp/oauth/authorize must never redirect to a redirect_uri that is
 * not one of the client's registered URIs (open redirect, RFC 6749 §4.1.2.1).
 */

const hoisted = vi.hoisted(() => ({
  client: null as { client_id: string; redirect_uris: string[]; client_name: string } | null,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        single: async () => ({ data: hoisted.client, error: null }),
      }
      return api
    },
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

const { GET } = await import('@/app/api/mcp/oauth/authorize/route')

const REGISTERED = 'https://client.example/cb'
const EVIL = 'https://evil.example/phish'

function authorize(params: Record<string, string>) {
  const qs = new URLSearchParams(params)
  return GET(new Request(`https://dial8.ai/api/mcp/oauth/authorize?${qs}`))
}

beforeEach(() => {
  hoisted.client = { client_id: 'c1', redirect_uris: [REGISTERED], client_name: 'Client' }
})

describe('GET /api/mcp/oauth/authorize — error redirects', () => {
  it('returns JSON, not a redirect, when client_id is missing', async () => {
    const res = await authorize({ redirect_uri: EVIL, code_challenge: 'x' })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('returns JSON, not a redirect, for an unknown client', async () => {
    hoisted.client = null
    const res = await authorize({ client_id: 'nope', redirect_uri: EVIL, code_challenge: 'x' })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('returns JSON for a bad challenge method with an unregistered redirect_uri', async () => {
    const res = await authorize({
      client_id: 'c1',
      redirect_uri: EVIL,
      code_challenge: 'x',
      code_challenge_method: 'plain',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('returns JSON, not a redirect, even to a registered redirect_uri (registered is not trusted)', async () => {
    const res = await authorize({
      client_id: 'c1',
      redirect_uri: REGISTERED,
      code_challenge: 'x',
      code_challenge_method: 'plain',
      state: 's1',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect((await res.json()).error).toBe('invalid_request')
  })
})
