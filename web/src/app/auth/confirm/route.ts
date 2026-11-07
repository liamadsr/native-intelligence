import { NextResponse, type NextRequest } from 'next/server'
import { emailLinkTarget, emailLinkType, isPkceTokenHash, verifyRedirect } from '@/lib/auth/email-link'
import { browserOrigin } from '@/lib/auth/post-auth-redirect'
import { createClient } from '@/lib/supabase/server'

/**
 * Where every Supabase Auth email links (src/lib/auth/email-link.ts). It does
 * the hop the browser used to make on supabase.co: Supabase's verify endpoint,
 * called from here, spends the token and answers with a redirect to the page
 * the sign-in asked for, carrying a PKCE code:
 *   /auth/callback?code=…          web sign-in, signup, invite, change email
 *   /auth/desktop-callback?code=…  the same from the desktop app, handed to it
 *   /reset-password                reset password, its code exchanged here
 * Those pages finish as they always have, with the verifier the starting
 * browser kept. Supabase's own failures (an expired or used link) arrive on
 * that page as `?error=`; a failure here sends `?error=auth_failed` there.
 * The verifier is what keeps a link working only where it was asked for:
 * someone else's link can't sign this browser into their account.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const tokenHash = params.get('token_hash')
  const type = emailLinkType(params.get('type'))
  const origin = browserOrigin(request)
  if (!isPkceTokenHash(tokenHash) || !type) {
    return NextResponse.redirect(new URL('/login?error=auth_failed', origin))
  }

  const target = emailLinkTarget(params.get('redirect_to'), type, origin)
  const next = await verifyRedirect(tokenHash, type, target)
  if (!next) {
    target.searchParams.set('error', 'auth_failed')
    return NextResponse.redirect(target)
  }
  if (type === 'recovery') return finishReset(next, origin)
  return NextResponse.redirect(next)
}

/**
 * /reset-password opens its form for whatever session the browser has, and a
 * reset code this browser can't redeem (opened somewhere other than where it
 * was asked for) fails there silently. So the code is exchanged here, with
 * this request's verifier cookie: the form opens only for the account the
 * link was for, and a failed link arrives as `?error=`, which keeps it shut.
 */
async function finishReset(next: URL, origin: string): Promise<NextResponse> {
  const resetPage = new URL('/reset-password', origin)
  const code = next.searchParams.get('code')
  if (!code) {
    resetPage.searchParams.set('error', next.searchParams.get('error_code') === 'otp_expired' ? 'link_expired' : 'auth_failed')
    return NextResponse.redirect(resetPage)
  }
  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    console.error('[auth-confirm] reset code refused:', error.code ?? error.message)
    resetPage.searchParams.set('error', 'auth_failed')
  }
  return NextResponse.redirect(resetPage)
}

/** Link previews and mail scanners send HEAD. Next would run GET for it,
 *  which spends the token before the person clicks. */
export function HEAD() {
  return new Response(null, { status: 204 })
}
