/**
 * Adding our Slack app to a Slack workspace: Slack's OAuth v2 install, run by
 * this app.
 *
 * Start ({@link buildSlackInstall}, POST /api/account/integrations/slack/install):
 * a workspace admin gets Slack's authorize URL, with our client id, the bot
 * scopes (config.ts SLACK_BOT_SCOPES), our redirect URI and a `state` signed
 * like every other integration's (src/lib/oauth/state.ts: HMAC, ten minutes,
 * `capability: 'slack_install'` so no other flow's state is taken here). The
 * state names who started it (user, workspace), the page to return to, and
 * the hosted origin it began on. Its nonce goes in a `__Host-` binding cookie
 * ({@link SLACK_INSTALL_NONCE_COOKIE}), which the callback requires: a state
 * someone else started can't be completed in another person's browser.
 *
 * Finish ({@link completeSlackInstall}, GET /api/slack/oauth/callback, after the
 * route checked the state and the cookie): the starter must still be an admin
 * of the workspace; the code is exchanged at oauth.v2.access; Slack's answer
 * must be ok, for OUR app, a bot token, for one team, and not an
 * organization-wide install (refused). The token is stored (./bot-token.ts),
 * and then the team is bound to the starter's workspace under the same rules
 * as a link code's binding (./inbound.ts redeemCode, ./store.ts
 * bindInstallation):
 *   - a team live in ANOTHER workspace stays there ('other_workspace');
 *   - a team live in THIS workspace is re-bound (its name, its bot user);
 *   - a new or disconnected team is bound only when the Slack user who ran
 *     the install is an admin or owner of that Slack workspace (an admin act
 *     on both sides, as with a code). Otherwise the app is in their Slack
 *     ('added') and a Slack admin finishes it: by adding it again from
 *     Settings, or by sending the bot their code.
 * The Slack user who ran the install, a member of that team, is linked to
 * the starter, as their code would have linked them.
 */
import 'server-only'
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { connectHomeOrigin } from '@/lib/oauth/authorize-url'
import { OAUTH_STATE_TTL_MS, bindingCookieName, oauthStateSecret } from '@/lib/oauth/state'
import type { SaveSlackBotTokenInput, SlackOAuthGrant } from './bot-token'
import { SLACK_BOT_SCOPES, SLACK_SETTINGS_PATH, slackAppId, slackClientId, slackRedirectUri } from './config'
import type { SlackInstallResult } from './install-result'
import { INSTALLING_ROLES, bindInstallation, getInstallation, linkSlackUser, memberRole } from './store'
import { slackUserName, type SlackApiResult, type SlackAuthTest, type SlackTeamInfo, type SlackUserInfo } from './web-api'

/** The `capability` a Slack install's state carries; the callback takes no other. */
export const SLACK_INSTALL_CAPABILITY = 'slack_install'

/** The install's binding cookie: the browser that started it holds the state's nonce. */
export const SLACK_INSTALL_NONCE_COOKIE = () => bindingCookieName('slack_install_nonce')

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'

/**
 * The page to return to: a path in the app's own account area, else Slack's
 * settings page. Never another origin.
 */
export function safeSlackReturnTo(value: unknown): string {
  if (typeof value !== 'string') return SLACK_SETTINGS_PATH
  const path = value.trim()
  if (path.length > 300 || !/^\/account\/[A-Za-z0-9/_-]*$/.test(path) || path.includes('//')) return SLACK_SETTINGS_PATH
  return path
}

export interface SlackInstallStart {
  url: string
  state: string
  /** Set as {@link SLACK_INSTALL_NONCE_COOKIE}. */
  nonce: string
}

/**
 * The signed state and Slack's authorize URL for one install. Throws when
 * Slack is not configured, or the state secret is missing in production.
 */
export function buildSlackInstall(args: {
  userId: string
  workspaceId: string
  returnTo?: string | null
  pageOrigin?: string | null
  now?: number
}): SlackInstallStart {
  const clientId = slackClientId()
  if (!clientId) throw new Error('Slack is not configured')
  const nonce = crypto.randomUUID()
  const origin = connectHomeOrigin(args.pageOrigin ?? null)
  const payload = JSON.stringify({
    nonce,
    user_id: args.userId,
    capability: SLACK_INSTALL_CAPABILITY,
    source: 'web',
    workspace_id: args.workspaceId,
    exp: (args.now ?? Date.now()) + OAUTH_STATE_TTL_MS,
    return_to: safeSlackReturnTo(args.returnTo),
    ...(origin && { origin }),
  })
  const stateB64 = Buffer.from(payload).toString('base64url')
  const sig = crypto.createHmac('sha256', oauthStateSecret()).update(stateB64).digest('base64url')
  const state = `${stateB64}.${sig}`
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','))
  url.searchParams.set('redirect_uri', slackRedirectUri())
  url.searchParams.set('state', state)
  return { url: url.toString(), state, nonce }
}

/** The outside calls the finish makes; the route passes the real ones, tests fakes. */
export interface SlackInstallDeps {
  /** oauth.v2.access with the code and our redirect URI (./bot-token.ts slackOauthAccess). */
  exchange: (code: string) => Promise<{ ok: true; grant: SlackOAuthGrant } | { ok: false; error: string }>
  /** Store the team's token, encrypted (./bot-token.ts saveSlackBotToken). */
  saveToken: (input: SaveSlackBotTokenInput) => Promise<boolean>
  slack: {
    authTest: (token: string) => Promise<SlackApiResult<SlackAuthTest>>
    teamInfo: (token: string) => Promise<SlackApiResult<SlackTeamInfo>>
    userInfo: (token: string, slackUserId: string) => Promise<SlackApiResult<SlackUserInfo>>
  }
  now?: () => number
}

/**
 * Finish an install whose state and cookie the route has verified. Returns
 * the result the page shows. Never throws; logs ids and Slack's error codes,
 * never a token.
 */
export async function completeSlackInstall(
  svc: SupabaseClient,
  input: { code: string; userId: string; workspaceId: string },
  deps: SlackInstallDeps,
): Promise<SlackInstallResult> {
  try {
    // Still an admin of the workspace the install was started for.
    const role = await memberRole(svc, input.workspaceId, input.userId)
    if (!role || !INSTALLING_ROLES.has(role)) return 'not_admin'

    const answer = await deps.exchange(input.code)
    if (!answer.ok) {
      console.warn('[slack/install] exchange refused', { error: answer.error })
      return 'failed'
    }
    const grant = answer.grant
    if (grant.isEnterpriseInstall) return 'enterprise'
    const appId = slackAppId()
    if (!appId || grant.appId !== appId) {
      console.warn('[slack/install] another app', { appId: grant.appId })
      return 'failed'
    }
    if (grant.tokenType !== 'bot' || !grant.botToken || !grant.teamId) {
      console.warn('[slack/install] no bot token or team', { tokenType: grant.tokenType, teamId: grant.teamId })
      return 'failed'
    }
    const teamId = grant.teamId
    const token = grant.botToken
    const now = deps.now?.() ?? Date.now()
    const saved = await deps.saveToken({
      teamId,
      appId,
      botToken: token,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresIn === null ? null : now + grant.expiresIn * 1000,
      botUserId: grant.botUserId,
      scopes: grant.scopes,
    })
    if (!saved) return 'failed'

    // The token must be this team's own: never bind a team on another team's word.
    const [auth, team] = await Promise.all([deps.slack.authTest(token), deps.slack.teamInfo(token)])
    if (!auth.ok || auth.team_id !== teamId) {
      console.warn('[slack/install] auth.test does not name the team', { teamId, error: auth.ok ? 'other_team' : auth.error })
      return 'failed'
    }

    // The Slack user who ran the install, as Slack knows them: a stranger, a
    // bot, a deactivated account or another team's user is never linked, and
    // never counts as this team's admin.
    const info = grant.authedUserId ? await deps.slack.userInfo(token, grant.authedUserId) : null
    const user = info?.ok ? info.user : undefined
    const member = user && !user.is_stranger && !user.is_bot && !user.deleted && (!user.team_id || user.team_id === teamId) ? user : undefined
    const slackAdmin = Boolean(member && (member.is_admin || member.is_owner || member.is_primary_owner))

    const existing = await getInstallation(svc, teamId)
    const live = existing?.status === 'active' ? existing : null
    if (live && live.workspace_id !== input.workspaceId) return 'other_workspace'
    if (!live && !slackAdmin) return 'added'

    const authBotUser = typeof auth.user_id === 'string' && /^[UW][A-Z0-9]{2,30}$/.test(auth.user_id) ? auth.user_id : null
    const bind = await bindInstallation(svc, {
      teamId,
      teamName: (team.ok ? team.team?.name : undefined) || grant.teamName || auth.team || '',
      teamDomain: (team.ok ? team.team?.domain : undefined) ?? '',
      enterpriseId: grant.enterpriseId ?? validEnterprise((team.ok ? team.team?.enterprise_id : undefined) ?? auth.enterprise_id),
      workspaceId: input.workspaceId,
      userId: input.userId,
      botUserId: grant.botUserId ?? authBotUser,
    })
    if (!bind.ok) return bind.reason === 'other_workspace' ? 'other_workspace' : 'failed'

    if (!member || !grant.authedUserId) return 'connected'
    const linked = await linkSlackUser(svc, { teamId, slackUserId: grant.authedUserId, userId: input.userId, slackUserName: slackUserName(member) })
    return linked ? 'installed' : 'connected'
  } catch (error) {
    console.error('[slack/install] failed', { error: error instanceof Error ? error.name : 'error' })
    return 'failed'
  }
}

function validEnterprise(value: unknown): string | null {
  return typeof value === 'string' && /^E[A-Z0-9]{2,30}$/.test(value) ? value : null
}
