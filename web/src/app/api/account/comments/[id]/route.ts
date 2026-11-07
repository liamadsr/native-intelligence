import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { notFound } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  if (!body.body?.trim()) return NextResponse.json({ error: 'Body is required' }, { status: 400 })

  // Only the author can edit — RLS enforces this, but we also check
  const { data, error } = await supabase
    .from('comment')
    .update({ body: body.body.trim() })
    .eq('id', id)
    .eq('author_id', member.id)
    .select('id, body, author_id, parent_id, created_at, edited_at, author:member!author_id(id, display_name, avatar_url)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  if (!data) return NextResponse.json({ error: 'Comment not found or not authorized' }, { status: 404 })

  const author = data.author as unknown as { id: string; display_name: string; avatar_url: string | null } | null
  return NextResponse.json({
    comment: {
      id: data.id,
      body: data.body,
      author_id: data.author_id,
      author_name: author?.display_name || null,
      author_avatar: author?.avatar_url || null,
      parent_id: data.parent_id,
      created_at: data.created_at,
      edited_at: data.edited_at,
    },
  })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!member) return NextResponse.json({ error: 'Not a member' }, { status: 403 })

  const { id } = await params
  const { data: deleted, error } = await supabase
    .from('comment')
    .delete()
    .eq('id', id)
    .eq('author_id', member.id)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  // Not theirs (someone else's, a guest's or a former member's) or gone: never ok.
  if (!deleted || deleted.length === 0) return notFound('Comment not found')
  return NextResponse.json({ success: true })
}
