import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { listMemberEmails } from '@/lib/workspace-member-emails'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(
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

  const { id: teamId } = await params

  // Verify team belongs to this workspace
  const { data: team, error: teamErr } = await supabase
    .from('team')
    .select('id')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .single()

  if (teamErr || !team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('team_member')
    .select('id, team_role, joined_at, member:member_id(id, display_name, avatar_url, role, user_id)')
    .eq('team_id', teamId)
    .order('joined_at', { ascending: true })

  if (error) {
    console.error('Team members fetch error:', error.message, error.code, error.details)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // A member's email is their sign-in address: there is no member.email
  // column, and the legacy user_profiles table has none either (the read this
  // replaced always came back empty), so it is resolved through the admin API
  // (workspace-member-emails.ts), keyed by member id.
  const emailMap: Record<string, string> = {}
  if ((data || []).length > 0) {
    for (const m of await listMemberEmails(workspaceId)) emailMap[m.id] = m.email
  }

  const members = (data || []).map((tm) => {
    const member = tm.member as unknown as Record<string, unknown> | null
    return {
      team_member_id: tm.id,
      team_role: tm.team_role,
      joined_at: tm.joined_at,
      member_id: member?.id,
      display_name: member?.display_name,
      avatar_url: member?.avatar_url,
      workspace_role: member?.role,
      email: emailMap[(member?.id as string) || ''] || '',
    }
  })

  return NextResponse.json({ members })
}

export async function POST(
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

  const { id: teamId } = await params
  const body = await request.json()
  const { member_id, team_role = 'member' } = body

  if (!member_id) {
    return NextResponse.json({ error: 'member_id is required' }, { status: 400 })
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

  const { data, error } = await supabase
    .from('team_member')
    .insert({
      team_id: teamId,
      member_id,
      team_role,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ team_member: data })
}
