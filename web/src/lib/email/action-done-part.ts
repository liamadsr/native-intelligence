/**
 * A to-do mail closed, in the home thread (migration 450,
 * ./action-done-from-mail.ts): one data part, written by the server, that the
 * chat draws as a chip ("Done from your mail · GEN-42 Look into renting a car
 * · enterprise.com · Undo"). Undo goes through
 * /api/account/email/action-done/[id]/undo, which rewrites the part with
 * `undone`, so a reload says "Reopened".
 *
 * The part is data the person's own client could write, so it only names the
 * row: Undo reads what to put back from action_mail_done, never from here.
 *
 * Client-safe and pure: a part is data, so every field is checked.
 */

/** The part's type. */
export const ACTION_DONE_PART_TYPE = 'data-action-done-from-mail' as const

/** `ui_message.metadata.kind` of the message. */
export const ACTION_DONE_MESSAGE_KIND = 'action_done_from_mail' as const

/** A to-do's title in the part. */
export const ACTION_DONE_TITLE_MAX = 200

export interface ActionDonePartData {
  /** action_mail_done.id */
  record_id: string
  action_id: string
  /** GEN-42 */
  identifier: string | null
  title: string
  /** The confirmation's sender domain ("enterprise.com"). */
  sender_domain: string | null
  /** The person reopened it with Undo. */
  undone?: boolean
  /** Undo found the to-do moved since, and left it where the person put it. */
  changed?: boolean
}

/** The message id of a close's message: one per to-do, rewritten in place on Undo. */
export function actionDoneMessageId(recordId: string): string {
  return `action-done-from-mail:${recordId}`
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A sender address's domain ("Enterprise <noreply@enterprise.com>" → "enterprise.com"), or null. Pure. */
export function senderDomainOf(from: string | null | undefined): string | null {
  if (typeof from !== 'string') return null
  const bracketed = /<([^<>]+)>/.exec(from)?.[1] ?? from
  const at = bracketed.lastIndexOf('@')
  if (at < 0) return null
  const domain = bracketed.slice(at + 1).trim().toLowerCase().replace(/\.$/, '')
  return DOMAIN_RE.test(domain) ? domain : null
}

/** The part's data, or null when it is not one (a part is data). Pure. */
export function actionDonePartData(value: unknown): ActionDonePartData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.record_id !== 'string' || !v.record_id) return null
  if (typeof v.action_id !== 'string' || !v.action_id) return null
  if (typeof v.title !== 'string' || !v.title.trim()) return null
  const identifier = typeof v.identifier === 'string' && v.identifier.trim() && v.identifier.length <= 64 ? v.identifier.trim() : null
  const domain = typeof v.sender_domain === 'string' && DOMAIN_RE.test(v.sender_domain) ? v.sender_domain : null
  return {
    record_id: v.record_id,
    action_id: v.action_id,
    identifier,
    title: v.title.trim().slice(0, ACTION_DONE_TITLE_MAX),
    sender_domain: domain,
    ...(v.undone === true ? { undone: true } : {}),
    ...(v.changed === true ? { changed: true } : {}),
  }
}
