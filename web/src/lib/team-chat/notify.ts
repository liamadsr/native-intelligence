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
  return kind === 'dm' ? 'all' : 'mentions'
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

/** Where a message was said, as a notification says it: "#general", or null for a DM. */
export function teamChatPlace(channel: { kind: TeamChatChannelKind; name: string | null }): string | null {
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
  author_kind: 'member' | 'agent'
  author_member_id: string | null
  agent_for_member_id: string | null
  agent_name: string | null
  thread_root_id: string | null
  body: string
  attachments: unknown
  deleted_at: string | null
}

/**
 * Write a new message's notifications (service role). Reads the message and
 * its channel, asks 560's team_chat_notify_candidates who it may be for,
 * decides ({@link teamChatRecipients}) and writes one `team_chat_message`
 * notification each, skipping anyone who has one for it already (a retry).
 * Returns who was told now. Throws on a failed read (the step retries).
 */
export async function notifyTeamChatMessage(svc: SupabaseClient, messageId: string): Promise<{ outcome: TeamChatNotifyOutcome; notified: TeamChatNotified[] }> {
  const { data: message, error } = await svc
    .from('team_chat_message')
    .select('id, channel_id, workspace_id, author_kind, author_member_id, agent_for_member_id, agent_name, thread_root_id, body, attachments, deleted_at')
    .eq('id', messageId)
    .maybeSingle<MessageRow>()
  if (error) throw new Error(`team chat notify: message read failed: ${error.message}`)
  if (!message || message.deleted_at) return { outcome: 'gone', notified: [] }
  const { data: channel, error: channelError } = await svc
    .from('team_chat_channel')
    .select('id, kind, name, archived_at')
    .eq('id', message.channel_id)
    .maybeSingle<{ id: string; kind: TeamChatChannelKind; name: string | null; archived_at: string | null }>()
  if (channelError) throw new Error(`team chat notify: channel read failed: ${channelError.message}`)
  if (!channel || channel.archived_at) return { outcome: 'gone', notified: [] }

  const { data: rows, error: candError } = await svc.rpc('team_chat_notify_candidates', { msg: messageId })
  if (candError) throw new Error(`team chat notify: candidates read failed: ${candError.message}`)
  const recipients = teamChatRecipients(message, channel.kind, (rows ?? []) as TeamChatNotifyCandidate[])
  if (recipients.length === 0) return { outcome: 'nobody', notified: [] }

  // A retry: whoever has theirs already isn't written again.
  const { data: had, error: hadError } = await svc
    .from('notification')
    .select('recipient_id')
    .eq('type', TEAM_CHAT_NOTIFICATION_TYPE)
    .eq('target_id', messageId)
  if (hadError) throw new Error(`team chat notify: notification read failed: ${hadError.message}`)
  const done = new Set(((had ?? []) as Array<{ recipient_id: string }>).map((r) => r.recipient_id))
  const fresh = recipients.filter((r) => !done.has(r.memberId))
  if (fresh.length === 0) return { outcome: 'already', notified: [] }

  let authorName = 'A teammate'
  if (message.author_kind === 'member' && message.author_member_id) {
    const { data: author } = await svc.from('member').select('display_name').eq('id', message.author_member_id).maybeSingle<{ display_name: string | null }>()
    authorName = author?.display_name?.trim() || authorName
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
  const rowFor = (r: TeamChatRecipient) => ({
    workspace_id: message.workspace_id,
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
      // What the email says (./email.ts): who wrote it and where, read off the row.
      author_name: message.author_kind === 'agent' ? `${message.agent_name ?? 'Agent'} (your agent)` : authorName,
      place,
    },
  })
  const { error: insertError } = await svc.from('notification').insert(fresh.map(rowFor))
  let written = fresh
  if (insertError) {
    if (insertError.code !== '23505') throw new Error(`team chat notify: write failed: ${insertError.message}`)
    // Raced with another run for some of them: one at a time, each duplicate skipped.
    written = []
    for (const r of fresh) {
      const { error: one } = await svc.from('notification').insert(rowFor(r))
      if (!one) written.push(r)
      else if (one.code !== '23505') throw new Error(`team chat notify: write failed: ${one.message}`)
    }
  }
  return {
    outcome: written.length ? 'notified' : 'already',
    notified: written.map((r) => ({ memberId: r.memberId, userId: r.userId, workspaceId: message.workspace_id, groupKey })),
  }
}

/**
 * A deleted message's notifications go with it (service role): nobody is
 * told, or emailed, about words that are gone. Never throws (logged).
 */
export async function removeTeamChatNotifications(svc: SupabaseClient, messageId: string): Promise<void> {
  try {
    const { error } = await svc.from('notification').delete().eq('type', TEAM_CHAT_NOTIFICATION_TYPE).eq('target_id', messageId)
    if (error) console.warn(`[team-chat-notify] message=${messageId} notifications not removed:`, error.message)
  } catch (err) {
    console.warn(`[team-chat-notify] message=${messageId} notifications not removed:`, err instanceof Error ? err.message : 'unknown')
  }
}
