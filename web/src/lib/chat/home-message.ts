/**
 * A message the agent wrote in the person's home thread, as a notice names it
 * (the router's `agent_message` banner, src/lib/reach/route.ts): its
 * workspace, its thread, and its ui message id.
 *
 * Two things follow from one (PROD 2026-10-31, the Whole Foods banner: the
 * banner came, its message never reached the open chat, and a click on it did
 * nothing, since the chat was already on the home thread):
 *   • its arrival tells a chat open on that thread to read the thread's newest
 *     server-written rows ({@link announceHomeMessage} → MainChatHost →
 *     ChatPanelHandle.catchUpServerTurns), so the message lands even when the
 *     chat's own Realtime bridge missed it;
 *   • a click opens the home thread on it (openHomeThread `reveal`): brought
 *     in when the chat lacks it, then scrolled to.
 *
 * Client-safe: no server imports.
 */

/** The notification type the router's banner is written with (lib/notifications.ts). */
export const AGENT_MESSAGE_NOTICE_TYPE = 'agent_message'

/** Window event: a home-thread message was announced. Handled by MainChatHost. */
export const HOME_MESSAGE_EVENT = 'dial8:home-message'

/**
 * The PostHog event a chat sends when it lacked such a message and read it in
 * (ChatPanel): `trigger` (the banner's arrival, or a click), `before` (the row
 * waited in the live bridge's mid-turn buffer, or never came), the chat's
 * status and the channel's, and for a click whether it then drew. It says
 * which way the live bridge missed it.
 */
export const HOME_MESSAGE_CATCH_UP_EVENT = 'home_message_catch_up'

export interface HomeMessageRef {
  workspaceId: string
  conversationId: string
  /** The message's ui message id; null on a banner written before it carried one. */
  messageId: string | null
}

/** An id is one to look for: a short non-empty string (the chat compares it with its own). */
const ID_MAX = 64
const MESSAGE_ID_MAX = 200

function idOf(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

const messageIdOf = (value: unknown) => idOf(value, MESSAGE_ID_MAX)

function refOf(workspaceId: unknown, conversationId: unknown, messageId: unknown): HomeMessageRef | null {
  const ws = idOf(workspaceId, ID_MAX)
  const conversation = idOf(conversationId, ID_MAX)
  return ws && conversation ? { workspaceId: ws, conversationId: conversation, messageId: messageIdOf(messageId) } : null
}

/**
 * The home-thread message a notice is about, or null for any other notice:
 * an `agent_message` row (or a native banner's payload of one) with its
 * thread in `metadata.conversation_id` and, when written since it carried
 * one, the message in `metadata.message_id`.
 */
export function homeMessageOfNotice(notice: { type?: unknown; workspace_id?: unknown; metadata?: unknown } | null | undefined): HomeMessageRef | null {
  if (!notice || notice.type !== AGENT_MESSAGE_NOTICE_TYPE) return null
  const meta = notice.metadata && typeof notice.metadata === 'object' && !Array.isArray(notice.metadata) ? (notice.metadata as Record<string, unknown>) : {}
  return refOf(notice.workspace_id, meta.conversation_id, meta.message_id)
}

/** Tell the chat a message landed in a home thread (see the module note). No-op off the browser. */
export function announceHomeMessage(ref: HomeMessageRef): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<HomeMessageRef>(HOME_MESSAGE_EVENT, { detail: ref }))
}

/** The event's detail, checked; null when it isn't one. */
export function parseHomeMessageDetail(value: unknown): HomeMessageRef | null {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return refOf(v.workspaceId, v.conversationId, v.messageId)
}

/** A click's ask to open the home thread on a message (OpenHomeThreadDetail `reveal`), checked; null when there is none. */
export function parseRevealDetail(value: unknown): { messageId: string | null } | null {
  if (!value || typeof value !== 'object') return null
  return { messageId: messageIdOf((value as { messageId?: unknown }).messageId) }
}
