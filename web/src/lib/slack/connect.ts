/**
 * Slack through Vercel Connect (docs/plans/slack-connect.md §3): the bot
 * token for a Slack team, the install link for a new team, and revoking one.
 *
 * One customer-managed connector serves every customer's Slack workspace: each
 * workspace is one Connect installation. Connect holds the Slack app's
 * secrets and every bot token, rotates them, and authenticates this app by
 * its Vercel OIDC token, or off Vercel by CONNECT_ACCESS_TOKEN
 * ({@link connectOptions}). getToken caches in process (an LRU keyed on the
 * connector and the request params, not on how the app authenticated), so a
 * bot token is fetched from Connect once per team until it nears expiry
 * (token requests are billed per 1,000).
 *
 * The installation id. The Slack connector's default installation id is the
 * Slack team id (the managed connector shows `defaultInstallationId:
 * "T08RZ8Z5UBG"`), so a team's installation id is taken to be its team id
 * ({@link installationIdForTeam}), checked when the team is bound
 * ({@link verifySlackInstallation}: the token Connect returns must name the
 * same tenant). The installation row stores the id it was bound with, and
 * every later token call reads it from there.
 */
import 'server-only'
import {
  ConnectError,
  ConnectorInstallationRequiredError,
  NoValidTokenError,
  deleteTokenCacheEntry,
  experimental_startInstallation,
  getToken,
  getTokenResponse,
  revokeToken,
  type ConnectTokenParams,
} from '@vercel/connect'
import { connectAccessToken, slackConnector } from './config'

/** The installation id a Slack team's Connect installation is addressed by. */
export function installationIdForTeam(teamId: string): string {
  return teamId
}

function appParams(installationId: string): ConnectTokenParams {
  return { subject: { type: 'app' }, installationId }
}

/**
 * How every Connect call authenticates: the access token when one is set (off
 * Vercel), else undefined, and the client uses the deployment's OIDC token.
 */
function connectOptions(): { vercelToken: string } | undefined {
  const vercelToken = connectAccessToken()
  return vercelToken ? { vercelToken } : undefined
}

function requireConnector(): string {
  const connector = slackConnector()
  if (!connector) throw new SlackNotConfiguredError()
  return connector
}

export class SlackNotConfiguredError extends Error {
  constructor() {
    super('Slack is not set up on this deployment (SLACK_CONNECTOR is unset).')
    this.name = 'SlackNotConfiguredError'
  }
}

/** True when Connect says this team has no live installation (removed, or never added). */
export function isInstallationGone(error: unknown): boolean {
  return error instanceof ConnectorInstallationRequiredError || error instanceof NoValidTokenError
}

/** The bot token for a team's installation. Throws a ConnectError when there is none. */
export async function slackBotToken(installationId: string): Promise<string> {
  return getToken(requireConnector(), appParams(installationId), connectOptions())
}

/**
 * Drop a cached bot token Slack rejected (`invalid_auth`, `token_revoked`), so
 * the next call asks Connect again instead of reusing it.
 */
export function forgetSlackBotToken(installationId: string): void {
  const connector = slackConnector()
  if (connector) deleteTokenCacheEntry(connector, appParams(installationId))
}

/**
 * Check a team's installation before binding it: Connect must return a bot
 * token for it, and that token's tenant must be the team the event came from.
 * Returns the token, or null when Connect has no installation for the team (or
 * names another tenant).
 */
export async function verifySlackInstallation(teamId: string): Promise<{ token: string; installationId: string } | null> {
  const installationId = installationIdForTeam(teamId)
  try {
    const response = await getTokenResponse(requireConnector(), appParams(installationId), connectOptions())
    if (response.tenantId && response.tenantId !== teamId) return null
    return { token: response.token, installationId }
  } catch (error) {
    if (isInstallationGone(error)) return null
    throw error
  }
}

/**
 * Thrown when this Vercel team can't create Connect installation requests.
 * `experimental_startInstallation` is feature-gated (Vercel turns it on per
 * team) and answers 403/404 until then. There is no fallback: Connect only
 * runs its authorization flow for user subjects ("Authorization flow is only
 * supported for user subjects"), so an app-subject `startAuthorization` sent
 * people to a dead end on Vercel's page.
 */
export class SlackInstallUnavailableError extends Error {
  constructor(readonly status: number | undefined) {
    super('Connect installation requests are not enabled for this Vercel team.')
    this.name = 'SlackInstallUnavailableError'
  }
}

/**
 * The URL that adds our Slack app to a Slack workspace (the standard Slack
 * install, run by Connect), returning the person to `returnUrl`. Throws
 * {@link SlackInstallUnavailableError} while the team doesn't have Connect's
 * installation requests.
 */
export async function startSlackInstall(returnUrl: string): Promise<string> {
  const connector = requireConnector()
  try {
    const install = await experimental_startInstallation(connector, {}, { returnUrl, ...connectOptions() })
    return install.url
  } catch (error) {
    if (error instanceof ConnectError && (error.status === 403 || error.status === 404)) {
      console.warn('[slack/connect] installation requests unavailable', { status: error.status, code: error.code })
      throw new SlackInstallUnavailableError(error.status)
    }
    throw error
  }
}

/**
 * Remove a team's installation from Connect (revokes its bot token).
 * 'gone' when Connect already had none for it (uninstalled in Slack). Never
 * throws.
 */
export async function revokeSlackInstallation(installationId: string): Promise<'revoked' | 'gone' | 'failed'> {
  try {
    await revokeToken(requireConnector(), appParams(installationId), connectOptions())
    return 'revoked'
  } catch (error) {
    if (isInstallationGone(error)) return 'gone'
    console.warn('[slack/connect] revoke failed', { installationId, error: error instanceof Error ? error.message : String(error) })
    return 'failed'
  }
}
