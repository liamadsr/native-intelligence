/**
 * Who hears about a comment on a canvas or a spreadsheet.
 *
 * These two keep their comments in tables of their own (682, 675), so the
 * shared comment notifier (comment-notifications.ts, which reads `comment`)
 * does not know them. This is the same idea for them, and smaller:
 *
 *   mentioned      each teammate the comment @-mentions
 *   comment_reply  the author of the thread a reply was written on
 *
 * Nobody else is told (no "someone commented" to every past commenter).
 *
 * THE RULE: a member hears about a comment only while they can open the
 * record it is on. That is asked of the database's own read rule, for that
 * member, at the moment of sending (canvas_visible_to, spreadsheet_entity_
 * visible_to), with the service role, because the author's session cannot
 * answer for someone else. Unknown reads as no: a failed check, a member with
 * no user, a record that is gone, all send nothing. So a private canvas or
 * spreadsheet never puts its title or a comment's words in front of anyone
 * who could not have opened it.
 *
 * A comment the assistant wrote for someone is that person's; the notice says
 * the assistant wrote it. Nothing here throws: a notice is never worth
 * failing the comment that is already saved.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { createNotification } from '@/lib/notifications'

export type CommentedRecordKind = 'canvas' | 'spreadsheet'

const TABLES: Record<CommentedRecordKind, { record: string; comment: string; noun: string }> = {
  canvas: { record: 'canvas', comment: 'canvas_comment', noun: 'a canvas' },
  spreadsheet: { record: 'spreadsheet', comment: 'spreadsheet_comment', noun: 'a spreadsheet' },
}

export interface RecordCommentNotice {
  kind: CommentedRecordKind
  recordId: string
  workspaceId: string
  authorMemberId: string
  commentId: string
  body: string
  /** The thread's first comment, when this is a reply. */
  parentId?: string | null
  /** The teammates the comment @-mentions, already fenced to the workspace. */
  mentionedMemberIds?: readonly string[]
  /** The assistant wrote it for the author. */
  viaAgent?: boolean
}

/** Can this member open the record? Asked of the record's own read rule; anything unsure is no. */
export async function memberCanOpenRecord(service: SupabaseClient, kind: CommentedRecordKind, recordId: string, workspaceId: string, memberId: string): Promise<boolean> {
  try {
    const { data: m } = await service.from('member').select('user_id').eq('id', memberId).eq('workspace_id', workspaceId).maybeSingle()
    const userId = (m as { user_id?: string | null } | null)?.user_id
    if (!userId) return false
    const { data, error } =
      kind === 'canvas'
        ? await service.rpc('canvas_visible_to', { p_canvas_id: recordId, p_user_id: userId })
        : await service.rpc('spreadsheet_entity_visible_to', { p_id: recordId, p_workspace: workspaceId, p_user: userId })
    return !error && data === true
  } catch {
    return false
  }
}

/** Tell the mentioned teammates, and the thread's author on a reply. Resolves to how many notices were asked for. */
export async function sendRecordCommentNotifications(notice: RecordCommentNotice, deps: { service?: SupabaseClient } = {}): Promise<number> {
  let sent = 0
  try {
    const service = deps.service ?? getServiceClient()
    const t = TABLES[notice.kind]
    const [{ data: author }, { data: record }] = await Promise.all([
      service.from('member').select('display_name').eq('id', notice.authorMemberId).eq('workspace_id', notice.workspaceId).maybeSingle(),
      service.from(t.record).select('title').eq('id', notice.recordId).eq('workspace_id', notice.workspaceId).maybeSingle(),
    ])
    // The record is gone, or is not this workspace's: nobody is told anything.
    if (!record) return 0
    const name = ((author as { display_name?: string | null } | null)?.display_name ?? '').trim() || 'Someone'
    const actor = notice.viaAgent ? `${name}'s assistant` : name
    const title = ((record as { title?: string | null }).title ?? '').trim() || t.noun
    const preview = notice.body.slice(0, 200)

    const asked = new Map<string, boolean>()
    const mayHear = async (memberId: string): Promise<boolean> => {
      if (!asked.has(memberId)) asked.set(memberId, await memberCanOpenRecord(service, notice.kind, notice.recordId, notice.workspaceId, memberId))
      return asked.get(memberId) === true
    }
    const told = new Set<string>([notice.authorMemberId])
    const tell = async (recipientId: string, type: 'mentioned' | 'comment_reply', line: string, extra: Record<string, unknown> = {}) => {
      if (told.has(recipientId)) return
      told.add(recipientId)
      if (!(await mayHear(recipientId))) return
      sent++
      await createNotification({
        workspaceId: notice.workspaceId,
        recipientId,
        type,
        title: line,
        body: notice.body.slice(0, 100),
        actorId: notice.authorMemberId,
        targetType: notice.kind,
        targetId: notice.recordId,
        metadata: { comment_preview: preview, comment_id: notice.commentId, ...(notice.viaAgent ? { via_agent: true } : {}), ...extra },
      })
    }

    // A mention is the stronger notice: whoever is mentioned hears that, and not also "replied".
    for (const id of new Set(notice.mentionedMemberIds ?? [])) await tell(id, 'mentioned', `${actor} mentioned you on ${title}`)

    if (notice.parentId) {
      const { data: parent } = await service.from(t.comment).select('author_id').eq('id', notice.parentId).eq(`${t.record}_id`, notice.recordId).maybeSingle()
      const parentAuthor = (parent as { author_id?: string | null } | null)?.author_id
      if (parentAuthor) await tell(parentAuthor, 'comment_reply', `${actor} replied to your comment on ${title}`, { parent_comment_id: notice.parentId })
    }
  } catch (err) {
    console.warn('[record-comments] notify threw:', err instanceof Error ? err.message : 'unknown')
  }
  return sent
}
