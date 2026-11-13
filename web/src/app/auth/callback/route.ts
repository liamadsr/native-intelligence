import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { authCallbackErrorCode } from '@/lib/auth/callback-error'
import { postAuthRedirect } from '@/lib/auth/post-auth-redirect'
import { joinByEmailDomainAtSignIn } from '@/lib/workspace-join/domain-join'

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
    return NextResponse.redirect(redirectUrl)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    redirectUrl.pathname = '/login'
    // An email link opened in a browser other than the one that asked for
    // it has no PKCE verifier here (src/app/auth/confirm/route.ts).
    redirectUrl.searchParams.set('error', error.code === 'pkce_code_verifier_not_found' ? 'other_browser' : 'auth_failed')
    return NextResponse.redirect(redirectUrl)
  }

  // NOTE: signup/login event tracking is NOT done here. It lives in the
  // authenticated account layout/onboarding page (see lib/posthog
  // `trackAuthSession`), the one choke-point every auth method passes through —
  // including password logins that never reach this OAuth-only callback.

  // Auto-join by email domain (src/lib/workspace-join/domain-join.ts): one
  // indexed lookup, and a brand-new account lands in its team's workspace.
  // Never fails the sign-in.
  await joinByEmailDomainAtSignIn(data?.user)

  // Invite, share-link or MCP redirect cookie, else /account.
  return postAuthRedirect(request)
}
