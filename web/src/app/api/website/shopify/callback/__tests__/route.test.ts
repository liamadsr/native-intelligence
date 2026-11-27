/**
 * The Shopify callback (phase 2 of docs/plans/hosted-site-builders.md): the
 * whole query goes to the check (Shopify's HMAC covers it), then a 303 to this
 * path with only a result code; the page after it is fixed words for the code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ user: { id: 'u-owner' } as { id: string } | null }))
vi.mock('@/lib/api-auth', () => ({ requireUser: vi.fn(async () => (auth.user ? { supabase: {}, user: auth.user } : new Response(null, { status: 401 }))) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: vi.fn(() => ({})) }))
const complete = vi.hoisted(() => vi.fn())
vi.mock('@/lib/website/builder', () => ({
  completeShopifyConnect: complete,
  CONNECT_REFUSALS: { BAD_STATE: 'That connect link is no longer good.', FAILED: 'Something went wrong.', REJECTED: 'Nothing was connected.' },
}))

import { GET } from '../route'

const BASE = 'https://app.example.test/api/website/shopify/callback'

beforeEach(() => {
  auth.user = { id: 'u-owner' }
  complete.mockReset()
})

describe('GET /api/website/shopify/callback', () => {
  it('checks the whole query, then 303s to the bare path: the code leaves the address', async () => {
    complete.mockResolvedValue({ ok: true, site: {} })
    const res = await GET(new Request(`${BASE}?code=one-time&hmac=abc&shop=example-goods.myshopify.com&state=s.sig&timestamp=1`))
    const { params, sessionUserId } = complete.mock.calls[0][1]
    expect(sessionUserId).toBe('u-owner')
    expect(Object.fromEntries(params)).toEqual({ code: 'one-time', hmac: 'abc', shop: 'example-goods.myshopify.com', state: 's.sig', timestamp: '1' })
    expect(res.status).toBe(303)
    expect(new URL(res.headers.get('location')!).search).toBe('?result=connected')
    expect(res.headers.get('location')).not.toContain('one-time')
  })

  it('a refusal and a turn-down go the same way; the page after is fixed words', async () => {
    complete.mockResolvedValue({ ok: false, code: 'BAD_STATE', error: 'x' })
    expect(new URL((await GET(new Request(`${BASE}?code=c&hmac=h&shop=s&state=s`))).headers.get('location')!).search).toBe('?result=BAD_STATE')
    expect(new URL((await GET(new Request(`${BASE}?error=access_denied`))).headers.get('location')!).search).toBe('?result=REJECTED')
    const page = await GET(new Request(`${BASE}?result=connected`))
    expect(await page.text()).toContain('Your Shopify store is connected')
    expect(await (await GET(new Request(`${BASE}?result=BAD_STATE`))).text()).toContain('That connect link is no longer good.')
    expect(complete).toHaveBeenCalledTimes(1)
  })
})
