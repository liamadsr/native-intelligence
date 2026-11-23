/**
 * WHAT A COMMENT @-MENTIONS (docs/plans/mentions-everywhere.md): teammates
 * and records, in the one mention format, stored on the comment (migration
 * 671) as team chat stores a message's (474, 480). Server only.
 *
 *   fenceCommentMentions  what the client sent, kept only while its `@label`
 *                         is in the words: members of this workspace, and
 *                         records the author may read (a foreign or private id
 *                         is dropped, never an error).
 *   applyCommentMentions  after the comment is saved: the record the comment
 *                         is on mentions each record (a `mentions` edge, so
 *                         its "Referenced in" lists it), and a private record
 *                         the author may share is opened, view only, to the
 *                         teammates mentioned beside it (decision 2: a mention
 *                         shares, as team chat's does).
 *
 * The edges are ADD-ONLY: they run from the record, which many comments
 * share, so an edited or deleted comment takes none back.
 * Nothing here throws: a mention is never worth failing the comment.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommentableType } from '@/lib/comments'
import { addEntityGrant } from '@/lib/entity-access/store'
import { MENTION_SHARE_SKIP_TYPES, isGrantableType } from '@/lib/entity-access/model'
import { shareConversationWithMembers } from '@/lib/chat/conversation-share'
import { shareMentionedMail } from '@/lib/email-share/share-on-mention'
import { MAX_MENTIONED_RECORDS, type LabeledMentionRef } from '@/lib/entity-links/mentionable'
import { syncMentions } from '@/lib/entity-links/mentions'
import { fenceRecordMentions } from '@/lib/team-chat/record-mentions'

export interface CommentMentions {
  memberIds: string[]
  records: LabeledMentionRef[]
}

export const NO_COMMENT_MENTIONS: CommentMentions = { memberIds: [], records: [] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The most grants one comment makes (records × teammates). */
const MAX_GRANTS = 20

/** A comment body's `mentions` (member ids) and `records`, fenced for its author. */
export async function fenceCommentMentions(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  raw: { mentions?: unknown; records?: unknown },
  body: string,
): Promise<CommentMentions> {
  try {
    const asked = Array.isArray(raw.mentions)
      ? [...new Set(raw.mentions.filter((id): id is string => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()))].slice(0, MAX_MENTIONED_RECORDS)
      : []
    const [members, records] = await Promise.all([
      asked.length && body.includes('@')
        ? supabase.from('member').select('id').eq('workspace_id', scope.workspaceId).in('id', asked)
        : Promise.resolve({ data: [] as unknown[], error: null }),
      fenceRecordMentions(supabase, scope, raw.records, body),
    ])
    const found = new Set(members.error ? [] : ((members.data ?? []) as Array<{ id: string }>).map((m) => m.id))
    return { memberIds: asked.filter((id) => found.has(id)), records }
  } catch (err) {
    console.warn('[comment-mentions] fence threw:', err instanceof Error ? err.message : 'unknown')
    return NO_COMMENT_MENTIONS
  }
}

/** The edges and the shares a saved comment's mentions make. Never throws. */
export async function applyCommentMentions(
  supabase: SupabaseClient,
  input: {
    workspaceId: string
    userId: string
    memberId: string
    commentable: { type: CommentableType; id: string }
    mentions: CommentMentions
  },
): Promise<void> {
  const { mentions } = input
  if (mentions.records.length === 0) return
  try {
    const result = await syncMentions(supabase, {
      workspaceId: input.workspaceId,
      source: input.commentable,
      targets: mentions.records.map(({ type, id }) => ({ type, id })),
      userId: input.userId,
      memberId: input.memberId,
      fenced: true,
      addOnly: true,
    })
    if (result.error) console.warn(`[comment-mentions] edges for ${input.commentable.type}=${input.commentable.id} failed:`, result.error)

    // A mention shares: each grantable record, with each teammate mentioned
    // beside it. The grant's own insert policy decides (492: only someone who
    // may share the record), so one the author can't share, or one a teammate
    // already has, is simply not made.
    const others = mentions.memberIds.filter((id) => id !== input.memberId)
    let made = 0
    for (const record of mentions.records) {
      // A spreadsheet or a canvas is shared only from its Share button (decision 12).
      if (!isGrantableType(record.type) || MENTION_SHARE_SKIP_TYPES.has(record.type)) continue
      for (const memberId of others) {
        if (made >= MAX_GRANTS) break
        made++
        const granted = await addEntityGrant(supabase, { workspaceId: input.workspaceId, memberId: input.memberId }, record.type, record.id, { kind: 'member', id: memberId }, 'view', 'mention')
        if ('error' in granted && granted.error === 'failed') console.warn('[comment-mentions] share failed:', granted.message)
      }
    }

    // A mentioned agent chat of the author's OWN (fenced to them at mention
    // time) is shared read-only with the teammates mentioned beside it
    // (decision 1). conversation is not a grant kind, so this is its own path:
    // the share's insert policy still refuses a chat the author doesn't own.
    if (others.length) {
      const conversationIds = [...new Set(mentions.records.filter((r) => r.type === 'conversation').map((r) => r.id))]
      for (const conversationId of conversationIds) {
        await shareConversationWithMembers(supabase, { workspaceId: input.workspaceId, conversationId, userId: input.userId, memberIds: others })
      }
    }

    // A mentioned mail thread of the author's OWN is shared live, view only,
    // with the teammates mentioned beside it (decision 1), through the one
    // shared helper (src/lib/email-share/share-on-mention.ts) that documents
    // and descriptions also use. Mail is not a grant kind and is not stored:
    // the share is email_thread_share (673), read live on open, written with
    // the service role (the helper calls getServiceClient). authorUserId is the
    // comment author, so only their OWN thread is ever shared; the share verifies
    // that with its own reads. A comment has no previous text, so every
    // (thread, teammate) pair is new, which keeps the old behaviour exactly.
    if (others.length) {
      await shareMentionedMail(supabase, {
        workspaceId: input.workspaceId,
        authorUserId: input.userId,
        authorMemberId: input.memberId,
        mentions: mentions.records,
        resolvedMemberIds: others,
        // The comment carried the mention; applyCommentMentions does not
        // receive the comment's own id, so only the kind is recorded.
        source: { type: 'comment' },
      })
    }
  } catch (err) {
    console.warn('[comment-mentions] apply threw:', err instanceof Error ? err.message : 'unknown')
  }
}
