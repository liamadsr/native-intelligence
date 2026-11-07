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

  // Verify action belongs to this user's workspace
  const { data: action } = await supabase
    .from('actions')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!action) {
    return NextResponse.json({ error: 'Action not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('action_label')
    .select('label:label(id, name, color)')
    .eq('action_id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const labels = (data || []).map((row) => row.label).filter(Boolean)
  return NextResponse.json({ labels })
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
  const body = await request.json()

  if (!body.label_id) {
    return NextResponse.json({ error: 'label_id is required' }, { status: 400 })
  }

  // Verify action belongs to this workspace (labels are workspace-shared)
  const { data: action } = await supabase
    .from('actions')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!action) {
    return NextResponse.json({ error: 'Action not found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('action_label')
    .insert({ action_id: id, label_id: body.label_id })

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Label already attached' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
