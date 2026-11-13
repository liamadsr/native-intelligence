import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { authCallbackErrorCode } from '@/lib/auth/callback-error'
import { dropAccountRedirect, postAuthRedirect } from '@/lib/auth/post-auth-redirect'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')

  const redirectUrl = request.nextUrl.clone()

  if (!code) {
    // Supabase sends provider/hook failures back here as ?error=... instead
    // of a code. The one we care to name is the work-email signup refusal.
    redirectUrl.pathname = '/login'
    redirectUrl.search = ''
    redirectUrl.searchParams.set('error', authCallbackErrorCode(searchParams))
    return dropAccountRedirect(NextResponse.redirect(redirectUrl))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    redirectUrl.pathname = '/login'
    // An email link opened in a browser other than the one that asked for
    // it has no PKCE verifier here (src/app/auth/confirm/route.ts).
    redirectUrl.searchParams.set('error', error.code === 'pkce_code_verifier_not_found' ? 'other_browser' : 'auth_failed')
    return dropAccountRedirect(NextResponse.redirect(redirectUrl))
  }

  // NOTE: signup/login event tracking is NOT done here. It lives in the
  // authenticated account layout/onboarding page (see lib/posthog
  // `trackAuthSession`), the one choke-point every auth method passes through —
  // including password logins that never reach this OAuth-only callback.

  // Invite, share-link or MCP redirect cookie, else /account.
  return postAuthRedirect(request)
}
