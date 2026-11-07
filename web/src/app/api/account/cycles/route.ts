import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { createNotificationsForMany, getAllTeamMembers, getMemberByUserId } from '@/lib/notifications'
import { NextResponse, type NextRequest } from 'next/server'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'

export async function GET(request: NextRequest) {
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

  const { searchParams } = request.nextUrl
  const teamId = searchParams.get('team_id')
  const statusFilter = searchParams.get('status')

  if (!teamId) {
    return NextResponse.json({ error: 'team_id is required' }, { status: 400 })
  }

  // Verify team belongs to workspace
  const { data: team } = await supabase
    .from('team')
    .select('id')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  let query = supabase
    .from('cycle')
    .select('id, name, number, start_date, end_date, status, created_at, updated_at')
    .eq('team_id', teamId)

  if (statusFilter) {
    query = query.eq('status', statusFilter)
  }

  query = query.order('number', { ascending: false })

  const { data: cycles, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Compute stats per cycle
  const cycleIds = (cycles || []).map((c) => c.id)

  let statsMap: Record<string, { total: number; completed: number; in_progress: number; not_started: number }> = {}

  if (cycleIds.length > 0) {
    // Chunked + paged: a team's cycles together easily hold more than one
    // 1000-row response, which under-counted (or zeroed) the older cycles.
    const { data: actions, error: actionsError } = await inChunks(cycleIds, 100, (chunkIds) =>
      fetchAllRows(() =>
        supabase
          .from('actions')
          .select('id, cycle_id, workflow_state:workflow_state!status_id(category)')
          .in('cycle_id', chunkIds)
          .neq('confirmation', 'dismissed'),
      ),
    )
    if (actionsError) {
      return NextResponse.json({ error: actionsError.message }, { status: 500 })
    }

    for (const a of actions) {
      const cid = a.cycle_id as string
      if (!statsMap[cid]) {
        statsMap[cid] = { total: 0, completed: 0, in_progress: 0, not_started: 0 }
      }
      statsMap[cid].total++
      const cat = (a.workflow_state as unknown as { category: string } | null)?.category
      if (cat === 'completed' || cat === 'canceled') {
        statsMap[cid].completed++
      } else if (cat === 'started') {
        statsMap[cid].in_progress++
      } else {
        statsMap[cid].not_started++
      }
    }
  }

  const result = (cycles || []).map((c) => ({
    ...c,
    total_actions: statsMap[c.id]?.total || 0,
    completed_actions: statsMap[c.id]?.completed || 0,
    in_progress_actions: statsMap[c.id]?.in_progress || 0,
    not_started_actions: statsMap[c.id]?.not_started || 0,
  }))

  return NextResponse.json({ cycles: result })
}

export async function POST(request: NextRequest) {
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
  const { team_id, name, start_date, end_date } = body as {
    team_id?: string
    name?: string
    start_date?: string
    end_date?: string
  }

  if (!team_id || !start_date || !end_date) {
    return NextResponse.json(
      { error: 'team_id, start_date, and end_date are required' },
      { status: 400 },
    )
  }

  if (new Date(end_date) <= new Date(start_date)) {
    return NextResponse.json(
      { error: 'end_date must be after start_date' },
      { status: 400 },
    )
  }

  const insertData: Record<string, unknown> = {
    team_id,
    start_date,
    end_date,
  }
  if (name?.trim()) insertData.name = name.trim()

  const { data, error } = await supabase
    .from('cycle')
    .insert(insertData)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Notify team members about new cycle (non-blocking)
  if (data.status === 'active') {
    const teamMembers = await getAllTeamMembers(team_id)
    const actorMember = await getMemberByUserId(workspaceId, user.id)

    // Get team name for notification
    const { data: teamData } = await supabase
      .from('team')
      .select('name')
      .eq('id', team_id)
      .single()

    createNotificationsForMany(teamMembers, {
      workspaceId,
      type: 'cycle_started',
      title: `Sprint ${data.number} has started for ${teamData?.name || 'your team'}`,
      actorId: actorMember?.id,
      targetType: 'cycle',
      targetId: data.id,
      // The team opens its board from the banner (notification-panel.tsx).
      metadata: { cycle_number: data.number, team_name: teamData?.name, team_id },
    })
  }

  return NextResponse.json({ cycle: data })
}
