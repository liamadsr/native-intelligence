/**
 * Opening what a mention names (a team-chat message's, a document's chip):
 * its card (./open-entity.ts), or for a file, the record it hangs off, read
 * first. Client only.
 */
import { openTarget } from '@/lib/chat-cards/open-card'
import { openConversation } from '@/lib/chat/open-conversation'
import { openSharedEmailThread } from '@/lib/email-share/open-shared-thread'
import { entityOpenTarget } from './open-entity'

/**
 * Whether a mention of this kind opens something: a card, a file's record, a
 * `conversation`'s read-only chat viewer (shared-conversation-dialog.tsx), or
 * an `email_thread` (the owner's mail, or a grantee's read-only shared viewer,
 * shared-thread-dialog.tsx — the viewer decides from the server).
 */
export function mentionOpens(type: string): boolean {
  return type === 'attachment' || type === 'conversation' || type === 'email_thread' || entityOpenTarget(type, '') !== null
}

/**
 * Open the mention's card. A file's record comes from GET
 * /api/account/attachments/[id] (its capture, task or project); nothing opens
 * when the file can't be read. False when nothing opened.
 */
export async function openMention(ref: { type: string; id: string; label?: string | null }, from: string): Promise<boolean> {
  // An agent chat (own, or one shared by a mention) opens the read-only viewer.
  if (ref.type === 'conversation') {
    openConversation(ref.id, ref.label)
    return true
  }
  // A mail thread: a grantee (shared by a mention, decision 1) opens the
  // read-only shared viewer; the OWNER keeps today's behaviour. We cannot tell
  // which client-side, so ask the share route: 200 means grantee, 404 falls
  // back to the owner's existing open.
  if (ref.type === 'email_thread') {
    try {
      const res = await fetch(`/api/account/email/thread-shares?thread=${encodeURIComponent(ref.id)}`, { cache: 'no-store' })
      if (res.ok) {
        openSharedEmailThread(ref.id)
        return true
      }
    } catch {
      // fall through to the owner's open
    }
    const target = entityOpenTarget(ref.type, ref.id, ref.label)
    return target ? openTarget(target, { from }) : false
  }
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
