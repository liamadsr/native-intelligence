import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

const STATE_FIELDS = 'id, team_id, name, category, color, sort_order, is_default, description, created_at'

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

  const teamId = request.nextUrl.searchParams.get('team_id')
  if (!teamId) {
    return NextResponse.json({ error: 'team_id is required' }, { status: 400 })
  }

  // Verify team belongs to this workspace
  const { data: team } = await supabase
    .from('team')
    .select('id')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('workflow_state')
    .select(STATE_FIELDS)
    .eq('team_id', teamId)
    .order('sort_order', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ states: data || [] })
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
  const { team_id, name, category, color, sort_order } = body as {
    team_id?: string
    name?: string
    category?: string
    color?: string
    sort_order?: number
  }

  if (!team_id || !name?.trim() || !category) {
    return NextResponse.json(
      { error: 'team_id, name, and category are required' },
      { status: 400 },
    )
  }

  // Verify team belongs to workspace
  const { data: team } = await supabase
    .from('team')
    .select('id')
    .eq('id', team_id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('workflow_state')
    .insert({
      team_id,
      name: name.trim(),
      category,
      color: color || '#6b7280',
      sort_order: sort_order ?? 0,
    })
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
