import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * PATCH /api/account/workflow-states/reorder
 *
 * Bulk-update sort_order for many workflow states in a single request.
 * Used by the kanban board column reorder, where a single visual column can
 * map to several workflow_state rows (one per team) that all need the same
 * sort_order. Body: { updates: { id: string; sort_order: number }[] }.
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const body = await request.json()
  const updates = body.updates as { id?: string; sort_order?: number }[] | undefined

  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: 'updates array is required' }, { status: 400 })
  }

  const valid = updates.filter(
    (u): u is { id: string; sort_order: number } =>
      typeof u?.id === 'string' && typeof u?.sort_order === 'number',
  )
  if (valid.length === 0) {
    return NextResponse.json({ error: 'No valid updates provided' }, { status: 400 })
  }

  // Verify every state belongs to a team in this workspace before mutating.
  const ids = valid.map((u) => u.id)
  const { data: states, error: fetchError } = await supabase
    .from('workflow_state')
    .select('id, team:team!team_id(workspace_id)')
    .in('id', ids)

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  const allowed = new Set(
    (states || [])
      .filter((s) => (s.team as unknown as { workspace_id: string })?.workspace_id === workspaceId)
      .map((s) => s.id),
  )

  const toApply = valid.filter((u) => allowed.has(u.id))
  if (toApply.length === 0) {
    return NextResponse.json({ error: 'No workflow states found in this workspace' }, { status: 404 })
  }

  // RLS still enforces that the user may update each row (owner/admin/team
  // lead, migration 020), and it refuses by matching 0 rows with no error, so
  // each update counts what it wrote.
  const results = await Promise.all(
    toApply.map((u) =>
      supabase
        .from('workflow_state')
        .update({ sort_order: u.sort_order }, { count: 'exact' })
        .eq('id', u.id),
    ),
  )

  const failed = results.find((r) => r.error)
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 })
  }
  const refused = results.filter((r) => !r.count).length
  if (refused > 0) {
    return forbidden(
      'Only a workspace owner or admin, or the team lead, can reorder workflow states' +
        (refused < results.length ? ` (${results.length - refused} of ${results.length} were reordered)` : ''),
    )
  }

  return NextResponse.json({ updated: toApply.length })
}
