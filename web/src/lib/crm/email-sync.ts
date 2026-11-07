import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { getValidToken, getAllValidTokens } from '@/lib/oauth/token-manager'
import { threadCopyWorkspaceIds } from '@/lib/email/account-scope'
import { mailboxAddresses } from '@/lib/email/reply-policy'
import {
  AUTOMATED_HEADER_NAMES,
  automatedCategory,
  automatedSenderReason,
  headerLookup,
  type AutomatedReason,
} from '@/lib/email/automated-sender'

// ---------------------------------------------------------------------------
// Email Thread Sync: ids, flags and addresses only. No subject, preview,
// display name or body is stored (no stored mail, 2026-10-15): the inbox
// reads those live (src/lib/email/thread-headers.ts).
// Syncs ALL connected email accounts in parallel.
// ---------------------------------------------------------------------------

export async function syncEmailThreads(
  userId: string,
  workspaceId: string,
  fullSync = false,
): Promise<{ synced: number }> {
  console.log(`[Email Refresh] syncEmailThreads called: userId=${userId} workspaceId=${workspaceId} fullSync=${fullSync}`)

  // Get all connected email accounts
  const allTokens = await getAllValidTokens(userId, 'email')
  console.log(`[Email Refresh] Found ${allTokens.length} email account(s)`)

  if (allTokens.length === 0) {
    // Legacy fallback: try single-token lookup
    const google = await getValidToken(userId, 'google', 'email')
    if (google) {
      console.log(`[Email Refresh] Legacy Google token found (email=${google.email})`)
      const result = await syncGmailThreads(google.token, google.email, userId, workspaceId, fullSync)
      console.log(`[Email Refresh] Gmail sync result: ${result.synced} threads synced`)
      return result
    }
    const microsoft = await getValidToken(userId, 'microsoft', 'email')
    if (microsoft) {
      console.log(`[Email Refresh] Legacy Microsoft token found (email=${microsoft.email})`)
      const result = await syncOutlookThreads(microsoft.token, microsoft.email, userId, workspaceId, fullSync)
      console.log(`[Email Refresh] Outlook sync result: ${result.synced} threads synced`)
      return result
    }
    console.log('[Email Refresh] No email tokens found for any provider')
    return { synced: 0 }
  }

  // Sync all accounts in parallel
  const results = await Promise.allSettled(
    allTokens.map(async ({ token, email, provider, accountId }) => {
      console.log(`[Email Refresh] Syncing ${provider} account: ${email} (accountId=${accountId})`)
      const syncFn = provider === 'google' ? syncGmailThreads : syncOutlookThreads
      const result = await syncFn(token, email, userId, workspaceId, fullSync, accountId)
      console.log(`[Email Refresh] ${provider} (${email}) sync result: ${result.synced} threads synced`)
      return result
    }),
  )

  const totalSynced = results.reduce((sum, r) => {
    if (r.status === 'fulfilled') return sum + r.value.synced
    console.error('[Email Refresh] Account sync failed:', r.reason)
    return sum
  }, 0)

  console.log(`[Email Refresh] Total synced across all accounts: ${totalSynced}`)
  return { synced: totalSynced }
}

// ---------------------------------------------------------------------------
// Gmail sync
// ---------------------------------------------------------------------------

async function syncGmailThreads(
  accessToken: string,
  userEmail: string | null,
  userId: string,
  workspaceId: string,
  fullSync: boolean,
  accountId?: string,
): Promise<{ synced: number }> {
  const supabaseAdmin = getServiceClient()

  // Get last sync state
  let lastHistoryId: string | null = null
  if (!fullSync) {
    const { data: syncState } = await supabaseAdmin
      .from('email_thread_index')
      .select('history_id')
      .eq('user_id', userId)
      .eq('provider', 'google')
      .not('history_id', 'is', null)
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastHistoryId = syncState?.history_id || null
  }

  // Fetch thread list
  let threadIds: string[] = []

  if (fullSync || !lastHistoryId) {
    // Full sync: recent threads
    const params = new URLSearchParams({
      maxResults: '200',
      q: 'newer_than:30d',
    })
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      console.error(`[Email Refresh] Gmail threads API error: ${res.status} ${res.statusText}`)
      return { synced: 0 }
    }
    const data = await res.json()
    threadIds = (data.threads || []).map((t: { id: string }) => t.id)
    console.log(`[Email Refresh] Gmail full sync: found ${threadIds.length} threads`)
  } else {
    // Incremental: fetch history
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${lastHistoryId}&historyTypes=messageAdded`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (res.ok) {
        const data = await res.json()
        const affectedThreadIds = new Set<string>()
        for (const h of data.history || []) {
          for (const m of h.messagesAdded || []) {
            if (m.message?.threadId) affectedThreadIds.add(m.message.threadId)
          }
        }
        threadIds = Array.from(affectedThreadIds)
      }
    } catch {
      // Fall back to full sync on error
      return syncGmailThreads(accessToken, userEmail, userId, workspaceId, true, accountId)
    }
  }

  if (threadIds.length === 0) return { synced: 0 }

  const workspaceIds = await threadCopyWorkspaceIds(accountId, workspaceId, supabaseAdmin)
  let syncedCount = 0

  // Process threads (limit to 100 for performance)
  for (const threadId of threadIds.slice(0, 100)) {
    try {
      const outcome = await indexGmailThread(
        supabaseAdmin,
        { accessToken, userEmail, userId, workspaceId, workspaceIds, threadId, accountId },
        { logWriteErrors: syncedCount < 3 },
      )
      if (outcome !== 'indexed') continue
      syncedCount++
    } catch (err) {
      if (syncedCount < 3) {
        console.error(`[Email Refresh] Gmail thread ${threadId} failed:`, err instanceof Error ? err.message : err)
      }
    }
  }

  console.log(`[Email Refresh] Gmail sync complete: ${syncedCount}/${threadIds.length} threads`)
  return { synced: syncedCount }
}

/**
 * Index a mailbox's recent threads (the last 30 days) from their metadata:
 * the initial import, and a Gmail history that expired. Ids, flags and
 * addresses only; no message is stored (no stored mail, 2026-10-15). At most
 * 100 threads, one metadata read each: flat in the mailbox's size.
 */
export async function indexRecentThreads(target: {
  accessToken: string
  userEmail: string | null
  userId: string
  workspaceId: string
  provider: 'google' | 'microsoft'
  accountId?: string
}): Promise<{ synced: number }> {
  const sync = target.provider === 'google' ? syncGmailThreads : syncOutlookThreads
  // Gmail's full listing is the last 30 days; Outlook's non-full listing is too.
  return sync(target.accessToken, target.userEmail, target.userId, target.workspaceId, target.provider === 'google', target.accountId)
}

/**
 * A thread the provider holds nothing of any more: its rows go from every
 * workspace's copy (the mailbox owner's, that account's). Never throws.
 */
export async function deleteThreadCopies(
  supabaseAdmin: SupabaseClient,
  ref: { userId: string; accountId: string | null; provider: 'google' | 'microsoft'; threadId: string },
): Promise<void> {
  try {
    let query = supabaseAdmin
      .from('email_thread_index')
      .delete()
      .eq('user_id', ref.userId)
      .eq('provider', ref.provider)
      .eq('provider_thread_id', ref.threadId)
    query = ref.accountId ? query.eq('account_id', ref.accountId) : query.is('account_id', null)
    await query
  } catch (err) {
    console.warn('[email-sync] gone thread not removed:', err instanceof Error ? err.message : err)
  }
}

/** One thread to index: the mailbox's token and address, and where its rows live. */
export interface ThreadIndexTarget {
  accessToken: string
  /** The mailbox's own address: a thread whose last message is from it needs no reply. */
  userEmail: string | null
  userId: string
  /** Where an account linked nowhere (or no account) is indexed. */
  workspaceId: string
  /**
   * The workspaces whose copy of the thread to write. Default: every workspace
   * the account is linked to (threadCopyWorkspaceIds), since each keeps its own
   * copy and Mail lists only the current workspace's.
   */
  workspaceIds?: string[]
  threadId: string
  accountId?: string | null
}

/**
 * 'gone': the provider holds nothing of the thread any more (a draft that was
 * all of it, discarded). 'unreadable': the provider would not say.
 */
export type ThreadIndexOutcome = 'indexed' | 'gone' | 'unreadable'

/**
 * Index one Gmail thread as Gmail holds it now: its row in each workspace's
 * copy (writeThreadCopies), updated in place or added. The sync runs it for
 * each thread it reads; a discarded draft runs it for the thread the draft was
 * on (src/lib/email/provider-drafts.ts), so the conversation keeps its row.
 */
export async function indexGmailThread(
  supabaseAdmin: SupabaseClient,
  target: ThreadIndexTarget,
  opts: { logWriteErrors?: boolean } = {},
): Promise<ThreadIndexOutcome> {
  const { accessToken, userEmail, userId, threadId, accountId } = target
  // The addresses, plus the automated-mail headers (src/lib/email/automated-sender.ts).
  const metadataHeaders = ['From', 'Reply-To', 'To', 'Cc', 'Date', ...AUTOMATED_HEADER_NAMES]
    .map((name) => `metadataHeaders=${encodeURIComponent(name)}`)
    .join('&')
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&${metadataHeaders}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (res.status === 404) return 'gone'
  if (!res.ok) return 'unreadable'
  const threadMeta = await res.json()

  const messages = threadMeta.messages || []
  if (messages.length === 0) return 'gone'

  const lastMessage = messages[messages.length - 1]

  const getHeader = (msg: Record<string, unknown>, name: string): string => {
    const headers = (msg.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }> || []
    return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
  }

  const fromHeader = getHeader(lastMessage, 'From')
  const replyDestination = getHeader(lastMessage, 'Reply-To').trim() || fromHeader

  // Collect all participant emails
  const allParticipants = new Set<string>()
  for (const msg of messages) {
    ;[getHeader(msg, 'From'), getHeader(msg, 'To'), getHeader(msg, 'Cc')]
      .filter(Boolean)
      .forEach((header) => extractEmails(header).forEach((e) => allParticipants.add(e.toLowerCase())))
  }

  // Determine needs_reply: never for the mailbox's own message, or automated mail.
  const senderEmail = mailboxAddresses(fromHeader)[0]
  const own = userEmail?.toLowerCase()
  const automated = automatedSenderReason({
    destination: replyDestination,
    header: (name) => getHeader(lastMessage, name),
    personSent: !!own && messages.some((m: Record<string, unknown>) => mailboxAddresses(getHeader(m, 'From'))[0] === own),
    sender: senderEmail !== own ? fromHeader : null,
  })
  const needsReply = senderEmail !== own && !automated

  // Classify
  const autoClassified = classifyThread(fromHeader, automated)

  // Determine folder from labels
  const labelIds = lastMessage.labelIds || []
  const folder = mapGmailLabelsToFolder(labelIds)
  const isDraft = labelIds.includes('DRAFT')

  const threadData = {
    user_id: userId,
    provider: 'google' as const,
    provider_thread_id: threadId,
    provider_message_id: lastMessage.id,
    account_id: accountId || null,
    from_email: senderEmail || null,
    participant_emails: Array.from(allParticipants),
    message_count: messages.length,
    is_unread: lastMessage.labelIds?.includes('UNREAD') || false,
    is_starred: lastMessage.labelIds?.includes('STARRED') || false,
    has_attachments: messages.some((m: Record<string, unknown>) => {
      const parts = (m.payload as Record<string, unknown>)?.parts as Array<{ filename?: string }> | undefined
      return parts?.some((p) => !!p.filename)
    }),
    last_message_at: lastMessage.internalDate
      ? new Date(parseInt(lastMessage.internalDate)).toISOString()
      : null,
    needs_reply: needsReply,
    auto_classified: autoClassified,
    folder,
    is_draft: isDraft,
    label_ids: labelIds,
    synced_at: new Date().toISOString(),
  }

  await writeThreadCopies(supabaseAdmin, target, threadData, senderEmail || null, { ...opts, what: 'Thread' })
  return 'indexed'
}

/**
 * Write one thread's row into each workspace's copy (`target.workspaceIds`,
 * else every workspace its account is linked to): updated in place or added,
 * its contact link that workspace's own contact for the sender. Upsert can't
 * name the COALESCE unique index, so each copy is found first.
 */
async function writeThreadCopies(
  supabaseAdmin: SupabaseClient,
  target: ThreadIndexTarget,
  threadData: Record<string, unknown>,
  senderEmail: string | null,
  opts: { logWriteErrors?: boolean; what: string },
): Promise<void> {
  const { userId, workspaceId, threadId, accountId } = target
  const workspaceIds = target.workspaceIds ?? (await threadCopyWorkspaceIds(accountId, workspaceId, supabaseAdmin))

  for (const ws of workspaceIds) {
    let linkedContactId: string | null = null
    if (senderEmail) {
      const { data: contact } = await supabaseAdmin
        .from('contact')
        .select('id')
        .eq('workspace_id', ws)
        .eq('email', senderEmail)
        .maybeSingle()
      linkedContactId = contact?.id || null
    }
    const row = { ...threadData, workspace_id: ws, linked_contact_id: linkedContactId }

    // Check if this thread already exists — try with account_id first, then without
    const { data: existingThread } = await supabaseAdmin
      .from('email_thread_index')
      .select('id, account_id')
      .eq('workspace_id', ws)
      .eq('provider_thread_id', threadId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingThread) {
      // Update existing thread (also sets account_id if it was null)
      const { error: updateErr } = await supabaseAdmin
        .from('email_thread_index')
        .update(row)
        .eq('id', existingThread.id)
      if (updateErr && opts.logWriteErrors) {
        console.error(`[Email Refresh] ${opts.what} update error for ${threadId}:`, updateErr.message)
      }
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('email_thread_index')
        .insert(row)
      if (insertErr && opts.logWriteErrors) {
        console.error(`[Email Refresh] ${opts.what} insert error for ${threadId}:`, insertErr.message)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outlook sync
// ---------------------------------------------------------------------------

/** The fields the Outlook sync reads of a message. */
const OUTLOOK_THREAD_SELECT =
  'id,conversationId,from,replyTo,toRecipients,ccRecipients,isRead,receivedDateTime,importance,hasAttachments'

interface OutlookMessage {
  id: string
  conversationId?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  replyTo?: Array<{ emailAddress?: { address?: string } }>
  toRecipients?: Array<{ emailAddress: { address: string } }>
  ccRecipients?: Array<{ emailAddress: { address: string } }>
  isRead?: boolean
  receivedDateTime?: string | null
  importance?: string
  hasAttachments?: boolean
  isDraft?: boolean
  parentFolderId?: string
  /** Asked for only when one conversation is read on its own (indexOutlookThread). */
  internetMessageHeaders?: Array<{ name?: string; value?: string }>
}

async function syncOutlookThreads(
  accessToken: string,
  userEmail: string | null,
  userId: string,
  workspaceId: string,
  fullSync: boolean,
  accountId?: string,
): Promise<{ synced: number }> {
  const supabaseAdmin = getServiceClient()

  // Fetch recent messages
  const params = new URLSearchParams({
    $top: '200',
    $orderby: 'receivedDateTime desc',
    $select: OUTLOOK_THREAD_SELECT,
  })

  if (!fullSync) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    params.set('$filter', `receivedDateTime ge ${thirtyDaysAgo}`)
  }

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    console.error(`[Email Refresh] Outlook messages API error: ${res.status} ${res.statusText}`)
    return { synced: 0 }
  }

  const data = await res.json()
  const messages = data.value || []

  // Group by conversationId
  const threadMap = new Map<string, typeof messages>()
  for (const msg of messages) {
    const threadId = msg.conversationId || msg.id
    if (!threadMap.has(threadId)) threadMap.set(threadId, [])
    threadMap.get(threadId)!.push(msg)
  }

  const workspaceIds = await threadCopyWorkspaceIds(accountId, workspaceId, supabaseAdmin)
  let syncedCount = 0

  for (const [threadId, threadMessages] of threadMap) {
    try {
      await indexOutlookMessages(
        supabaseAdmin,
        { accessToken, userEmail, userId, workspaceId, workspaceIds, threadId, accountId },
        threadMessages,
        { logWriteErrors: syncedCount < 3 },
      )
      syncedCount++
    } catch (err) {
      if (syncedCount < 3) {
        console.error(`[Email Refresh] Outlook thread ${threadId} failed:`, err instanceof Error ? err.message : err)
      }
    }
  }

  console.log(`[Email Refresh] Outlook sync complete: ${syncedCount}/${threadMap.size} threads`)
  return { synced: syncedCount }
}

/**
 * Index one Outlook conversation from its messages, newest first: its row in
 * each workspace's copy (writeThreadCopies), updated in place or added. The
 * sync runs it for each conversation among the recent messages it lists;
 * indexOutlookThread runs it for one conversation read on its own.
 */
async function indexOutlookMessages(
  supabaseAdmin: SupabaseClient,
  target: ThreadIndexTarget,
  threadMessages: OutlookMessage[],
  opts: { logWriteErrors?: boolean } = {},
): Promise<void> {
  const { userEmail, userId, threadId, accountId } = target
  const lastMsg = threadMessages[0] // newest first
  const fromEmail = lastMsg.from?.emailAddress?.address?.toLowerCase() || ''
  const replyDestination = lastMsg.replyTo?.map(recipient => recipient.emailAddress?.address).filter(Boolean).join(', ') || fromEmail

  const allParticipants = new Set<string>()
  for (const msg of threadMessages) {
    const from = msg.from?.emailAddress?.address
    if (from) allParticipants.add(from.toLowerCase())
    for (const r of msg.toRecipients || []) {
      if (r.emailAddress?.address) allParticipants.add(r.emailAddress.address.toLowerCase())
    }
    for (const r of msg.ccRecipients || []) {
      if (r.emailAddress?.address) allParticipants.add(r.emailAddress.address.toLowerCase())
    }
  }

  // The sync's listing reads no headers (200 messages at a time): the address
  // rules apply, and the reply gate reads the headers live before any draft.
  const own = userEmail?.toLowerCase()
  const automated = automatedSenderReason({
    destination: replyDestination,
    header: lastMsg.internetMessageHeaders ? headerLookup(lastMsg.internetMessageHeaders) : null,
    personSent: !!own && threadMessages.some((m) => m.from?.emailAddress?.address?.toLowerCase() === own),
    sender: fromEmail !== own ? fromEmail : null,
  })
  const needsReply = fromEmail !== own && !automated
  const autoClassified = classifyThread(fromEmail, automated)

  const outlookThreadData = {
    user_id: userId,
    provider: 'microsoft' as const,
    provider_thread_id: threadId,
    provider_message_id: lastMsg.id,
    account_id: accountId || null,
    from_email: fromEmail || null,
    participant_emails: Array.from(allParticipants),
    message_count: threadMessages.length,
    is_unread: !lastMsg.isRead,
    is_starred: lastMsg.importance === 'high',
    has_attachments: lastMsg.hasAttachments || false,
    last_message_at: lastMsg.receivedDateTime || null,
    needs_reply: needsReply,
    auto_classified: autoClassified,
    // Graph says which message is a draft only when asked: indexOutlookThread
    // asks, the sync's listing does not (and leaves the column alone).
    ...(typeof lastMsg.isDraft === 'boolean' ? { is_draft: lastMsg.isDraft } : {}),
    synced_at: new Date().toISOString(),
  }

  await writeThreadCopies(supabaseAdmin, target, outlookThreadData, fromEmail || null, {
    ...opts,
    what: 'Outlook thread',
  })
}

/**
 * The id of the mailbox's Deleted Items folder. Graph's DELETE moves a message
 * there rather than away (a discarded or superseded draft too, still a draft),
 * and a conversation read by its id spans every folder, so this is how to tell
 * what was deleted. Null when Graph will not say.
 */
export async function outlookDeletedItemsId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems?$select=id', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const id = ((await res.json()) as { id?: unknown }).id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * Index one Outlook conversation as Graph holds it now, read on its own.
 * Graph's message list spans every folder, and a deleted message goes to
 * Deleted Items rather than away, so those are left out: a discarded draft no
 * longer stands as the conversation's last message. 'gone' when nothing else
 * of it is left.
 */
export async function indexOutlookThread(
  supabaseAdmin: SupabaseClient,
  target: ThreadIndexTarget,
  opts: { logWriteErrors?: boolean } = {},
): Promise<ThreadIndexOutcome> {
  const params = new URLSearchParams({
    // OData string literal: single quotes are escaped by doubling.
    $filter: `conversationId eq '${target.threadId.replace(/'/g, "''")}'`,
    // internetMessageHeaders: the automated-mail check (src/lib/email/automated-sender.ts).
    $select: `${OUTLOOK_THREAD_SELECT},isDraft,parentFolderId,internetMessageHeaders`,
    $top: '50',
  })
  const [listRes, deletedItems] = await Promise.all([
    fetch(`https://graph.microsoft.com/v1.0/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${target.accessToken}` },
    }),
    outlookDeletedItemsId(target.accessToken),
  ])
  if (!listRes.ok || !deletedItems) return 'unreadable'
  const messages = (((await listRes.json()) as { value?: OutlookMessage[] }).value ?? [])
    .filter((m) => m.parentFolderId !== deletedItems)
    .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
  if (messages.length === 0) return 'gone'
  await indexOutlookMessages(supabaseAdmin, target, messages, opts)
  return 'indexed'
}

// ---------------------------------------------------------------------------
// Link threads to contacts
// ---------------------------------------------------------------------------

export async function linkThreadsToContacts(
  userId: string,
  workspaceId: string,
): Promise<void> {
  const supabaseAdmin = getServiceClient()

  // This workspace's copies only: a copy's contact is its own workspace's, and
  // another workspace's copy linked to a contact here would leak it there.
  const { data: unlinked } = await supabaseAdmin
    .from('email_thread_index')
    .select('id, from_email')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .is('linked_contact_id', null)
    .not('from_email', 'is', null)
    .limit(200)

  for (const thread of unlinked || []) {
    const { data: contact } = await supabaseAdmin
      .from('contact')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('email', thread.from_email!.toLowerCase())
      .maybeSingle()

    if (contact) {
      await supabaseAdmin
        .from('email_thread_index')
        .update({ linked_contact_id: contact.id })
        .eq('id', thread.id)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A Gmail thread's Mail folder, by its last message's labels. The send path files a sent draft by it too. */
export function mapGmailLabelsToFolder(labelIds: string[]): string {
  if (labelIds.includes('TRASH')) return 'trash'
  if (labelIds.includes('SPAM')) return 'spam'
  if (labelIds.includes('DRAFT')) return 'drafts'
  if (labelIds.includes('SENT') && !labelIds.includes('INBOX')) return 'sent'
  if (labelIds.includes('INBOX')) return 'inbox'
  return 'archive'
}

function extractEmails(header: string): string[] {
  if (!header) return []
  const emailRegex = /[\w.+-]+@[\w.-]+\.\w+/g
  return Array.from(header.matchAll(emailRegex)).map((m) => m[0].toLowerCase())
}

/** Automated mail (src/lib/email/automated-sender.ts) is a newsletter or a notification; the rest by sender. */
function classifyThread(from: string, automated: AutomatedReason | null): 'newsletter' | 'notification' | 'personal' | 'transactional' | 'important' {
  if (automated) return automatedCategory(automated)
  const lower = from.toLowerCase()
  if (lower.includes('receipts@') || lower.includes('billing@') || lower.includes('invoice@')) return 'transactional'

  return 'personal'
}
