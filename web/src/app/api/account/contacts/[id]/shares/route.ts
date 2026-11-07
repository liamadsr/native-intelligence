import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { forbidden, notFound } from '@/lib/api-errors'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  // Verify contact exists and user can see it (RLS handles visibility)
  const { data: contact } = await supabase
    .from('contact')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

  const { data: shares, error } = await supabase
    .from('contact_share')
    .select(`
      *,
      shared_with_member:member!shared_with_member_id(id, display_name, avatar_url),
      shared_with_team:team!shared_with_team_id(id, name, icon, color),
      shared_by:member!shared_by_member_id(id, display_name)
    `)
    .eq('contact_id', id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ shares: shares || [] })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 403 })

  // Verify contact exists (RLS will check if user can see it)
  const { data: contact } = await supabase
    .from('contact')
    .select('id, created_by_member_id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

  const body = await request.json()
  const { target_type, target_id, access_level = 'view' } = body

  if (!target_type || !target_id) {
    return NextResponse.json({ error: 'target_type and target_id required' }, { status: 400 })
  }

  if (!['member', 'team'].includes(target_type)) {
    return NextResponse.json({ error: 'target_type must be member or team' }, { status: 400 })
  }

  if (!['view', 'edit'].includes(access_level)) {
    return NextResponse.json({ error: 'access_level must be view or edit' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    contact_id: id,
    workspace_id: workspaceId,
    shared_by_member_id: member.id,
    access_level,
  }

  if (target_type === 'member') {
    insert.shared_with_member_id = target_id
  } else {
    insert.shared_with_team_id = target_id
  }

  const { data: share, error } = await supabase
    .from('contact_share')
    .insert(insert)
    .select(`
      *,
      shared_with_member:member!shared_with_member_id(id, display_name, avatar_url),
      shared_with_team:team!shared_with_team_id(id, name, icon, color),
      shared_by:member!shared_by_member_id(id, display_name)
    `)
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Already shared with this target' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ share })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params
  const { searchParams } = request.nextUrl
  const shareId = searchParams.get('share_id')

  if (!shareId) {
    return NextResponse.json({ error: 'share_id required' }, { status: 400 })
  }

  // RLS on contact_share ensures only creator/admin can delete. A refused row
  // is skipped without an error, so count the delete rather than assume it.
  const { error, count } = await supabase
    .from('contact_share')
    .delete({ count: 'exact' })
    .eq('id', shareId)
    .eq('contact_id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!count) {
    const { data: visible } = await supabase
      .from('contact_share')
      .select('id')
      .eq('id', shareId)
      .eq('contact_id', id)
      .maybeSingle()
    return visible
      ? forbidden("Only the contact's creator or a workspace admin can remove a share")
      : notFound('Share not found')
  }

  return NextResponse.json({ success: true })
}
