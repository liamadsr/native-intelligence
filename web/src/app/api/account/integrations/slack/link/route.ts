/**
 * PATCH  /api/account/integrations/slack/link?team=T…  { alerts: boolean }
 *
 * Turn the person's "Native Intelligence needs your OK" DMs on or off in that Slack
 * workspace (slack_user_link.alerts_off_at, 426; src/lib/reach/dispatch.ts).
 * On by default once linked.
 *
 * DELETE /api/account/integrations/slack/link?team=T…
 *
 * Unlink the person's own Slack account in a Slack workspace connected to the
 * current Native Intelligence workspace. Afterwards the bot treats them as someone it
 * doesn't know.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { slackConfigured } from '@/lib/slack/config'
import { getInstallation, unlinkSlackUser } from '@/lib/slack/store'

const TEAM_ID = /^T[A-Z0-9]{2,30}$/

export async function PATCH(request: Request) {
  if (!slackConfigured()) return notFound('Slack is not set up')
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const teamId = new URL(request.url).searchParams.get('team') ?? ''
  if (!TEAM_ID.test(teamId)) return badRequest('A Slack team id is required')
  let body: { alerts?: unknown }
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (typeof body.alerts !== 'boolean') return badRequest('alerts must be true or false')
  const svc = getServiceClient()
  try {
    const installation = await getInstallation(svc, teamId)
    if (!installation || installation.workspace_id !== auth.workspaceId) return notFound('That Slack workspace is not connected here')
  } catch {
    return serverError('Could not read the Slack connection')
  }
  const { data, error } = await svc
    .from('slack_user_link')
    .update({ alerts_off_at: body.alerts ? null : new Date().toISOString() })
    .eq('slack_team_id', teamId)
    .eq('user_id', auth.user.id)
    .select('slack_user_id')
  if (error) return serverError('Could not change Slack alerts')
  if (!Array.isArray(data) || data.length === 0) return notFound('Your Slack account is not linked there')
  return Response.json({ alertsOn: body.alerts })
}

export async function DELETE(request: Request) {
  if (!slackConfigured()) return notFound('Slack is not set up')
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const teamId = new URL(request.url).searchParams.get('team') ?? ''
  if (!TEAM_ID.test(teamId)) return badRequest('A Slack team id is required')
  const svc = getServiceClient()
  try {
    const installation = await getInstallation(svc, teamId)
    if (!installation || installation.workspace_id !== auth.workspaceId) return notFound('That Slack workspace is not connected here')
  } catch {
    return serverError('Could not read the Slack connection')
  }
  if (!(await unlinkSlackUser(svc, teamId, auth.user.id))) return serverError('Could not unlink Slack')
  return Response.json({ ok: true })
}
