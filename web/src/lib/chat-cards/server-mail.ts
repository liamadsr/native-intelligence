/**
 * The server half of a mail card (docs/plans/one-agent-and-chat-pages.md,
 * P2): `show` checks the folder, mailboxes or thread and counts the threads
 * once, `read_card` lists the threads the card shows now.
 *
 * Mail is per person. Visibility is exactly list_emails' and read_email's:
 *   - only the person's OWN mailboxes this workspace may read
 *     (readableWorkspaceEmailAccounts: linked here, or never-linked orphans),
 *     never one scoped to another workspace, never a teammate's;
 *   - only this workspace's copy of each thread (email_thread_index keeps one
 *     per linked workspace), and only rows whose user_id is the person's;
 *   - the query runs on the service client, so every one of those is an
 *     explicit filter here, never left to RLS.
 * An account filter can only narrow those mailboxes; a refusal lists the
 * person's own readable addresses, nobody else's.
 *
 * Subjects and previews are written by whoever sent the mail: they go to the
 * model inside the untrusted marker, as list_emails sends them. The sender's
 * address and name stay bare, as there.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readableWorkspaceEmailAccounts, type ReadableEmailAccount } from '@/lib/email/account-scope'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { fetchThreadHeaders, type ThreadHeader } from '@/lib/email/thread-headers'
import { searchThreadsLive, type LiveSearchHit } from '@/lib/email/live-thread-search'
import type { MailCardSpec, MailQuery } from './kinds'
import type { Checked } from './validate'

export interface MailScope {
  supabase: SupabaseClient
  workspaceId: string
  userId: string
}

/** One thread in short form, as show and read_card hand it to the model. */
export interface MailItem {
  thread_id: string
  from: string
  subject: string | null
  date: string | null
  unread?: boolean
  needs_reply?: boolean
  starred?: boolean
  account?: string
  /** One thread (a thread card): how many messages it holds. */
  messages?: number
}

const THREAD_COLUMNS =
  'id, provider, provider_thread_id, provider_message_id, account_id, from_email, last_message_at, is_unread, is_starred, needs_reply, folder, message_count'

interface ThreadRow {
  id: string
  provider: string | null
  provider_thread_id: string
  provider_message_id: string | null
  account_id: string
  from_email: string | null
  last_message_at: string | null
  is_unread: boolean | null
  is_starred: boolean | null
  needs_reply: boolean | null
  folder: string | null
  message_count: number | null
}

/**
 * The mailboxes a card may read: the person's readable mailboxes here,
 * narrowed to the card's accounts (emails or ids). A name that is not one of
 * them is refused, naming the person's own addresses.
 */
export async function resolveMailAccounts(scope: MailScope, wanted: string[] | undefined): Promise<Checked<ReadableEmailAccount[]>> {
  const readable = await readableWorkspaceEmailAccounts(scope.userId, scope.workspaceId, scope.supabase)
  if (readable.length === 0) {
    return { ok: false, error: 'No mailbox is connected to this workspace. Offer the person a Connect card: call connect with provider "google" or "microsoft" and capability "email"' }
  }
  if (!wanted?.length) return { ok: true, value: readable }
  const picked: ReadableEmailAccount[] = []
  for (const w of wanted) {
    const hit = readable.find((a) => a.id.toLowerCase() === w.toLowerCase() || a.account_email?.toLowerCase() === w.toLowerCase())
    if (!hit) {
      const known = readable.map((a) => a.account_email).filter(Boolean)
      return { ok: false, error: `mail.accounts: '${w}' is not one of your mailboxes here. Use one of: ${known.join(', ')}, or leave accounts out for all` }
    }
    if (!picked.includes(hit)) picked.push(hit)
  }
  return { ok: true, value: picked }
}

function item(row: ThreadRow, accounts: ReadableEmailAccount[], header?: ThreadHeader): MailItem {
  const from = header?.from_name && row.from_email ? `${header.from_name} <${row.from_email}>` : (row.from_email ?? header?.from_name ?? '')
  const account = accounts.find((a) => a.id === row.account_id)?.account_email
  return {
    thread_id: row.provider_thread_id,
    from,
    // Read live from the mailbox (no stored mail); a sender wrote it, so it is marked as data.
    subject: wrapUntrusted(header?.subject ?? null),
    date: row.last_message_at,
    ...(row.is_unread ? { unread: true } : {}),
    ...(row.needs_reply ? { needs_reply: true } : {}),
    ...(row.is_starred ? { starred: true } : {}),
    ...(account && accounts.length > 1 ? { account } : {}),
  }
}

/** The thread rows the person may read here, before any folder or search. */
function readableThreads(scope: MailScope, accounts: ReadableEmailAccount[], opts: { count?: boolean } = {}) {
  return scope.supabase
    .from('email_thread_index')
    .select(THREAD_COLUMNS, opts.count ? { count: 'exact' } : undefined)
    .eq('user_id', scope.userId)
    .eq('workspace_id', scope.workspaceId)
    .in(
      'account_id',
      accounts.map((a) => a.id),
    )
}

/** One thread the person may read here, by its provider thread id; null when it is not one. */
export async function findMailThread(scope: MailScope, accounts: ReadableEmailAccount[], threadId: string): Promise<MailItem | null> {
  const { data, error } = await readableThreads(scope, accounts).eq('provider_thread_id', threadId).limit(1)
  if (error) throw new Error(error.message)
  const row = ((data ?? []) as unknown as ThreadRow[])[0]
  if (!row) return null
  const headers = await fetchThreadHeaders(scope.supabase, { userId: scope.userId, workspaceId: scope.workspaceId, rows: [row] })
  return { ...item(row, accounts, headers[row.id]), ...(row.message_count ? { messages: row.message_count } : {}) }
}

/** A provider search hit as show and read_card hand it to the model. */
function hitItem(hit: LiveSearchHit, accounts: ReadableEmailAccount[]): MailItem {
  const from = hit.fromName && hit.fromEmail ? `${hit.fromName} <${hit.fromEmail}>` : (hit.fromEmail ?? hit.fromName ?? '')
  const account = accounts.find((a) => a.id === hit.accountId)?.account_email
  return {
    thread_id: hit.threadId,
    from,
    // Read live from the mailbox (no stored mail); a sender wrote it, so it is marked as data.
    subject: wrapUntrusted(hit.subject),
    date: hit.date,
    ...(hit.isUnread ? { unread: true } : {}),
    ...(hit.isStarred ? { starred: true } : {}),
    ...(account && accounts.length > 1 ? { account } : {}),
  }
}

/**
 * A page of a folder's threads (newest first) and the total, as the Mail page
 * lists them. A search is the provider's, exactly as the card's list runs it
 * (GET /api/account/email/threads?search=, live-thread-search.ts): its first
 * page of hits is the count, so the card's number matches what it shows.
 */
export async function listMailThreads(
  scope: MailScope,
  accounts: ReadableEmailAccount[],
  query: MailQuery,
  limit: number,
): Promise<{ count: number; items: MailItem[] }> {
  if (query.search?.trim()) {
    const found = await searchThreadsLive(scope.userId, scope.workspaceId, {
      query: query.search,
      folder: query.folder,
      accountIds: accounts.map((a) => a.id),
      unreadOnly: !!query.unread,
    })
    return { count: found.hits.length, items: found.hits.slice(0, limit).map((h) => hitItem(h, accounts)) }
  }
  let q = readableThreads(scope, accounts, { count: true })
  if (query.folder === 'starred') q = q.eq('is_starred', true)
  else q = q.eq('folder', query.folder)
  if (query.unread) q = q.eq('is_unread', true)
  const { data, count, error } = await q.order('last_message_at', { ascending: false, nullsFirst: false }).range(0, limit - 1)
  if (error) throw new Error(error.message)
  // A thread is listed once (the list keys on provider_thread_id).
  const seen = new Set<string>()
  const rows = ((data ?? []) as unknown as ThreadRow[]).filter((r) => !seen.has(r.provider_thread_id) && !!seen.add(r.provider_thread_id))
  // The page's subjects, live: one batched call per mailbox (src/lib/email/thread-headers.ts).
  const headers = await fetchThreadHeaders(scope.supabase, { userId: scope.userId, workspaceId: scope.workspaceId, rows })
  return { count: count ?? rows.length, items: rows.map((r) => item(r, accounts, headers[r.id])) }
}

/** `show` for a mail card: the mailboxes and thread checked, the folder counted once. */
export async function showMail(
  scope: MailScope,
  spec: MailCardSpec,
  preview: number,
): Promise<Checked<{ card: MailCardSpec; count?: number; items?: MailItem[]; item?: MailItem }>> {
  const accounts = await resolveMailAccounts(scope, spec.mail.accounts)
  if (!accounts.ok) return accounts
  const ids = spec.mail.accounts?.length ? accounts.value.map((a) => a.id) : undefined
  // The card holds the account ids, so it filters the page however they were named.
  const card: MailCardSpec = { ...spec, mail: { ...spec.mail, ...(ids ? { accounts: ids } : {}) } }
  if (!ids) delete card.mail.accounts
  if (spec.mail.thread_id) {
    const thread = await findMailThread(scope, accounts.value, spec.mail.thread_id)
    if (!thread) {
      return {
        ok: false,
        error: `mail.thread_id: no thread '${spec.mail.thread_id}' in your mailboxes here. Use a thread_id from list_emails, read_email or search, or show the folder instead`,
      }
    }
    return { ok: true, value: { card, item: thread } }
  }
  const page = await listMailThreads(scope, accounts.value, card.mail, preview)
  return { ok: true, value: { card, count: page.count, items: page.items } }
}
