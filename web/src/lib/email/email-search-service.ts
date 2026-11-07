import { readableWorkspaceEmailAccounts } from './account-scope'
import { ownedMailbox, type LiveMailbox } from './thread-mailbox'
import { mapGmailLabelsToFolder } from '@/lib/crm/email-sync'
import { decodeHtmlEntities } from './html-entities'

/**
 * Mail search, at the provider only. No stored mail (2026-10-15): there is no
 * local copy to search, so a query goes to Gmail (`q=`) and Graph (`$search`,
 * or `$filter` for a filter-only query) for each mailbox the workspace may
 * read (readableWorkspaceEmailAccounts: the person's own accounts linked
 * here), in parallel, newest first. The results live in memory for the caller;
 * nothing is written.
 */

// =====================================================================
// Types
// =====================================================================

export interface EmailSearchResult {
  threadId: string
  messageId?: string
  subject: string
  from: { name: string | null; email: string }
  snippet: string
  date: string
  isUnread: boolean
  folder: string
  matchSource: 'provider'
  /** The mailbox it came from. */
  account?: string | null
}

export interface EmailSearchOptions {
  query: string
  folder?: string
  from?: string
  to?: string
  after?: string
  before?: string
  hasAttachment?: boolean
  limit?: number
}

/** Most results one search returns; each Gmail hit costs one metadata read. */
const SEARCH_MAX = 25

// =====================================================================
// Search
// =====================================================================

export async function searchEmails(
  userId: string,
  workspaceId: string,
  options: EmailSearchOptions,
): Promise<{ results: EmailSearchResult[]; source: 'provider' }> {
  const limit = Math.min(Math.max(1, options.limit || 20), SEARCH_MAX)
  const hasCriteria = !!(options.query?.trim() || options.from || options.to || options.after || options.before || options.hasAttachment || options.folder)
  if (!hasCriteria) return { results: [], source: 'provider' }

  let accounts: Array<{ id: string; account_email: string | null }> = []
  try {
    accounts = await readableWorkspaceEmailAccounts(userId, workspaceId)
  } catch (err) {
    console.error('[email-search] mailboxes not read:', err instanceof Error ? err.message : 'unknown error')
    return { results: [], source: 'provider' }
  }

  const perMailbox = await Promise.all(
    accounts.map(async (account) => {
      try {
        const mailbox = await ownedMailbox(userId, account.id)
        if (!mailbox) return []
        const found = await searchMailbox(mailbox, options, limit)
        return found.map((r) => ({ ...r, account: account.account_email }))
      } catch (err) {
        console.error('[email-search] a mailbox search failed:', err instanceof Error ? err.message : 'unknown error')
        return []
      }
    }),
  )

  // One row per thread, newest first.
  const seen = new Set<string>()
  const results = perMailbox
    .flat()
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .filter((r) => (seen.has(r.threadId) ? false : (seen.add(r.threadId), true)))
    .slice(0, limit)
  return { results, source: 'provider' }
}

/** One mailbox's matches. Exported for its tests. */
export async function searchMailbox(mailbox: LiveMailbox, options: EmailSearchOptions, limit: number): Promise<EmailSearchResult[]> {
  return mailbox.provider === 'google' ? searchGmail(mailbox.token, options, limit) : searchOutlook(mailbox.token, options, limit)
}

async function searchGmail(
  accessToken: string,
  options: EmailSearchOptions,
  limit: number,
): Promise<EmailSearchResult[]> {
  const parts: string[] = []
  if (options.query) parts.push(options.query)
  if (options.from) parts.push(`from:${options.from}`)
  if (options.to) parts.push(`to:${options.to}`)
  if (options.after) parts.push(`after:${formatGmailDate(options.after)}`)
  if (options.before) parts.push(`before:${formatGmailDate(options.before)}`)
  if (options.hasAttachment) parts.push('has:attachment')
  if (options.folder === 'starred') parts.push('is:starred')
  else if (options.folder && GMAIL_FOLDER_QUERY[options.folder]) parts.push(GMAIL_FOLDER_QUERY[options.folder])

  const params = new URLSearchParams({ q: parts.join(' '), maxResults: String(limit) })
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return []
  const data = await res.json()
  const ids: string[] = ((data.messages ?? []) as Array<{ id: string }>).map((m) => m.id).slice(0, limit)
  if (!ids.length) return []

  // The hits' headers, in parallel (5 quota units each; at most SEARCH_MAX).
  const found = await Promise.all(
    ids.map(async (id) => {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!msgRes.ok) return null
        const msg = await msgRes.json()
        const headers = (msg.payload?.headers || []) as Array<{ name: string; value: string }>
        const getHeader = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
        return {
          threadId: msg.threadId as string,
          messageId: msg.id as string,
          subject: getHeader('Subject') || '(no subject)',
          from: parseEmailAddress(getHeader('From')),
          snippet: decodeHtmlEntities((msg.snippet as string) || ''),
          date: new Date(parseInt(msg.internalDate)).toISOString(),
          isUnread: ((msg.labelIds as string[] | undefined) ?? []).includes('UNREAD'),
          folder: mapGmailLabelsToFolder((msg.labelIds as string[] | undefined) ?? []),
          matchSource: 'provider' as const,
        }
      } catch {
        return null
      }
    }),
  )
  return found.filter((r): r is NonNullable<typeof r> => r !== null)
}

const GMAIL_FOLDER_QUERY: Record<string, string> = {
  inbox: 'in:inbox',
  sent: 'in:sent',
  drafts: 'in:drafts',
  spam: 'in:spam',
  trash: 'in:trash',
}

async function searchOutlook(
  accessToken: string,
  options: EmailSearchOptions,
  limit: number,
): Promise<EmailSearchResult[]> {
  const select = 'id,conversationId,subject,from,receivedDateTime,isRead,bodyPreview'
  const params = new URLSearchParams({ $top: String(limit), $select: select })
  const text = [options.query, options.from && `from:${options.from}`, options.to && `to:${options.to}`]
    .filter((t): t is string => !!t && !!t.trim())
    .join(' ')
  if (text) {
    // Graph refuses $search with $orderby (it ranks by relevance); dates are filtered after.
    params.set('$search', `"${text.replace(/"/g, '')}"`)
  } else {
    const filter: string[] = []
    if (options.after) filter.push(`receivedDateTime ge ${new Date(options.after).toISOString()}`)
    if (options.before) filter.push(`receivedDateTime le ${new Date(options.before).toISOString()}`)
    if (options.hasAttachment) filter.push('hasAttachments eq true')
    if (filter.length) params.set('$filter', filter.join(' and '))
    params.set('$orderby', 'receivedDateTime desc')
  }

  const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, ...(text ? { ConsistencyLevel: 'eventual' } : {}) },
  })
  if (!res.ok) return []
  const data = await res.json()
  const after = options.after ? Date.parse(options.after) : NaN
  const before = options.before ? Date.parse(options.before) : NaN

  return ((data.value || []) as Array<Record<string, unknown>>)
    .filter((msg) => {
      const at = Date.parse(msg.receivedDateTime as string)
      return !(Number.isFinite(after) && at < after) && !(Number.isFinite(before) && at > before)
    })
    .map((msg) => ({
      threadId: (msg.conversationId as string) || (msg.id as string),
      messageId: msg.id as string,
      subject: (msg.subject as string) || '(no subject)',
      from: {
        name: (msg.from as Record<string, Record<string, string>>)?.emailAddress?.name || null,
        email: (msg.from as Record<string, Record<string, string>>)?.emailAddress?.address?.toLowerCase() || '',
      },
      snippet: (msg.bodyPreview as string) || '',
      date: msg.receivedDateTime as string,
      isUnread: !(msg.isRead as boolean),
      folder: '',
      matchSource: 'provider' as const,
    }))
}

// =====================================================================
// Helpers
// =====================================================================

function formatGmailDate(isoDate: string): string {
  const d = new Date(isoDate)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function parseEmailAddress(raw: string): { name: string | null; email: string } {
  const match = raw.match(/^(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?$/)
  if (match) {
    return { name: match[1]?.trim() || null, email: match[2].trim().toLowerCase() }
  }
  return { name: null, email: raw.trim().toLowerCase() }
}
