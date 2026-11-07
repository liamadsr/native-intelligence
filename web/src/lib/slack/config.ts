/**
 * Slack as a customer connection (docs/plans/slack-connect.md): the
 * deployment's settings. None of these is a secret. The Slack app's secrets
 * (client secret, signing secret, verification token) live ONLY in the
 * Vercel Connect connector, and bot tokens come from Connect at runtime
 * (./connect.ts). Nothing in this app ever holds them.
 *
 *   SLACK_CONNECTOR  the Connect connector (uid like `slack/dial8-public`, or
 *                    its `scl_…` id). Unset: Slack is off, and the Settings
 *                    card doesn't show.
 *   SLACK_APP_ID     our Slack app's id (A…). The events route drops any
 *                    payload whose api_app_id isn't this (fails closed).
 */

/** The Connect connector, or null when Slack is not set up on this deployment. */
export function slackConnector(): string | null {
  const value = process.env.SLACK_CONNECTOR?.trim()
  return value ? value : null
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
 * True once people can add Dial8 to a new Slack workspace from Settings
 * (`SLACK_SELF_INSTALL=1`): Connect's installation requests are feature-gated
 * per Vercel team, so until Vercel turns them on, workspaces are added from
 * the Connect dashboard and the page hides "Add to Slack".
 */
export function slackSelfInstallOpen(): boolean {
  return process.env.SLACK_SELF_INSTALL?.trim() === '1'
}

/** The app's public origin, for links the bot sends and Connect's return URL. */
export function appOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai').replace(/\/$/, '')
}

/** Slack's page under Settings › Connectors (slack-connector-view.tsx). */
export const SLACK_SETTINGS_PATH = '/account/settings/connectors/slack'
