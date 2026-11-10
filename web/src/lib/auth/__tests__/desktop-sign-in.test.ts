import { describe, expect, it, vi } from 'vitest'
import { completeDesktopSignIn, desktopSignInLanding, parseDesktopAuthCallback, type DesktopAuthCallback } from '../desktop-sign-in'

/**
 * The desktop app's dial8desktop://auth/callback. A password reset asked for
 * in the app comes back the same way, marked `type=recovery`, and lands on the
 * reset page. The PKCE verifier in the app's web view is still what lets a
 * code through: a link without it fails.
 */

function client(result: { data?: { redirectType?: string | null } | null; error: unknown }) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn(async (_code: string) => result),
      verifyOtp: vi.fn(async () => ({ error: null })),
    },
  }
}

const parse = (raw: string) => parseDesktopAuthCallback(raw) as DesktopAuthCallback

describe('parseDesktopAuthCallback', () => {
  it('reads the reset mark on a code and on an error', () => {
    expect(parse('dial8desktop://auth/callback?code=abc&type=recovery')).toEqual({ kind: 'code', code: 'abc', reset: true })
    expect(parse('dial8desktop://auth/callback?code=abc')).toEqual({ kind: 'code', code: 'abc', reset: false })
    expect(parse('dial8desktop://auth/callback?error=link_expired&type=recovery')).toEqual({
      kind: 'error',
      error: 'link_expired',
      description: null,
      reset: true,
    })
  })

  it('still refuses anything that is not a dial8desktop callback', () => {
    expect(parseDesktopAuthCallback('https://nativeintelligence.dev/auth/desktop-callback?code=abc&type=recovery')).toBeNull()
    expect(parseDesktopAuthCallback('dial8desktop://oauth/complete?code=abc')).toBeNull()
  })
})

describe('completeDesktopSignIn + desktopSignInLanding', () => {
  it('opens the reset page for a reset this web view asked for', async () => {
    const supabase = client({ data: { redirectType: 'PASSWORD_RECOVERY' }, error: null })
    const outcome = await completeDesktopSignIn(parse('dial8desktop://auth/callback?code=abc&type=recovery'), supabase)
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('abc')
    expect(outcome).toEqual({ ok: true, reset: true })
    expect(desktopSignInLanding(outcome)).toBe('/reset-password')
  })

  it('lets only the exchange decide a reset: the mark alone does not open the reset page', async () => {
    const supabase = client({ data: { redirectType: null }, error: null })
    const outcome = await completeDesktopSignIn(parse('dial8desktop://auth/callback?code=abc&type=recovery'), supabase)
    expect(desktopSignInLanding(outcome)).toBe('/account')
  })

  it('a sign-in code still goes to the dashboard', async () => {
    const outcome = await completeDesktopSignIn(parse('dial8desktop://auth/callback?code=abc'), client({ data: { redirectType: null }, error: null }))
    expect(desktopSignInLanding(outcome)).toBe('/account')
  })

  it('a reset link without this web view’s verifier still fails, and the reset page says where to open it', async () => {
    const error = Object.assign(new Error('PKCE code verifier not found in storage.'), { code: 'pkce_code_verifier_not_found' })
    const outcome = await completeDesktopSignIn(parse('dial8desktop://auth/callback?code=abc&type=recovery'), client({ data: null, error }))
    expect(outcome).toEqual({ ok: false, error: 'opened_elsewhere', description: null, reset: true })
    expect(desktopSignInLanding(outcome)).toBe('/reset-password?error=opened_elsewhere')
  })

  it('a sign-in code without the verifier fails to the login page, as before', async () => {
    const error = Object.assign(new Error('PKCE code verifier not found in storage.'), { code: 'pkce_code_verifier_not_found' })
    const outcome = await completeDesktopSignIn(parse('dial8desktop://auth/callback?code=abc'), client({ data: null, error }))
    expect(desktopSignInLanding(outcome)).toBe('/login?error=auth_failed')
  })

  it('a reset link that failed before reaching the app lands on the reset page with its error', async () => {
    const supabase = client({ error: null })
    const outcome = await completeDesktopSignIn(parse('dial8desktop://auth/callback?error=link_expired&type=recovery'), supabase)
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(desktopSignInLanding(outcome)).toBe('/reset-password?error=link_expired')
    // A sign-in error keeps going to the login page.
    expect(desktopSignInLanding(await completeDesktopSignIn(parse('dial8desktop://auth/callback?error=work_email_required'), supabase))).toBe(
      '/login?error=work_email_required',
    )
  })

  it('an exchange that throws fails where the callback was headed', async () => {
    const supabase = client({ error: null })
    supabase.auth.exchangeCodeForSession.mockRejectedValueOnce(new Error('offline'))
    const outcome = await completeDesktopSignIn(parse('dial8desktop://auth/callback?code=abc&type=recovery'), supabase)
    expect(desktopSignInLanding(outcome)).toBe('/reset-password?error=auth_failed')
  })
})
