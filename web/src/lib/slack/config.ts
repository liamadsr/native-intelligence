/**
 * Slack as a customer connection: the deployment's settings. The app talks to
 * Slack directly with our own Slack app: Slack's OAuth v2 install
 * (./install.ts), the bot tokens it gives, stored encrypted per Slack team
 * (./bot-token.ts, migration 643), and Slack's own signature on every request
 * Slack sends here (./signature.ts).
 *
 *   SLACK_APP_ID          our Slack app's id (A…). An install, an event or a
 *                         button click for any other app is refused.
 *   SLACK_CLIENT_ID       the app's client id (digits.digits), sent in the
 *                         authorize link and with every token exchange.
 *   SLACK_CLIENT_SECRET   the app's client secret. A secret: never logged.
 *   SLACK_SIGNING_SECRET  the app's signing secret: every request Slack sends
 *                         to /api/slack/events and /api/slack/interactivity
 *                         must carry its signature. A secret: never logged.
 *
 * All four from the Slack app's own settings (Basic Information). Slack is
 * on only when all four are set and well formed (the secrets: 32 to 128
 * hexadecimal characters, the same rule deploy/app/check_settings.py holds
 * them to); otherwise every Slack route answers that Slack is not set up, the
 * Settings card says so, and a malformed one is logged once by name.
 */

import { appUrl } from '@/lib/app-url'

const APP_ID = /^A[A-Z0-9]{2,30}$/
const CLIENT_ID = /^[0-9]{3,20}\.[0-9]{3,20}$/
/** Slack's client and signing secrets: hexadecimal, 32 today; up to 128 accepted, either case. */
const SECRET = /^[0-9a-f]{32,128}$/i

const warned = new Set<string>()

function setting(name: string, shape: RegExp): string | null {
  const value = process.env[name]?.trim()
  if (!value) return null
  if (shape.test(value)) return value
  // Set but not in the shape the app takes: Slack is off. Said once per process,
  // by name only (deploy/app/check_settings.py says it before a roll-out).
  if (!warned.has(name)) {
    warned.add(name)
    console.warn('[slack/config] setting is malformed; Slack is off', { setting: name })
  }
  return null
}

/** Our Slack app's id, or null when unset or malformed. */
export function slackAppId(): string | null {
  return setting('SLACK_APP_ID', APP_ID)
}

/** The Slack app's client id, or null when unset or malformed. */
export function slackClientId(): string | null {
  return setting('SLACK_CLIENT_ID', CLIENT_ID)
}

/** The Slack app's client secret, or null when unset or malformed. Never log it. */
export function slackClientSecret(): string | null {
  return setting('SLACK_CLIENT_SECRET', SECRET)
}

/** The Slack app's signing secret, or null when unset or malformed. Never log it. */
export function slackSigningSecret(): string | null {
  return setting('SLACK_SIGNING_SECRET', SECRET)
}

/** True when this deployment can install, link and answer Slack: all four settings, well formed. */
export function slackConfigured(): boolean {
  return slackAppId() !== null && slackClientId() !== null && slackClientSecret() !== null && slackSigningSecret() !== null
}

/**
 * The bot scopes the install asks for, exactly: read mentions and DMs, open
 * and write DMs, react, and read the team and its people (the link checks).
 */
export const SLACK_BOT_SCOPES: readonly string[] = [
  'app_mentions:read',
  'chat:write',
  'im:history',
  'im:read',
  'im:write',
  'reactions:write',
  'team:read',
  'users:read',
]

/** Where Slack sends the person back after the install (listed in the Slack app's OAuth settings). */
export const SLACK_OAUTH_CALLBACK_PATH = '/api/slack/oauth/callback'

/** The app's public origin, for links the bot sends and the install's redirect. */
export function appOrigin(): string {
  return appUrl()
}

/** The install's redirect_uri: the app's public origin and the callback path. */
export function slackRedirectUri(): string {
  return `${appOrigin()}${SLACK_OAUTH_CALLBACK_PATH}`
}

/** Slack's page under Settings › Connectors (slack-connector-view.tsx). */
export const SLACK_SETTINGS_PATH = '/account/settings/connectors/slack'
