/**
 * Opening an agent chat read-only (docs/plans/mentions-everywhere.md, JOB 2):
 * a `ni:open-conversation` window event the one global viewer listens for
 * (src/components/chat/shared-conversation-dialog.tsx). A mention chip of a
 * `conversation` and a picked search row both fire it. Client-safe: a no-op on
 * the server (no window).
 */
export const OPEN_CONVERSATION_EVENT = 'ni:open-conversation'

export interface OpenConversationDetail {
  id: string
  /** The chat's title, if the caller has it, shown while the read loads. */
  title?: string | null
}

/** Open the read-only viewer for conversation `id`. No-op on the server. */
export function openConversation(id: string, title?: string | null): void {
  if (typeof window === 'undefined' || !id) return
  window.dispatchEvent(new CustomEvent<OpenConversationDetail>(OPEN_CONVERSATION_EVENT, { detail: { id, title: title ?? null } }))
}

/** Parse a `ni:open-conversation` event's detail, or null when it's malformed. */
export function parseOpenConversationDetail(detail: unknown): OpenConversationDetail | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as { id?: unknown; title?: unknown }
  if (typeof d.id !== 'string' || !d.id) return null
  return { id: d.id, title: typeof d.title === 'string' ? d.title : null }
}
