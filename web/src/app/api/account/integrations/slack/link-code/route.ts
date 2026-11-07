/**
 * POST /api/account/integrations/slack/link-code
 *
 * A one-time code the person sends the Dial8 bot in a Slack DM
 * (src/lib/slack/link-code.ts). It links the Slack account it comes from to
 * this Dial8 account, in the current workspace; an admin's code also connects
 * a Slack workspace that isn't connected yet. Shown once; only its hash is
 * kept; it stops working after 15 minutes, after one use, or when the person
 * asks for a new one.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden, notFound, serverError } from '@/lib/api-errors'
import { slackConfigured } from '@/lib/slack/config'
import { LINKING_ROLES, createLinkCode } from '@/lib/slack/store'

export async function POST() {
  if (!slackConfigured()) return notFound('Slack is not set up')
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (!LINKING_ROLES.has(auth.member.role ?? 'member')) return forbidden('Guests cannot link Slack')
  try {
    const { code, expiresAt } = await createLinkCode(getServiceClient(), { userId: auth.user.id, workspaceId: auth.workspaceId })
    return Response.json({ code, expiresAt }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[slack/link-code] failed', { error: error instanceof Error ? error.message : String(error) })
    return serverError('Could not make a link code')
  }
}
