/**
 * Mail attachments in Drive (docs/plans/drive-files.md, phase 2): the files
 * attached to mail in the person's OWN mailboxes linked to this workspace,
 * read live from Gmail or Graph, a page at a time, newest first.
 *
 * Nothing is stored: not the file, not its name, not the message's subject
 * (the 10-15 rule behind migration 344: the app keeps no copy of anyone's
 * mail). Each file opens through the mailbox's own attachment route
 * (`/api/account/email/threads/[threadId]/attachment`), which reads it from
 * the same mailbox again. Visibility is the person's own mailboxes only
 * (readableWorkspaceEmailAccounts): narrower than "who can see the thread",
 * never wider. A mailbox that fails adds nothing; this never throws.
 *
 * Cost per page and mailbox: Gmail, one list call and one message read per
 * hit (its attachments' names live only in the full message); Graph, one
 * call (attachments expanded in it), plus one for the folders it leaves out.
 */
import { readableWorkspaceEmailAccounts, type ReadableEmailAccount } from '@/lib/email/account-scope'
import { graphExcludedFolderIds } from '@/lib/email/live-thread-search'
import { ownedMailbox, type LiveMailbox } from '@/lib/email/thread-mailbox'

export interface MailFile {
  /** Stable key: the mailbox, message and the file's name. */
  key: string
  accountId: string
  provider: 'google' | 'microsoft'
  threadId: string
  messageId: string
  name: string
  mimeType: string
  size: number
  /** The message's subject and sender, read live and shown, never kept. */
  subject: string | null
  fromName: string | null
  fromEmail: string | null
  /** When the message came (ISO). */
  date: string | null
  /** Where it opens: the owner's attachment route. */
  href: string
}

export interface MailFilesPage {
  files: MailFile[]
  /** The next page's cursor, while any mailbox has more. */
  cursor: string | null
  /** How many of the person's mailboxes were read. */
  mailboxes: number
}

export interface MailFilesDeps {
  accounts?: (userId: string, workspaceId: string) => Promise<ReadableEmailAccount[]>
  mailbox?: (userId: string, accountId: string) => Promise<LiveMailbox | null>
  fetch?: typeof fetch
}

/** Messages read per mailbox per page. */
export const MAIL_FILES_PAGE = 20
const READ_CONCURRENCY = 6

/** The owner's route that reads one attachment (the viewer and the download use it). */
export function mailFileHref(threadId: string, messageId: string, name: string): string {
  return `/api/account/email/threads/${encodeURIComponent(threadId)}/attachment?message=${encodeURIComponent(messageId)}&name=${encodeURIComponent(name)}`
}

type Cursor = Record<string, string>

function encodeCursor(cursor: Cursor): string | null {
  return Object.keys(cursor).length ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

/** A cursor this module wrote, or null (never trusted past its shape). */
export function decodeMailFilesCursor(raw: string | null | undefined): Cursor | null {
  if (!raw || raw.length > 8000) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const out: Cursor = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val.length <= 4000 && /^[0-9a-f-]{36}$/i.test(k)) out[k] = val
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

/** The Gmail `q` for a page: messages with files, out of spam and trash, with the person's words. */
export function gmailFilesQuery(words: string): string {
  return ['has:attachment', '-in:spam', '-in:trash', words.trim().replace(/\s+/g, ' ')].filter(Boolean).join(' ')
}

interface GmailPart {
  filename?: string
  mimeType?: string
  body?: { size?: number; attachmentId?: string }
  headers?: Array<{ name?: string; value?: string }>
  parts?: GmailPart[]
}

const headerOf = (part: { headers?: Array<{ name?: string; value?: string }> } | undefined, name: string) =>
  part?.headers?.find((h) => (h.name ?? '').toLowerCase() === name)?.value ?? ''

/**
 * The files of a Gmail message's parts: a part with a file name and a body of
 * its own. A picture placed inline in the body (a signature's logo) is not a
 * file the person sent, and is left out.
 */
export function gmailFilesOf(payload: GmailPart | undefined): Array<{ name: string; mimeType: string; size: number }> {
  const out: Array<{ name: string; mimeType: string; size: number }> = []
  const walk = (part: GmailPart | undefined, depth: number) => {
    if (!part || depth > 8) return
    const name = (part.filename ?? '').trim()
    const disposition = headerOf(part, 'content-disposition').toLowerCase()
    const inlineImage = disposition.startsWith('inline') && (part.mimeType ?? '').startsWith('image/')
    if (name && part.body?.attachmentId && !inlineImage) out.push({ name, mimeType: part.mimeType || 'application/octet-stream', size: part.body.size ?? 0 })
    for (const child of part.parts ?? []) walk(child, depth + 1)
  }
  walk(payload, 0)
  return out
}

function parseAddress(raw: string): { name: string | null; email: string | null } {
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+@[^>]+)>\s*$/)
  if (m) return { name: m[1]?.trim() || null, email: m[2].trim().toLowerCase() }
  const bare = raw.trim().toLowerCase()
  return { name: null, email: bare.includes('@') ? bare : null }
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

// Only the parts that name files, and the three headers shown.
const GMAIL_FIELDS =
  'id,threadId,internalDate,payload(headers,filename,mimeType,body(size,attachmentId),parts(headers,filename,mimeType,body(size,attachmentId),parts(headers,filename,mimeType,body(size,attachmentId),parts(headers,filename,mimeType,body(size,attachmentId)))))'

async function gmailPage(f: typeof fetch, mailbox: LiveMailbox, accountId: string, words: string, token: string | undefined, limit: number) {
  const params = new URLSearchParams({ q: gmailFilesQuery(words), maxResults: String(limit) })
  if (token) params.set('pageToken', token)
  const auth = { headers: { Authorization: `Bearer ${mailbox.token}` } }
  const res = await f(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, auth)
  if (!res.ok) return { files: [] as MailFile[], next: null }
  const data = (await res.json()) as { messages?: Array<{ id?: string }>; nextPageToken?: string }
  const ids = (data.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id))
  const messages = await pool(ids, READ_CONCURRENCY, async (id) => {
    try {
      const r = await f(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full&fields=${encodeURIComponent(GMAIL_FIELDS)}`, auth)
      return r.ok ? ((await r.json()) as { id?: string; threadId?: string; internalDate?: string; payload?: GmailPart }) : null
    } catch {
      return null
    }
  })
  const files: MailFile[] = []
  for (const msg of messages) {
    if (!msg?.id || !msg.threadId) continue
    const at = Number(msg.internalDate)
    const from = parseAddress(headerOf(msg.payload, 'from'))
    for (const file of gmailFilesOf(msg.payload)) {
      files.push({
        key: `${accountId}:${msg.id}:${file.name}`,
        accountId,
        provider: 'google',
        threadId: msg.threadId,
        messageId: msg.id,
        ...file,
        subject: headerOf(msg.payload, 'subject') || null,
        fromName: from.name,
        fromEmail: from.email,
        date: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null,
        href: mailFileHref(msg.threadId, msg.id, file.name),
      })
    }
  }
  return { files, next: typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null }
}

const GRAPH = 'https://graph.microsoft.com/'

/** The first Graph page's URL: newest messages with files, or a search of the person's words (Graph's search takes no filter; those without files are dropped after). */
export function graphFilesUrl(words: string, limit: number): string {
  const select = 'id,conversationId,subject,from,receivedDateTime,hasAttachments,parentFolderId'
  const expand = 'attachments($select=name,contentType,size,isInline)'
  const text = words.trim().replace(/"/g, '')
  const params = new URLSearchParams(
    text
      ? { $search: `"${text}"`, $top: String(limit), $select: select, $expand: expand }
      : {
          $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z and hasAttachments eq true',
          $orderby: 'receivedDateTime desc',
          $top: String(limit),
          $select: select,
          $expand: expand,
        },
  )
  return `${GRAPH}v1.0/me/messages?${params}`
}

interface GraphMessage {
  id?: string
  conversationId?: string
  subject?: string
  receivedDateTime?: string
  hasAttachments?: boolean
  parentFolderId?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  attachments?: Array<{ name?: string; contentType?: string; size?: number; isInline?: boolean; '@odata.type'?: string }>
}

async function graphPage(f: typeof fetch, mailbox: LiveMailbox, accountId: string, words: string, token: string | undefined, limit: number) {
  // A next link is Graph's own; only one on Graph's origin is followed.
  const url = token && token.startsWith(`${GRAPH}v1.0/me/messages`) ? token : graphFilesUrl(words, limit)
  const auth = { headers: { Authorization: `Bearer ${mailbox.token}` } }
  const [res, excluded] = await Promise.all([f(url, auth), graphExcludedFolderIds(mailbox.token)])
  if (!res.ok) return { files: [] as MailFile[], next: null }
  const data = (await res.json()) as { value?: GraphMessage[]; '@odata.nextLink'?: string }
  const files: MailFile[] = []
  for (const msg of data.value ?? []) {
    if (!msg.id || !msg.conversationId || !msg.hasAttachments) continue
    if (msg.parentFolderId && excluded.has(msg.parentFolderId)) continue
    for (const a of msg.attachments ?? []) {
      const name = (a.name ?? '').trim()
      // A file attachment only: not an inline picture, not an attached message or a link to a cloud file.
      if (!name || a.isInline || (a['@odata.type'] && a['@odata.type'] !== '#microsoft.graph.fileAttachment')) continue
      files.push({
        key: `${accountId}:${msg.id}:${name}`,
        accountId,
        provider: 'microsoft',
        threadId: msg.conversationId,
        messageId: msg.id,
        name,
        mimeType: a.contentType || 'application/octet-stream',
        size: a.size ?? 0,
        subject: msg.subject ?? null,
        fromName: msg.from?.emailAddress?.name ?? null,
        fromEmail: msg.from?.emailAddress?.address?.toLowerCase() ?? null,
        date: msg.receivedDateTime ?? null,
        href: mailFileHref(msg.conversationId, msg.id, name),
      })
    }
  }
  const next = data['@odata.nextLink']
  return { files, next: typeof next === 'string' && next.startsWith(GRAPH) ? next : null }
}

/** One page of the files in the person's own mailboxes here (see the header). */
export async function listMailFiles(
  userId: string,
  workspaceId: string,
  opts: { q?: string | null; cursor?: string | null; limit?: number },
  deps: MailFilesDeps = {},
): Promise<MailFilesPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? MAIL_FILES_PAGE), MAIL_FILES_PAGE)
  const f = deps.fetch ?? fetch
  let accounts: ReadableEmailAccount[] = []
  try {
    accounts = await (deps.accounts ?? readableWorkspaceEmailAccounts)(userId, workspaceId)
  } catch {
    return { files: [], cursor: null, mailboxes: 0 }
  }
  const cursor = opts.cursor ? decodeMailFilesCursor(opts.cursor) : null
  if (opts.cursor && !cursor) return { files: [], cursor: null, mailboxes: accounts.length }
  const read = cursor ? accounts.filter((a) => cursor[a.id]) : accounts
  const resolve = deps.mailbox ?? ownedMailbox
  const next: Cursor = {}
  const pages = await Promise.all(
    read.map(async (account) => {
      try {
        const mailbox = await resolve(userId, account.id)
        if (!mailbox) return []
        const page =
          mailbox.provider === 'google'
            ? await gmailPage(f, mailbox, account.id, opts.q ?? '', cursor?.[account.id], limit)
            : await graphPage(f, mailbox, account.id, opts.q ?? '', cursor?.[account.id], limit)
        if (page.next) next[account.id] = page.next
        return page.files
      } catch (err) {
        console.error('[drive-mail-files] a mailbox read failed:', err instanceof Error ? err.message : 'unknown error')
        return []
      }
    }),
  )
  const files = pages.flat().sort((a, b) => (Date.parse(b.date ?? '') || 0) - (Date.parse(a.date ?? '') || 0))
  return { files, cursor: encodeCursor(next), mailboxes: accounts.length }
}
