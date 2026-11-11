import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden, notFound } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'
import { requestTeamCallEjections } from '@/lib/team-calls/eject'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
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

  const { id: teamId, memberId } = await params
  const body = await request.json()
  const { team_role } = body

  if (!team_role || !['lead', 'member'].includes(team_role)) {
    return NextResponse.json({ error: 'Invalid team_role' }, { status: 400 })
  }

  // Verify team belongs to workspace
  const { data: team, error: teamErr } = await supabase
    .from('team')
    .select('id')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .single()

  if (teamErr || !team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  // Verify caller is a team lead (or workspace admin/owner) before allowing role changes
  const { data: callerMember } = await supabase
    .from('member')
    .select('id, role')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  const isWorkspaceAdmin = callerMember?.role === 'owner' || callerMember?.role === 'admin'

  if (!isWorkspaceAdmin && callerMember) {
    const { data: callerTeamMember } = await supabase
      .from('team_member')
      .select('team_role')
      .eq('member_id', callerMember.id)
      .eq('team_id', teamId)
      .single()

    if (!callerTeamMember || callerTeamMember.team_role !== 'lead') {
      return NextResponse.json({ error: 'Only team leads or workspace admins can change roles' }, { status: 403 })
    }
  }

  const { data, error } = await supabase
    .from('team_member')
    .update({ team_role })
    .eq('id', memberId)
    .eq('team_id', teamId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ team_member: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
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

  const { id: teamId, memberId } = await params

  // Verify team belongs to workspace
  const { data: team, error: teamErr } = await supabase
    .from('team')
    .select('id')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .single()

  if (teamErr || !team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  // count: 'exact' because team_member RLS (can_manage_team_members: admin or team
  // lead, migration 017) skips a refused row without an error, which read as
  // success.
  const { error, count } = await supabase
    .from('team_member')
    .delete({ count: 'exact' })
    .eq('id', memberId)
    .eq('team_id', teamId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!count) {
    const { data: visible } = await supabase
      .from('team_member')
      .select('id')
      .eq('id', memberId)
      .eq('team_id', teamId)
      .maybeSingle()
    return visible
      ? forbidden('Only a workspace owner or admin, or the team lead, can remove team members')
      : notFound('Team member not found')
  }

  // Out of any call in the team's channels now (the database queued it; this drains it at once).
  await requestTeamCallEjections()
  return NextResponse.json({ success: true })
}
