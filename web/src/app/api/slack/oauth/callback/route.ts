/**
 * GET /api/slack/oauth/callback
 *
 * Where Slack sends the person back after "Add to Slack" (the redirect URL
 * listed in our Slack app's OAuth settings; src/lib/slack/install.ts starts
 * it). Always answers with a redirect to the page the install began on, with
 * `?slack=<result>` (src/lib/slack/install-result.ts): never Slack's own
 * answer, never a stack trace.
 *
 * ── Binding the finish to the start ─────────────────────────────────────
 * The state must verify (signed, unexpired, a Slack install's), and this
 * browser must hold the install's binding cookie with the state's nonce
 * (`__Host-` in production): a state started by someone else can't be
 * finished in another person's browser. The person need not be signed in
 * here; the state names them, and completeSlackInstall checks they are still
 * an admin of the workspace it names.
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
import { bindingCookieOptions, readCookie, secretsEqual, verifyOAuthState } from '@/lib/oauth/state'
import { requestOrigin } from '@/lib/security/same-origin'
import { saveSlackBotToken, slackOauthAccess } from '@/lib/slack/bot-token'
import { SLACK_OAUTH_CALLBACK_PATH, SLACK_SETTINGS_PATH, appOrigin, slackConfigured, slackRedirectUri } from '@/lib/slack/config'
import { SLACK_INSTALL_CAPABILITY, SLACK_INSTALL_NONCE_COOKIE, completeSlackInstall, safeSlackReturnTo } from '@/lib/slack/install'
import { SLACK_INSTALL_RESULT_PARAM, type SlackInstallResult } from '@/lib/slack/install-result'
import { slackApi, type SlackAuthTest, type SlackTeamInfo, type SlackUserInfo } from '@/lib/slack/web-api'

const HANDED_OVER = 'handed'

function back(result: SlackInstallResult, opts: { base?: string; path?: string; clearCookie?: boolean } = {}): NextResponse {
  const target = new URL(opts.path ?? SLACK_SETTINGS_PATH, opts.base ?? appOrigin())
  target.searchParams.set(SLACK_INSTALL_RESULT_PARAM, result)
  const response = NextResponse.redirect(target)
  // Spent either way: the cookie answers one install.
  if (opts.clearCookie) response.cookies.set(SLACK_INSTALL_NONCE_COOKIE(), '', bindingCookieOptions(0))
  return response
}

export async function GET(request: Request) {
  if (!slackConfigured()) return back('unavailable')
  const url = new URL(request.url)

  const verified = verifyOAuthState(url.searchParams.get('state'))
  if (!verified.ok) return back(verified.error === 'state_expired' ? 'expired' : 'failed')
  const state = verified.data
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
  const result = await completeSlackInstall(
    svc,
    { code, userId: state.userId, workspaceId: state.workspaceId },
    {
      exchange: (c) => slackOauthAccess({ code: c, redirect_uri: slackRedirectUri() }),
      saveToken: (input) => saveSlackBotToken(svc, input),
      slack: {
        authTest: (token) => slackApi<SlackAuthTest>('auth.test', token, {}),
        teamInfo: (token) => slackApi<SlackTeamInfo>('team.info', token, {}),
        userInfo: (token, user) => slackApi<SlackUserInfo>('users.info', token, { user }),
      },
    },
  )
  console.log('[slack/install]', { result })
  return done(result)
}
