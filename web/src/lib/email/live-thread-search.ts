import { readableWorkspaceEmailAccounts, type ReadableEmailAccount } from './account-scope'
import { ownedMailbox, type LiveMailbox } from './thread-mailbox'
import { gmailHeaderValue, gmailMetadata, gmailThreadHeader, graphFolderOf } from './thread-headers'
import { mapGmailLabelsToFolder } from '@/lib/crm/email-sync'

/**
 * Mail's list search, at the provider and nowhere else (no stored mail,
 * 2026-10-15). The index holds the last 30 days' pointers only, so a search
 * that kept just the hits the index knows dropped every older thread (and any
 * not indexed yet): "meeting" found nothing. Here the hits ARE the results,
 * rendered from the provider's own headers; the caller merges the index's
 * flags in where it has the thread.
 *
 * The folder is the provider's: Gmail `q` with `in:inbox` (and the rest),
 * Graph's search scoped to the well-known folder. A page is SEARCH_PAGE hits
 * per mailbox, newest first; the cursor carries each mailbox's own page token
 * (Gmail's nextPageToken, Graph's nextLink), so the list pages on. Per page:
 * Gmail one list call and one metadata batch, Graph one call. Never throws:
 * a mailbox that fails adds nothing.
 */

/** Hits per mailbox per page (one Gmail metadata batch: 50 x 5 quota units). */
export const SEARCH_PAGE = 50

export interface LiveSearchHit {
  accountId: string
  provider: 'google' | 'microsoft'
  threadId: string
  messageId: string
  subject: string | null
  snippet: string | null
  fromName: string | null
  fromEmail: string | null
  date: string | null
  isUnread: boolean
  isStarred: boolean
  hasAttachments: boolean
  /** The Mail folder the newest hit sits in, when the provider says. */
  folder: string | null
}

export interface LiveSearchOptions {
  query: string
  /** Mail's folder: inbox, sent, drafts, spam, trash, archive, starred, or all. */
  folder: string
  /** Narrows the person's readable mailboxes here (never widens them). */
  accountIds?: readonly string[] | null
  unreadOnly?: boolean
  hasAttachments?: boolean
  from?: string | null
  /** The previous page's cursor; null or absent for the first page. */
  cursor?: string | null
  limit?: number
}

export interface LiveSearchPage {
  hits: LiveSearchHit[]
  /** Set while any mailbox has more. */
  cursor: string | null
  /** The mailboxes searched (for the caller's account chips). */
  accounts: ReadableEmailAccount[]
}

export interface LiveSearchDeps {
  accounts?: (userId: string, workspaceId: string) => Promise<ReadableEmailAccount[]>
  mailbox?: (userId: string, accountId: string) => Promise<LiveMailbox | null>
}

type Cursor = Record<string, string>

export function encodeSearchCursor(cursor: Cursor): string | null {
  return Object.keys(cursor).length ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

/** A cursor this route wrote, or null for anything else (never trusted past its shape). */
export function decodeSearchCursor(raw: string | null | undefined): Cursor | null {
  if (!raw || raw.length > 8_000) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const out: Cursor = {}
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === 'string' && t) out[k] = t
    return out
  } catch {
    return null
  }
}

const GMAIL_FOLDER_QUERY: Record<string, string> = {
  inbox: 'in:inbox',
  sent: 'in:sent',
  drafts: 'in:drafts',
  spam: 'in:spam',
  trash: 'in:trash',
  starred: 'is:starred',
  // Gmail has no archive label: what is in neither the inbox nor a system folder.
  archive: '-in:inbox -in:sent -in:drafts -in:spam -in:trash',
}

/** The Gmail `q` for a search (Gmail already leaves spam and trash out of a plain search). */
export function gmailSearchQuery(opts: LiveSearchOptions): string {
  const parts = [opts.query.trim()]
  const folder = GMAIL_FOLDER_QUERY[opts.folder]
  if (folder) parts.push(folder)
  if (opts.unreadOnly) parts.push('is:unread')
  if (opts.hasAttachments) parts.push('has:attachment')
  if (opts.from) parts.push(`from:${opts.from.replace(/\s+/g, '')}`)
  return parts.filter(Boolean).join(' ')
}

function parseAddress(raw: string): { name: string | null; email: string | null } {
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+@[^>]+)>\s*$/)
  if (m) return { name: m[1]?.trim() || null, email: m[2].trim().toLowerCase() }
  const bare = raw.trim().toLowerCase()
  return { name: null, email: bare.includes('@') ? bare : null }
}

async function searchGmailPage(
  mailbox: LiveMailbox,
  accountId: string,
  opts: LiveSearchOptions,
  pageToken: string | undefined,
  limit: number,
): Promise<{ hits: LiveSearchHit[]; next: string | null }> {
  const params = new URLSearchParams({ q: gmailSearchQuery(opts), maxResults: String(limit) })
  if (pageToken) params.set('pageToken', pageToken)
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${mailbox.token}` },
  })
  if (!res.ok) return { hits: [], next: null }
  const data = (await res.json()) as { messages?: Array<{ id?: string; threadId?: string }>; nextPageToken?: string }
  // The list is newest first: a thread's first hit is its newest matching message.
  const firstByThread = new Map<string, string>()
  for (const m of data.messages ?? []) {
    if (typeof m.id === 'string' && typeof m.threadId === 'string' && !firstByThread.has(m.threadId)) firstByThread.set(m.threadId, m.id)
  }
  const meta = await gmailMetadata(mailbox.token, [...firstByThread.values()], { headers: ['Subject', 'From', 'Date'] })
  const hits: LiveSearchHit[] = []
  for (const [threadId, messageId] of firstByThread) {
    const msg = meta.get(messageId)
    if (!msg) continue
    const header = gmailThreadHeader(msg)
    const from = parseAddress(gmailHeaderValue(msg, 'from'))
    const labels = msg.labelIds ?? []
    const at = Number(msg.internalDate)
    hits.push({
      accountId,
      provider: 'google',
      threadId,
      messageId,
      subject: header.subject,
      snippet: header.snippet,
      fromName: header.from_name ?? from.name,
      fromEmail: from.email,
      date: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null,
      isUnread: labels.includes('UNREAD'),
      isStarred: labels.includes('STARRED'),
      hasAttachments: false,
      folder: mapGmailLabelsToFolder(labels),
    })
  }
  return { hits, next: typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null }
}

const GRAPH_SELECT = 'id,conversationId,subject,bodyPreview,from,receivedDateTime,isRead,hasAttachments,flag,parentFolderId'
/** What a whole-mailbox search leaves out, as Gmail's plain search does: Deleted Items and Junk. */
const GRAPH_EXCLUDED_FOLDERS = ['deleteditems', 'junkemail'] as const
const GRAPH_ORIGIN = 'https://graph.microsoft.com/'

/** The Graph search URL for a first page: folder-scoped where Graph has the folder. */
export function graphSearchUrl(opts: LiveSearchOptions, limit: number): string {
  const text = [opts.query.trim(), opts.from ? `from:${opts.from.replace(/\s+/g, '')}` : '']
    .filter(Boolean)
    .join(' ')
    .replace(/"/g, '')
  const params = new URLSearchParams({ $search: `"${text}"`, $top: String(limit), $select: GRAPH_SELECT })
  const folder = graphFolderOf(opts.folder)
  const base = folder ? `${GRAPH_ORIGIN}v1.0/me/mailFolders/${folder}/messages` : `${GRAPH_ORIGIN}v1.0/me/messages`
  return `${base}?${params}`
}

/**
 * The ids of the folders a whole-mailbox Graph search leaves out (Graph's
 * $search takes no $filter, so they are dropped from the page by
 * parentFolderId). A folder Graph won't name is not filtered.
 */
async function graphExcludedFolderIds(token: string): Promise<Set<string>> {
  const ids = await Promise.all(
    GRAPH_EXCLUDED_FOLDERS.map(async (name) => {
      try {
        const res = await fetch(`${GRAPH_ORIGIN}v1.0/me/mailFolders/${name}?$select=id`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return null
        const id = ((await res.json()) as { id?: unknown }).id
        return typeof id === 'string' && id ? id : null
      } catch {
        return null
      }
    }),
  )
  return new Set(ids.filter((id): id is string => !!id))
}

async function searchGraphPage(
  mailbox: LiveMailbox,
  accountId: string,
  opts: LiveSearchOptions,
  nextLink: string | undefined,
  limit: number,
): Promise<{ hits: LiveSearchHit[]; next: string | null }> {
  // A page token is Graph's own nextLink; only ever followed to Graph.
  const url = nextLink && nextLink.startsWith(GRAPH_ORIGIN) ? nextLink : graphSearchUrl(opts, limit)
  // A whole-mailbox search (All, Starred) skips Deleted Items and Junk; a folder search is already scoped.
  const wholeMailbox = !graphFolderOf(opts.folder)
  const [res, excluded] = await Promise.all([
    fetch(url, { headers: { Authorization: `Bearer ${mailbox.token}`, ConsistencyLevel: 'eventual' } }),
    wholeMailbox ? graphExcludedFolderIds(mailbox.token) : Promise.resolve(new Set<string>()),
  ])
  if (!res.ok) return { hits: [], next: null }
  const data = (await res.json()) as { value?: Array<Record<string, unknown>>; '@odata.nextLink'?: string }
  const seen = new Set<string>()
  const hits: LiveSearchHit[] = []
  for (const m of data.value ?? []) {
    const threadId = typeof m.conversationId === 'string' ? m.conversationId : null
    const messageId = typeof m.id === 'string' ? m.id : null
    if (!threadId || !messageId || seen.has(threadId)) continue
    if (typeof m.parentFolderId === 'string' && excluded.has(m.parentFolderId)) continue
    seen.add(threadId)
    const from = (m.from as { emailAddress?: { name?: string; address?: string } } | undefined)?.emailAddress
    const isUnread = m.isRead === false
    const isStarred = (m.flag as { flagStatus?: string } | undefined)?.flagStatus === 'flagged'
    const hasAttachments = m.hasAttachments === true
    // Graph's $search takes no $filter: the switches apply here.
    if (opts.unreadOnly && !isUnread) continue
    if (opts.hasAttachments && !hasAttachments) continue
    if (opts.folder === 'starred' && !isStarred) continue
    hits.push({
      accountId,
      provider: 'microsoft',
      threadId,
      messageId,
      subject: typeof m.subject === 'string' && m.subject.trim() ? m.subject.trim().slice(0, 500) : null,
      snippet: typeof m.bodyPreview === 'string' && m.bodyPreview.trim() ? m.bodyPreview.trim().slice(0, 200) : null,
      fromName: from?.name?.trim() || null,
      fromEmail: from?.address?.trim().toLowerCase() || null,
      date: typeof m.receivedDateTime === 'string' ? m.receivedDateTime : null,
      isUnread,
      isStarred,
      hasAttachments,
      folder: graphFolderOf(opts.folder) ? opts.folder : null,
    })
  }
  const next = data['@odata.nextLink']
  return { hits, next: typeof next === 'string' && next.startsWith(GRAPH_ORIGIN) ? next : null }
}

/**
 * One page of a search across the person's readable mailboxes here (narrowed
 * to `accountIds`), newest first, one row per thread per mailbox.
 */
export async function searchThreadsLive(
  userId: string,
  workspaceId: string,
  opts: LiveSearchOptions,
  deps: LiveSearchDeps = {},
): Promise<LiveSearchPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? SEARCH_PAGE), SEARCH_PAGE)
  if (opts.query.trim().length < 2) return { hits: [], cursor: null, accounts: [] }
  let accounts: ReadableEmailAccount[] = []
  try {
    accounts = await (deps.accounts ?? ((u, w) => readableWorkspaceEmailAccounts(u, w)))(userId, workspaceId)
  } catch {
    return { hits: [], cursor: null, accounts: [] }
  }
  if (opts.accountIds) {
    const wanted = new Set(opts.accountIds)
    accounts = accounts.filter((a) => wanted.has(a.id))
  }
  // A later page asks only the mailboxes that had more.
  const cursor = opts.cursor ? decodeSearchCursor(opts.cursor) : null
  if (opts.cursor && !cursor) return { hits: [], cursor: null, accounts }
  const searched = cursor ? accounts.filter((a) => cursor[a.id]) : accounts

  const resolveMailbox = deps.mailbox ?? ownedMailbox
  const next: Cursor = {}
  const pages = await Promise.all(
    searched.map(async (account) => {
      try {
        const mailbox = await resolveMailbox(userId, account.id)
        if (!mailbox) return []
        const token = cursor?.[account.id]
        const page = mailbox.provider === 'google'
          ? await searchGmailPage(mailbox, account.id, opts, token, limit)
          : await searchGraphPage(mailbox, account.id, opts, token, limit)
        if (page.next) next[account.id] = page.next
        return page.hits
      } catch (err) {
        console.error('[email-search] a mailbox search failed:', err instanceof Error ? err.message : 'unknown error')
        return []
      }
    }),
  )
  const hits = pages.flat().sort((a, b) => (Date.parse(b.date ?? '') || 0) - (Date.parse(a.date ?? '') || 0))
  return { hits, cursor: encodeSearchCursor(next), accounts }
}
