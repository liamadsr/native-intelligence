import { NextResponse, type NextRequest } from 'next/server'
import { authCallbackErrorCode } from '@/lib/auth/callback-error'
import { deepLinkPage as callbackPage, escapeHtml } from '@/lib/auth/deep-link-page'
import { RESET_TYPE } from '@/lib/auth/password-reset'

/**
 * Auth callback for the Tauri desktop app.
 * Passes the OAuth code to the Tauri app via deep link so the
 * webview's client-side Supabase can exchange it for a session.
 *
 * A password reset asked for in the app comes back here too, marked
 * `type=recovery` by /auth/confirm (src/lib/auth/password-reset.ts): the deep
 * link carries the mark, so the app opens its reset page, and this page says
 * what's happening in reset words.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const reset = searchParams.get('type') === RESET_TYPE

  if (!code) {
    // Hand the failure (e.g. a Google signup refused by the work-email hook)
    // back to the app as `dial8desktop://auth/callback?error=`. The desktop's
    // sign-in sheet (a web authentication session) completes on that URL and
    // the login form shows the message; a sheet left on a web login page
    // would be a dead end. The page itself also says what happened, with a
    // link to the web login, for a sign-in that ran in a regular browser.
    const errorCode = authCallbackErrorCode(searchParams)
    const deepLink = new URL('dial8desktop://auth/callback')
    deepLink.searchParams.set('error', errorCode)
    if (reset) {
      deepLink.searchParams.set('type', RESET_TYPE)
      const forgotUrl = new URL('/forgot-password', request.url)
      return htmlPage(
        callbackPage({
          title: "Reset link didn't work",
          deepLink: deepLink.toString(),
          body: `<p>${errorCode === 'link_expired' ? 'This reset link has expired or has already been used.' : "This reset link didn't work."}</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">
      Return to Native Intelligence and ask for a new one, or
      <a href="${escapeHtml(forgotUrl.toString())}" style="color: #60a5fa;">reset your password here</a>.
    </p>`,
        }),
      )
    }
    const loginUrl = new URL(`/login?error=${errorCode}`, request.url)
    return htmlPage(
      callbackPage({
        title: 'Sign-in failed',
        deepLink: deepLink.toString(),
        body: `<p>Sign-in didn't complete.</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">
      Return to Native Intelligence and try again, or
      <a href="${escapeHtml(loginUrl.toString())}" style="color: #60a5fa;">sign in on the web</a>.
    </p>`,
      }),
    )
  }

  // Pass the code to the Tauri app via deep link.
  // The webview will exchange it client-side so the session lives in the correct context.
  const deepLink = new URL('dial8desktop://auth/callback')
  deepLink.searchParams.set('code', code)
  if (reset) deepLink.searchParams.set('type', RESET_TYPE)

  // Return an HTML page that redirects to the deep link.
  // We can't do a 302 redirect to a custom scheme, so we use JS + meta refresh.
  const clickHere = `<a href="${escapeHtml(deepLink.toString())}" style="color: #60a5fa;">click here</a>`
  return htmlPage(
    reset
      ? callbackPage({
          title: 'Opening Native Intelligence...',
          deepLink: deepLink.toString(),
          body: `<p>Opening Native Intelligence so you can set a new password...</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">
      If the app doesn't open, ${clickHere}.
      This link only works on the computer where you asked for it.
    </p>`,
        })
      : callbackPage({
          title: 'Signing in to Native Intelligence...',
          deepLink: deepLink.toString(),
          body: `<p>Signing you in to Native Intelligence...</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">
      If the app doesn't open automatically, ${clickHere}.
    </p>`,
        }),
  )
}

function htmlPage(html: string): NextResponse {
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html' } })
}
