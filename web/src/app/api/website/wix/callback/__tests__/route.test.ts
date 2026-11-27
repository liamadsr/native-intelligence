/**
 * The Wix callback (phase 4 of docs/plans/hosted-site-builders.md): the
 * query (the site's instance and our state) goes to the check, then a 303 to
 * the bare path with only a result code; the page after says what Wix allows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-auth', () => ({ requireUser: vi.fn(async () => ({ supabase: {}, user: { id: 'u-owner' } })) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: vi.fn(() => ({})) }))
const complete = vi.hoisted(() => vi.fn())
vi.mock('@/lib/website/builder', () => ({ completeWixConnect: complete, CONNECT_REFUSALS: { FAILED: 'Something went wrong.', REJECTED: 'Nothing was connected.', WRONG_PERSON: 'Sign in.' } }))

import { GET } from '../route'

const BASE = 'https://app.example.test/api/website/wix/callback'

beforeEach(() => complete.mockReset())

describe('GET /api/website/wix/callback', () => {
  it('checks the instance and state, then 303s to the bare path', async () => {
    complete.mockResolvedValue({ ok: true, site: {} })
    const res = await GET(new Request(`${BASE}?instanceId=11111111-2222-4333-8444-555555555555&state=s.sig`))
    expect(Object.fromEntries(complete.mock.calls[0][1].params)).toEqual({ instanceId: '11111111-2222-4333-8444-555555555555', state: 's.sig' })
    expect(res.status).toBe(303)
    expect(new URL(res.headers.get('location')!).search).toBe('?result=connected')
  })

  it('the page after says what Wix allows; a refusal is fixed words', async () => {
    expect(await (await GET(new Request(`${BASE}?result=connected`))).text()).toContain('the words of a page itself stay yours to edit in Wix')
    const no = await GET(new Request(`${BASE}?result=WRONG_PERSON`))
    expect(no.status).toBe(403)
    expect(await no.text()).toContain('Sign in.')
    expect(complete).not.toHaveBeenCalled()
  })
})
