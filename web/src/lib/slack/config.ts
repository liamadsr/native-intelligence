/**
 * Slack as a customer connection (docs/plans/slack-connect.md): the
 * deployment's settings. Neither SLACK_* one is a secret. The Slack app's secrets
 * (client secret, signing secret, verification token) live ONLY in the
 * Vercel Connect connector, and bot tokens come from Connect at runtime
 * (./connect.ts). Nothing in this app ever holds them.
 *
 *   SLACK_CONNECTOR  the Connect connector (uid like `slack/ni-public`, or
 *                    its `scl_…` id). Unset: Slack is off, and the Settings
 *                    card doesn't show.
 *   SLACK_APP_ID     our Slack app's id (A…). The events route drops any
 *                    payload whose api_app_id isn't this (fails closed).
 *
 * Off Vercel (our own server) the app has no Vercel OIDC token, so it reaches
 * Connect with these instead. Unset (on Vercel): the OIDC token, as before.
 *
 *   CONNECT_ACCESS_TOKEN  a Vercel access token scoped to the team the
 *                         connector is in. Every Connect call sends it
 *                         (`{ vercelToken }`) instead of the OIDC token. A
 *                         secret: never logged.
 *   CONNECT_PROJECT_ID    the Vercel project Connect forwards Slack's events
 *                         for (prj_…): a forwarded request's OIDC token must
 *                         name it, instead of VERCEL_PROJECT_ID.
 *   CONNECT_ENVIRONMENT   the environment that token must name, instead of
 *                         VERCEL_TARGET_ENV / VERCEL_ENV. `production` when
 *                         unset; read only with CONNECT_PROJECT_ID.
 *
 * A `*` in either of the last two refuses every forwarded request.
 */

import { appUrl } from '@/lib/app-url'

/** The Connect connector, or null when Slack is not set up on this deployment. */
export function slackConnector(): string | null {
  const value = process.env.SLACK_CONNECTOR?.trim()
  return value ? value : null
}

/** The access token every Connect call sends, or null to use the Vercel OIDC token. */
export function connectAccessToken(): string | null {
  const value = process.env.CONNECT_ACCESS_TOKEN?.trim()
  return value ? value : null
}

/**
 * The project and environment a forwarded request's OIDC token must name, or
 * undefined for the verifier's own defaults (VERCEL_PROJECT_ID, VERCEL_ENV).
 * 'refuse' when either setting holds a `*`: the verifier reads `*` as "any",
 * so such a value must close the check, never widen it.
 */
export function connectForwardTarget(): { projectId: string; environment: string } | 'refuse' | undefined {
  const projectId = process.env.CONNECT_PROJECT_ID?.trim()
  const environment = process.env.CONNECT_ENVIRONMENT?.trim()
  if (projectId?.includes('*') || environment?.includes('*')) return 'refuse'
  if (!projectId) return undefined
  return { projectId, environment: environment || 'production' }
}

/** Our Slack app's id, or null when unset. */
export function slackAppId(): string | null {
  const value = process.env.SLACK_APP_ID?.trim()
  return value && /^A[A-Z0-9]{2,30}$/.test(value) ? value : null
}

/** True when this deployment can install, link and answer Slack. */
export function slackConfigured(): boolean {
  return slackConnector() !== null && slackAppId() !== null
}

/**
 * True once people can add Native Intelligence to a new Slack workspace from Settings
 * (`SLACK_SELF_INSTALL=1`): Connect's installation requests are feature-gated
 * per Vercel team, so until Vercel turns them on, workspaces are added from
 * the Connect dashboard and the page hides "Add to Slack".
 */
export function slackSelfInstallOpen(): boolean {
  return process.env.SLACK_SELF_INSTALL?.trim() === '1'
}

/** The app's public origin, for links the bot sends and Connect's return URL. */
export function appOrigin(): string {
  return appUrl()
}

/** Slack's page under Settings › Connectors (slack-connector-view.tsx). */
export const SLACK_SETTINGS_PATH = '/account/settings/connectors/slack'
