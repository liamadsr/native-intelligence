import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const m = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  setSession: vi.fn(async () => ({ error: null })),
  bareOptions: [] as unknown[],
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    m.bareOptions.push(options)
    return { auth: { verifyOtp: m.verifyOtp } }
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { setSession: m.setSession } }),
}))

const { GET, HEAD } = await import('../route')

/** GET /auth/demo-link: a local `next dev` signs into the demo person only. */

const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef01234567'

function request(origin: string, query: Record<string, string> = { token_hash: HASH }) {
  const url = new URL('/auth/demo-link', origin)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return new NextRequest(url, { headers: { host: url.host } })
}
const location = (res: Response) => res.headers.get('location')

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://edrjddsxjoigpbecqgfb.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon')
  m.verifyOtp.mockReset().mockResolvedValue({
    data: { user: { email: 'demo@native-intelligence.test' }, session: { access_token: 'at', refresh_token: 'rt' } },
    error: null,
  })
  m.setSession.mockClear()
  m.bareOptions.length = 0
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /auth/demo-link', () => {
  it('signs the demo person in on localhost and lands on /account', async () => {
    const res = await GET(request('http://localhost:3001'))
    expect(m.verifyOtp).toHaveBeenCalledWith({ token_hash: HASH, type: 'magiclink' })
    expect(m.bareOptions[0]).toMatchObject({ auth: { persistSession: false } })
    expect(m.setSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' })
    expect(location(res)).toBe('http://localhost:3001/account')
  })

  it('is a 404 outside next dev', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const res = await GET(request('http://localhost:3001'))
    expect(res.status).toBe(404)
    expect(m.verifyOtp).not.toHaveBeenCalled()
  })

  it('is a 404 on any host but loopback', async () => {
    const res = await GET(request('https://dial8.ai'))
    expect(res.status).toBe(404)
    expect(m.verifyOtp).not.toHaveBeenCalled()
  })

  it('is a 404 against PROD or an unknown Supabase', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://bzfthjzyzevjokbuhqci.supabase.co')
    expect((await GET(request('http://localhost:3001'))).status).toBe(404)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://another.supabase.co')
    expect((await GET(request('http://localhost:3001'))).status).toBe(404)
    expect(m.verifyOtp).not.toHaveBeenCalled()
  })

  it('refuses a malformed token without asking Supabase', async () => {
    const res = await GET(request('http://localhost:3001', { token_hash: 'pkce_nope' }))
    expect(location(res)).toBe('http://localhost:3001/login?error=auth_failed')
    expect(m.verifyOtp).not.toHaveBeenCalled()
  })

  it('never stores anyone but the demo person\'s session', async () => {
    m.verifyOtp.mockResolvedValue({
      data: { user: { email: 'someone@real.example' }, session: { access_token: 'x', refresh_token: 'y' } },
      error: null,
    })
    const res = await GET(request('http://localhost:3001'))
    expect(m.setSession).not.toHaveBeenCalled()
    expect(location(res)).toBe('http://localhost:3001/login?error=auth_failed')
  })

  it('sends the person to the login page if the session cannot be set', async () => {
    m.setSession.mockResolvedValueOnce({ error: { message: 'bad' } } as never)
    const res = await GET(request('http://localhost:3001'))
    expect(location(res)).toBe('http://localhost:3001/login?error=auth_failed')
  })

  it('sends a spent or expired token to the login page', async () => {
    m.verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: 'expired' } })
    const res = await GET(request('http://localhost:3001'))
    expect(location(res)).toBe('http://localhost:3001/login?error=auth_failed')
  })

  it('answers HEAD without spending the token', async () => {
    expect(HEAD().status).toBe(204)
    expect(m.verifyOtp).not.toHaveBeenCalled()
  })
})
