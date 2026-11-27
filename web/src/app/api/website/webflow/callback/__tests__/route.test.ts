/**
 * The Webflow and WordPress.com callbacks (phase 3 of
 * docs/plans/hosted-site-builders.md): the query goes to the check for that
 * builder, then a 303 to the bare path with only a result code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-auth', () => ({ requireUser: vi.fn(async () => ({ supabase: {}, user: { id: 'u-owner' } })) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: vi.fn(() => ({})) }))
const complete = vi.hoisted(() => vi.fn())
vi.mock('@/lib/website/builder', () => ({ completeOAuthBuilderConnect: complete, CONNECT_REFUSALS: { FAILED: 'Something went wrong.', REJECTED: 'Nothing was connected.', OTHER_SITE: 'Another site.' } }))

import { GET as webflow } from '../route'
import { GET as wpcom } from '../../../wpcom/callback/route'

beforeEach(() => complete.mockReset())

describe('the OAuth builder callbacks', () => {
  it('checks the code for its own builder, then 303s to the bare path', async () => {
    complete.mockResolvedValue({ ok: true, site: {} })
    const res = await webflow(new Request('https://app.example.test/api/website/webflow/callback?code=one-time&state=s.sig'))
    expect(complete.mock.calls[0][1]).toBe('webflow')
    expect(complete.mock.calls[0][2].sessionUserId).toBe('u-owner')
    expect(res.status).toBe(303)
    const to = new URL(res.headers.get('location')!)
    expect(`${to.pathname}${to.search}`).toBe('/api/website/webflow/callback?result=connected')
    complete.mockResolvedValue({ ok: false, code: 'OTHER_SITE', error: 'x' })
    const no = await wpcom(new Request('https://app.example.test/api/website/wpcom/callback?code=c&state=s'))
    expect(complete.mock.calls[1][1]).toBe('wpcom')
    expect(new URL(no.headers.get('location')!).search).toBe('?result=OTHER_SITE')
  })

  it('a turn-down stores nothing; the page after is fixed words', async () => {
    expect(new URL((await wpcom(new Request('https://app.example.test/api/website/wpcom/callback?error=access_denied'))).headers.get('location')!).search).toBe('?result=REJECTED')
    expect(await (await webflow(new Request('https://app.example.test/api/website/webflow/callback?result=connected'))).text()).toContain('Your Webflow site is connected')
    expect(await (await wpcom(new Request('https://app.example.test/api/website/wpcom/callback?result=OTHER_SITE'))).text()).toContain('Another site.')
    expect(complete).not.toHaveBeenCalled()
  })
})
