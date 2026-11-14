/**
 * Sharing an email thread into team chat (migration 646): the shared
 * vocabulary, pure and client-safe.
 *
 * Founder's decision (2026-11-14): a shared thread is READ LIVE, and Native
 * Intelligence stores NOTHING of the mail. The owner shares a thread into a
 * channel or DM they can post in; the server freezes the ids of the thread's
 * messages at that moment (`email_share.message_ids`: a later reply stays
 * private) and posts a message, authored by them, carrying the share. Anyone
 * who can read that channel opens the thread read-only, fetched from the
 * owner's mailbox with the owner's token each time (src/lib/email-share/
 * service.ts, the routes under src/app/api/account/email/shares/).
 *
 * Agents never see a share's mail: every agent path (the team-chat agent's
 * context, read_team_chat_message, the main chat agent, MCP, loops) reads the
 * message's words only, which are the sharer's note or
 * EMAIL_SHARE_DEFAULT_BODY, plus at most "an email was shared"
 * ({@link emailShareAgentText}). The share routes refuse Bearer callers (MCP,
 * devices): shared mail opens in the app, in a person's own session.
 *
 * Out of scope for now, and where each would plug in:
 *   - @mentioning an email in the composer: the composer's record picker
 *     (src/lib/entity-links/mentionable.ts MENTIONABLE_TYPES leaves mail out);
 *     it would post through createEmailShare (./service.ts) instead of a
 *     record mention.
 *   - the agent sharing mail on request: a chat tool would call
 *     createEmailShare as the person, behind an approval card; no agent tool
 *     may read a share's mail (src/lib/email-share/__tests__/agent-fence.test.ts).
 *   - iOS: the share routes refuse Bearer callers (./http.ts refuseBearer); an
 *     iOS reader would need its own fenced session check there.
 */

/** The words a share's message carries when the sharer adds no note (agents and notifications read these). */
export const EMAIL_SHARE_DEFAULT_BODY = 'Shared an email'

/** The longest note a share carries. */
export const EMAIL_SHARE_NOTE_MAX = 2000

/** The most messages one share freezes (a longer thread shares its newest). */
export const EMAIL_SHARE_MAX_MESSAGES = 100

/** What a card and the read-only view say once the owner un-shared. */
export const EMAIL_SHARE_REVOKED_TEXT = 'No longer shared'

/** What they say when the owner's mailbox can't give the mail any more. */
export const EMAIL_SHARE_UNAVAILABLE_TEXT = 'This email is no longer available'

/** What a card and the read-only view say when the mailbox can't answer now (it may in a moment). */
export const EMAIL_SHARE_BUSY_TEXT = 'Couldn’t load right now'

/** What a non-owner hears when they try to share someone else's thread. */
export const EMAIL_SHARE_NOT_OWNER_TEXT = 'Only the mail’s owner can share it'

/** The warning before sharing somewhere people outside the workspace (guests) read. */
export const EMAIL_SHARE_OUTSIDE_WARNING = 'People outside the workspace are in this channel'

/** What an agent is told about a share: that it happened, never what it says. */
export const EMAIL_SHARE_AGENT_NOTICE = '[An email thread was shared here. Its contents are shown only to people, in the app, never to agents.]'

/** A place the owner can share into: a channel or a DM they can post in. */
export interface EmailShareTarget {
  id: string
  kind: 'channel' | 'dm'
  /** "#sales", or the other member's name for a DM ("Note to self" for one's own). */
  label: string
  /** Guests (people outside the workspace) can read it: the picker warns. */
  outside: boolean
}

/** Where a thread is shared, for its owner's chips. */
export interface EmailShareChip {
  /** The share's id, or the link's (kind 'link'). */
  id: string
  /** A share in a chat ("Shared to #sales · Un-share"), or a copied link ("Link · Revoke"). */
  kind: 'share' | 'link'
  channelId: string | null
  label: string
  createdAt: string
}

/** A share's state for a reader who may see it. */
export type EmailShareState = 'live' | 'revoked' | 'unavailable'

/** A share as its card in chat shows it (loaded live when it comes into view). */
export interface EmailShareCardView {
  id: string
  state: EmailShareState
  /** The reader is the mail's owner: the card offers Un-share. */
  mine: boolean
  /** The sender's address of the newest SHARED message, read live (never a later, private reply's). Null when not live. */
  sender: string | null
  /** Read live from the mailbox; null when not live. */
  subject: string | null
  firstLine: string | null
  /** How many messages the share holds. */
  messageCount: number
}

export interface EmailShareAddress {
  name: string | null
  email: string
}

/** An attachment of a shared message: downloaded through the share route by its key. */
export interface EmailShareAttachment {
  /** Gmail: the part id; Graph: the attachment id. Opaque to the client. */
  key: string
  name: string
  size: number
  mimeType: string
}

/** One shared message, read-only. */
export interface EmailShareMessage {
  id: string
  from: EmailShareAddress
  to: EmailShareAddress[]
  cc: EmailShareAddress[]
  date: string
  subject: string
  /** Sanitized on the server (./sanitize.ts), and again by the view before it draws it. */
  bodyHtml: string | null
  bodyText: string | null
  attachments: EmailShareAttachment[]
  /** Remote images and CSS urls left out of bodyHtml (the view offers "Load images"). */
  blockedImages?: number
}

/** A shared thread as the read-only view shows it. */
export interface EmailShareThreadView {
  id: string
  subject: string
  mine: boolean
  messages: EmailShareMessage[]
  /** Frozen messages the mailbox no longer has (each one "no longer available"). */
  missing: number
  /** Remote images and CSS urls left out across the messages; 0 when there were none, or they were asked for. */
  blockedImages: number
}

/** The message words a share posts: the note as typed (tidied), or the default line. */
export function emailShareBody(note: unknown): string {
  const words = typeof note === 'string' ? note.replace(/\r\n?/g, '\n').trim() : ''
  return words ? words.slice(0, EMAIL_SHARE_NOTE_MAX) : EMAIL_SHARE_DEFAULT_BODY
}

/** True when a share's message carries no note of its own (the view hides the default line). */
export function isDefaultShareBody(body: string | null | undefined): boolean {
  return (body ?? '').trim() === EMAIL_SHARE_DEFAULT_BODY
}

/**
 * A message's words as an agent reads them: its words, and for a message
 * carrying a share, the notice that an email was shared. Never the mail.
 */
export function emailShareAgentText(body: string | null | undefined, emailShareId: string | null | undefined): string {
  const words = body ?? ''
  if (!emailShareId) return words
  return isDefaultShareBody(words) || !words.trim() ? EMAIL_SHARE_AGENT_NOTICE : `${words}\n${EMAIL_SHARE_AGENT_NOTICE}`
}
