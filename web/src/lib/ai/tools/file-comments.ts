import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { filterVisibleAttachments } from '@/lib/attachments/visibility'
import { addFileComment, listFileComments, noticeRecord, parseFileTarget, threadsOfFile, type FileTarget } from '@/lib/drive/file-comments'
import { afterRecordComment, fenceRecordCommentMentions } from '@/lib/record-comments/mentions'
import { workspaceEcho } from './_shared'

const MENTION_HELP = 'Teammates to @-mention: their member ids (from list_workspace_members). Write each as @Name in the body too. Only those who can open the file are told.'

/**
 * Comments on a file for the person (migration 711; docs/plans/drive-files.md,
 * phase 4): an uploaded file (attachment_id, from list_attachments or find) or
 * a file sent in team chat (message_id and file_path, from find). Never a mail
 * attachment: its comments are not kept.
 *
 * The tool runs on the service client, so it asks the file's own read rule
 * for the person first: an upload's (filterVisibleAttachments: a capture's, a
 * table row's and a Drive upload's, 709), a chat file's (its message's,
 * entity_visible_to, the channel's readers). A guest's or a linked agent's
 * turn writes no comment as the person. The comment is the person's own,
 * marked as written by their assistant (via_agent, 692's rule), and its
 * mentions are told only when they can open the file.
 */
export function createFileCommentTools(userId: string, supabase: SupabaseClient, workspaceId: string, omitGrants = false) {
  /** The person's member id in the file's workspace, or null. */
  async function memberIn(ws: string): Promise<string | null> {
    const { data } = await supabase.from('member').select('id, role').eq('workspace_id', ws).eq('user_id', userId).maybeSingle()
    return (data as { id?: string } | null)?.id ?? null
  }

  /** The file, if the person may read it: its target, workspace and name. */
  async function readable(input: { attachment_id?: string; message_id?: string; file_path?: string }): Promise<{ ok: true; target: FileTarget; ws: string; name: string } | { ok: false; error: string }> {
    const target = parseFileTarget({ attachment: input.attachment_id, message: input.message_id, path: input.file_path })
    if (!target) return { ok: false, error: 'Name the file: attachment_id for an uploaded file, or message_id and file_path for a file sent in team chat.' }
    if (target.kind === 'attachment') {
      const { data } = await supabase.from('attachments').select('id, workspace_id, user_id, note_id, data_row_id, file_name, from_form').eq('id', target.id).maybeSingle()
      const row = data as { id: string; workspace_id: string; user_id: string | null; note_id: string | null; data_row_id: string | null; file_name: string; from_form?: boolean } | null
      if (!row || row.from_form) return { ok: false, error: 'No such file, or not one this person can read.' }
      const visible = await filterVisibleAttachments(supabase, { workspaceId: row.workspace_id, userId }, [row])
      if (!visible.length) return { ok: false, error: 'No such file, or not one this person can read.' }
      return { ok: true, target, ws: row.workspace_id, name: row.file_name }
    }
    const { data } = await supabase.from('team_chat_message').select('id, workspace_id, deleted_at, attachments').eq('id', target.messageId).maybeSingle()
    const msg = data as { id: string; workspace_id: string; deleted_at: string | null; attachments: Array<{ path?: string; name?: string }> | null } | null
    const file = msg && !msg.deleted_at ? (msg.attachments ?? []).find((a) => a.path === target.path) : undefined
    if (!msg || !file) return { ok: false, error: 'No such file in that message, or not one this person can read.' }
    const { data: can, error } = await supabase.rpc('entity_visible_to', { p_type: 'team_chat_message', p_id: msg.id, p_workspace: msg.workspace_id, p_user: userId })
    if (error || can !== true) return { ok: false, error: 'No such file in that message, or not one this person can read.' }
    return { ok: true, target, ws: msg.workspace_id, name: file.name ?? 'a file' }
  }

  return {
    comment_on_file: tool({
      description:
        "Write a comment on a file for the person: a thread pinned to a place on a PDF's page (page, and x and y as fractions of the page from its top-left corner), a thread about the whole file, or a reply (reply_to, a thread id). The file is an uploaded one (attachment_id) or one sent in team chat (message_id and file_path). The comment is the person's own and is shown as written by their assistant; everyone who can read the file sees it. Use it to leave a note or a question for people, not to answer the person you are talking to. You cannot edit or delete comments. Mail attachments take no comments.",
      inputSchema: z.object({
        attachment_id: z.string().optional().describe('An uploaded file (from list_attachments or find).'),
        message_id: z.string().optional().describe('A team chat message that carries the file (from find).'),
        file_path: z.string().optional().describe("The team chat file's path (from find), with message_id."),
        body: z.string().min(1).max(4000).describe('The words. Plain text.'),
        page: z.number().int().min(1).optional().describe('The page a new thread is pinned to (from 1). Leave out for the whole file.'),
        x: z.number().min(0).max(1).optional().describe('Across the page, 0 (left) to 1 (right). With page.'),
        y: z.number().min(0).max(1).optional().describe('Down the page, 0 (top) to 1 (bottom). With page.'),
        reply_to: z.string().optional().describe('A thread id on this file, to reply on that thread instead of starting one.'),
        mention_member_ids: z.array(z.string()).max(10).optional().describe(MENTION_HELP),
      }),
      execute: async ({ attachment_id, message_id, file_path, body, page, x, y, reply_to, mention_member_ids }) => {
        try {
          if (omitGrants) return { success: false, error: 'Comments are written only on the person’s own turn.' }
          const found = await readable({ attachment_id, message_id, file_path })
          if (!found.ok) return { success: false, error: found.error }
          const me = await memberIn(found.ws)
          if (!me) return { success: false, error: "This person is not a member of that file's workspace." }
          if (page !== undefined && (x === undefined || y === undefined)) return { success: false, error: 'A place on a page needs page, x and y.' }
          if (reply_to) {
            const list = await listFileComments(supabase, found.ws, found.target)
            const thread = list.ok ? threadsOfFile(list.value).find((t) => t.root.id === reply_to) : undefined
            if (!thread) return { success: false, error: 'reply_to is the id of a thread on this file.' }
          }
          const words = body.trim()
          const mentions = await fenceRecordCommentMentions(supabase, { workspaceId: found.ws, userId }, { mentions: mention_member_ids }, words)
          const saved = await addFileComment(
            supabase,
            found.ws,
            me,
            found.target,
            { body: words, parent_id: reply_to ?? null, ...(reply_to ? {} : { page, x, y }), mentions: mentions.memberIds },
            { viaAgent: true },
          )
          if (!saved.ok) return { success: false, error: saved.error }
          await afterRecordComment(supabase, {
            ...noticeRecord(found.target),
            workspaceId: found.ws,
            userId,
            memberId: me,
            commentId: saved.value.id,
            parentId: saved.value.parent_id,
            body: words,
            mentions,
            viaAgent: true,
            ...(found.target.kind === 'chat' ? { recordTitle: found.name } : {}),
          })
          return {
            success: true,
            comment: { id: saved.value.id, thread: saved.value.parent_id ?? saved.value.id, ...(saved.value.page ? { page: saved.value.page } : {}) },
            mentioned: mentions.memberIds.length,
            message: `Commented on "${found.name}" as the person, marked as written by their assistant.`,
            ...workspaceEcho(found.ws),
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : 'Could not comment on the file' }
        }
      },
    }),
  }
}
