import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { inngest } from '@/lib/inngest/client'
import { NextResponse, type NextRequest } from 'next/server'

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

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.status !== undefined) updates.status = body.status
  if (body.target_date !== undefined) updates.target_date = body.target_date
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order

  // Verify milestone belongs to a project in this workspace. Also captures
  // the previous status so we only emit `flow/entity.status_changed` on a
  // real transition.
  const { data: milestone } = await supabase
    .from('milestone')
    .select('id, status, project:project_id(workspace_id)')
    .eq('id', id)
    .single()

  const proj = milestone?.project as unknown as { workspace_id: string } | null
  if (!milestone || proj?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const previousStatus = (milestone.status as string | null) ?? null

  const { data, error } = await supabase
    .from('milestone')
    .update(updates)
    .eq('id', id)
    .select('id, name, description, status, target_date, sort_order, created_at, updated_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Fire any Flows tied to this milestone status transition. team_id is
  // null — milestones are workspace-scoped via their parent project.
  if (body.status !== undefined && body.status !== previousStatus) {
    inngest
      .send({
        name: 'flow/entity.status_changed',
        data: {
          entity_type: 'milestone',
          entity_id: id,
          workspace_id: workspaceId,
          team_id: null,
          from_status_id: previousStatus,
          to_status_id: body.status,
          actor_user_id: user.id,
          fired_at: new Date().toISOString(),
        },
      })
      .catch((err) => {
        console.error('[flows] inngest.send failed', err)
      })
  }

  return NextResponse.json({ milestone: data })
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

  // Verify milestone belongs to a project in this workspace
  const { data: milestone } = await supabase
    .from('milestone')
    .select('id, project:project_id(workspace_id)')
    .eq('id', id)
    .single()

  const proj = milestone?.project as unknown as { workspace_id: string } | null
  if (!milestone || proj?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('milestone')
    .delete()
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
