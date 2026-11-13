/**
 * The current workspace's joining settings (migration 644):
 *
 *   GET    what the caller may see: the switches, the domain line, and the
 *          link's address only when they may copy it (owners and admins; a
 *          member while "members can invite" is on) and it is on.
 *   PATCH  owners and admins only: { link_enabled?, auto_join?,
 *          members_can_invite? }. auto_join: true claims the caller's OWN
 *          verified domain; nothing in the body can name a domain.
 *
 * The tables are service-role only, so this route reads and writes them on
 * the service client after checking the caller's role on their own session.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, conflict, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { claimRefusalText, claimableDomain, domainClashText } from '@/lib/workspace-join/domains'
import { canManageJoining } from '@/lib/workspace-join/roles'
import { readJoinSettings, setAutoJoinDomain, setJoinLinkEnabled, setMembersCanInvite } from '@/lib/workspace-join/settings'
import { joinSettingsView } from '@/lib/workspace-join/view'

export async function GET() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth
  try {
    const settings = await readJoinSettings(getServiceClient(), workspaceId)
    return NextResponse.json(joinSettingsView(settings, member.role ?? null, user))
  } catch (err) {
    console.error('[workspace-join] settings read failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth
  if (!canManageJoining(member.role)) return forbidden('Only owners and admins can change how people join')

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return badRequest('Invalid JSON')
  }
  const known = ['link_enabled', 'auto_join', 'members_can_invite']
  const keys = Object.keys(body ?? {}).filter((k) => known.includes(k))
  if (keys.length === 0) return badRequest('Nothing to change')
  for (const k of keys) {
    if (typeof body[k] !== 'boolean') return badRequest(`${k} must be true or false`)
  }

  const service = getServiceClient()
  try {
    if (typeof body.auto_join === 'boolean') {
      if (body.auto_join) {
        // ALWAYS the caller's own verified domain; never one from the body.
        const claim = claimableDomain(user)
        if (!claim.ok) return forbidden(claimRefusalText(claim) ?? 'You can’t switch this on')
        const result = await setAutoJoinDomain(service, workspaceId, claim.domain, user.id)
        if (!result.ok) return conflict(domainClashText(claim.domain), undefined, 'DOMAIN_TAKEN')
      } else {
        await setAutoJoinDomain(service, workspaceId, null, user.id)
      }
    }
    if (typeof body.members_can_invite === 'boolean') {
      await setMembersCanInvite(service, workspaceId, body.members_can_invite, user.id)
    }
    if (typeof body.link_enabled === 'boolean') {
      await setJoinLinkEnabled(service, workspaceId, body.link_enabled, user.id)
    }
    const settings = await readJoinSettings(service, workspaceId)
    return NextResponse.json(joinSettingsView(settings, member.role ?? null, user))
  } catch (err) {
    console.error('[workspace-join] settings write failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
}
