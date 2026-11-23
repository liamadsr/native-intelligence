/**
 * The inbox's read (docs/plans/channels-inbox.md, phase 2): the person's
 * own rows, as the person (their Supabase client, under RLS), in the current
 * workspace. Nothing here widens a read:
 *
 *   notifications  theirs (recipient_id = their member), not archived, the
 *                  plain notices only (a reachable bot's live with the bot:
 *                  plainNotices, as the shell's route splits them). A team
 *                  chat notification stays only while its channel is one they
 *                  may read now (team_chat_channel under 474's policy,
 *                  team_chat_can_read) and isn't archived: one they left, or
 *                  whose team they left, drops out.
 *   mail           their own email_thread_index rows in the workspace's
 *                  mailboxes (getWorkspaceEmailAccountIds), in the inbox,
 *                  "To respond" or important. Subjects are read live on the
 *                  page, as Mail reads them (POST /email/threads/headers).
 *   holds          their own inbox_hold rows (702); none before 702.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { noticeTeammateReach, plainNotices } from '@/lib/bots/notice-reach'
import { getWorkspaceEmailAccountIds } from '@/lib/email/account-scope'
import { applyHolds, mailItems, notificationItems, type InboxHold, type InboxItem, type InboxMailRow, type InboxNotificationRow } from './items'

/** The newest notifications one read takes (an inbox of a few hundred conversations). */
export const INBOX_NOTIFICATIONS_MAX = 300
/** The most mail threads listed. */
export const INBOX_MAIL_MAX = 50

const NOTIFICATION_COLUMNS =
  'id, type, title, body, actor_id, target_type, target_id, context_type, context_id, is_read, group_key, metadata, created_at, actor:member!actor_id(id, display_name, avatar_url)'

const MAIL_COLUMNS = 'id, account_id, provider, provider_thread_id, provider_message_id, folder, last_message_at, is_unread, needs_reply, auto_classified, from_email'

export interface InboxRead {
  items: InboxItem[]
  held: InboxItem[]
  /** Mail rows by index id, for the page's header fetch (subject, sender, preview). */
  mail: Array<InboxMailRow & { provider: string | null; provider_message_id: string | null; folder: string | null }>
}

function isMissingRelation(error: { code?: string; message?: string } | null | undefined, name: string): boolean {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find/i.test(error.message ?? '')) && (error.message ?? '').includes(name)
}

export async function readInbox(
  supabase: SupabaseClient,
  scope: { userId: string; workspaceId: string; memberId: string },
  now: Date = new Date(),
): Promise<InboxRead> {
  const reach = await noticeTeammateReach(supabase, { userId: scope.userId, recipientIds: [scope.memberId] })
  const accountIds = await getWorkspaceEmailAccountIds(supabase, scope.userId, scope.workspaceId).catch(() => [] as string[])

  const [notices, holds, mail] = await Promise.all([
    plainNotices(supabase.from('notification').select(NOTIFICATION_COLUMNS).eq('recipient_id', scope.memberId).eq('is_archived', false), reach.orphans)
      .order('created_at', { ascending: false })
      .limit(INBOX_NOTIFICATIONS_MAX),
    supabase.from('inbox_hold').select('item_key, held_until, held_at').eq('user_id', scope.userId).eq('workspace_id', scope.workspaceId),
    accountIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from('email_thread_index')
          .select(MAIL_COLUMNS)
          .eq('user_id', scope.userId)
          .eq('workspace_id', scope.workspaceId)
          .in('account_id', accountIds)
          .eq('folder', 'inbox')
          .or('needs_reply.eq.true,auto_classified.eq.important')
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(INBOX_MAIL_MAX),
  ])
  if (notices.error) throw new Error(`inbox: notifications read failed: ${notices.error.message}`)
  if (holds.error && !isMissingRelation(holds.error, 'inbox_hold')) throw new Error(`inbox: holds read failed: ${holds.error.message}`)
  // Mail that can't be read leaves mail out, never the inbox.
  const mailRows = (mail.error ? [] : (mail.data ?? [])) as InboxRead['mail']

  const rows = ((notices.data ?? []) as unknown as InboxNotificationRow[]).map((r) => ({
    ...r,
    actor: Array.isArray(r.actor) ? ((r.actor as unknown[])[0] as InboxNotificationRow['actor']) ?? null : r.actor ?? null,
  }))
  const readable = await readableChannels(supabase, rows)
  const visible = rows.filter((r) => {
    if (r.type !== 'team_chat_message') return true
    const channelId = teamChatChannelOf(r)
    return !!channelId && readable.has(channelId)
  })

  const all = [...notificationItems(visible), ...mailItems(mailRows)]
  const { listed, held } = applyHolds(all, holds.error ? [] : ((holds.data ?? []) as InboxHold[]), now)
  return { items: listed, held, mail: mailRows }
}

function teamChatChannelOf(row: InboxNotificationRow): string | null {
  const fromMeta = row.metadata && typeof row.metadata.channel_id === 'string' ? row.metadata.channel_id : null
  return fromMeta ?? (row.context_type === 'team_chat_channel' ? row.context_id : null)
}

/** Of the channels these team chat notifications name, the ones the person may read now (474's policy) and not archived. */
async function readableChannels(supabase: SupabaseClient, rows: readonly InboxNotificationRow[]): Promise<Set<string>> {
  const ids = [...new Set(rows.filter((r) => r.type === 'team_chat_message').map(teamChatChannelOf).filter((id): id is string => !!id))]
  if (ids.length === 0) return new Set()
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('team_chat_channel').select('id').in('id', ids.slice(i, i + 150)).is('archived_at', null)
    if (error) throw new Error(`inbox: channels read failed: ${error.message}`)
    for (const row of (data ?? []) as Array<{ id: string }>) out.add(row.id)
  }
  return out
}
