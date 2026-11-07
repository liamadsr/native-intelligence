import { NextResponse, type NextRequest } from 'next/server'
import { browserOrigin } from '@/lib/auth/post-auth-redirect'
import { chatGptClient, chatGptRedirectUri } from '@/lib/chatgpt/config'
import {
  BIND_PATTERN,
  TRANSACTION_COOKIE,
  TRANSACTION_TTL_SECONDS,
  authorizeUrl,
  createTransaction,
  sealTransaction,
} from '@/lib/chatgpt/oidc'

/**
 * Start "Continue with ChatGPT": one consent for sign-in and ChatGPT plan
 * usage (docs/plans/chatgpt-free-tier.md). Seals a one-time transaction into
 * an HttpOnly cookie and sends the browser to OpenAI; /auth/chatgpt/callback
 * finishes it.
 *
 *   /auth/chatgpt                      web sign-in
 *   /auth/chatgpt?desktop=1&bind=<hex> the desktop's sign-in sheet; finishes
 *                                      on a dial8desktop:// deep link
 */
export async function GET(request: NextRequest) {
  const client = chatGptClient()
  if (!client) return NextResponse.redirect(new URL('/login', browserOrigin(request)))

  const desktop = request.nextUrl.searchParams.get('desktop') === '1'
  const bind = request.nextUrl.searchParams.get('bind')
  if (desktop && !(bind && BIND_PATTERN.test(bind))) {
    return NextResponse.redirect(new URL('/login?error=auth_failed', browserOrigin(request)))
  }

  // The transaction cookie must be set on the host OpenAI calls back to, or
  // the callback can't read it. If the browser came in on another host (a
  // preview URL, or localhost when the registered callback is 127.0.0.1),
  // move it to the callback's origin first. The Host header is what the
  // browser used; nextUrl can't say (the dev server reports localhost).
  const redirectUri = chatGptRedirectUri(browserOrigin(request))
  const callbackUrl = new URL(redirectUri)
  const browserHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (browserHost && browserHost !== callbackUrl.host) {
    return NextResponse.redirect(`${callbackUrl.origin}/auth/chatgpt${request.nextUrl.search}`)
  }

  const tx = createTransaction(client, { desktop, bind, redirectUri })
  const response = NextResponse.redirect(authorizeUrl(client, tx))
  response.cookies.set(TRANSACTION_COOKIE, sealTransaction(tx), {
    httpOnly: true,
    secure: request.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: '/auth/chatgpt',
    maxAge: TRANSACTION_TTL_SECONDS,
  })
  return response
}
