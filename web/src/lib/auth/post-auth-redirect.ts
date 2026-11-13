import { NextResponse, type NextRequest } from 'next/server'
import { accountRedirectTarget, isInviteRedirectPath, mcpRedirectTarget } from '@/lib/auth/login-redirect'

/**
 * Where a successful web sign-in lands, shared by the OAuth callbacks
 * (/auth/callback for Supabase's providers, /auth/chatgpt/callback for
 * ChatGPT). The login form leaves one of these cookies when it was reached
 * with `?redirect=`; each is honoured only for its own path family and
 * cleared on use:
 *   invite_redirect  /invite/<token>, or an agent link's /link/<token>
 *   share_redirect   /s/<token>
 *   mcp_redirect     /api/mcp/… or /mcp/… on this origin (full URL or
 *                    path), the MCP OAuth authorize step to resume
 *   account_redirect a page of the app with its deep link (/account?…), such
 *                    as the Studio export the desktop app sent the person
 *                    here to download
 * Anything else, or no cookie, lands on /account.
 *
 * `origin` is where relative targets resolve; it defaults to the request's
 * own (pass browserOrigin() where the dev server's reported origin differs
 * from the host the browser used).
 */
export function postAuthRedirect(request: NextRequest, origin: string = request.nextUrl.origin): NextResponse {
  // The account redirect is for this sign-in only: whichever way it ends, it never waits for the next one.
  return dropAccountRedirect(chooseRedirect(request, origin))
}

/** The cookie the login form leaves for a page of the app to return to (/login?redirect=/account…). */
export const ACCOUNT_REDIRECT_COOKIE = 'account_redirect'

/**
 * Clear the account redirect on a sign-in's way out, done or failed: a cookie left behind would send a later
 * sign-in in this browser to an old deep link (one that downloads an export, say).
 */
export function dropAccountRedirect<R extends NextResponse>(response: R): R {
  response.cookies.delete(ACCOUNT_REDIRECT_COOKIE)
  return response
}

function chooseRedirect(request: NextRequest, origin: string): NextResponse {
  const redirectUrl = new URL(request.nextUrl.pathname, origin)

  const inviteRedirect = request.cookies.get('invite_redirect')?.value
  if (inviteRedirect) {
    const decoded = decodeURIComponent(inviteRedirect)
    if (isInviteRedirectPath(decoded)) {
      redirectUrl.pathname = decoded
      redirectUrl.search = ''
      const response = NextResponse.redirect(redirectUrl)
      response.cookies.delete('invite_redirect')
      return response
    }
    const response = NextResponse.redirect(new URL('/account', origin))
    response.cookies.delete('invite_redirect')
    return response
  }

  // Share-link redirect cookie (restricted to /s/{token} paths only).
  // Set when a reader clicks "Create an account to comment" on a shared page;
  // after auth completes we drop them back onto the shared view.
  const shareRedirect = request.cookies.get('share_redirect')?.value
  if (shareRedirect) {
    const decoded = decodeURIComponent(shareRedirect)
    if (decoded.startsWith('/s/') && !decoded.includes('//')) {
      redirectUrl.pathname = decoded
      redirectUrl.search = ''
      const response = NextResponse.redirect(redirectUrl)
      response.cookies.delete('share_redirect')
      return response
    }
    const response = NextResponse.redirect(new URL('/account', origin))
    response.cookies.delete('share_redirect')
    return response
  }

  // MCP OAuth redirect cookie (full URL or path to /api/mcp/ or /mcp/), on
  // this origin only: the cookie comes from `/login?redirect=`, which anyone
  // can link to (src/lib/auth/login-redirect.ts). Read as Next's cookie
  // parser decoded it, once: a second decode would turn the authorize query's
  // own escapes (`%2B`, `%26`, `%23`) into the characters they stand for.
  const mcpRedirect = request.cookies.get('mcp_redirect')?.value
  if (mcpRedirect) {
    const target = mcpRedirectTarget(mcpRedirect, origin)
    if (target) {
      const response = NextResponse.redirect(new URL(target, origin))
      response.cookies.delete('mcp_redirect')
      return response
    }
    const response = NextResponse.redirect(new URL('/account', origin))
    response.cookies.delete('mcp_redirect')
    return response
  }

  // A page of the app (/account and its deep links), same-site only.
  const accountRedirect = request.cookies.get(ACCOUNT_REDIRECT_COOKIE)?.value
  if (accountRedirect) return NextResponse.redirect(new URL(accountRedirectTarget(accountRedirect) ?? '/account', origin))

  redirectUrl.pathname = '/account'
  redirectUrl.search = ''
  return NextResponse.redirect(redirectUrl)
}

/**
 * The origin the browser actually used: X-Forwarded-Host / Host, with the
 * request's scheme. `request.nextUrl` can't be trusted for this in local dev
 * (the dev server reports localhost even for 127.0.0.1), and the ChatGPT
 * flow's cookies live on the browser's host.
 */
export function browserOrigin(request: NextRequest): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (!host) return request.nextUrl.origin
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(/:$/, '')
  return `${proto}://${host}`
}
