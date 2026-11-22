/**
 * A company's discussion (migration 679): the contact comments' shape, with
 * the company's own visibility (its row policy, read as the caller).
 */
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getComments, createComment } from '@/lib/comments'
import { sendCommentNotifications } from '@/lib/comment-notifications'
import { applyCommentMentions, fenceCommentMentions } from '@/lib/comment-mentions'
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

  // The company, as the caller's RLS shows it: its comments have the company's own visibility (679)
  const { data: company } = await supabase
    .from('company')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  const result = await getComments(supabase, 'company', id)
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
  // Only on a company the caller can see (the insert policy holds it too).
  const { data: company } = await supabase.from('company').select('id').eq('id', id).eq('workspace_id', workspaceId).maybeSingle()
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
  const body = await request.json()
  if (!body.body?.trim()) return NextResponse.json({ error: 'Body is required' }, { status: 400 })

  // What it @-mentions (teammates, records), fenced for the author before it is stored.
  const mentions = await fenceCommentMentions(supabase, { workspaceId, userId: user.id }, { mentions: body.mentions, records: body.records }, body.body.trim())
  const result = await createComment(supabase, 'company', id, member.id, body.body.trim(), body.parent_id, undefined, mentions)
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 })

  // The record mentions each record named, and a mention shares (non-blocking).
  void applyCommentMentions(supabase, { workspaceId, userId: user.id, memberId: member.id, commentable: { type: 'company', id }, mentions })

  // Fire comment notifications (non-blocking)
  sendCommentNotifications({
    supabase,
    workspaceId,
    commentableType: 'company',
    commentableId: id,
    authorMemberId: member.id,
    commentBody: body.body.trim(),
    commentId: result.comment!.id,
    parentId: body.parent_id,
    mentionedMemberIds: mentions.memberIds,
  })

  return NextResponse.json({ comment: result.comment }, { status: 201 })
}
