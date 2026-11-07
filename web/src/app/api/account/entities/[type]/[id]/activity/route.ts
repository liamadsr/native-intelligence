/**
 * GET /api/account/entities/[type]/[id]/activity — the entity tab (plan Part
 * 2.1, rows 10 and 12): every agent interaction with one action, capture,
 * project, contact, document, company, initiative or email thread (its index
 * row's id) in the current workspace, one row per work item, newest first.
 *
 * `{ rows, hidden, workspace_id }`. Reads on the session client (RLS is the
 * fence): `hidden` counts the work items that touched the entity but belong to
 * another member (tracked_job SELECT is owner-only; entity-activity.ts).
 * The panel keeps the list live itself (use-entity-activity.ts).
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { isEntityActivityType, loadEntityActivity } from '@/lib/work/entity-activity'
import { isUuid } from '@/lib/work/touch'

export async function GET(_request: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params
  if (!isEntityActivityType(type)) return badRequest('Unknown entity type')
  if (!isUuid(id)) return badRequest('Invalid entity id')

  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const activity = await loadEntityActivity(supabase, { workspaceId, entityType: type, entityId: id.toLowerCase() })
  if ('error' in activity) {
    console.error('[entity-activity] read failed:', type, id, activity.error)
    return serverError('Could not read this item’s agent activity')
  }
  return NextResponse.json({ ...activity, workspace_id: workspaceId })
}
