/**
 * POST: give the current workspace's join link a new token. The old link
 * stops working at once (a page opened with it says so). Owners and admins
 * only; the link stays on or off as it was.
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { canManageJoining } from '@/lib/workspace-join/roles'
import { readJoinSettings, resetJoinLink } from '@/lib/workspace-join/settings'
import { joinSettingsView } from '@/lib/workspace-join/view'

export async function POST() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth
  if (!canManageJoining(member.role)) return forbidden('Only owners and admins can reset the link')

  const service = getServiceClient()
  try {
    await resetJoinLink(service, workspaceId, user.id)
    const settings = await readJoinSettings(service, workspaceId)
    return NextResponse.json(joinSettingsView(settings, member.role ?? null, user))
  } catch (err) {
    console.error('[workspace-join] link reset failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
}
