import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { deepLinkPage, escapeHtml } from '@/lib/auth/deep-link-page'
import { browserOrigin, dropAccountRedirect, postAuthRedirect } from '@/lib/auth/post-auth-redirect'
import { resolveChatGptAccount, sessionTokenHash } from '@/lib/chatgpt/account'
import { DYNAMIC_CLIENT_ID, chatGptClient } from '@/lib/chatgpt/config'
import { saveConnection } from '@/lib/chatgpt/connection'
import {
  TRANSACTION_COOKIE,
  exchangeClientId,
  exchangeCode,
  openTransaction,
  stateMatches,
  verifyIdToken,
  type SignInTransaction,
} from '@/lib/chatgpt/oidc'
import { createClient } from '@/lib/supabase/server'

/**
 * Finish "Continue with ChatGPT" (started by /auth/chatgpt):
 *   1. recover and consume the sealed transaction; refuse a missing, expired
 *      or mismatched one, and OpenAI's own errors, before touching a code;
 *   2. exchange the code (with `resource`, which plan usage requires) and
 *      verify the ID token;
 *   3. find, link or create the Native Intelligence account (src/lib/chatgpt/account.ts)
 *      and store the encrypted connection;
 *   4. sign in: the web gets its session cookie here; the desktop gets a
 *      one-time token on a dial8desktop:// deep link, bound to the sign-in
 *      sheet that started it.
 * Failures go to /login?error=<code> (web) or back to the app (desktop).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const sealed = request.cookies.get(TRANSACTION_COOKIE)?.value
  const tx = openTransaction(sealed)
  if (!tx || !stateMatches(tx, params.get('state'))) {
    console.warn(
      `[chatgpt] callback refused: ${!sealed ? 'no transaction cookie (started on another host?)' : !tx ? 'transaction expired or unreadable' : 'state mismatch'}`,
    )
    return fail(request, tx, 'auth_failed')
  }

  const oauthError = params.get('error')
  if (oauthError) return fail(request, tx, oauthError === 'access_denied' ? 'chatgpt_declined' : 'auth_failed')
  const code = params.get('code')
  if (!code) return fail(request, tx, 'missing_code')

  const client = chatGptClient()
  const clientId = exchangeClientId(tx, params.get('client_id'))
  if (!client || !clientId) return fail(request, tx, 'auth_failed')
  if (tx.clientId === DYNAMIC_CLIENT_ID) {
    console.info(
      `[chatgpt] registered OpenAI self-serve client ${clientId}; set CHATGPT_CLIENT_ID=${clientId} so later sign-ins reuse it`,
    )
  }

  let identity, tokens
  try {
    tokens = await exchangeCode(client, clientId, code, tx)
    if (!tokens.idToken) return fail(request, tx, 'auth_failed')
    identity = await verifyIdToken(tokens.idToken, clientId, tx.nonce)
  } catch (err) {
    console.error('[chatgpt] sign-in could not be verified:', err instanceof Error ? err.message : err)
    return fail(request, tx, 'auth_failed')
  }

  const service = getServiceClient()
  const account = await resolveChatGptAccount(service, identity)
  if (!account.ok) return fail(request, tx, account.error)
  try {
    await saveConnection(service, { userId: account.userId, identity, clientId, tokens })
  } catch (err) {
    console.error('[chatgpt] connection not saved:', err instanceof Error ? err.message : err)
    return fail(request, tx, 'auth_failed')
  }

  const tokenHash = await sessionTokenHash(service, account.email)
  if (!tokenHash) return fail(request, tx, 'auth_failed')

  if (tx.desktop) {
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

  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (error) {
    console.error('[chatgpt] session not created:', error.message)
    return fail(request, tx, 'auth_failed')
  }
  return finish(postAuthRedirect(request, browserOrigin(request)))
}

/** Clear the one-time transaction cookie, and the account redirect (post-auth-redirect.ts), on every outcome. */
function finish(response: NextResponse): NextResponse {
  response.cookies.set(TRANSACTION_COOKIE, '', { path: '/auth/chatgpt', maxAge: 0 })
  return dropAccountRedirect(response)
}

function fail(request: NextRequest, tx: SignInTransaction | null, error: string): NextResponse {
  if (tx?.desktop) {
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
  const loginUrl = new URL('/login', browserOrigin(request))
  loginUrl.searchParams.set('error', error)
  return finish(NextResponse.redirect(loginUrl))
}
