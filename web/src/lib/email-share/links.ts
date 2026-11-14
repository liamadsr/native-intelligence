/**
 * Share links (migration 646's email_share_link): the owner copies a link to
 * their email thread and pastes it into a chat by hand. Pure and client-safe:
 * the link's shape, finding links in a message's words, and what the views
 * say.
 *
 * A link GRANTS NOTHING on its own. A team chat message its OWNER posts with
 * it becomes a share in that channel or DM (./bind.ts, from the message post
 * route), read live like a share from the picker. Pasted by anyone else, it
 * stays plain text. Opened directly (/mail/s/<token>), it shows the owner
 * their thread, a teammate the thread when a share from it sits in a chat
 * they can read, and anyone else only that it is shared in chat.
 *
 * The token grants nothing on its own, and it is scrubbed from analytics and
 * error-report events like a join link's (src/lib/privacy/
 * join-token-redaction.ts, as deep as that scrub walks); its page sends no
 * pageview and the link never gets a preview (src/lib/team-chat/
 * link-preview.ts firstLink skips it).
 */

/** A link's page: `/mail/s/<token>`. */
export const EMAIL_SHARE_LINK_PREFIX = '/mail/s/'

/** The most links one message turns into shares (more stay plain text). */
export const EMAIL_SHARE_LINKS_PER_MESSAGE = 5

/** The toast after Copy link. */
export const EMAIL_SHARE_LINK_COPIED = 'Link copied. Paste it in a chat to share this email there.'

/** What the link's page says to anyone it shows nothing to. */
export const EMAIL_SHARE_LINK_OUTSIDE = 'This email is shared in chat. Ask the person who shared it.'

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,128}$/

/** Cheap shape check before a lookup: anything else never reaches the database. */
export function isEmailShareLinkToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value)
}

export function emailShareLinkPath(token: string): string {
  return `${EMAIL_SHARE_LINK_PREFIX}${token}`
}

/** A share link in words: any host (the app answers on several), `/mail/s/<token>`, the token whole. */
const IN_WORDS = /https?:\/\/[^\s/<>"'`]+\/mail\/s\/([A-Za-z0-9_-]{22,128})(?![A-Za-z0-9_-])/gi

/** The distinct share-link tokens in a message's words, in order, at most EMAIL_SHARE_LINKS_PER_MESSAGE. */
export function emailShareLinkTokens(body: string | null | undefined): string[] {
  if (!body || !/\/mail\/s\//i.test(body)) return []
  const out: string[] = []
  for (const m of body.matchAll(IN_WORDS)) {
    if (!out.includes(m[1])) out.push(m[1])
    if (out.length >= EMAIL_SHARE_LINKS_PER_MESSAGE) break
  }
  return out
}

/** True for a share link's URL (no preview is ever fetched for one). */
export function isEmailShareLinkUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.pathname.startsWith(EMAIL_SHARE_LINK_PREFIX) && isEmailShareLinkToken(u.pathname.slice(EMAIL_SHARE_LINK_PREFIX.length).replace(/\/+$/, ''))
  } catch {
    return false
  }
}

/** A share link's own page, for the analytics and error-report fences. */
export function isEmailShareLinkPage(pathname: string): boolean {
  return pathname.startsWith(EMAIL_SHARE_LINK_PREFIX)
}

/**
 * Why one of the AUTHOR's own links didn't become a share (anyone else's
 * links are not theirs to hear about): the link was revoked, their mailbox
 * no longer reads here, this isn't a channel or DM (or is another
 * workspace's), or the write failed. No mail in it, no token.
 */
export type UnboundReason = 'revoked' | 'mailbox' | 'place' | 'failed'

/** How the composer says it: "Couldn't share the email: <this>". */
export const EMAIL_SHARE_UNBOUND_TEXT: Readonly<Record<UnboundReason, string>> = {
  revoked: 'that link was revoked',
  mailbox: 'your mailbox isn’t connected',
  place: 'emails are shared only in channels and direct messages',
  failed: 'something went wrong, try again',
}

/** The composer's toast for a post whose own links didn't all bind, or null. */
export function emailShareUnboundToast(reasons: unknown): string | null {
  if (!Array.isArray(reasons)) return null
  const first = reasons.find((r): r is UnboundReason => typeof r === 'string' && r in EMAIL_SHARE_UNBOUND_TEXT)
  return first ? `Couldn’t share the email: ${EMAIL_SHARE_UNBOUND_TEXT[first]}` : null
}
