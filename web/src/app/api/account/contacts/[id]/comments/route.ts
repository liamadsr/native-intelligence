import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getComments, createComment } from '@/lib/comments'
import { sendCommentNotifications } from '@/lib/comment-notifications'
import { NextResponse, type NextRequest } from 'next/server'

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

  // Verify contact belongs to this workspace
  const { data: contact } = await supabase
    .from('contact')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

  const result = await getComments(supabase, 'contact', id)
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ comments: result.comments })
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

  const result = await createComment(supabase, 'contact', id, member.id, body.body.trim(), body.parent_id)
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 })

  // Fire comment notifications (non-blocking)
  sendCommentNotifications({
    supabase,
    workspaceId,
    commentableType: 'contact',
    commentableId: id,
    authorMemberId: member.id,
    commentBody: body.body.trim(),
    commentId: result.comment!.id,
    parentId: body.parent_id,
  })

  return NextResponse.json({ comment: result.comment }, { status: 201 })
}
