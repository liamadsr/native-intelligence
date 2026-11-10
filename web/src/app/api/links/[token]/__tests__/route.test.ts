import { beforeEach, describe, expect, it, vi } from 'vitest'
import { oneTimeLinkDb } from '@/lib/links/__tests__/one-time-fake'
import { createOneTimeLink } from '@/lib/links/one-time'

/**
 * POST /api/links/[token]: the button on a texted link's page. Same-origin
 * only; uses the link once; for a connect, a 303 to the provider with the
 * oauth_nonce cookie the callback requires. A used or expired link goes to
 * the "no longer works" page.
 */
const db = oneTimeLinkDb()
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => db.client }))

const { POST } = await import('../route')
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv12'

beforeEach(async () => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
  db.rows.length = 0
  await createOneTimeLink(db.client, { purpose: 'oauth_connect', userId: 'user-1', workspaceId: 'ws-1', payload: { provider: 'google', capabilities: ['email', 'calendar'] }, origin: 'https://nativeintelligence.dev' }, { token: () => TOKEN })
})

function post(headers: Record<string, string>, token = TOKEN) {
  return POST(new Request(`https://nativeintelligence.dev/api/links/${token}`, { method: 'POST', headers }), { params: Promise.resolve({ token }) })
}

describe('POST /api/links/[token]', () => {
  it('from our own page: uses the link and sends the browser to Google with the binding cookie', async () => {
    const res = await post({ 'sec-fetch-site': 'same-origin' })
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location')!)
    expect(location.host).toBe('accounts.google.com')
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/oauth_nonce=[0-9a-f-]{36}/)
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('samesite=lax')
    expect(db.rows[0].consumed_at).not.toBeNull()
  })

  it('a second tap finds it used: the "no longer works" page, and no cookie', async () => {
    await post({ 'sec-fetch-site': 'same-origin' })
    const again = await post({ 'sec-fetch-site': 'same-origin' })
    expect(again.status).toBe(303)
    expect(again.headers.get('location')).toBe('https://nativeintelligence.dev/l/done?status=invalid')
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  it('an expired link goes to the same page and is not used', async () => {
    db.rows[0].expires_at = new Date(Date.now() - 1000).toISOString()
    const res = await post({ origin: 'https://nativeintelligence.dev', host: 'nativeintelligence.dev' })
    expect(res.headers.get('location')).toBe('https://nativeintelligence.dev/l/done?status=invalid')
    expect(db.rows[0].consumed_at).toBeNull()
  })

  it("another site's form can't use it: cross-site, a foreign Origin, or no signal at all is refused, and the link stays unused", async () => {
    const refused: Array<Record<string, string>> = [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example', host: 'nativeintelligence.dev' }, {}]
    for (const headers of refused) {
      const res = await post(headers)
      expect(res.status, JSON.stringify(headers)).toBe(403)
    }
    expect(db.rows[0].consumed_at).toBeNull()
  })

  it('without Sec-Fetch-Site (older Safari), a real Origin on this host is accepted and an opaque "null" one refused', async () => {
    expect((await post({ origin: 'null', host: 'nativeintelligence.dev' })).status).toBe(403)
    expect(db.rows[0].consumed_at).toBeNull()
    const ok = await post({ origin: 'https://nativeintelligence.dev', host: 'nativeintelligence.dev' })
    expect(ok.status).toBe(303)
    expect(new URL(ok.headers.get('location')!).host).toBe('accounts.google.com')
  })

  it('a token of the wrong shape reads nothing', async () => {
    const res = await post({ 'sec-fetch-site': 'same-origin' }, 'nope')
    expect(res.headers.get('location')).toBe('https://nativeintelligence.dev/l/done?status=invalid')
  })
})
