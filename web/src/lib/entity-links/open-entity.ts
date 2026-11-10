/**
 * The card an entity of a graph kind opens (src/lib/chat-cards/open-card.ts),
 * for the surfaces that list entities of any kind: a message's record
 * mentions, "Referenced in". Client-safe and pure.
 */
import type { OpenTarget } from '@/lib/chat-cards/open-card'

/** The target to open (`openTarget`), or null for a kind no card draws. */
export function entityOpenTarget(type: string, id: string, title?: string | null): OpenTarget | null {
  switch (type) {
    case 'action':
    case 'document':
    case 'project':
    case 'initiative':
    case 'capture':
    case 'contact':
    case 'company':
    case 'deal':
      return { type, id, title: title ?? null }
    case 'flow':
      return { type: 'flow', id, title: title ?? null }
    case 'calendar_event':
      return { type: 'calendar-event', id, title: title ?? null }
    case 'team_chat_message':
    case 'team_chat_channel':
      // Team chat itself (which channel it opens on is its own).
      return { type: 'page', slug: 'team-chat' }
    default:
      return null
  }
}
