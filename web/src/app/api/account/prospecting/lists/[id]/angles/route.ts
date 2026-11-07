/**
 * GET /api/account/prospecting/lists/[id]/angles — per-angle telemetry.
 *
 * Returns `[{ angle, found, new, saved }]`, which the UI renders as "By angle"
 * under the run-history popover. The three numbers come from two tables and
 * mean three different things; `src/lib/prospecting/telemetry.ts` documents
 * why they are not one query.
 *
 * A cross-workspace or missing list id is a 404 rather than an empty array:
 * an empty `angles` legitimately means "no run has stamped an angle on this
 * list yet", and a list that does not exist must not be indistinguishable
 * from one that has never run.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { listAngleTelemetry } from '@/lib/prospecting/telemetry'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  // The existence probe carries the workspace filter itself — RLS is never the
  // only boundary in this feature, and the aggregation below is workspace- AND
  // list-scoped for the same reason.
  const { data: list, error } = await supabase
    .from('prospect_list')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] angles list check failed:', error.message)
    return serverError()
  }
  if (!list) return notFound('List not found')

  const result = await listAngleTelemetry(supabase, { workspaceId, listId: id })
  if (!result.ok) return serverError()

  return NextResponse.json({ angles: result.angles })
}
