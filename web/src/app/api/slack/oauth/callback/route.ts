/**
 * GET /api/slack/oauth/callback
 *
 * Where Slack sends the person back after "Add to Slack" (the redirect URL
 * listed in our Slack app's OAuth settings; src/lib/slack/install.ts starts
 * it). A web install is answered with a redirect to the page it began on, with
 * `?slack=<result>` (src/lib/slack/install-result.ts); a desktop install with
 * a deep link back to the app. Never Slack's own answer, never a stack trace.
 * A state that does not verify goes to the web page: nothing then says it
 * was a desktop one.
 *
 * ── Binding the finish to the start (web) ───────────────────────────────
 * The state must verify (signed, unexpired, a Slack install's), and this
 * browser must hold the install's binding cookie with the state's nonce
 * (`__Host-` in production): a state started by someone else can't be
 * finished in another person's browser. The person need not be signed in
 * here; the state names them, and completeSlackInstall checks they are still
 * an admin of the workspace it names.
 *
 * ── A desktop install ──────────────────────────────────────────────────
 * Started in the desktop app, it is finished in the person's system browser,
 * which holds none of the app's cookies, so this browser can't prove anything
 * and is never allowed to finish it. The code is not exchanged here: it is
 * sealed (only this server opens it, and only with the state's nonce;
 * src/lib/oauth/state.ts sealDesktopCode) and deep-linked back to the app
 * with the state (dial8desktop://slack/complete), or Slack's refusal as a
 * result (dial8desktop://slack/error). The window that started the install
 * claims it at /api/slack/oauth/claim with its claim secret and its session.
 *
 * ── An install that began on the app's other domain
 * The hosted app answers on two domains, and Slack knows one redirect URL.
 * When the state's signed origin (one of the app's page origins) is not the
 * one this request came to, Slack's answer is handed over to that domain's
 * callback, unspent, where the cookie is (as the other integrations'
 * callback does). `handed` marks an answer handed over once.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { bindingCookieOptions, readCookie, sealDesktopCode, secretsEqual, verifyOAuthState } from '@/lib/oauth/state'
import { requestOrigin } from '@/lib/security/same-origin'
import { SLACK_OAUTH_CALLBACK_PATH, SLACK_SETTINGS_PATH, appOrigin, slackConfigured } from '@/lib/slack/config'
import { slackInstallDeps } from '@/lib/slack/deps'
import { SLACK_INSTALL_CAPABILITY, SLACK_INSTALL_NONCE_COOKIE, completeSlackInstall, safeSlackReturnTo } from '@/lib/slack/install'
import { SLACK_INSTALL_RESULT_PARAM, type SlackInstallResult } from '@/lib/slack/install-result'

const HANDED_OVER = 'handed'

function back(result: SlackInstallResult, opts: { base?: string; path?: string; clearCookie?: boolean } = {}): NextResponse {
  const target = new URL(opts.path ?? SLACK_SETTINGS_PATH, opts.base ?? appOrigin())
  target.searchParams.set(SLACK_INSTALL_RESULT_PARAM, result)
  const response = NextResponse.redirect(target)
  // Spent either way: the cookie answers one install.
  if (opts.clearCookie) response.cookies.set(SLACK_INSTALL_NONCE_COOKIE(), '', bindingCookieOptions(0))
  return response
}

/** Back to the desktop app (the scheme its bundle registers), with the state the window that started it holds. */
function toDesktop(path: 'complete' | 'error', query: Record<string, string>): NextResponse {
  return NextResponse.redirect(`dial8desktop://slack/${path}?${new URLSearchParams(query).toString()}`)
}

export async function GET(request: Request) {
  if (!slackConfigured()) return back('unavailable')
  const url = new URL(request.url)

  const verified = verifyOAuthState(url.searchParams.get('state'))
  if (!verified.ok) return back(verified.error === 'state_expired' ? 'expired' : 'failed')
  const state = verified.data
  if (state.capability === SLACK_INSTALL_CAPABILITY && state.source === 'desktop') {
    const stateParam = url.searchParams.get('state')!
    const failed = (result: SlackInstallResult) => toDesktop('error', { error: result, state: stateParam })
    // A desktop state always carries the claim hash; one without it can't be
    // claimed by anyone, so refuse it here rather than hand back a dead code.
    if (!state.claim || !state.nonce || !state.userId || !state.workspaceId) return failed('failed')
    const error = url.searchParams.get('error')
    if (error) return failed(error === 'access_denied' ? 'denied' : 'failed')
    const code = url.searchParams.get('code')
    if (!code || code.length > 500) return failed('failed')
    // Never exchanged here, and no cookie read: sealed for the app's claim.
    return toDesktop('complete', { sealed: sealDesktopCode(code, state.nonce), state: stateParam })
  }
  if (state.capability !== SLACK_INSTALL_CAPABILITY || state.source !== 'web' || !state.nonce || !state.userId || !state.workspaceId) {
    return back('failed')
  }

  if (state.origin && !url.searchParams.has(HANDED_OVER) && state.origin !== requestOrigin(request)) {
    const there = new URL(SLACK_OAUTH_CALLBACK_PATH, state.origin)
    there.search = url.search
    there.searchParams.set(HANDED_OVER, '1')
    return NextResponse.redirect(there)
  }

  const home = { base: state.origin ?? appOrigin(), path: safeSlackReturnTo(state.returnTo) }
  if (!secretsEqual(readCookie(request.headers.get('cookie'), SLACK_INSTALL_NONCE_COOKIE()), state.nonce)) return back('session', home)

  const done = (result: SlackInstallResult) => back(result, { ...home, clearCookie: true })
  const error = url.searchParams.get('error')
  if (error) return done(error === 'access_denied' ? 'denied' : 'failed')
  const code = url.searchParams.get('code')
  if (!code || code.length > 500) return done('failed')

  const svc = getServiceClient()
  const result = await completeSlackInstall(svc, { code, userId: state.userId, workspaceId: state.workspaceId }, slackInstallDeps(svc))
  console.log('[slack/install]', { result })
  return done(result)
}
