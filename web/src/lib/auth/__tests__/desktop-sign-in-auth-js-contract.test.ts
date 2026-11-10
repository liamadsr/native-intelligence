import { describe, expect, it, vi } from 'vitest'
import { AuthClient } from '@supabase/supabase-js'
import { completeDesktopSignIn, desktopSignInLanding, parseDesktopAuthCallback, type DesktopAuthCallback } from '../desktop-sign-in'

/**
 * The desktop reset leans on Supabase's own client, not on anything in the
 * link: resetPasswordForEmail stores this web view's PKCE verifier marked
 * PASSWORD_RECOVERY, and exchangeCodeForSession reports that mark back as
 * `redirectType` (it isn't in the client's types). Run against the real
 * client, with only the network stubbed, so an upgrade that drops either
 * shows up here instead of as resets that quietly land on the dashboard.
 * A code without this web view's verifier fails before any request is made.
 */

const URL_BASE = 'https://auth.example.test/auth/v1'

function realClient() {
  const store = new Map<string, string>()
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    requests.push({ path: `${url.pathname}${url.search}`, body })
    if (url.pathname.endsWith('/token')) {
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'bearer',
        user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
      })
    }
    return Response.json({})
  })
  const client = new AuthClient({
    url: URL_BASE,
    headers: { apikey: 'anon' },
    storageKey: 'sb-test-auth-token',
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    flowType: 'pkce',
    autoRefreshToken: false,
    persistSession: true,
    detectSessionInUrl: false,
    fetch: fetchStub as unknown as typeof fetch,
  })
  return { supabase: { auth: client }, requests }
}

const callback = (raw: string) => parseDesktopAuthCallback(raw) as DesktopAuthCallback

describe('desktop reset against the real Supabase auth client', () => {
  it('a reset this web view asked for opens the reset page', async () => {
    const { supabase, requests } = realClient()
    const { error } = await supabase.auth.resetPasswordForEmail('person@example.com', {
      redirectTo: 'https://nativeintelligence.dev/auth/desktop-callback',
    })
    expect(error).toBeNull()
    expect(requests[0].path).toContain('/recover')
    expect(requests[0].body.code_challenge).toEqual(expect.any(String))

    const outcome = await completeDesktopSignIn(callback('dial8desktop://auth/callback?code=c1&type=recovery'), supabase)
    expect(outcome).toEqual({ ok: true, reset: true })
    expect(desktopSignInLanding(outcome)).toBe('/reset-password')
    // The verifier, not the mark, went to Supabase with the code.
    expect(requests[1]).toMatchObject({ path: '/auth/v1/token?grant_type=pkce', body: { auth_code: 'c1', code_verifier: expect.any(String) } })
    expect(requests[1].body.code_verifier).not.toContain('PASSWORD_RECOVERY')
  })

  it('a sign-in this web view asked for goes to the dashboard, whatever the link says', async () => {
    const { supabase } = realClient()
    await supabase.auth.signInWithOtp({ email: 'person@example.com', options: { emailRedirectTo: 'https://nativeintelligence.dev/auth/desktop-callback' } })
    const outcome = await completeDesktopSignIn(callback('dial8desktop://auth/callback?code=c1&type=recovery'), supabase)
    expect(outcome).toEqual({ ok: true, reset: false })
    expect(desktopSignInLanding(outcome)).toBe('/account')
  })

  it('a reset link this web view did not ask for fails without a request, on the reset page', async () => {
    const { supabase, requests } = realClient()
    const outcome = await completeDesktopSignIn(callback('dial8desktop://auth/callback?code=someone-elses&type=recovery'), supabase)
    expect(requests).toEqual([])
    expect(outcome).toEqual({ ok: false, error: 'opened_elsewhere', description: null, reset: true })
    expect(desktopSignInLanding(outcome)).toBe('/reset-password?error=opened_elsewhere')
  })
})
