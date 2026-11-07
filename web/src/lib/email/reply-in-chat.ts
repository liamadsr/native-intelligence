/**
 * Mail → chat reply handoff. Reply All in Mail's thread view (and Reply on one
 * of its messages) hands the thread to the chat assistant, which reads it and
 * saves a reply as a draft on the thread, where the user reviews, edits and
 * sends it.
 *
 * The thread view doesn't own a chat: the tab fires this window event, the
 * shell (dashboard-shell.tsx) routes it to the active tab's chat panel, and
 * the panel auto-sends the seeded turn below. There is no reply skill (the
 * catalog rebuild, migration 159, retired it): the general assistant drafts
 * replies with its email tools (read_email, then create_email_draft on the
 * thread), as it does when asked in the user's own words.
 *
 * The seed is sent as the user's own message, so it carries ids and a bare
 * address only, never a subject or a display name: those are written by
 * whoever sent the mail, and read_email hands them to the model marked as
 * untrusted instead.
 */
import { isDraftAddress } from './draft-edits'

/** Window event name. Listened for in dashboard-shell.tsx. */
export const EMAIL_REPLY_EVENT = 'dial8:email-reply'

export interface EmailReplyRequest {
  /** The thread's provider id, as Mail and the email tools name it. */
  threadId: string
  /** A message's own Reply: that message. Absent, the thread's Reply All: everyone on it. */
  message?: { id: string; fromEmail: string }
}

/** A provider id (Gmail hex, Graph base64): anything else is not one we wrote. */
const PROVIDER_ID = /^[A-Za-z0-9_=+/-]{1,512}$/

/** Whether a value is shaped like a provider thread or message id. */
export function isMailId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID.test(value)
}

/** Fire the handoff. Safe during SSR (no window, no event). */
export function requestEmailReply(detail: EmailReplyRequest): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<EmailReplyRequest>(EMAIL_REPLY_EVENT, { detail }))
}

/**
 * The request in an event's detail, checked: null unless it names a thread by
 * a provider id (and a message, when it names one, by one too). A sender
 * address that isn't a bare address is left out.
 */
export function parseEmailReplyRequest(value: unknown): EmailReplyRequest | null {
  if (!value || typeof value !== 'object') return null
  const { threadId, message } = value as { threadId?: unknown; message?: unknown }
  if (!isMailId(threadId)) return null
  if (message === undefined) return { threadId }
  const { id, fromEmail } = (message ?? {}) as { id?: unknown; fromEmail?: unknown }
  if (!isMailId(id)) return null
  const from = typeof fromEmail === 'string' && isDraftAddress(fromEmail) ? fromEmail : ''
  return { threadId, message: { id, fromEmail: from } }
}

/** The seeded turn: what the chat shows as the user's message, and what the assistant acts on. */
export function buildEmailReplySeedText({ threadId, message }: EmailReplyRequest): string {
  const thread = `this email thread (thread_id ${threadId})`
  if (!message) return `Draft a reply to everyone on ${thread}.`
  const from = message.fromEmail ? ` from ${message.fromEmail}` : ''
  return `Draft a reply to the message${from} (message_id ${message.id}) on ${thread}.`
}
