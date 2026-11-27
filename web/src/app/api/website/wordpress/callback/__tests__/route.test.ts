/**
 * The WordPress callback (migration 724): the login is stored, then the
 * browser is sent to this path with only a result code, so the address that
 * carried the password leaves its address bar and history; the page after it
 * is drawn from the code alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ user: { id: 'u-owner' } as { id: string } | null }))
vi.mock('@/lib/api-auth', () => ({ requireUser: vi.fn(async () => (auth.user ? { supabase: {}, user: auth.user } : new Response(null, { status: 401 }))) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: vi.fn(() => ({})) }))
const complete = vi.hoisted(() => vi.fn())
vi.mock('@/lib/website/builder', () => ({
  completeWordpressConnect: complete,
  CONNECT_REFUSALS: { WRONG_PERSON: 'Sign in as the person who asked.', FAILED: 'Something went wrong.', REJECTED: 'Nothing was connected.' },
}))

import { GET } from '../route'

const BASE = 'https://app.example.test/api/website/wordpress/callback'
const WITH_PASSWORD = `${BASE}?state=s.sig&site_url=https%3A%2F%2Fsite.example.test&user_login=site-admin&password=abcd+efgh+ijkl`

beforeEach(() => {
  auth.user = { id: 'u-owner' }
  complete.mockReset()
})

describe('GET /api/website/wordpress/callback', () => {
  it('stores the login, then 303s to the bare path with only a result: the password leaves the address', async () => {
    complete.mockResolvedValue({ ok: true, site: {} })
    const res = await GET(new Request(WITH_PASSWORD))
    expect(complete).toHaveBeenCalledWith({}, { state: 's.sig', sessionUserId: 'u-owner', siteUrl: 'https://site.example.test', userLogin: 'site-admin', password: 'abcd efgh ijkl' })
    expect(res.status).toBe(303)
    const to = new URL(res.headers.get('location')!)
    expect(to.pathname).toBe('/api/website/wordpress/callback')
    expect([...to.searchParams.keys()]).toEqual(['result'])
    expect(to.searchParams.get('result')).toBe('connected')
    expect(res.headers.get('location')).not.toMatch(/abcd|site-admin|password/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('a refusal goes the same way, with its code', async () => {
    auth.user = null
    complete.mockResolvedValue({ ok: false, code: 'WRONG_PERSON', error: 'x' })
    const res = await GET(new Request(WITH_PASSWORD))
    expect(complete.mock.calls[0][1].sessionUserId).toBeNull()
    expect(new URL(res.headers.get('location')!).search).toBe('?result=WRONG_PERSON')
  })

  it('the page after it: fixed words for the code, never what the query says', async () => {
    const ok = await GET(new Request(`${BASE}?result=connected`))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Your WordPress site is connected')
    const no = await GET(new Request(`${BASE}?result=WRONG_PERSON`))
    expect(no.status).toBe(403)
    expect(await no.text()).toContain('Sign in as the person who asked.')
    const odd = await GET(new Request(`${BASE}?result=%3Cscript%3E`))
    expect(await odd.text()).toContain('Something went wrong.')
    expect(complete).not.toHaveBeenCalled()
  })

  it('a turn-down on WordPress stores nothing', async () => {
    const res = await GET(new Request(`${BASE}?state=s.sig&success=false`))
    expect(new URL(res.headers.get('location')!).search).toBe('?result=REJECTED')
    expect(complete).not.toHaveBeenCalled()
  })
})
