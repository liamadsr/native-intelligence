/**
 * The same-origin check for cookie-authed, state-changing routes: an Origin
 * must be the app's own; without one, Sec-Fetch-Site must be same-origin or
 * none; with neither, only a bearer (non-browser) caller passes.
 */
import { describe, expect, it } from 'vitest'
import { CROSS_SITE_REQUEST, crossSiteRefusal, requestOrigin } from '../same-origin'

const PROD = 'https://dial8.ai/api/local-agent/sessions/s/claim'
const DEV = 'http://localhost:3000/api/local-agent/sessions/s/claim'

const post = (url: string, headers: Record<string, string>) => new Request(url, { method: 'POST', headers })

async function refusedCode(request: Request): Promise<string | null> {
  const res = crossSiteRefusal(request)
  if (!res) return null
  expect(res.status).toBe(403)
  return ((await res.json()) as { code: string }).code
}

describe('requestOrigin', () => {
  it('is the origin the request was sent to, as a browser writes Origin', () => {
    expect(requestOrigin(post(PROD, { host: 'dial8.ai', 'x-forwarded-proto': 'https' }))).toBe('https://dial8.ai')
    expect(requestOrigin(post(DEV, { host: 'localhost:3000' }))).toBe('http://localhost:3000')
    // The forwarded host wins over the route's URL (Next reports localhost for 127.0.0.1).
    expect(requestOrigin(post(DEV, { 'x-forwarded-host': '127.0.0.1:3000', 'x-forwarded-proto': 'http' }))).toBe('http://127.0.0.1:3000')
    // The first hop of a forwarded list; default ports and case normalize away.
    expect(requestOrigin(post(PROD, { 'x-forwarded-host': 'Dial8.AI:443, internal.example', 'x-forwarded-proto': 'https, http' }))).toBe('https://dial8.ai')
    // No forwarding headers: the request URL.
    expect(requestOrigin(post(PROD, {}))).toBe('https://dial8.ai')
  })
})

describe('crossSiteRefusal', () => {
  it.each([
    ['the desktop webview / a browser on dial8.ai', PROD, { origin: 'https://dial8.ai', host: 'dial8.ai', 'x-forwarded-proto': 'https' }],
    ['dev on localhost:3000', DEV, { origin: 'http://localhost:3000', host: 'localhost:3000' }],
    ['dev on 127.0.0.1:3000 (forwarded host)', DEV, { origin: 'http://127.0.0.1:3000', 'x-forwarded-host': '127.0.0.1:3000', 'x-forwarded-proto': 'http' }],
    ['no Origin, Sec-Fetch-Site same-origin', PROD, { 'sec-fetch-site': 'same-origin' }],
    ['no Origin, Sec-Fetch-Site none (the person’s own navigation)', PROD, { 'sec-fetch-site': 'none' }],
    ['neither header, a bearer (a script: no ambient cookie)', PROD, { authorization: 'Bearer eyJ.jwt.sig' }],
  ])('passes %s', async (_label, url, headers) => {
    expect(await refusedCode(post(url, headers))).toBeNull()
  })

  it.each([
    ['a sibling subdomain', PROD, { origin: 'https://evil.dial8.ai', host: 'dial8.ai', 'x-forwarded-proto': 'https' }],
    ['www against the apex', PROD, { origin: 'https://www.dial8.ai', host: 'dial8.ai', 'x-forwarded-proto': 'https' }],
    ['the same host over http', PROD, { origin: 'http://dial8.ai', host: 'dial8.ai', 'x-forwarded-proto': 'https' }],
    ['another site', PROD, { origin: 'https://attacker.example', host: 'dial8.ai' }],
    ['an opaque origin', PROD, { origin: 'null', host: 'dial8.ai' }],
    ['a foreign Origin, whatever Sec-Fetch-Site says', PROD, { origin: 'https://attacker.example', 'sec-fetch-site': 'same-origin', host: 'dial8.ai' }],
    ['no Origin, Sec-Fetch-Site same-site', PROD, { 'sec-fetch-site': 'same-site' }],
    ['no Origin, Sec-Fetch-Site cross-site', PROD, { 'sec-fetch-site': 'cross-site' }],
    ['no Origin, cross-site even with a bearer', PROD, { 'sec-fetch-site': 'cross-site', authorization: 'Bearer eyJ.jwt.sig' }],
    ['neither header, a cookie alone', PROD, { cookie: 'sb-access-token=x' }],
    ['neither header, an empty bearer', PROD, { authorization: 'Bearer ' }],
  ])('refuses %s', async (_label, url, headers) => {
    expect(await refusedCode(post(url, headers))).toBe(CROSS_SITE_REQUEST)
  })
})
