import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { notFound } from '@/lib/api-errors'
import { applyCommentMentions, fenceCommentMentions } from '@/lib/comment-mentions'
import type { CommentableType } from '@/lib/comments'
import { hasMention } from '@/lib/team-chat/compose'
import { tidyLabeledMentionRefs } from '@/lib/entity-links/mentionable'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The stored member mentions whose `@name` the edited words still hold, for a
 * client that sends no `mentions` (one from before migration 671): their names
 * are resolved and matched, so an edit that drops `@Rosa` drops her mention.
 */
async function membersStillNamed(
  supabase: SupabaseClient,
  workspaceId: string,
  stored: unknown,
  body: string,
): Promise<string[]> {
  if (!Array.isArray(stored) || stored.length === 0 || !body.includes('@')) return []
  const ids = stored.filter((id): id is string => typeof id === 'string')
  if (ids.length === 0) return []
  const { data } = await supabase.from('member').select('id, display_name').eq('workspace_id', workspaceId).in('id', ids)
  return ((data ?? []) as Array<{ id: string; display_name: string | null }>)
    .filter((m) => hasMention(body, m.display_name ?? ''))
    .map((m) => m.id)
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

  const { id } = await params
  const body = await request.json()
  if (!body.body?.trim()) return NextResponse.json({ error: 'Body is required' }, { status: 400 })
  const text = body.body.trim()

  // What the comment mentions now (the author's own row), for the author check
  // and for an older client that sends no mentions/records: those are kept only
  // while the edited words still name them.
  const { data: current } = await supabase
    .from('comment')
    .select('mentions, record_mentions, commentable_type, commentable_id')
    .eq('id', id)
    .eq('author_id', member.id)
    .maybeSingle()
  if (!current) return NextResponse.json({ error: 'Comment not found or not authorized' }, { status: 404 })

  const rawMentions = body.mentions !== undefined
    ? body.mentions
    : await membersStillNamed(supabase, workspaceId, current.mentions, text)
  const rawRecords = body.records !== undefined ? body.records : (current.record_mentions ?? [])
  // Fence what it @-mentions (teammates, records), kept only while `@label` is
  // still in the edited words (src/lib/comment-mentions.ts).
  const mentions = await fenceCommentMentions(supabase, { workspaceId, userId: user.id }, { mentions: rawMentions, records: rawRecords }, text)

  // Only the author can edit — RLS enforces this, but we also check
  const { data, error } = await supabase
    .from('comment')
    .update({ body: text, mentions: mentions.memberIds, record_mentions: mentions.records })
    .eq('id', id)
    .eq('author_id', member.id)
    .select('id, body, author_id, parent_id, created_at, edited_at, mentions, record_mentions, author:member!author_id(id, display_name, avatar_url)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  if (!data) return NextResponse.json({ error: 'Comment not found or not authorized' }, { status: 404 })

  // The record the comment is on mentions each record named (a `mentions` edge,
  // add-only), and a private record is shared with the teammates mentioned
  // beside it, exactly as a new comment does (non-blocking; never throws).
  if (current.commentable_type && current.commentable_id) {
    void applyCommentMentions(supabase, {
      workspaceId,
      userId: user.id,
      memberId: member.id,
      commentable: { type: current.commentable_type as CommentableType, id: current.commentable_id as string },
      mentions,
    })
  }

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
      mentions: Array.isArray(data.mentions) ? data.mentions : [],
      record_mentions: tidyLabeledMentionRefs(data.record_mentions),
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
