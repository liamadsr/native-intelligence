/**
 * How Slack's install ended, as the callback (/api/slack/oauth/callback)
 * hands it to the page it returns to (`?slack=<result>`), and the plain words
 * the page shows for it. Pure, and safe in the browser: never Slack's own
 * answer, never a stack trace.
 */

export const SLACK_INSTALL_RESULTS = [
  'installed',
  'connected',
  'added',
  'other_workspace',
  'enterprise',
  'denied',
  'expired',
  'session',
  'not_admin',
  'unavailable',
  'failed',
] as const

export type SlackInstallResult = (typeof SLACK_INSTALL_RESULTS)[number]

/** The query parameter the result travels in. */
export const SLACK_INSTALL_RESULT_PARAM = 'slack'

const MESSAGES: Record<SlackInstallResult, { ok: boolean; text: string }> = {
  installed: {
    ok: true,
    text: 'Slack is connected, and your Slack account is linked. Message Native Intelligence there any time; teammates link their own accounts from here.',
  },
  connected: { ok: true, text: 'Slack is connected. Link your own Slack account with a code from here.' },
  added: {
    ok: false,
    text: 'Native Intelligence is now in your Slack, but only an admin or owner of that Slack workspace can connect it to this workspace. Ask one of them to add it from here.',
  },
  other_workspace: { ok: false, text: 'That Slack workspace is already connected to a different Native Intelligence workspace.' },
  enterprise: {
    ok: false,
    text: "Native Intelligence can't be added to a whole Enterprise Grid organization at once. Add it to one Slack workspace instead.",
  },
  denied: { ok: false, text: 'The Slack install was cancelled. Nothing changed.' },
  expired: { ok: false, text: 'The Slack install took too long. Start it again.' },
  session: { ok: false, text: 'The Slack install came back to a different browser than the one that started it. Start it again here.' },
  not_admin: { ok: false, text: 'Only a workspace admin can add Native Intelligence to Slack.' },
  unavailable: { ok: false, text: "Slack isn't available here." },
  failed: { ok: false, text: "Couldn't add Native Intelligence to Slack. Try again." },
}

/** The result a `?slack=` value names, or null for anything else. */
export function parseSlackInstallResult(value: string | null | undefined): SlackInstallResult | null {
  return value && (SLACK_INSTALL_RESULTS as readonly string[]).includes(value) ? (value as SlackInstallResult) : null
}

/** What the page says for a result, and whether it is good news. */
export function slackInstallMessage(result: SlackInstallResult): { ok: boolean; text: string } {
  return MESSAGES[result]
}
