/**
 * Opening what a mention names (a team-chat message's, a document's chip):
 * its card (./open-entity.ts), or for a file, the record it hangs off, read
 * first. Client only.
 */
import { openTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from './open-entity'

/** Whether a mention of this kind opens something: a card, or (a file) the record it hangs off. */
export function mentionOpens(type: string): boolean {
  return type === 'attachment' || entityOpenTarget(type, '') !== null
}

/**
 * Open the mention's card. A file's record comes from GET
 * /api/account/attachments/[id] (its capture, task or project); nothing opens
 * when the file can't be read. False when nothing opened.
 */
export async function openMention(ref: { type: string; id: string; label?: string | null }, from: string): Promise<boolean> {
  if (ref.type !== 'attachment') {
    const target = entityOpenTarget(ref.type, ref.id, ref.label)
    return target ? openTarget(target, { from }) : false
  }
  try {
    const res = await fetch(`/api/account/attachments/${encodeURIComponent(ref.id)}`, { cache: 'no-store' })
    if (!res.ok) return false
    const data = (await res.json()) as { attachment?: { parent?: { type: string; id: string } | null } }
    const parent = data.attachment?.parent
    const target = parent ? entityOpenTarget(parent.type, parent.id) : null
    return target ? openTarget(target, { from }) : false
  } catch {
    return false
  }
}
