/**
 * What a comment on a canvas or a spreadsheet @-mentions, and what follows
 * from it once the comment is saved. The same two steps the app's other
 * comments take (comment-mentions.ts), for the two records that keep their
 * comments in tables of their own:
 *
 *   fence   what was sent, kept only while its `@label` is in the words:
 *           members of this workspace, records the author may read.
 *   after   the record mentions each record named (a `mentions` edge), a
 *           private record the author may share is opened to the teammates
 *           mentioned beside it, and the people concerned are told
 *           (notify.ts: only those who can open the canvas or spreadsheet).
 *
 * `after` never throws and is not awaited by its callers: the comment is
 * already saved.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommentableType } from '@/lib/comments'
import { applyCommentMentions, fenceCommentMentions, NO_COMMENT_MENTIONS, type CommentMentions } from '@/lib/comment-mentions'
import { sendRecordCommentNotifications, type CommentedRecordKind } from './notify'

export { NO_COMMENT_MENTIONS, type CommentMentions }

export const fenceRecordCommentMentions = (
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  raw: { mentions?: unknown; records?: unknown },
  body: string,
): Promise<CommentMentions> => fenceCommentMentions(supabase, scope, raw, body)

export interface SavedRecordComment {
  kind: CommentedRecordKind
  recordId: string
  workspaceId: string
  userId: string
  memberId: string
  commentId: string
  parentId?: string | null
  body: string
  mentions: CommentMentions
  viaAgent?: boolean
  /** An edit: who the comment already mentioned. Only the newly named are told, and nobody is told of a reply again. */
  alreadyMentioned?: readonly string[]
  /** The record's name when it has none of its own (a chat file's name). */
  recordTitle?: string | null
}

/** The linkable record a comment's mentions hang off: a chat file's is the message that carries it. */
const SOURCE_TYPE: Record<SavedRecordComment['kind'], string> = { canvas: 'canvas', spreadsheet: 'spreadsheet', attachment: 'attachment', team_chat_file: 'team_chat_message' }

export async function afterRecordComment(supabase: SupabaseClient, saved: SavedRecordComment): Promise<void> {
  try {
    const edit = saved.alreadyMentioned !== undefined
    const before = new Set(saved.alreadyMentioned ?? [])
    const mentioned = saved.mentions.memberIds.filter((id) => !before.has(id))
    await Promise.all([
      applyCommentMentions(supabase, {
        workspaceId: saved.workspaceId,
        userId: saved.userId,
        memberId: saved.memberId,
        // The edge runs from the record: a canvas, a spreadsheet, a file, or a chat file's message.
        commentable: { type: SOURCE_TYPE[saved.kind] as unknown as CommentableType, id: saved.recordId },
        mentions: saved.mentions,
      }),
      sendRecordCommentNotifications({
        kind: saved.kind,
        recordId: saved.recordId,
        workspaceId: saved.workspaceId,
        authorMemberId: saved.memberId,
        commentId: saved.commentId,
        body: saved.body,
        parentId: edit ? null : saved.parentId,
        mentionedMemberIds: mentioned,
        viaAgent: saved.viaAgent,
        recordTitle: saved.recordTitle,
      }),
    ])
  } catch (err) {
    console.warn('[record-comments] after threw:', err instanceof Error ? err.message : 'unknown')
  }
}
