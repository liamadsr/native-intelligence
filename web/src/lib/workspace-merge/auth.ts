/**
 * The gate the two merge routes share, before the database's own
 * (_wsmerge_gate re-checks inside the transaction): a signed-in person (never
 * a device token) who owns the destination (their current workspace) AND the
 * source, with the destination pinned to the one the dialog showed. A source
 * they are not in reads as "not found", never "forbidden" (the engine's
 * anti-oracle).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { badRequest, conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import { isDeviceToken } from '@/lib/device-tokens'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/**
 * A device token (`nid_…`) is pinned to a workspace and has no person at the
 * keyboard to type the source's name: it may not merge, or read the preflight
 * that would tell it that name.
 */
export function refuseDeviceToken(req: Request): Response | null {
  const header = req.headers.get('authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (bearer && isDeviceToken(bearer)) {
    return forbidden('Merging workspaces needs a signed-in session')
  }
  return null
}

export interface MergeGateInput {
  service: SupabaseClient
  userId: string
  /** The workspace this request resolved to (cookie, header or device pin). */
  destinationWorkspaceId: string
  destinationRole: string | null | undefined
  /** From the body: the destination the dialog showed; must be the resolved one. */
  claimedDestinationId: unknown
  sourceWorkspaceId: unknown
}

export interface MergeGateOk {
  sourceWorkspaceId: string
  sourceMemberId: string
}

/** A Response to return, or the resolved source. */
export async function gateMerge(input: MergeGateInput): Promise<MergeGateOk | Response> {
  if (!isUuid(input.sourceWorkspaceId)) return badRequest('source_workspace_id must be a workspace id')
  if (!isUuid(input.claimedDestinationId)) return badRequest('destination_workspace_id must be a workspace id')
  const source = input.sourceWorkspaceId.toLowerCase()
  const destination = input.destinationWorkspaceId.toLowerCase()
  if (input.claimedDestinationId.toLowerCase() !== destination) {
    // Another tab or a stale cookie moved this request to a different workspace than the one confirmed.
    return conflict('This request is not in the workspace you confirmed; reload and try again', undefined, 'DESTINATION_MISMATCH')
  }
  if (source === destination) return badRequest('Source and destination workspace are the same')
  if (input.destinationRole !== 'owner') {
    return forbidden('Only the owner of this workspace can merge another one into it')
  }
  const { data: member, error } = await input.service
    .from('member')
    .select('id, role')
    .eq('workspace_id', source)
    .eq('user_id', input.userId)
    .maybeSingle()
  if (error) {
    console.error('[workspace-merge] source membership lookup failed:', error)
    return serverError('Could not verify workspace membership')
  }
  if (!member) return notFound('Workspace not found')
  const row = member as { id: string; role: string }
  if (row.role !== 'owner') return forbidden('Only the owner of both workspaces can merge them')
  return { sourceWorkspaceId: source, sourceMemberId: row.id }
}
