import type { EmailOtpType } from '@supabase/supabase-js'

/**
 * Supabase Auth's emails (confirm signup, magic link, reset password, invite,
 * change email) link to dial8.ai/auth/confirm instead of the Supabase
 * project's own /auth/v1/verify, so the person never sees supabase.co. The
 * templates (supabase/templates/*.html, pasted into the dashboard) carry the
 * link's `token_hash`, its `type`, and the `redirect_to` the sign-in asked for:
 *
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink&redirect_to={{ .RedirectTo }}
 *
 * The auth emails note under docs/auth has the setup.
 */

const EMAIL_LINK_TYPES: readonly EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email']

/** The link's `type`, or null when it isn't an email link's. */
export function emailLinkType(raw: string | null): EmailOtpType | null {
  return EMAIL_LINK_TYPES.find((t) => t === raw) ?? null
}

/**
 * A PKCE link's token hash (`pkce_` + hex). Every Native Intelligence sign-in uses PKCE, so
 * any other token is refused before it reaches Supabase: a link without PKCE
 * isn't bound to the browser that asked for it, and someone else's could sign
 * this browser into their account.
 */
export function isPkceTokenHash(raw: string | null): raw is string {
  return !!raw && /^pkce_[0-9a-f]{40,64}$/.test(raw)
}

/**
 * Where the link should land: the `redirect_to` the sign-in asked for
 * (/auth/callback, /auth/desktop-callback, /reset-password) when it is on
 * this origin, else the page a link of this type lands on.
 */
export function emailLinkTarget(redirectTo: string | null, type: EmailOtpType, origin: string): URL {
  try {
    const target = new URL(redirectTo ?? '')
    if (target.origin === origin) {
      target.hash = ''
      return target
    }
  } catch {
    // Missing or not a URL: the default below.
  }
  return new URL(type === 'recovery' ? '/reset-password' : '/auth/callback', origin)
}

/**
 * Do what the browser did on supabase.co, from the server: Supabase's verify
 * endpoint spends the email's token and redirects to `target` with a PKCE
 * `?code=` (or `?error=…`). That code only works where the sign-in started,
 * with the verifier that browser (or the desktop's webview) kept, so a link
 * forwarded to someone else still can't sign them in. Returns the redirect,
 * without its fragment, or null when Supabase answered anything but a
 * redirect to `target` (an unlisted redirect falls back to the Site URL).
 */
export async function verifyRedirect(tokenHash: string, type: EmailOtpType, target: URL): Promise<URL | null> {
  const verify = new URL('/auth/v1/verify', process.env.NEXT_PUBLIC_SUPABASE_URL)
  verify.searchParams.set('token', tokenHash)
  verify.searchParams.set('type', type)
  verify.searchParams.set('redirect_to', target.toString())
  let response: Response
  try {
    response = await fetch(verify, {
      redirect: 'manual',
      cache: 'no-store',
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '' },
    })
  } catch (err) {
    console.error('[email-link] verify request failed:', err instanceof Error ? err.message : err)
    return null
  }
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
  if (!location) {
    console.error(`[email-link] verify answered ${response.status} without a redirect`)
    return null
  }
  let next: URL
  try {
    next = new URL(location, verify)
  } catch {
    return null
  }
  if (next.origin !== target.origin || next.pathname !== target.pathname) {
    console.error('[email-link] verify redirected somewhere other than the link\'s target (redirect URL not allowed?)')
    return null
  }
  // A PKCE link's result is in the query. A fragment would hold a non-PKCE
  // link's tokens, which never go to the browser from here.
  next.hash = ''
  return next
}
