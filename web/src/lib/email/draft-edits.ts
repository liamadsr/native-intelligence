/**
 * What the user changed in a draft before sending it: Mail's draft editor and
 * the chat's draft card post these with the send (POST
 * /api/account/email/draft/send), and the send path puts them into the message
 * it sends (src/lib/integrations/email.ts). Pure, so the editors, the route
 * and the send path share one shape and one check.
 */
export interface DraftEdits {
  to: string[]
  cc: string[]
  /** Only when the sender changed it (the chat card has a Bcc field): absent,
   *  the draft keeps the Bcc it has; `[]` takes it off. */
  bcc?: string[]
  subject: string
  /** Plain text: sent as text, and as HTML made from it. */
  body: string
}

/**
 * A bare address, whole: no display name, brackets, separators or whitespace.
 * Addresses go into MIME headers as they are, so a CR/LF or a `,` in one
 * would add a header or a recipient.
 */
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/

export const MAX_DRAFT_RECIPIENTS = 50
/** RFC 5322's line limit; the subject is folded to one line before it is sent. */
export const MAX_DRAFT_SUBJECT = 998
export const MAX_DRAFT_BODY = 100_000

export function isDraftAddress(value: string): boolean {
  return ADDRESS.test(value)
}

/**
 * The edits in a request, checked: null when there are none, 'invalid' when
 * they are not a well-formed set (at least one To or Cc recipient, every one a
 * bare address, Bcc too when it is given, and the subject and body within
 * their limits).
 */
export function parseDraftEdits(value: unknown): DraftEdits | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const v = value as Record<string, unknown>
  const to = addresses(v.to)
  const cc = v.cc === undefined ? [] : addresses(v.cc)
  const bcc = v.bcc === undefined ? undefined : addresses(v.bcc)
  if (!to || !cc || bcc === null) return 'invalid'
  const recipients = to.length + cc.length
  if (recipients === 0 || recipients + (bcc?.length ?? 0) > MAX_DRAFT_RECIPIENTS) return 'invalid'
  if (typeof v.subject !== 'string' || v.subject.length > MAX_DRAFT_SUBJECT) return 'invalid'
  if (typeof v.body !== 'string' || v.body.length > MAX_DRAFT_BODY) return 'invalid'
  return { to, cc, ...(bcc ? { bcc } : {}), subject: v.subject, body: v.body }
}

function addresses(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((a) => typeof a === 'string')) return null
  const out = (value as string[]).map((a) => a.trim())
  return out.every(isDraftAddress) ? out : null
}
