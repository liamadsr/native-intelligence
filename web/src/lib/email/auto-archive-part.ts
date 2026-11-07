/**
 * The morning tidy's message in the home thread (migration 446,
 * ./auto-archive.ts): one data part, written by the server, that the chat
 * draws as a chip ("Inbox tidied · 14 threads · amazon.com, gusto.com +3
 * · Undo"). Undo goes through
 * /api/account/email/auto-archive/[id]/undo, which rewrites the part with
 * `undone`, so a reload says "Put back".
 *
 * Client-safe and pure: a part is data, so every field is checked.
 */

/** The part's type. */
export const EMAIL_AUTO_ARCHIVE_PART_TYPE = 'data-email-auto-archive' as const

/** `ui_message.metadata.kind` of the message. */
export const EMAIL_AUTO_ARCHIVE_MESSAGE_KIND = 'email_auto_archive' as const

/** The most sender domains the chip names (then "+N"). */
export const AUTO_ARCHIVE_PART_DOMAINS = 3

export interface EmailAutoArchivePartData {
  /** email_auto_archive.id */
  batch_id: string
  /** Threads archived. */
  count: number
  /** Up to AUTO_ARCHIVE_PART_DOMAINS sender domains, the most common first. */
  domains: string[]
  /** Sender domains past those. */
  more_domains: number
  /** The person put the batch back. */
  undone?: boolean
}

/** The message id of a batch's message: one per batch, rewritten in place on Undo. */
export function autoArchiveMessageId(batchId: string): string {
  return `email-auto-archive:${batchId}`
}

/** The part's data, or null when it is not one (a part is data). Pure. */
export function emailAutoArchivePartData(value: unknown): EmailAutoArchivePartData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.batch_id !== 'string' || !v.batch_id) return null
  if (typeof v.count !== 'number' || !Number.isInteger(v.count) || v.count < 1) return null
  const domains = Array.isArray(v.domains) ? v.domains.filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length <= 253) : []
  const more = typeof v.more_domains === 'number' && Number.isInteger(v.more_domains) && v.more_domains > 0 ? v.more_domains : 0
  return {
    batch_id: v.batch_id,
    count: v.count,
    domains: domains.slice(0, AUTO_ARCHIVE_PART_DOMAINS),
    more_domains: more,
    ...(v.undone === true ? { undone: true } : {}),
  }
}

/** "amazon.com, gusto.com +3", or null with none. Pure. */
export function autoArchiveDomainsLine(data: Pick<EmailAutoArchivePartData, 'domains' | 'more_domains'>): string | null {
  if (!data.domains.length) return null
  return `${data.domains.join(', ')}${data.more_domains > 0 ? ` +${data.more_domains}` : ''}`
}

/**
 * The sender domains of the archived threads, the most common first (ties in
 * the order first seen), as the part carries them. Pure.
 */
export function senderDomains(senders: readonly string[]): { domains: string[]; more_domains: number } {
  const counts = new Map<string, number>()
  for (const s of senders) {
    const at = s.lastIndexOf('@')
    const domain = at > 0 ? s.slice(at + 1).trim().toLowerCase() : ''
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d)
  return { domains: ranked.slice(0, AUTO_ARCHIVE_PART_DOMAINS), more_domains: Math.max(0, ranked.length - AUTO_ARCHIVE_PART_DOMAINS) }
}
