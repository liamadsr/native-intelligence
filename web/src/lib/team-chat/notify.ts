/**
 * Team chat messages reach the people they are for (phase 2, migration 560).
 *
 * Who a new message notifies ({@link teamChatRecipients}, pure):
 *   - a DM: everyone in it but the author (a DM is 'all' unless they chose
 *     otherwise);
 *   - a channel: the people it @-mentions, and the members who set the
 *     channel to 'all' (its own messages; a thread's replies stay in the
 *     thread);
 *   - a thread's reply: the thread's people (team_chat_thread_member: the
 *     root's person, everyone who replied, everyone a reply mentioned), and
 *     anyone it mentions;
 *   - the agent's reply: only the person whose agent it is (who asked). The
 *     agent posts its reply once, finished (agent-turn.ts postAsAgent); an
 *     edit never notifies anyone.
 * Never the author, never someone who may not read the channel
 * (team_chat_member_can_read), never someone who muted it, never someone who
 * already read past the message (it was on their screen). One notification
 * per message per person however many rules match (its reason is the first
 * that holds: a mention, the thread, the DM or 'all'); the database holds it
 * to one too (notification_team_chat_message_key).
 *
 * The fan-out ({@link notifyTeamChatMessage}) runs in the `team-chat-notify`
 * Inngest function (src/lib/inngest/team-chat-reach.ts), asked for by
 * {@link requestTeamChatNotify} right after a message is written (the post
 * route, the agent's reply). It writes the `team_chat_message`
 * notifications: in the app at once (the notification context's Realtime
 * toast, the desktop's native banner, whose click opens the channel or the
 * thread on the message), and each one's person is then handed to the email
 * batcher (./email.ts), which writes to them only while they are away.
 *
 * A support conversation (migration 715) is every message, as a DM: our
 * staff's message notifies the customer; the customer's notifies each of our
 * staff too ({@link supportStaffRecipients}), in their own workspace's inbox
 * (the notification is theirs; the message stays in the customer's). Staff
 * are never emailed about it (they aren't members there, so 560's
 * team_chat_readable_messages never reads it for them, and they are left out
 * of what is handed to the email batcher).
 *
 * Privacy: events and step outputs carry ids only; logs carry ids and counts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TeamChatChannelKind, TeamChatMessage } from './types'
import { isUuid } from './types'

export const TEAM_CHAT_NOTIFY_EVENT = 'team-chat/notify.requested' as const
/** The notification type every team chat notification is (migration 560). */
export const TEAM_CHAT_NOTIFICATION_TYPE = 'team_chat_message' as const

/** How loud a channel is for a member (team_chat_member.notify_level). */
export const TEAM_CHAT_NOTIFY_LEVELS = ['all', 'mentions', 'muted'] as const
export type TeamChatNotifyLevel = (typeof TEAM_CHAT_NOTIFY_LEVELS)[number]

export function isTeamChatNotifyLevel(value: unknown): value is TeamChatNotifyLevel {
  return typeof value === 'string' && (TEAM_CHAT_NOTIFY_LEVELS as readonly string[]).includes(value)
}

/** A channel's level when the member chose none: mentions only for a channel, every message in a DM. */
export function defaultNotifyLevel(kind: TeamChatChannelKind): TeamChatNotifyLevel {
  return kind === 'dm' || kind === 'support' ? 'all' : 'mentions'
}

/** The level in effect: the member's own, else the kind's default. */
export function notifyLevelOf(kind: TeamChatChannelKind, stored: unknown): TeamChatNotifyLevel {
  return isTeamChatNotifyLevel(stored) ? stored : defaultNotifyLevel(kind)
}

/**
 * The conversation a message belongs to, as its notifications' group_key: the
 * channel's own messages (a DM's too) are one, each thread another. Reading
 * one reads its notifications (560's team_chat_mark_read and
 * team_chat_mark_thread_read), and the email batches by it.
 */
export function teamChatGroupKey(message: { channel_id: string; thread_root_id: string | null }): string {
  return message.thread_root_id ? `team_chat_thread:${message.thread_root_id}` : `team_chat:${message.channel_id}`
}

/** One row of 560's team_chat_notify_candidates. */
export interface TeamChatNotifyCandidate {
  member_id: string
  user_id: string | null
  is_author: boolean
  in_dm: boolean
  mentioned: boolean
  in_thread: boolean
  /** The message is the agent's reply, and this is the person whose agent it is. */
  asked: boolean
  notify_level: string | null
  can_read: boolean
  read_past: boolean
}

export type TeamChatNotifyReason = 'mention' | 'agent_reply' | 'dm' | 'thread' | 'all'

export interface TeamChatRecipient {
  memberId: string
  userId: string
  reason: TeamChatNotifyReason
}

/** Who a new message notifies, and why (the header's rules). Pure. */
export function teamChatRecipients(
  message: Pick<TeamChatMessage, 'author_kind' | 'thread_root_id'>,
  channelKind: TeamChatChannelKind,
  candidates: readonly TeamChatNotifyCandidate[],
): TeamChatRecipient[] {
  const out = new Map<string, TeamChatRecipient>()
  for (const c of candidates) {
    if (!c.member_id || !c.user_id || out.has(c.member_id)) continue
    if (c.is_author || !c.can_read || c.read_past) continue
    const level = notifyLevelOf(channelKind, c.notify_level)
    if (level === 'muted') continue
    let reason: TeamChatNotifyReason | null = null
    if (message.author_kind === 'agent') {
      // The agent's reply is for the person who asked, and no one else.
      reason = c.asked ? 'agent_reply' : null
    } else if (c.mentioned) {
      reason = 'mention'
    } else if (message.thread_root_id && c.in_thread) {
      reason = 'thread'
    } else if (!message.thread_root_id && level === 'all') {
      // Every message of the channel itself (a DM's, by default).
      reason = channelKind === 'dm' ? (c.in_dm ? 'dm' : null) : 'all'
    } else if (message.thread_root_id && channelKind === 'dm' && c.in_dm && level === 'all') {
      // A DM is two people: a reply in its thread is for the other one too.
      reason = 'dm'
    }
    if (reason) out.set(c.member_id, { memberId: c.member_id, userId: c.user_id, reason })
  }
  return [...out.values()]
}

/** The longest snippet a notification shows of the words. */
export const TEAM_CHAT_NOTICE_CHARS = 140

/** Where a message was said, as a notification says it: "#general", "Support" (migration 715), or null for a DM. */
export function teamChatPlace(channel: { kind: TeamChatChannelKind; name: string | null }): string | null {
  if (channel.kind === 'support') return 'Support'
  return channel.kind === 'channel' ? `#${channel.name ?? 'channel'}` : null
}

/**
 * A notification's words: who wrote it and where ("Ana Ruiz in #general",
 * "Ana Ruiz in a thread in #general", "Joseph (your agent) in #general", in a
 * DM just the name), and the first words on one line (a message of files
 * alone: "Sent a file"). Pure.
 */
export function teamChatNotificationCopy(input: {
  authorName: string
  /** An agent's reply: its name, said as the reader's own agent. */
  agentName?: string | null
  place: string | null
  inThread: boolean
  body: string
  files: number
}): { title: string; body: string } {
  const who = input.agentName ? `${input.agentName.trim() || 'Agent'} (your agent)` : input.authorName.trim() || 'A teammate'
  const where = input.inThread ? (input.place ? ` in a thread in ${input.place}` : ' in a thread') : input.place ? ` in ${input.place}` : ''
  const line = input.body.replace(/\s+/g, ' ').trim()
  const words = line.length > TEAM_CHAT_NOTICE_CHARS ? `${line.slice(0, TEAM_CHAT_NOTICE_CHARS - 1).trimEnd()}…` : line
  const files = input.files > 1 ? `Sent ${input.files} files` : input.files === 1 ? 'Sent a file' : ''
  return { title: `${who}${where}`, body: words || files }
}

// ── The fan-out ─────────────────────────────────────────────────────────────

/** The event that asks for a message's notifications (its id dedupes a retried send). */
export function teamChatNotifyEvent(messageId: string) {
  return { name: TEAM_CHAT_NOTIFY_EVENT, id: `team-chat-notify-${messageId}`, data: { messageId } }
}

/**
 * Ask for a new message's notifications, after it is written. Never throws:
 * a message nobody was told about is still a message (logged).
 */
export async function requestTeamChatNotify(
  messageId: string,
  send?: (event: ReturnType<typeof teamChatNotifyEvent>) => Promise<unknown>,
): Promise<void> {
  if (!isUuid(messageId)) return
  try {
    if (send) await send(teamChatNotifyEvent(messageId))
    else {
      const { inngest } = await import('@/lib/inngest/client')
      await inngest.send(teamChatNotifyEvent(messageId))
    }
  } catch (err) {
    console.warn(`[team-chat-notify] message=${messageId} not requested:`, err instanceof Error ? err.message : 'unknown')
  }
}

/** One person told, as the fan-out hands them on (ids only: a step output). */
export interface TeamChatNotified {
  memberId: string
  userId: string
  workspaceId: string
  groupKey: string
}

export type TeamChatNotifyOutcome = 'gone' | 'nobody' | 'notified' | 'already'

interface MessageRow {
  id: string
  channel_id: string
  workspace_id: string
  author_kind: 'member' | 'agent' | 'guest' | 'support'
  author_member_id: string | null
  agent_for_member_id: string | null
  agent_name: string | null
  thread_root_id: string | null
  body: string
  attachments: unknown
  deleted_at: string | null
  support_name?: string | null
}

/**
 * Write a new message's notifications (service role). Reads the message and
 * its channel, asks 560's team_chat_notify_candidates who it may be for,
 * decides ({@link teamChatRecipients}) and writes one `team_chat_message`
 * notification each, skipping anyone who has one for it already (a retry).
 * Returns everyone who has one now (a retry's too, so none of them is left
 * out of the email). Throws on a failed read (the step retries).
 */
export async function notifyTeamChatMessage(svc: SupabaseClient, messageId: string): Promise<{ outcome: TeamChatNotifyOutcome; notified: TeamChatNotified[] }> {
  const message715Columns = await hasSupportColumns(svc)
  const { data: message, error } = await svc
    .from('team_chat_message')
    .select(
      message715Columns
        ? 'id, channel_id, workspace_id, author_kind, author_member_id, agent_for_member_id, agent_name, thread_root_id, body, attachments, deleted_at, support_name'
        : 'id, channel_id, workspace_id, author_kind, author_member_id, agent_for_member_id, agent_name, thread_root_id, body, attachments, deleted_at',
    )
    .eq('id', messageId)
    .maybeSingle<MessageRow>()
  if (error) throw new Error(`team chat notify: message read failed: ${error.message}`)
  if (!message || message.deleted_at) return { outcome: 'gone', notified: [] }
  // A meeting guest's message (migration 670) notifies nobody; its route never asks, and this holds if anything ever does.
  if (message.author_kind === 'guest') return { outcome: 'nobody', notified: [] }
  const { data: channel, error: channelError } = await svc
    .from('team_chat_channel')
    .select('id, kind, name, archived_at')
    .eq('id', message.channel_id)
    .maybeSingle<{ id: string; kind: TeamChatChannelKind; name: string | null; archived_at: string | null }>()
  if (channelError) throw new Error(`team chat notify: channel read failed: ${channelError.message}`)
  if (!channel || channel.archived_at) return { outcome: 'gone', notified: [] }

  const { data: rows, error: candError } = await svc.rpc('team_chat_notify_candidates', { msg: messageId })
  if (candError) throw new Error(`team chat notify: candidates read failed: ${candError.message}`)
  const members = teamChatRecipients(message, channel.kind, (rows ?? []) as TeamChatNotifyCandidate[])
  // A customer's message in their support conversation is for each of our staff too (in their own workspace).
  const staff = channel.kind === 'support' && message.author_kind === 'member' ? await supportStaffRecipients(svc, channel.id) : []
  const staffIds = new Set(staff.map((s) => s.memberId))
  const recipients: Array<TeamChatRecipient & { workspaceId: string }> = [
    ...members.map((r) => ({ ...r, workspaceId: message.workspace_id })),
    ...staff.filter((s) => !members.some((r) => r.userId === s.userId)),
  ]
  if (recipients.length === 0) return { outcome: 'nobody', notified: [] }

  // A retry: whoever has theirs already isn't written again (but is handed on below).
  const done = await notifiedAlready(svc, messageId)
  const fresh = recipients.filter((r) => !done.has(r.memberId))

  let authorName = 'A teammate'
  if (message.author_kind === 'member' && message.author_member_id) {
    const { data: author } = await svc.from('member').select('display_name').eq('id', message.author_member_id).maybeSingle<{ display_name: string | null }>()
    authorName = author?.display_name?.trim() || authorName
  } else if (message.author_kind === 'support') {
    authorName = message.support_name?.trim() || 'Support'
  }
  const place = teamChatPlace(channel)
  const copy = teamChatNotificationCopy({
    authorName,
    agentName: message.author_kind === 'agent' ? (message.agent_name ?? 'Agent') : null,
    place,
    inThread: !!message.thread_root_id,
    body: message.body ?? '',
    files: Array.isArray(message.attachments) ? message.attachments.length : 0,
  })
  const groupKey = teamChatGroupKey(message)
  const rowFor = (r: TeamChatRecipient & { workspaceId: string }) => ({
    workspace_id: r.workspaceId,
    recipient_id: r.memberId,
    type: TEAM_CHAT_NOTIFICATION_TYPE,
    title: copy.title,
    body: copy.body || null,
    actor_id: message.author_kind === 'member' ? message.author_member_id : null,
    target_type: 'team_chat_message',
    target_id: message.id,
    context_type: 'team_chat_channel',
    context_id: channel.id,
    group_key: groupKey,
    metadata: {
      channel_id: channel.id,
      message_id: message.id,
      thread_root_id: message.thread_root_id,
      channel_kind: channel.kind,
      reason: r.reason,
      // Our staff's, about a customer's support conversation (715): the customer's workspace, for the click.
      ...(staffIds.has(r.memberId) ? { support_workspace_id: message.workspace_id } : {}),
      // What the email says (./email.ts): who wrote it and where, read off the row.
      author_name: message.author_kind === 'agent' ? `${message.agent_name ?? 'Agent'} (your agent)` : authorName,
      place,
    },
  })
  if (fresh.length > 0) {
    // The database writes each with the message's words as they are now, and none at all once it is deleted
    // (560's team_chat_notification_live, which also makes a racing edit or delete wait and then follow).
    const { error: insertError } = await svc.from('notification').insert(fresh.map(rowFor))
    if (insertError) {
      if (insertError.code !== '23505') throw new Error(`team chat notify: write failed: ${insertError.message}`)
      // Raced with another run for some of them: one at a time, each duplicate skipped.
      for (const r of fresh) {
        const { error: one } = await svc.from('notification').insert(rowFor(r))
        if (one && one.code !== '23505') throw new Error(`team chat notify: write failed: ${one.message}`)
      }
    }
  }
  // Everyone who has one now, written by this try or an earlier one (a retry after a
  // partial failure still hands every one of them to the email batcher).
  const have = await notifiedAlready(svc, messageId)
  const told = recipients.filter((r) => have.has(r.memberId))
  return {
    outcome: told.length === 0 ? 'gone' : fresh.length === 0 ? 'already' : 'notified',
    // Our staff aren't emailed about a support conversation (their notice is in the app).
    notified: told.filter((r) => !staffIds.has(r.memberId)).map((r) => ({ memberId: r.memberId, userId: r.userId, workspaceId: message.workspace_id, groupKey })),
  }
}

/** Whether migration 715's columns are there (asked once per process once they are). */
let supportColumns: boolean | null = null
async function hasSupportColumns(svc: SupabaseClient): Promise<boolean> {
  if (supportColumns) return true
  const { error } = await svc.from('team_chat_message').select('support_name').limit(0)
  supportColumns = !error
  return supportColumns
}

/** Tests only. */
export function resetSupportColumns(): void {
  supportColumns = null
}

/**
 * Each of our support staff (migration 715's support_staff), as who a
 * customer's support message notifies: their first workspace's member row
 * (where their inbox is). Someone on the team with no workspace is skipped,
 * and so is anyone who muted this conversation (715's support_chat_mute).
 * Empty before 715, or when nobody is on the team.
 */
export async function supportStaffRecipients(svc: SupabaseClient, channelId?: string): Promise<Array<TeamChatRecipient & { workspaceId: string }>> {
  const { data: staff, error } = await svc.from('support_staff').select('user_id')
  if (error || !staff?.length) return []
  let muted = new Set<string>()
  if (channelId) {
    const { data: marks, error: markError } = await svc.from('support_chat_read').select('user_id').eq('channel_id', channelId).eq('muted', true)
    if (markError) throw new Error(`team chat notify: staff mutes read failed: ${markError.message}`)
    muted = new Set(((marks ?? []) as Array<{ user_id: string }>).map((m) => m.user_id))
  }
  const userIds = (staff as Array<{ user_id: string }>).map((s) => s.user_id).filter((id) => !muted.has(id))
  if (userIds.length === 0) return []
  const { data: rows, error: memberError } = await svc
    .from('member')
    .select('id, user_id, workspace_id, created_at')
    .in('user_id', userIds)
    .order('created_at', { ascending: true })
  if (memberError) throw new Error(`team chat notify: staff read failed: ${memberError.message}`)
  const first = new Map<string, { id: string; user_id: string; workspace_id: string }>()
  for (const m of (rows ?? []) as Array<{ id: string; user_id: string; workspace_id: string }>) {
    if (!first.has(m.user_id)) first.set(m.user_id, m)
  }
  return [...first.values()].map((m) => ({ memberId: m.id, userId: m.user_id, workspaceId: m.workspace_id, reason: 'all' as const }))
}

/** Who has this message's notification already. Throws on a failed read. */
async function notifiedAlready(svc: SupabaseClient, messageId: string): Promise<Set<string>> {
  const { data, error } = await svc
    .from('notification')
    .select('recipient_id')
    .eq('target_type', 'team_chat_message')
    .eq('target_id', messageId)
    .eq('type', TEAM_CHAT_NOTIFICATION_TYPE)
  if (error) throw new Error(`team chat notify: notification read failed: ${error.message}`)
  return new Set(((data ?? []) as Array<{ recipient_id: string }>).map((r) => r.recipient_id))
}
