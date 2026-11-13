/**
 * GET    /api/account/integrations/slack            the Settings card's state
 * DELETE /api/account/integrations/slack?team=T…     disconnect a Slack workspace (admins)
 *
 * GET answers `{ configured: false }` when this deployment has no Slack app
 * set up (src/lib/slack/config.ts), and the card says so. Otherwise it lists
 * the Slack workspaces bound to the current Native Intelligence workspace,
 * whether the app holds a bot token for each (`tokenStored`: false means the
 * app must be added to that Slack workspace again), the person's own link in
 * each, and whether they may add or remove one.
 *
 * Disconnect revokes the team's bot token at Slack (auth.revoke, best effort),
 * deletes the stored token (src/lib/slack/bot-token.ts), then marks the row
 * revoked. Per Slack, revoking a bot token does not uninstall the app from the
 * Slack workspace (it stays listed there), and with token rotation it revokes
 * that one access token: the bot stops answering because this app no longer
 * holds a token for the team and the row is revoked. The people's links stay
 * on the row, so adding the same Slack workspace again brings them back. When
 * the stored token can't be deleted, nothing is marked: a row marked revoked
 * while the app still holds the token would let the team be bound to another
 * workspace.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { revokeSlackBotToken, teamsWithStoredToken } from '@/lib/slack/bot-token'
import { slackAppId, slackConfigured } from '@/lib/slack/config'
import { INSTALLING_ROLES, LINKING_ROLES, getInstallation, installationsForWorkspace, linksForUser, markInstallationRevoked } from '@/lib/slack/store'

const TEAM_ID = /^T[A-Z0-9]{2,30}$/

/**
 * The teams where the person turned the "needs your OK" DMs off
 * (slack_user_link.alerts_off_at, 426); null when it can't be read (a
 * database without 426), and the page then shows no switch.
 */
async function alertsOffTeams(svc: ReturnType<typeof getServiceClient>, userId: string, teamIds: string[]): Promise<Set<string> | null> {
  if (teamIds.length === 0) return new Set()
  const { data, error } = await svc.from('slack_user_link').select('slack_team_id, alerts_off_at').eq('user_id', userId).in('slack_team_id', teamIds)
  if (error || !Array.isArray(data)) return null
  return new Set((data as Array<{ slack_team_id: string; alerts_off_at: string | null }>).filter((r) => r.alerts_off_at).map((r) => r.slack_team_id))
}

export async function GET() {
  if (!slackConfigured()) return Response.json({ configured: false })
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const role = auth.member.role ?? 'member'
  const svc = getServiceClient()
  try {
    const installations = await installationsForWorkspace(svc, auth.workspaceId)
    const links = await linksForUser(svc, auth.user.id, installations.map((i) => i.slack_team_id))
    const alertsOff = await alertsOffTeams(svc, auth.user.id, links.map((l) => l.slack_team_id))
    // A team connected here whose bot token is not stored (connected before
    // the app held its own tokens, or its token died): the app must be added
    // to that Slack workspace again.
    const stored = await teamsWithStoredToken(svc, installations.map((i) => i.slack_team_id))
    return Response.json({
      configured: true,
      appId: slackAppId(),
      canInstall: INSTALLING_ROLES.has(role),
      canLink: LINKING_ROLES.has(role),
      installations: installations.map((i) => {
        const mine = links.find((l) => l.slack_team_id === i.slack_team_id)
        return {
          teamId: i.slack_team_id,
          teamName: i.team_name,
          teamDomain: i.team_domain,
          connectedAt: i.created_at,
          tokenStored: stored.has(i.slack_team_id),
          myLink: mine
            ? { slackUserId: mine.slack_user_id, slackUserName: mine.slack_user_name, linkedAt: mine.linked_at, alertsOn: alertsOff ? !alertsOff.has(i.slack_team_id) : null }
            : null,
        }
      }),
    })
  } catch (error) {
    console.error('[slack/settings] read failed', { error: error instanceof Error ? error.message : String(error) })
    return serverError('Could not read the Slack connection')
  }
}

export async function DELETE(request: Request) {
  if (!slackConfigured()) return notFound('Slack is not set up')
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (!INSTALLING_ROLES.has(auth.member.role ?? 'member')) return forbidden('Only a workspace admin can disconnect Slack')
  const teamId = new URL(request.url).searchParams.get('team') ?? ''
  if (!TEAM_ID.test(teamId)) return badRequest('A Slack team id is required')

  const svc = getServiceClient()
  let installation: Awaited<ReturnType<typeof getInstallation>>
  try {
    installation = await getInstallation(svc, teamId)
  } catch {
    return serverError('Could not read the Slack connection')
  }
  if (!installation || installation.workspace_id !== auth.workspaceId || installation.status !== 'active') {
    return notFound('That Slack workspace is not connected here')
  }
  // The stored token first: once it is gone, this app no longer answers there.
  const revoked = await revokeSlackBotToken(teamId)
  if (revoked === 'failed') return apiError('Could not disconnect Slack right now. Try again.', { status: 502, code: 'SLACK_REVOKE_FAILED' })
  if (!(await markInstallationRevoked(svc, teamId, auth.workspaceId))) return serverError('Could not disconnect Slack')
  return Response.json({ ok: true })
}
