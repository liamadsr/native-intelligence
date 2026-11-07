import { NextResponse, type NextRequest } from 'next/server'
import { authCallbackErrorCode } from '@/lib/auth/callback-error'
import { deepLinkPage as callbackPage, escapeHtml } from '@/lib/auth/deep-link-page'

/**
 * Auth callback for the Tauri desktop app.
 * Passes the OAuth code to the Tauri app via deep link so the
 * webview's client-side Supabase can exchange it for a session.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')

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
    const loginUrl = new URL(`/login?error=${errorCode}`, request.url)
    return new NextResponse(
      callbackPage({
        title: 'Sign-in failed',
        deepLink: deepLink.toString(),
        body: `<p>Sign-in didn't complete.</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">
      Return to Dial8 and try again, or
      <a href="${escapeHtml(loginUrl.toString())}" style="color: #60a5fa;">sign in on the web</a>.
    </p>`,
      }),
      { headers: { 'Content-Type': 'text/html' } },
    )
  }

  // Pass the code to the Tauri app via deep link.
  // The webview will exchange it client-side so the session lives in the correct context.
  const deepLink = new URL('dial8desktop://auth/callback')
  deepLink.searchParams.set('code', code)

  // Return an HTML page that redirects to the deep link.
  // We can't do a 302 redirect to a custom scheme, so we use JS + meta refresh.
  const html = callbackPage({
    title: 'Signing in to Dial8...',
    deepLink: deepLink.toString(),
    body: `<p>Signing you in to Dial8...</p>
    <p style="color: #888; font-size: 14px; margin-top: 8px;">
      If the app doesn't open automatically,
      <a href="${escapeHtml(deepLink.toString())}" style="color: #60a5fa;">click here</a>.
    </p>`,
  })

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html' },
  })
}
