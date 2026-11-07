import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
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

  const { id } = await params

  // Verify the capture belongs to this workspace (workspace-shared visibility —
  // teammates can read each other's captures).
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('decision')
    .select(`
      id, capture_id, content, source_timestamp, project_id, confirmation, created_at,
      decided_by_member:member!decided_by(id, display_name, avatar_url),
      project:projects!project_id(id, name)
    `)
    .eq('capture_id', id)
    .order('source_timestamp', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const decisions = (data || []).map((d) => {
    const memberData = d.decided_by_member as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    const projectData = d.project as unknown as { id: string; name: string } | null
    return {
      id: d.id,
      capture_id: d.capture_id,
      content: d.content,
      source_timestamp: d.source_timestamp,
      project_id: d.project_id,
      project_name: projectData?.name || null,
      confirmation: d.confirmation,
      decided_by: memberData?.id || null,
      decided_by_name: memberData?.display_name || null,
      decided_by_avatar: memberData?.avatar_url || null,
      created_at: d.created_at,
    }
  })

  return NextResponse.json({ decisions })
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

  const { id } = await params

  // Verify the capture belongs to this user/workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  const body = await request.json()

  if (!body.content) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    capture_id: id,
    content: body.content,
  }

  if (body.source_timestamp !== undefined) insert.source_timestamp = body.source_timestamp
  if (body.project_id) insert.project_id = body.project_id
  if (body.decided_by) insert.decided_by = body.decided_by
  if (body.confirmation) insert.confirmation = body.confirmation

  const { data, error } = await supabase
    .from('decision')
    .insert(insert)
    .select('id, capture_id, content, source_timestamp, project_id, confirmation, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ decision: data })
}
