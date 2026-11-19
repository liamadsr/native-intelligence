/**
 * A meeting guest's chat (migration 670): what a guest reads of the meeting's
 * conversation while they are in its call, and what they write in it. Pure
 * and client-safe: the guest's route (src/app/m/[token]/chat/route.ts) makes
 * each message plain here before it leaves the server, and the guest's page
 * (src/components/meeting-links/guest-chat.tsx) reads the route's answer back
 * through the same module.
 *
 * What a guest is given of a message: its time, who wrote it (a member's name
 * as the app shows it, the agent's name, a guest's name; `mine` for their
 * own), and its words as plain text. The members' messages are stored as
 * typed, and the agent's replies are markdown; mentions are plain `@Name`
 * words (src/lib/team-chat/compose.ts: the ids live in their own columns, never
 * in the words), so they stay as they read. Made plain: markdown's emphasis,
 * code, headings, quotes and fences; a link with a label becomes its label,
 * never the address behind it; an image its words; HTML comments and tags go.
 * A link into the signed-in app (its /account, /api or /admin pages, which
 * name records by their ids and open for members only) goes, and so does a
 * bare id. A link anyone may open (another site, a public form or booking
 * page) stays as typed. Never a file's path, a link's preview or a shared
 * email: a message's files are counted ("Sent a file"), a shared email is
 * "Shared an email".
 */
import { isWithinAppDomain } from '@/lib/app-url'
import { linkRuns } from '@/lib/team-chat/compose'

/** The most characters a guest's message holds (670's check). */
export const GUEST_CHAT_MAX = 2000
/** The most messages one read carries (the newest). */
export const GUEST_CHAT_READ_MAX = 100
/** The longest a member's message is shown to a guest. */
export const GUEST_CHAT_SHOWN_MAX = 4000
/** How often the guest's page asks while the call is on screen. */
export const GUEST_CHAT_POLL_MS = 4_000

export type GuestChatAuthor = 'member' | 'agent' | 'guest'

/** A message as a guest is given it. `text` may be empty when `note` says what it was ("Sent a file"). */
export interface GuestChatMessage {
  id: string
  at: string
  author: GuestChatAuthor
  name: string
  mine: boolean
  text: string
  note: string | null
}

/** 670's meeting_guest_chat_read row, as the database hands it over. */
interface ReadRow {
  id?: unknown
  at?: unknown
  author?: unknown
  label?: unknown
  mine?: unknown
  body?: unknown
  files?: unknown
  email?: unknown
}

const UUID_ANYWHERE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const APP_ONLY_PATH = /^\/(?:account|api|admin)(?:[/?#]|$)/i

/** A link into the signed-in app (members only, records by id): never shown to a guest. */
function isMembersLink(href: string): boolean {
  try {
    const url = new URL(href)
    return isWithinAppDomain(url.hostname) && APP_ONLY_PATH.test(url.pathname)
  } catch {
    return false
  }
}

/** Markdown's marks made plain, line by line (a fence's own line goes; a heading, quote or list keeps its words). */
function plainMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]*\[[^\]\n]+\]:.*$/gm, '')
    .replace(/<[^>\n]*>/g, '')
    .replace(/^[ \t]*(?:```|~~~).*$/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
}

/**
 * A stored message's words as a guest reads them: plain text, no address
 * behind a label, no link into the signed-in app, no bare id, line breaks
 * kept (at most one empty line in a row), at most GUEST_CHAT_SHOWN_MAX
 * characters.
 */
export function guestChatTextOf(body: string | null | undefined): string {
  const plain = plainMarkdown((body ?? '').replace(/\r\n?/g, '\n'))
  // Links as typed: one into the signed-in app goes; a bare id goes from the words between them, never from inside a link.
  const out = linkRuns(plain)
    .map((run) => (run.href ? (isMembersLink(run.href) ? '' : run.text) : run.text.replace(UUID_ANYWHERE, '')))
    .join('')
    // A path into the signed-in app typed on its own ("see /account/actions/…").
    .replace(/(^|\s)\/(?:account|api|admin)\/\S*/gi, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return [...out].length > GUEST_CHAT_SHOWN_MAX ? `${[...out].slice(0, GUEST_CHAT_SHOWN_MAX - 1).join('').trimEnd()}…` : out
}

/** What a message that is (also) files or a share says, plainly. */
function noteOf(files: number, email: boolean): string | null {
  if (email) return 'Shared an email'
  if (files === 1) return 'Sent a file'
  if (files > 1) return `Sent ${files} files`
  return null
}

const AUTHORS: readonly GuestChatAuthor[] = ['member', 'agent', 'guest']

/**
 * 670's rows as a guest is given them (server side): only these fields, the
 * words made plain; a message with nothing left to show (neither words nor a
 * note) is left out.
 */
export function guestChatMessagesOf(raw: unknown): GuestChatMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row): GuestChatMessage[] => {
    const r = (row ?? {}) as ReadRow
    const author = AUTHORS.find((a) => a === r.author)
    if (typeof r.id !== 'string' || typeof r.at !== 'string' || !author) return []
    const name = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : author === 'guest' ? 'Guest' : author === 'agent' ? 'Agent' : 'Teammate'
    const files = typeof r.files === 'number' && Number.isFinite(r.files) ? Math.max(0, Math.floor(r.files)) : 0
    const email = r.email === true
    // A shared email's words are the sharer's note about mail the guest can't open: the note alone says it.
    const text = email ? '' : guestChatTextOf(typeof r.body === 'string' ? r.body : '')
    const note = noteOf(files, email)
    if (!text && !note) return []
    return [{ id: r.id, at: r.at, author, name, mine: r.mine === true && author === 'guest', text, note }]
  })
}

/** The route's answer as the page reads it: only the fields a message may carry. */
export function guestChatListOf(raw: unknown): GuestChatMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row): GuestChatMessage[] => {
    const r = (row ?? {}) as Partial<Record<keyof GuestChatMessage, unknown>>
    const author = AUTHORS.find((a) => a === r.author)
    if (typeof r.id !== 'string' || typeof r.at !== 'string' || !author || typeof r.name !== 'string' || typeof r.text !== 'string') return []
    return [{ id: r.id, at: r.at, author, name: r.name, mine: r.mine === true, text: r.text, note: typeof r.note === 'string' ? r.note : null }]
  })
}

/** A guest's words as sent: line breaks made plain, control characters out, trimmed; null when empty or over GUEST_CHAT_MAX. */
export function tidyGuestWords(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const words = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (!words || [...words].length > GUEST_CHAT_MAX) return null
  return words
}

/**
 * Of a list, the messages from others newer than `seenAt` (ms, the newest the
 * guest had on screen; null: never): what the Chat control's dot counts.
 * Their own never count.
 */
export function unreadSince(list: readonly GuestChatMessage[], seenAt: number | null): number {
  return list.filter((m) => !m.mine && (seenAt === null || Date.parse(m.at) > seenAt)).length
}

/** A list with one more message in (by id; oldest first). */
export function withMessage(list: readonly GuestChatMessage[], message: GuestChatMessage): GuestChatMessage[] {
  const rest = list.filter((m) => m.id !== message.id)
  return [...rest, message].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
}
