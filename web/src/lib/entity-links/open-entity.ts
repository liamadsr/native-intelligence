/**
 * The card an entity opens (src/lib/chat-cards/open-card.ts), for the
 * surfaces that list entities of any kind: a message's record mentions,
 * "Referenced in", the entity actions menu. Read from each kind's `open` in
 * the entity actions registry. Client-safe and pure.
 */
import type { CardRecordType } from '@/lib/chat-cards/kinds'
import type { OpenTarget } from '@/lib/chat-cards/open-card'
import { entityActionsDescriptor } from '@/lib/entities/entity-actions-registry'

/** The target to open (`openTarget`), or null for a kind no card draws. */
export function entityOpenTarget(type: string, id: string, title?: string | null): OpenTarget | null {
  const t = title ?? null
  switch (entityActionsDescriptor(type)?.open) {
    case 'record':
      return { type: type as CardRecordType, id, title: t }
    case 'calendar-event':
      return { type: 'calendar-event', id, title: t }
    case 'flow':
      return { type: 'flow', id, title: t }
    case 'sequence':
      return { type: 'sequence', id, title: t }
    case 'prospect_list':
      return { type: 'prospect_list', id, title: t }
    case 'eval_suite':
      return { type: 'eval_suite', id, title: t }
    case 'team-chat':
      // Team chat itself (which channel it opens on is its own).
      return { type: 'page', slug: 'team-chat' }
    default:
      return null
  }
}
