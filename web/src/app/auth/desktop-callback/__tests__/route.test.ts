import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

/**
 * /auth/desktop-callback hands a desktop sign-in's code to the app on a
 * dial8desktop:// link. A password reset asked for in the app comes through
 * too, marked `type=recovery` by /auth/confirm: the mark rides along on the
 * deep link (the app opens its reset page) and the page speaks of a reset.
 */
const ORIGIN = 'https://nativeintelligence.dev'

async function open(query: string) {
  const res = await GET(new NextRequest(`${ORIGIN}/auth/desktop-callback?${query}`))
  const html = await res.text()
  const deepLink = /window\.location\.href = "([^"]+)"/.exec(html)?.[1] ?? ''
  return { html, deepLink: JSON.parse(`"${deepLink}"`) as string, type: res.headers.get('content-type') }
}

describe('GET /auth/desktop-callback', () => {
  it('hands a sign-in code to the app, as before', async () => {
    const page = await open('code=abc')
    expect(page.deepLink).toBe('dial8desktop://auth/callback?code=abc')
    expect(page.html).toContain('Signing you in to Native Intelligence')
    expect(page.type).toBe('text/html')
  })

  it('hands a reset code to the app marked as a reset, and says so', async () => {
    const page = await open('code=abc&type=recovery')
    expect(page.deepLink).toBe('dial8desktop://auth/callback?code=abc&type=recovery')
    expect(page.html).toContain('set a new password')
    expect(page.html).toContain('only works on the computer where you asked for it')
    expect(page.html).not.toContain('Signing you in')
  })

  it("passes a failed reset link to the app's reset page and offers a new one on the web", async () => {
    const page = await open('error=access_denied&error_code=otp_expired&type=recovery')
    expect(page.deepLink).toBe('dial8desktop://auth/callback?error=link_expired&type=recovery')
    expect(page.html).toContain('expired or has already been used')
    expect(page.html).toContain(`${ORIGIN}/forgot-password`)

    const failed = await open('error=auth_failed&type=recovery')
    expect(failed.deepLink).toBe('dial8desktop://auth/callback?error=auth_failed&type=recovery')
    expect(failed.html).toContain("This reset link didn't work.")
  })

  it('keeps the sign-in failure page for a sign-in', async () => {
    const page = await open('error=access_denied&error_code=otp_expired')
    expect(page.deepLink).toBe('dial8desktop://auth/callback?error=link_expired')
    expect(page.html).toContain("Sign-in didn't complete.")
  })
})
