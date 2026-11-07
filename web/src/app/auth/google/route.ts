import { NextResponse, type NextRequest } from 'next/server'
import { browserOrigin } from '@/lib/auth/post-auth-redirect'
import { BIND_PATTERN } from '@/lib/chatgpt/oidc'
import {
  GOOGLE_TRANSACTION_COOKIE,
  GOOGLE_TRANSACTION_PATH,
  GOOGLE_TRANSACTION_TTL_SECONDS,
  createGoogleTransaction,
  googleAuthorizeUrl,
  googleRedirectUri,
  googleSignInClient,
  sealGoogleTransaction,
  type GoogleSignInMode,
} from '@/lib/auth/google-sign-in'

/**
 * Start "Sign in with Google" on dial8.ai (src/lib/auth/google-sign-in.ts).
 * Seals a one-time transaction into an HttpOnly cookie and sends the browser
 * to Google; /auth/google/callback finishes it.
 *
 *   /auth/google                       web sign-in
 *   /auth/google?desktop=1&bind=<hex>  the desktop's sign-in sheet; finishes
 *                                      on a dial8desktop:// deep link
 *   /auth/google?admin=1               the admin panel (/admin/login)
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const mode: GoogleSignInMode =
    params.get('desktop') === '1' ? 'desktop' : params.get('admin') === '1' ? 'admin' : 'web'
  const loginPath = mode === 'admin' ? '/admin/login' : '/login'

  const client = googleSignInClient()
  if (!client) return NextResponse.redirect(new URL(loginPath, browserOrigin(request)))

  const bind = params.get('bind')
  if (mode === 'desktop' && !(bind && BIND_PATTERN.test(bind))) {
    return NextResponse.redirect(new URL(`${loginPath}?error=auth_failed`, browserOrigin(request)))
  }

  // The transaction cookie must be set on the host Google calls back to, or
  // the callback can't read it. If the browser came in on another host (a
  // preview URL, or www), move it to the callback's origin first. The Host
  // header is what the browser used; nextUrl can't say (the dev server
  // reports localhost).
  const redirectUri = googleRedirectUri(browserOrigin(request))
  const callbackUrl = new URL(redirectUri)
  const browserHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (browserHost && browserHost !== callbackUrl.host) {
    return NextResponse.redirect(`${callbackUrl.origin}${GOOGLE_TRANSACTION_PATH}${request.nextUrl.search}`)
  }

  const tx = createGoogleTransaction({ mode, bind, redirectUri })
  const response = NextResponse.redirect(googleAuthorizeUrl(client, tx))
  response.cookies.set(GOOGLE_TRANSACTION_COOKIE, sealGoogleTransaction(tx), {
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: GOOGLE_TRANSACTION_PATH,
    maxAge: GOOGLE_TRANSACTION_TTL_SECONDS,
  })
  return response
}
