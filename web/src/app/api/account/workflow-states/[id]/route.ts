import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

const STATE_FIELDS = 'id, team_id, name, category, color, sort_order, is_default, description, created_at'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params
  const body = await request.json()

  // Fetch the state to get team_id and verify workspace
  const { data: existing } = await supabase
    .from('workflow_state')
    .select('id, team_id, team:team!team_id(workspace_id)')
    .eq('id', id)
    .single()

  if (!existing || (existing.team as unknown as { workspace_id: string })?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Workflow state not found' }, { status: 404 })
  }

  // If setting as default, unset existing default for this team first
  if (body.is_default === true) {
    await supabase
      .from('workflow_state')
      .update({ is_default: false })
      .eq('team_id', existing.team_id)
      .eq('is_default', true)
  }

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.color !== undefined) updates.color = body.color
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order
  if (body.is_default !== undefined) updates.is_default = body.is_default
  if (body.description !== undefined) updates.description = body.description

  const { data, error } = await supabase
    .from('workflow_state')
    .update(updates)
    .eq('id', id)
    .select(STATE_FIELDS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'A workflow state with that name already exists in this team' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ state: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params

  // Check if any actions reference this state
  const { count } = await supabase
    .from('actions')
    .select('id', { count: 'exact', head: true })
    .eq('status_id', id)

  if (count && count > 0) {
    return NextResponse.json(
      { error: `Cannot delete workflow state: ${count} action(s) still reference it` },
      { status: 409 },
    )
  }

  // Verify it belongs to a team in this workspace
  const { data: state } = await supabase
    .from('workflow_state')
    .select('id, team:team!team_id(workspace_id)')
    .eq('id', id)
    .single()

  if (!state || (state.team as unknown as { workspace_id: string })?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Workflow state not found' }, { status: 404 })
  }

  // count: 'exact' because workflow_state RLS (owner/admin/team lead manage,
  // migration 020) skips a refused row without an error, which read as
  // success. The state was visible just above, so 0 rows means refused.
  const { error, count: deleted } = await supabase
    .from('workflow_state')
    .delete({ count: 'exact' })
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!deleted) {
    return forbidden('Only a workspace owner or admin, or the team lead, can delete a workflow state')
  }

  return NextResponse.json({ success: true })
}
