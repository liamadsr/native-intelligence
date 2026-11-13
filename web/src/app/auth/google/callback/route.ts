import type { AuthError } from '@supabase/supabase-js'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient, isAuthorizedAdmin } from '@/lib/admin'
import { deepLinkPage, escapeHtml } from '@/lib/auth/deep-link-page'
import {
  GOOGLE_TRANSACTION_COOKIE,
  GOOGLE_TRANSACTION_PATH,
  exchangeGoogleCode,
  googleSignInClient,
  googleStateMatches,
  openGoogleTransaction,
  type GoogleSignInTransaction,
  type GoogleTokens,
} from '@/lib/auth/google-sign-in'
import { browserOrigin, postAuthRedirect } from '@/lib/auth/post-auth-redirect'
import { WORK_EMAIL_REQUIRED_ERROR_CODE, isWorkEmailRejection } from '@/lib/auth/work-email'
import { sessionTokenHash } from '@/lib/chatgpt/account'
import { createClient } from '@/lib/supabase/server'

/**
 * Finish "Sign in with Google" on nativeintelligence.dev (started by /auth/google):
 *   1. recover and consume the sealed transaction; refuse a missing, expired
 *      or mismatched one, and Google's own errors, before touching a code;
 *   2. exchange the code (PKCE) for Google's ID token;
 *   3. sign in with it (`signInWithIdToken`): Supabase verifies the token and
 *      signs in, links or creates the account as its Google provider would;
 *   4. finish: the web gets its session cookie here and follows the redirect
 *      cookies; the admin panel checks ADMIN_EMAILS; the desktop gets a
 *      one-time token on a dial8desktop:// deep link, bound to the sign-in
 *      sheet that started it (the session must live in its webview).
 * Failures go to /login?error=<code>, /admin/login?error=<code>, or back to
 * the app (desktop).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const sealed = request.cookies.get(GOOGLE_TRANSACTION_COOKIE)?.value
  const tx = openGoogleTransaction(sealed)
  if (!tx || !googleStateMatches(tx, params.get('state'))) {
    console.warn(
      `[google-sign-in] callback refused: ${!sealed ? 'no transaction cookie (started on another host?)' : !tx ? 'transaction expired or unreadable' : 'state mismatch'}`,
    )
    return fail(request, tx, 'auth_failed')
  }

  const oauthError = params.get('error')
  if (oauthError) return fail(request, tx, oauthError === 'access_denied' ? 'google_declined' : 'auth_failed')
  const code = params.get('code')
  if (!code) return fail(request, tx, 'missing_code')

  const client = googleSignInClient()
  if (!client) return fail(request, tx, 'auth_failed')

  let tokens: GoogleTokens
  try {
    tokens = await exchangeGoogleCode(client, code, tx)
  } catch (err) {
    console.error('[google-sign-in] code exchange failed:', err instanceof Error ? err.message : err)
    return fail(request, tx, 'auth_failed')
  }

  if (tx.mode === 'desktop') return finishDesktop(request, tx, tokens)

  const supabase = await createClient()
  const { data, error } = await signInWithGoogle(supabase.auth, tokens, tx)
  if (error || !data.user) return fail(request, tx, signInErrorCode(error))

  if (tx.mode === 'admin') {
    // Server-side admin allowlist check (ADMIN_EMAILS): the security gate.
    if (!isAuthorizedAdmin(data.user.email)) {
      // Local scope: drop only the session this sign-in just made.
      await supabase.auth.signOut({ scope: 'local' })
      return fail(request, tx, 'unauthorized_domain')
    }
    return finish(NextResponse.redirect(new URL('/admin', browserOrigin(request))))
  }

  return finish(postAuthRedirect(request, browserOrigin(request)))
}

/**
 * The desktop's session must be created in its webview, so the sign-in here
 * runs on a client that keeps nothing: it verifies the token and signs in,
 * links or creates the account, then its session is ended and the webview is
 * handed a one-time magic-link token for that account instead (as ChatGPT
 * sign-in does, src/lib/chatgpt/account.ts).
 */
async function finishDesktop(
  request: NextRequest,
  tx: GoogleSignInTransaction,
  tokens: GoogleTokens,
): Promise<NextResponse> {
  const verifier = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  )
  const { data, error } = await signInWithGoogle(verifier.auth, tokens, tx)
  if (error || !data.user) return fail(request, tx, signInErrorCode(error))
  const { error: signOutError } = await verifier.auth.signOut({ scope: 'local' })
  if (signOutError) console.warn('[google-sign-in] interim session not ended:', signOutError.message)
  // A magic link needs an address (an account with only a phone can't have one).
  if (!data.user.email) return fail(request, tx, 'auth_failed')

  const tokenHash = await sessionTokenHash(getServiceClient(), data.user.email)
  if (!tokenHash) return fail(request, tx, 'auth_failed')

  const deepLink = new URL('dial8desktop://auth/callback')
  deepLink.searchParams.set('token_hash', tokenHash)
  if (tx.bind) deepLink.searchParams.set('bind', tx.bind)
  return finish(
    new NextResponse(
      deepLinkPage({
        title: 'Signing in to Native Intelligence...',
        deepLink: deepLink.toString(),
        body: `<p>Signing you in to Native Intelligence...</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">You can close this window if the app doesn't open.</p>`,
      }),
      { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } },
    ),
  )
}

type GoogleAuth = Pick<ReturnType<typeof createStatelessClient>['auth'], 'signInWithIdToken'>

/** Supabase checks the ID token's signature, issuer, audience (its Google
 *  provider's client), expiry, `at_hash` against the access token, and the
 *  nonce: SHA-256 of the raw value we pass against the hash Google was sent. */
function signInWithGoogle(auth: GoogleAuth, tokens: GoogleTokens, tx: GoogleSignInTransaction) {
  return auth.signInWithIdToken({
    provider: 'google',
    token: tokens.idToken,
    access_token: tokens.accessToken,
    nonce: tx.nonce,
  })
}

/** A signup the work-email hook refused is named; anything else is generic. */
function signInErrorCode(error: AuthError | null): string {
  if (error) console.error('[google-sign-in] sign-in refused:', error.message)
  return isWorkEmailRejection(error?.message) ? WORK_EMAIL_REQUIRED_ERROR_CODE : 'auth_failed'
}

/** Clear the one-time transaction cookie on every outcome. */
function finish(response: NextResponse): NextResponse {
  response.cookies.set(GOOGLE_TRANSACTION_COOKIE, '', { path: GOOGLE_TRANSACTION_PATH, maxAge: 0 })
  return response
}

function fail(request: NextRequest, tx: GoogleSignInTransaction | null, error: string): NextResponse {
  if (tx?.mode === 'desktop') {
    const deepLink = new URL('dial8desktop://auth/callback')
    deepLink.searchParams.set('error', error)
    const loginUrl = new URL(`/login?error=${encodeURIComponent(error)}`, browserOrigin(request))
    return finish(
      new NextResponse(
        deepLinkPage({
          title: 'Sign-in failed',
          deepLink: deepLink.toString(),
          body: `<p>Sign-in didn't complete.</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">
      Return to Native Intelligence and try again, or
      <a href="${escapeHtml(loginUrl.toString())}" style="color: #60a5fa;">sign in on the web</a>.
    </p>`,
        }),
        { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } },
      ),
    )
  }
  const loginUrl = new URL(tx?.mode === 'admin' ? '/admin/login' : '/login', browserOrigin(request))
  loginUrl.searchParams.set('error', error)
  return finish(NextResponse.redirect(loginUrl))
}
