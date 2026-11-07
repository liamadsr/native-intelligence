/**
 * POST /api/account/integrations/slack/install
 *
 * "Add to Slack" (docs/plans/slack-connect.md §4 piece 3): a workspace admin
 * gets the URL that adds our Slack app to their Slack workspace (Slack's own
 * install, run by Vercel Connect). Slack sends them back to Settings. The
 * Slack workspace is bound to this Dial8 workspace when the admin then sends
 * the bot their link code (src/lib/slack/inbound.ts): the install alone binds
 * nothing, so a Slack team is never tied to a workspace on a redirect's word.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, forbidden, notFound } from '@/lib/api-errors'
import { SLACK_SETTINGS_PATH, appOrigin, slackConfigured } from '@/lib/slack/config'
import { SlackInstallUnavailableError, startSlackInstall } from '@/lib/slack/connect'
import { INSTALLING_ROLES } from '@/lib/slack/store'

/** Shown on Slack's settings page while Connect can't take new installs. */
const SLACK_INSTALL_UNAVAILABLE = "Adding Dial8 to a new Slack workspace isn't open yet. We're turning it on soon."

export async function POST() {
  if (!slackConfigured()) return notFound('Slack is not set up')
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (!INSTALLING_ROLES.has(auth.member.role ?? 'member')) return forbidden('Only a workspace admin can add Dial8 to Slack')
  try {
    const url = await startSlackInstall(`${appOrigin()}${SLACK_SETTINGS_PATH}?slack=installed`)
    return Response.json({ url })
  } catch (error) {
    if (error instanceof SlackInstallUnavailableError) {
      return apiError(SLACK_INSTALL_UNAVAILABLE, { status: 503, code: 'SLACK_INSTALL_UNAVAILABLE' })
    }
    console.error('[slack/install] could not start', { error: error instanceof Error ? error.message : String(error) })
    return apiError('Could not start the Slack install', { status: 502, code: 'SLACK_INSTALL_FAILED' })
  }
}
