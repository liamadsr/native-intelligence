/**
 * POST /api/account/integrations/slack/install   body (optional): { returnTo }
 *
 * "Add to Slack": a workspace admin gets `{ url }`, Slack's own authorize page
 * for our Slack app (src/lib/slack/install.ts), and this browser gets the
 * install's binding cookie. Slack sends them back to /api/slack/oauth/callback,
 * which stores the bot token and binds the Slack workspace to this Native
 * Intelligence workspace, then returns them to `returnTo` (a page in the
 * account area; Slack's settings page by default) with `?slack=<result>`.
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, forbidden, notFound } from '@/lib/api-errors'
import { OAUTH_STATE_TTL_MS, bindingCookieOptions } from '@/lib/oauth/state'
import { requestOrigin } from '@/lib/security/same-origin'
import { slackConfigured } from '@/lib/slack/config'
import { SLACK_INSTALL_NONCE_COOKIE, buildSlackInstall } from '@/lib/slack/install'
import { INSTALLING_ROLES } from '@/lib/slack/store'

export async function POST(request: Request) {
  if (!slackConfigured()) return notFound('Slack is not set up')
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (!INSTALLING_ROLES.has(auth.member.role ?? 'member')) return forbidden('Only a workspace admin can add Native Intelligence to Slack')
  const body = (await request.json().catch(() => null)) as { returnTo?: unknown } | null
  try {
    const { url, nonce } = buildSlackInstall({
      userId: auth.user.id,
      workspaceId: auth.workspaceId,
      returnTo: typeof body?.returnTo === 'string' ? body.returnTo : null,
      // The cookie below is set on this origin, so the install finishes here
      // (the callback hands Slack's answer over when Slack called the app's other domain).
      pageOrigin: requestOrigin(request),
    })
    const response = NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store' } })
    response.cookies.set(SLACK_INSTALL_NONCE_COOKIE(), nonce, bindingCookieOptions(Math.floor(OAUTH_STATE_TTL_MS / 1000)))
    return response
  } catch (error) {
    console.error('[slack/install] could not start', { error: error instanceof Error ? error.name : 'error' })
    return apiError('Could not start the Slack install', { status: 502, code: 'SLACK_INSTALL_FAILED' })
  }
}
