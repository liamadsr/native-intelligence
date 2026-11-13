/**
 * The current workspace's joining settings (migration 644):
 *
 *   GET    what the caller may see: the switches, the listed domains, and
 *          the link's address only when they may copy it (owners and admins;
 *          a member while "members can invite" is on) and it is on.
 *   PATCH  owners and admins only, any of:
 *            link_enabled: boolean
 *            members_can_invite: boolean
 *            by_domain: boolean      list (true) or unlist (false) the
 *                                    caller's OWN verified domain; nothing in
 *                                    the body can name a domain to list
 *            remove_domains: string[]  unlist these (any owner or admin may
 *                                      unlist another admin's domain)
 *          All or nothing: everything is checked before anything is written.
 *
 * The tables are service-role only, so this route reads and writes them on
 * the service client after checking the caller's role on their own session.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { claimRefusalText, claimableDomain, normalizeDomain } from '@/lib/workspace-join/domains'
import { canManageJoining } from '@/lib/workspace-join/roles'
import {
  addJoinDomain,
  readJoinSettings,
  removeJoinDomains,
  setJoinLinkEnabled,
  setMembersCanInvite,
} from '@/lib/workspace-join/settings'
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

const BOOLEAN_KEYS = ['link_enabled', 'members_can_invite', 'by_domain'] as const
const MAX_REMOVALS = 20

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
  if (!body || typeof body !== 'object') return badRequest('Invalid JSON')

  // 1. Check everything.
  const present = BOOLEAN_KEYS.filter((k) => k in body)
  if (present.length === 0 && !('remove_domains' in body)) return badRequest('Nothing to change')
  for (const k of present) {
    if (typeof body[k] !== 'boolean') return badRequest(`${k} must be true or false`)
  }

  let removals: string[] = []
  if ('remove_domains' in body) {
    const raw = body.remove_domains
    if (!Array.isArray(raw) || raw.length > MAX_REMOVALS || raw.some((d) => typeof d !== 'string')) {
      return badRequest(`remove_domains must be a list of up to ${MAX_REMOVALS} domains`)
    }
    const normalized = (raw as string[]).map((d) => normalizeDomain(d))
    if (normalized.some((d) => d === null)) return badRequest('remove_domains holds something that is not a domain')
    removals = normalized as string[]
  }

  const claim = claimableDomain(user)
  let listMine: string | null = null
  let unlistMine: string | null = null
  if (body.by_domain === true) {
    if (!claim.ok) return forbidden(claimRefusalText(claim) ?? 'You can’t turn this on')
    listMine = claim.domain
  } else if (body.by_domain === false && claim.domain) {
    unlistMine = normalizeDomain(claim.domain)
  }

  // 2. Write.
  const service = getServiceClient()
  try {
    if (listMine) await addJoinDomain(service, workspaceId, listMine, user.id)
    const unlist = [...new Set([...removals, ...(unlistMine ? [unlistMine] : [])])].filter((d) => d !== listMine)
    await removeJoinDomains(service, workspaceId, unlist)
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
