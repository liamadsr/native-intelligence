import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notMember, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { canManageWorkspaceMemory } from '@/lib/packs/memory-types'
import { memberRole } from '@/lib/packs/memory-write'
import { MEMORY_ENTRY_ACTIONS, listTeammateMemory, settleMemoryEntry, type MemoryEntryAction } from '@/lib/work/agent-memory'

/**
 * What the agents learned at work: a teammate's memory (agent_memory; trust
 * layer P2, decision 16 as apply with undo; migration 374), shown in What
 * Native Intelligence has learned. Every entry is live at once and can be removed (and
 * restored); one learned after its run read untrusted outside text carries
 * the tools that brought it, for its label. Nothing waits to be accepted. A
 * teammate's memory is read by every member's runs of it, so only those who
 * manage the workspace's memory see or remove it, as with workspace lines
 * (canManageWorkspaceMemory). A member gets an empty answer (nothing to
 * show), not an error.
 *
 * agent_memory is service-role only (289), so the role is checked on the
 * person's own session and the rows are read and written with the service
 * client, fenced to the caller's workspace and to the captures the caller
 * may see (an entry learned from one they can't is never shown or changed).
 */

/** GET: the live entries, newest first, with their teammate's name. */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const role = await memberRole(supabase, workspaceId, user.id)
  if (!role) return notMember()
  if (!canManageWorkspaceMemory(role)) return NextResponse.json({ canManage: false, entries: [] })

  try {
    const service = getServiceClient()
    const { entries } = await listTeammateMemory(service, { workspaceId, viewerUserId: user.id })
    const teammateIds = [...new Set(entries.map((e) => e.teammateId))]
    const names = new Map<string, string>()
    if (teammateIds.length) {
      const { data } = await service.from('ai_team_member').select('id, name').eq('workspace_id', workspaceId).in('id', teammateIds)
      for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) if (row.name) names.set(row.id, row.name)
    }
    return NextResponse.json({ canManage: true, entries: entries.map((e) => ({ ...e, teammateName: names.get(e.teammateId) ?? null })) })
  } catch {
    return serverError('Could not read what the agents learned.')
  }
}

/** PATCH { id, action: 'remove' | 'restore' }: remove one entry, or undo that. */
export async function PATCH(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return badRequest(`Send JSON: { id, action: ${MEMORY_ENTRY_ACTIONS.map((a) => `'${a}'`).join(' | ')} }.`)
  if (typeof body.id !== 'string' || !body.id) return badRequest('id must be the entry’s id.')
  if (typeof body.action !== 'string' || !(MEMORY_ENTRY_ACTIONS as readonly string[]).includes(body.action)) {
    return badRequest(`action must be one of ${MEMORY_ENTRY_ACTIONS.join(', ')}.`)
  }

  const role = await memberRole(supabase, workspaceId, user.id)
  if (!role) return notMember()
  if (!canManageWorkspaceMemory(role)) return forbidden('Only an owner or admin can change what the agents learned for the workspace.')

  try {
    const result = await settleMemoryEntry(getServiceClient(), { workspaceId, viewerUserId: user.id, id: body.id, action: body.action as MemoryEntryAction })
    if (!result.ok) return apiError(result.error, { status: result.code === 'NOT_FOUND' ? 404 : 409, code: result.code })
    return NextResponse.json(result)
  } catch {
    return serverError('Could not change that entry.')
  }
}
