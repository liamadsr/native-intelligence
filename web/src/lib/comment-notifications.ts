import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'
import { getServiceClient } from '@/lib/admin'

interface CommentNotificationParams {
  supabase: SupabaseClient
  workspaceId: string
  commentableType: 'action' | 'capture' | 'document' | 'project' | 'contact'
  commentableId: string
  authorMemberId: string
  commentBody: string
  commentId: string
  parentId?: string
}

/**
 * Send notifications for a new comment. Handles:
 * - comment_reply: if replying to a specific comment, notify parent author
 * - comment_added: notify entity owner + previous commenters
 *
 * Non-blocking — fire and forget.
 */
export async function sendCommentNotifications(params: CommentNotificationParams): Promise<void> {
  try {
    const service = getServiceClient()

    // Get author name for notification title
    const { data: author } = await service
      .from('member')
      .select('display_name')
      .eq('id', params.authorMemberId)
      .single()
    const actorName = author?.display_name || 'Someone'

    // Get the parent entity title for context
    let parentTitle = ''
    // Set for a private document: the one member who may hear about it.
    let privateTo: string | null | undefined
    if (params.commentableType === 'action') {
      const { data } = await service
        .from('actions')
        .select('identifier, title')
        .eq('id', params.commentableId)
        .single()
      parentTitle = data ? `${data.identifier} ${data.title}` : 'an action'
    } else if (params.commentableType === 'capture') {
      const { data } = await service
        .from('captures')
        .select('title')
        .eq('id', params.commentableId)
        .single()
      parentTitle = data?.title || 'a capture'
    } else if (params.commentableType === 'document') {
      const { data } = await service
        .from('document')
        .select('title, visibility, created_by')
        .eq('id', params.commentableId)
        .single()
      parentTitle = data?.title || 'a document'
      // A private document is its creator's alone (migration 369): someone who
      // commented while it was shared hears nothing of it.
      if (data?.visibility === 'private') privateTo = data.created_by ?? null
    } else if (params.commentableType === 'project') {
      const { data } = await service
        .from('projects')
        .select('name')
        .eq('id', params.commentableId)
        .single()
      parentTitle = data?.name || 'a project'
    } else {
      // A contact's name is not repeated into notices: contacts can be private.
      parentTitle = `a ${params.commentableType}`
    }

    const commentPreview = params.commentBody.substring(0, 200)
    const recipients = new Set<string>()
    // Who already got the reply notice: they get no second comment_added.
    const notified = new Set<string>()

    // 1. If this is a reply, notify the parent comment author
    if (params.parentId) {
      const { data: parentComment } = await service
        .from('comment')
        .select('author_id')
        .eq('id', params.parentId)
        .single()

      if (
        parentComment?.author_id &&
        parentComment.author_id !== params.authorMemberId &&
        (privateTo === undefined || parentComment.author_id === privateTo)
      ) {
        await createNotification({
          workspaceId: params.workspaceId,
          recipientId: parentComment.author_id,
          type: 'comment_reply',
          title: `${actorName} replied to your comment`,
          body: params.commentBody.substring(0, 100),
          actorId: params.authorMemberId,
          targetType: params.commentableType,
          targetId: params.commentableId,
          metadata: {
            comment_preview: commentPreview,
            parent_comment_id: params.parentId,
            comment_id: params.commentId,
          },
        })
        notified.add(parentComment.author_id)
      }
    }

    // 2. Notify entity owner
    if (params.commentableType === 'action') {
      const { data } = await service
        .from('actions')
        .select('assignee_id')
        .eq('id', params.commentableId)
        .single()
      if (data?.assignee_id) recipients.add(data.assignee_id)
    } else if (params.commentableType === 'capture') {
      const { data } = await service
        .from('captures')
        .select('user_id')
        .eq('id', params.commentableId)
        .single()
      if (data?.user_id) {
        // Resolve user_id to member_id
        const { data: member } = await service
          .from('member')
          .select('id')
          .eq('user_id', data.user_id)
          .eq('workspace_id', params.workspaceId)
          .single()
        if (member) recipients.add(member.id)
      }
    } else if (params.commentableType === 'document') {
      const { data } = await service
        .from('document')
        .select('created_by')
        .eq('id', params.commentableId)
        .single()
      if (data?.created_by) recipients.add(data.created_by)
    }

    // 3. Previous commenters on this entity
    const { data: prevComments } = await service
      .from('comment')
      .select('author_id')
      .eq('commentable_type', params.commentableType)
      .eq('commentable_id', params.commentableId)
      .neq('author_id', params.authorMemberId)

    if (prevComments) {
      for (const c of prevComments) {
        recipients.add(c.author_id)
      }
    }

    // Remove the actor
    recipients.delete(params.authorMemberId)
    if (privateTo !== undefined) {
      for (const r of [...recipients]) if (r !== privateTo) recipients.delete(r)
    }

    // Send comment_added to all recipients who haven't already gotten a reply notification
    for (const recipientId of recipients) {
      if (notified.has(recipientId)) continue
      await createNotification({
        workspaceId: params.workspaceId,
        recipientId,
        type: 'comment_added',
        title: `${actorName} commented on ${parentTitle}`,
        body: params.commentBody.substring(0, 100),
        actorId: params.authorMemberId,
        targetType: params.commentableType,
        targetId: params.commentableId,
        metadata: {
          comment_preview: commentPreview,
          comment_id: params.commentId,
        },
      })
    }
  } catch (err) {
    console.error('Comment notification error:', err)
  }
}
