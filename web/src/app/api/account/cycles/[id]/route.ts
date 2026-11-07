import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
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

  // Verify cycle belongs to a team in this workspace
  const { data: cycle, error } = await supabase
    .from('cycle')
    .select('id, team_id, name, number, start_date, end_date, status, created_at, updated_at, team:team_id(workspace_id)')
    .eq('id', id)
    .single()

  const teamData = cycle?.team as unknown as { workspace_id: string } | null
  if (error || !cycle || teamData?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Cycle not found' }, { status: 404 })
  }

  // Fetch actions in this cycle
  const { data: actions } = await supabase
    .from('actions')
    .select(`
      id, identifier, title, status_id, priority, due_at, assignee_id,
      workflow_state:workflow_state!status_id(id, name, category, color),
      assignee:member!assignee_id(id, display_name, avatar_url)
    `)
    .eq('cycle_id', id)
    .neq('confirmation', 'dismissed')
    .order('priority', { ascending: true })

  const flatActions = (actions || []).map((a) => {
    const ws = a.workflow_state as unknown as { id: string; name: string; category: string; color: string } | null
    const assigneeData = a.assignee as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    return {
      id: a.id,
      identifier: a.identifier,
      title: a.title,
      status_id: a.status_id,
      status_name: ws?.name || '',
      status_category: ws?.category || '',
      status_color: ws?.color || '#6b7280',
      priority: a.priority,
      due_at: a.due_at,
      assignee_id: a.assignee_id,
      assignee_name: assigneeData?.display_name || null,
      assignee_avatar: assigneeData?.avatar_url || null,
    }
  })

  // Compute stats
  let total = 0, completed = 0, in_progress = 0, not_started = 0
  for (const a of flatActions) {
    total++
    if (a.status_category === 'completed' || a.status_category === 'canceled') {
      completed++
    } else if (a.status_category === 'started') {
      in_progress++
    } else {
      not_started++
    }
  }

  return NextResponse.json({
    cycle: {
      ...cycle,
      total_actions: total,
      completed_actions: completed,
      in_progress_actions: in_progress,
      not_started_actions: not_started,
      actions: flatActions,
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
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

  // Verify cycle belongs to a team in this workspace
  const { data: cycleRow } = await supabase
    .from('cycle')
    .select('team_id, team:team_id(workspace_id)')
    .eq('id', id)
    .single()

  const teamWs = cycleRow?.team as unknown as { workspace_id: string } | null
  if (!cycleRow || teamWs?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Cycle not found' }, { status: 404 })
  }

  const body = await request.json()
  const updates: Record<string, unknown> = {}

  if (body.name !== undefined) updates.name = body.name
  if (body.start_date !== undefined) updates.start_date = body.start_date
  if (body.end_date !== undefined) updates.end_date = body.end_date
  if (body.status !== undefined) updates.status = body.status

  // Validate dates if both provided
  const startDate = body.start_date || undefined
  const endDate = body.end_date || undefined
  if (startDate && endDate && new Date(endDate) <= new Date(startDate)) {
    return NextResponse.json(
      { error: 'end_date must be after start_date' },
      { status: 400 },
    )
  }

  // If setting to active, check no other active cycle for this team
  if (body.status === 'active') {
    const { data: existingActive } = await supabase
      .from('cycle')
      .select('id')
      .eq('team_id', cycleRow.team_id)
      .eq('status', 'active')
      .neq('id', id)
      .limit(1)

    if (existingActive && existingActive.length > 0) {
      return NextResponse.json(
        { error: 'Team already has an active cycle' },
        { status: 409 },
      )
    }
  }

  const { data, error } = await supabase
    .from('cycle')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ cycle: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
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

  // Verify cycle belongs to a team in this workspace
  const { data: cycleRow } = await supabase
    .from('cycle')
    .select('team:team_id(workspace_id)')
    .eq('id', id)
    .single()

  const teamWs = cycleRow?.team as unknown as { workspace_id: string } | null
  if (!cycleRow || teamWs?.workspace_id !== workspaceId) {
    return NextResponse.json({ error: 'Cycle not found' }, { status: 404 })
  }

  // count: 'exact' because the cycle delete RLS (team leads and admins,
  // migration 024) skips a refused row without an error, which read as success.
  // The cycle was visible just above, so 0 rows means refused.
  const { error, count } = await supabase.from('cycle').delete({ count: 'exact' }).eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!count) {
    return forbidden('Only a workspace owner or admin, or the team lead, can delete a cycle')
  }

  return NextResponse.json({ success: true })
}
