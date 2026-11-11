/**
 * Which team chat conversations are on screen in this window right now (the
 * channel each open team chat view shows, and the thread open beside it), so
 * a notification about a message the person is looking at raises no toast or
 * banner (src/app/account/notification-context.tsx): the view reads it, and
 * its read mark reads the notification too (migration 560). In-memory, this
 * window only. Client-safe.
 */

export interface TeamChatPlaceOnScreen {
  channelId: string
  /** The thread open beside it (its root), or null. */
  threadRootId: string | null
}

const places = new Map<symbol, TeamChatPlaceOnScreen>()

/** Say what one view shows now (null: nothing). Returns nothing; call again with null when it unmounts. */
export function setTeamChatOnScreen(view: symbol, place: TeamChatPlaceOnScreen | null): void {
  if (place) places.set(view, place)
  else places.delete(view)
}

/**
 * Whether a team chat notification is about what is on screen: its channel's
 * own messages with the channel showing, or a thread's reply with that thread
 * open. False while the page is hidden. Pure but for the registry and the
 * document.
 */
export function isTeamChatNoticeOnScreen(notification: { type?: string | null; metadata?: unknown }): boolean {
  if (notification.type !== 'team_chat_message') return false
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false
  const meta = notification.metadata && typeof notification.metadata === 'object' ? (notification.metadata as Record<string, unknown>) : {}
  const channelId = typeof meta.channel_id === 'string' ? meta.channel_id : null
  const root = typeof meta.thread_root_id === 'string' ? meta.thread_root_id : null
  if (!channelId) return false
  for (const place of places.values()) {
    if (place.channelId !== channelId) continue
    if (root ? place.threadRootId === root : true) return true
  }
  return false
}
