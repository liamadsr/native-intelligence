import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getAllComments, createComment, resolveComment, parseAnchorFields } from '@/lib/comments'
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

  // Verify document belongs to this workspace
  const { data: doc } = await supabase
    .from('document')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  const result = await getAllComments(supabase, 'document', id)
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

  const anchor = parseAnchorFields(body)

  const result = await createComment(supabase, 'document', id, member.id, body.body.trim(), body.parent_id, anchor)
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 })

  // Fire comment notifications (non-blocking)
  sendCommentNotifications({
    supabase,
    workspaceId,
    commentableType: 'document',
    commentableId: id,
    authorMemberId: member.id,
    commentBody: body.body.trim(),
    commentId: result.comment!.id,
    parentId: body.parent_id,
  })

  return NextResponse.json({ comment: result.comment }, { status: 201 })
}

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

  const body = await request.json()
  const { comment_id, is_resolved } = body

  if (!comment_id || typeof comment_id !== 'string') {
    return NextResponse.json({ error: 'comment_id is required' }, { status: 400 })
  }
  if (typeof is_resolved !== 'boolean') {
    return NextResponse.json({ error: 'is_resolved must be a boolean' }, { status: 400 })
  }

  const result = await resolveComment(supabase, comment_id, is_resolved)
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 })

  return NextResponse.json({ comment: result.comment })
}
