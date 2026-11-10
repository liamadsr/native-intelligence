import { NextResponse } from 'next/server'
import { isValidProvider, isValidCapability, type OAuthCapability } from '@/lib/oauth/config'
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_TTL_MS,
  bindingCookieOptions,
  readCookie,
  sealDesktopCode,
  secretsEqual,
  verifyOAuthState,
} from '@/lib/oauth/state'
import { completeOAuthConnect } from '@/lib/oauth/complete-connect'
import { handleTextConnectCallback } from '@/lib/links/text-connect-callback'
import { confirmTextConnect } from '@/lib/links/oauth-link'
import { getServiceClient } from '@/lib/supabase/service'
import { requestOrigin } from '@/lib/security/same-origin'

/**
 * GET /api/oauth/[provider]/callback — where the provider sends the person
 * back after consent.
 *
 * ── Binding the completer to the initiator (security review 2026-10-31, P0-2)
 * NO callback may store tokens for a user_id unless the completion is provably
 * bound to the person who started the flow. The signed state alone is NOT
 * enough: an attacker can mint a valid signed authUrl for their own user_id
 * and send the consent link to a victim, whose provider tokens would then land
 * under the attacker's account.
 *
 *   WEB: the authorize fetch and this callback land in the SAME browser, which
 *   carries the single-use nonce cookie the authorize route set (`__Host-` in
 *   production, so no subdomain can plant one). The callback requires it to
 *   equal the state's nonce, then exchanges and stores. A matching session no
 *   longer stands in for it (a subdomain could toss its owner's session).
 *
 *   DESKTOP: the authorize fetch runs in the app's webview, but this callback
 *   arrives in the SYSTEM browser, a different cookie jar with neither signal.
 *   So the callback NEVER exchanges a desktop code. It deep-links the code,
 *   sealed so only this server can open it, and the state back to the app
 *   (dial8desktop://oauth/complete), and the claim route
 *   (/api/oauth/[provider]/claim) exchanges it only for a caller signed in as
 *   state.user_id who presents the claim secret whose hash the state carries —
 *   a secret only the initiating window ever held. In the attack the code
 *   lands on the victim's machine, which has neither the attacker's secret nor
 *   the attacker's session.
 *
 *   TEXT: a connect started from a texted single-use link (state `via:
 *   'text'`, src/lib/links/oauth-link.ts) is a web flow in the phone's
 *   browser, bound to THAT browser by the nonce cookie the link's POST set.
 *   It chains its next leg and confirms in the text thread
 *   (src/lib/links/text-connect-callback.ts), and lands on /l/done. Here the
 *   initiator is whoever holds the link, so the link itself is the binding:
 *   only the server ever sends one, only to the account's verified number
 *   (never to the model, a web chat or MCP), once, for 15 minutes; the page
 *   names the masked number before its button; and the connected address is
 *   emailed which Native Intelligence account it joined. A link the owner forwards still
 *   connects whoever taps it: the residual risk this design accepts
 *   (roadmap track A, 2026-11-01), for the founder to weigh.
 *
 * Every state carries a signed `exp` (10 minutes); an expired state is refused.
 *
 * ── A connect that began on the app's other domain
 * The hosted app answers on two domains while it moves (src/lib/app-url.ts),
 * and each provider knows ONE callback, on the app's address. A web connect
 * that began on the other domain has its nonce cookie and its opener there,
 * so this route would refuse it. Its state says where it began (`origin`,
 * signed, one of the app's page origins), and the provider's answer is handed
 * over to that domain's callback, unspent, which finishes it as usual. The
 * redirect_uri sent to the provider is the same on both, so the exchange
 * still matches. `handed` marks an answer that has been handed over once.
 */
const HANDED_OVER = 'handed'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  const verified = verifyOAuthState(url.searchParams.get('state'))
  if (!verified.ok) {
    // source/return_to aren't trustworthy without a verified state: the web page.
    const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const qs = new URLSearchParams({ provider, error: verified.error })
    return NextResponse.redirect(`${base}/account/settings/connectors?${qs}`)
  }
  const state = verified.data
  const source = state.source
  const userId = state.userId
  const capability: OAuthCapability = state.capability && isValidCapability(state.capability) ? state.capability : 'calendar'

  if (source === 'web' && state.origin && !url.searchParams.has(HANDED_OVER) && state.origin !== requestOrigin(req)) {
    const there = new URL(`/api/oauth/${encodeURIComponent(provider)}/callback`, state.origin)
    there.search = url.search
    there.searchParams.set(HANDED_OVER, '1')
    return NextResponse.redirect(there)
  }

  function buildRedirect(path: string, query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString()
    if (source === 'web') {
      // Back to the page it began on: the app's address, or its other domain (state.origin).
      const base = state.origin ?? (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')
      // Honour return_to if set (e.g. from onboarding), validating it's a relative path
      const webPath =
        state.returnTo && state.returnTo.startsWith('/') && !state.returnTo.includes('//')
          ? state.returnTo
          : '/account/settings/connectors'
      return NextResponse.redirect(`${base}${webPath}?${qs}`)
    }
    // Desktop (Tauri): back to the app by deep link. Must use dial8desktop://,
    // the scheme registered in tauri.conf.json.
    return NextResponse.redirect(`dial8desktop://${path}?${qs}`)
  }

  if (!state.nonce) {
    return buildRedirect('oauth/error', { provider, error: 'csrf_validation_failed' })
  }

  if (state.via === 'text') {
    const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const text = await handleTextConnectCallback(
      { provider, code, error, state, cookieNonce: readCookie(req.headers.get('cookie'), OAUTH_NONCE_COOKIE()) },
      {
        complete: completeOAuthConnect,
        confirm: (args) => confirmTextConnect(getServiceClient(), args),
      },
    )
    const response = NextResponse.redirect(text.redirect.startsWith('/') ? `${base}${text.redirect}` : text.redirect)
    // The next leg's nonce, or cleared when the flow ended; left alone when the binding failed.
    if (text.nonce !== undefined) response.cookies.set(OAUTH_NONCE_COOKIE(), text.nonce ?? '', bindingCookieOptions(text.nonce ? Math.floor(OAUTH_STATE_TTL_MS / 1000) : 0))
    return response
  }

  if (error) {
    return buildRedirect('oauth/error', { provider, error })
  }

  if (!code || !isValidProvider(provider)) {
    return buildRedirect('oauth/error', { provider, error: 'invalid_request' })
  }

  if (!userId) {
    return buildRedirect('oauth/error', { provider, error: 'no_user_id' })
  }

  if (source === 'desktop') {
    // A desktop state always carries the claim hash; one without it can't be
    // claimed by anyone, so refuse it here rather than hand back a dead code.
    if (!state.claim) {
      return buildRedirect('oauth/error', { provider, error: 'csrf_validation_failed' })
    }
    // Hand the code back to the app UNEXCHANGED and SEALED: only this server
    // can open it (lib/oauth/state.ts sealDesktopCode), and only the claim
    // route will, for the claim secret and the initiator's session.
    return buildRedirect('oauth/complete', {
      provider,
      capability,
      sealed: sealDesktopCode(code, state.nonce),
      state: url.searchParams.get('state')!,
    })
  }

  // WEB: the completing browser must be the one that started the flow: its
  // single-use nonce cookie (`__Host-` in production, so no subdomain can
  // plant one; lib/oauth/state.ts bindingCookieName). A matching session does
  // not stand in for it: a subdomain could toss its owner's session cookie.
  if (!secretsEqual(readCookie(req.headers.get('cookie'), OAUTH_NONCE_COOKIE()), state.nonce)) {
    return buildRedirect('oauth/error', { provider, error: 'csrf_validation_failed' })
  }

  const result = await completeOAuthConnect({
    provider,
    code,
    userId,
    capability,
    stateWorkspaceId: state.workspaceId,
    stateNonce: state.nonce,
  })
  if (!result.ok) {
    return buildRedirect('oauth/error', { provider, error: result.error })
  }

  const successResponse = buildRedirect('oauth/success', {
    integration_success: 'true',
    provider: result.provider,
    capability: result.capability,
    email: result.email,
  })
  // Clear the nonce cookie
  successResponse.cookies.set(OAUTH_NONCE_COOKIE(), '', bindingCookieOptions(0))
  return successResponse
}
