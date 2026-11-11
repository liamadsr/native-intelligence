/**
 * What a push says (the iOS app), pure and dependency-free: a team chat
 * conversation's push, and the agent's message in the person's own thread.
 * The ids under `data` are what the app opens the push at (the iOS app's
 * TeamChatPushRoute and PushRoute read these keys). The sender is ./send.ts.
 */
import type { ApnsNotification } from './apns'

/** The longest body a push shows (the in-app notification's excerpt is shorter already). */
export const PUSH_BODY_CHARS = 180

/** One line, at most PUSH_BODY_CHARS. Pure. */
export function pushLine(text: string, max = PUSH_BODY_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** What the app reads from a team chat push to open it (the iOS app's TeamChatPushRoute parses these keys). */
export interface TeamChatPushTarget {
  workspaceId: string
  channelId: string
  messageId: string
  threadRootId: string | null
}

/**
 * A team chat push: one conversation's newest unread message (the
 * notification's own title and words), or, when several wait, how many
 * ("3 new messages in #general") over the newest one's words. Grouped and
 * collapsed by the conversation, so a burst is one entry on the lock screen.
 * Pure.
 */
export function teamChatPush(input: {
  groupKey: string
  target: TeamChatPushTarget
  newest: { title: string; body: string | null; authorName: string | null; place: string | null }
  count: number
}): Omit<ApnsNotification, 'badge'> {
  const { newest, count, target } = input
  const inThread = !!target.threadRootId
  const where = inThread ? (newest.place ? `a thread in ${newest.place}` : 'a thread') : newest.place
  const words = pushLine(newest.body ?? '')
  const title =
    count <= 1
      ? newest.title
      : where
        ? `${count} new ${inThread ? 'replies' : 'messages'} in ${where}`
        : `${count} new messages from ${newest.authorName ?? 'a teammate'}`
  const body = count <= 1 ? words || 'New message' : newest.authorName ? `${newest.authorName}: ${words}` : words
  return {
    title,
    body,
    threadId: input.groupKey,
    collapseId: input.groupKey,
    data: {
      kind: 'team_chat',
      workspace_id: target.workspaceId,
      channel_id: target.channelId,
      message_id: target.messageId,
      thread_root_id: target.threadRootId,
    },
  }
}

/**
 * An agent's message in the person's own thread, while they are away: who
 * says it, the words, and any approvals waiting (answered in the app). Opens
 * the chat. Pure.
 */
export function homeMessagePush(input: {
  workspaceId: string
  conversationId: string
  agentName: string
  text: string
  approvals: ReadonlyArray<{ title: string }>
}): Omit<ApnsNotification, 'badge'> {
  const words = pushLine(input.text)
  const asks = input.approvals.map((a) => a.title.trim()).filter(Boolean)
  const waiting = asks.length === 0 ? '' : asks.length === 1 ? `Waiting on you: ${asks[0]}` : `${asks.length} things wait on you`
  const body = pushLine([words, waiting].filter(Boolean).join(' · ')) || 'A new message in our thread.'
  return {
    title: input.agentName.trim() || 'Your agent',
    body,
    threadId: `home:${input.conversationId}`,
    collapseId: `home:${input.conversationId}`,
    data: { kind: 'home_message', workspace_id: input.workspaceId, conversation_id: input.conversationId },
  }
}
