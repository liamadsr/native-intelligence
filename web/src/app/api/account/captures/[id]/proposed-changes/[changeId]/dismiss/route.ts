import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { deleteAppliedEntity } from '@/lib/proposed-changes/apply-engine'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/proposed-changes/[changeId]/dismiss
 * Dismiss a proposed change.
 *
 * Works on both pending and applied proposals. When an applied `create:*`
 * proposal is dismissed, the entity it spawned is deleted first so the
 * dismissal actually removes the item the user is looking at — otherwise a
 * dismissed auto-accepted action would silently linger in the workspace.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  try {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id, changeId } = await params

  const { data: change } = await supabase
    .from('proposed_change')
    .select('status, change_type, entity_type, result_entity_id')
    .eq('id', changeId)
    .eq('capture_id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (change.status === 'dismissed') {
    return NextResponse.json({ error: 'Change is already dismissed' }, { status: 400 })
  }

  // If the proposal was applied and created a fresh entity, delete that entity
  // so the dismissal removes it. update/assign proposals mutated pre-existing
  // data we can't safely delete — deleteAppliedEntity refuses those, and we
  // just mark the proposal dismissed and leave the entity alone.
  if (change.status === 'applied' && change.change_type === 'create' && change.result_entity_id) {
    const result = await deleteAppliedEntity(
      supabase,
      change.change_type,
      change.entity_type,
      change.result_entity_id,
      workspaceId,
    )
    if (!result.success && result.code !== 'NOT_CREATED_BY_PROPOSAL') {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }
  }

  const { data, error } = await supabase
    .from('proposed_change')
    .update({ status: 'dismissed', result_entity_id: null })
    .eq('id', changeId)
    .eq('workspace_id', workspaceId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ change: data })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAuth = /auth|session|jwt|token/i.test(message)
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : 'Failed to dismiss change' },
      { status: isAuth ? 401 : 500 },
    )
  }
}
