import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { getValidToken, getAllValidTokens } from '@/lib/oauth/token-manager'
import { fetchGmailHistory } from '@/lib/email/gmail-api'
import { threadCopyWorkspaceIds } from '@/lib/email/account-scope'
import { mailboxAddresses } from '@/lib/email/reply-policy'
import { isPre722Error, reenteredInbox, withoutLocalArchive, type LocalArchiveMark, type MailboxReadEvidence } from '@/lib/email/local-archive'
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

/** The most threads one sync reads (each is a Gmail call): the newest changes first. */
export const SYNC_MAX_THREADS = 100

/**
 * The thread ids a Gmail history names (messages added or deleted, labels
 * added or removed), newest change first, each once. History pages come
 * oldest first, so the records are walked from the end: under a cap the
 * sync keeps what changed last.
 */
export function historyThreadIdsNewestFirst(history: ReadonlyArray<Record<string, unknown>>): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i]
    for (const key of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
      const items = (record[key] as Array<{ message?: { threadId?: unknown } }> | undefined) ?? []
      for (let j = items.length - 1; j >= 0; j--) {
        const id = items[j]?.message?.threadId
        if (typeof id === 'string' && id && !seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
      }
    }
  }
  return ids
}

/**
 * The mailbox's own checkpoint: the push path's `email_sync_state.gmail_history_id`
 * (src/lib/inngest/email-functions.ts), per account (a legacy mailbox's by
 * person and provider). Null when there is none, or it can't be read.
 */
async function gmailCheckpoint(supabaseAdmin: SupabaseClient, userId: string, accountId?: string): Promise<string | null> {
  try {
    let query = supabaseAdmin.from('email_sync_state').select('gmail_history_id')
    query = accountId ? query.eq('account_id', accountId) : query.eq('user_id', userId).eq('provider', 'google')
    const { data, error } = await query.limit(1).maybeSingle()
    if (error) {
      console.warn('[Email Refresh] Gmail checkpoint not read:', error.message)
      return null
    }
    const id = (data as { gmail_history_id?: unknown } | null)?.gmail_history_id
    return typeof id === 'string' && id ? id : null
  } catch (err) {
    console.warn('[Email Refresh] Gmail checkpoint not read:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * The daily cron's and the Sync button's Gmail pass (the push path,
 * email-functions.ts, is the one that keeps up as mail arrives).
 *
 * Incremental: what changed since the mailbox's checkpoint, the one the push
 * path keeps (gmailCheckpoint), every page of it, newest changes first up to
 * SYNC_MAX_THREADS. Never email_thread_index.history_id: nothing writes it
 * any more, and a legacy row's (or a row a triage stamped, whose synced_at
 * then sorts first) is a stale cursor Gmail answers 404 to. Left as it is on
 * the rows (no migration): nothing reads it now.
 *
 * This pass only READS the checkpoint. Moving it is the push path's alone:
 * the push path triages what it passes (drafts, the agent's news, email
 * loops), so a pass that moved it would make the push path skip mail it
 * never triaged, and two writers would race on one cursor. Reading from it
 * again is safe: indexing a thread twice writes the same row.
 *
 * No checkpoint, or one Gmail has expired (404): the last 30 days instead,
 * said once in the log. Any other refusal is logged with its status and
 * falls back the same way, never a silent nothing.
 */
async function syncGmailThreads(
  accessToken: string,
  userEmail: string | null,
  userId: string,
  workspaceId: string,
  fullSync: boolean,
  accountId?: string,
): Promise<{ synced: number }> {
  const supabaseAdmin = getServiceClient()

  const checkpoint = fullSync ? null : await gmailCheckpoint(supabaseAdmin, userId, accountId)

  // Fetch thread list
  let threadIds: string[] = []

  if (checkpoint) {
    try {
      const { history } = await fetchGmailHistory(accessToken, checkpoint)
      threadIds = historyThreadIdsNewestFirst(history as Array<Record<string, unknown>>)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      if (why === 'HISTORY_EXPIRED') {
        console.warn(`[Email Refresh] Gmail checkpoint expired (account=${accountId ?? 'legacy'}): reading the last 30 days instead`)
      } else {
        console.error(`[Email Refresh] Gmail history read failed (account=${accountId ?? 'legacy'}): ${why}; reading the last 30 days instead`)
      }
      return syncGmailThreads(accessToken, userEmail, userId, workspaceId, true, accountId)
    }
  } else {
    // Full sync: recent threads (newest first, as Gmail lists them)
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
  }

  if (threadIds.length === 0) return { synced: 0 }

  const workspaceIds = await threadCopyWorkspaceIds(accountId, workspaceId, supabaseAdmin)
  let syncedCount = 0

  // The newest first, at most SYNC_MAX_THREADS (each is a Gmail call).
  for (const threadId of threadIds.slice(0, SYNC_MAX_THREADS)) {
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
  // When the mailbox was read: a local change after it wins (writeThreadCopies).
  const fetchedAt = new Date().toISOString()
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

  // What this answer says against an archive made here (src/lib/email/local-archive.ts):
  // the thread's historyId, and its newest message that isn't a draft.
  const newestReceived = [...messages]
    .filter((m: Record<string, unknown>) => !((m.labelIds as string[] | undefined) ?? []).includes('DRAFT'))
    .map((m: Record<string, unknown>) => Number(m.internalDate))
    .filter((t: number) => Number.isFinite(t) && t > 0)
    .reduce((a: number, b: number) => Math.max(a, b), 0)
  const evidence: MailboxReadEvidence = {
    historyId: typeof threadMeta.historyId === 'string' && /^\d+$/.test(threadMeta.historyId) ? threadMeta.historyId : null,
    newestMessageAt: newestReceived > 0 ? new Date(newestReceived).toISOString() : null,
  }

  await writeThreadCopies(supabaseAdmin, target, threadData, senderEmail || null, { ...opts, what: 'Thread', fetchedAt, mailboxState: GMAIL_MAILBOX_STATE, evidence })
  return 'indexed'
}

/**
 * The columns a local change (thread-triage.ts, email-client.ts: archive,
 * trash, move, read, star) writes from what it just did to the mailbox. A
 * sync's copy of them is only as new as its read of the mailbox: one that
 * read before a local change and writes after it would put the old state back
 * (Liam, 11-24: archived invites back in the inbox). Every local change stamps
 * `synced_at`, and a sync writes these only while the row's `synced_at` is no
 * later than its read (writeThreadCopies). Outlook's index keeps no folder
 * from the sync; its move gives the newest message a new id, so that id is
 * the local change's too. Gmail's newest message id is never a local change's
 * (and is what says new mail arrived, triage.ts), so the sync always writes it.
 */
export const GMAIL_MAILBOX_STATE = ['folder', 'is_unread', 'is_starred', 'label_ids'] as const
export const OUTLOOK_MAILBOX_STATE = ['is_unread', 'is_starred', 'provider_message_id'] as const

/**
 * Write one thread's row into each workspace's copy (`target.workspaceIds`,
 * else every workspace its account is linked to): updated in place or added,
 * its contact link that workspace's own contact for the sender. Upsert can't
 * name the COALESCE unique index, so each copy is found first.
 *
 * `fetchedAt` (when the mailbox was read) fences `mailboxState`: a row whose
 * `synced_at` is later (a local change, or a sync that read after this one)
 * keeps those columns and its `synced_at`; the rest is written as read.
 */
async function writeThreadCopies(
  supabaseAdmin: SupabaseClient,
  target: ThreadIndexTarget,
  threadData: Record<string, unknown>,
  senderEmail: string | null,
  opts: {
    logWriteErrors?: boolean
    what: string
    fetchedAt?: string
    mailboxState?: readonly string[]
    /**
     * A Gmail read's word against an archive made here (src/lib/email/local-archive.ts):
     * a row the person archived is put back in the inbox only on it.
     */
    evidence?: MailboxReadEvidence
  },
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

    // This workspace's copy, if it has one (with the person's archive mark, from 722).
    const existingThread = await existingCopy(supabaseAdmin, ws, threadId, userId)

    if (existingThread) {
      let write: Record<string, unknown> = row
      let mailboxState = opts.mailboxState ?? []
      if (opts.evidence && existingThread.local_archived_at) {
        if (row.folder === 'inbox' && !reenteredInbox(existingThread, opts.evidence)) {
          // Archived here, and this answer is no newer than the archive: the
          // mailbox state stays the archive's; the rest is written as read.
          mailboxState = [...new Set([...mailboxState, ...GMAIL_MAILBOX_STATE])]
          write = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'synced_at' && !mailboxState.includes(key)))
        } else if (row.folder === 'inbox') {
          // Back in the inbox since (a new message, or moved back in Gmail): the mark goes.
          write = { ...row, local_archived_at: null, local_archived_history_id: null }
          // A local change after this read keeps its own mark, as it keeps its folder.
          mailboxState = [...mailboxState, 'local_archived_at', 'local_archived_history_id']
        }
      }
      // Update existing thread (also sets account_id if it was null)
      const updateErr = !('synced_at' in write)
        ? (await supabaseAdmin.from('email_thread_index').update(write).eq('id', existingThread.id)).error
        : opts.fetchedAt
          ? await writeFenced(supabaseAdmin, existingThread.id, write, opts.fetchedAt, mailboxState)
          : (await supabaseAdmin.from('email_thread_index').update(write).eq('id', existingThread.id)).error
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

/**
 * A workspace's copy of the thread: its id, account and (from migration 722)
 * the person's archive mark. Null when it has none, or it can't be read (the
 * copy is then added, as before).
 */
async function existingCopy(
  supabaseAdmin: SupabaseClient,
  ws: string,
  threadId: string,
  userId: string,
): Promise<({ id: string; account_id: string | null } & LocalArchiveMark) | null> {
  const read = (columns: string) =>
    supabaseAdmin.from('email_thread_index').select(columns).eq('workspace_id', ws).eq('provider_thread_id', threadId).eq('user_id', userId).maybeSingle()
  let { data, error } = await read('id, account_id, local_archived_at, local_archived_history_id')
  if (error && isPre722Error(error)) ({ data, error } = await read('id, account_id'))
  return (data as unknown as ({ id: string; account_id: string | null } & LocalArchiveMark) | null) ?? null
}

/**
 * The row as read, unless something newer wrote it since `fetchedAt`: then
 * everything but the mailbox state (and `synced_at`, which stays theirs).
 */
async function writeFenced(
  supabaseAdmin: SupabaseClient,
  id: string,
  row: Record<string, unknown>,
  fetchedAt: string,
  mailboxState: readonly string[],
): Promise<{ message: string } | null> {
  const fenced = (patch: Record<string, unknown>) =>
    supabaseAdmin.from('email_thread_index').update(patch).eq('id', id).or(`synced_at.is.null,synced_at.lte.${fetchedAt}`).select('id')
  let { data, error } = await fenced(row)
  // Before migration 722: the same write without the archive mark.
  if (error && isPre722Error(error)) ({ data, error } = await fenced(withoutLocalArchive(row)))
  if (error) return error
  if ((data ?? []).length > 0) return null
  const rest = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'synced_at' && !mailboxState.includes(key)))
  return (await supabaseAdmin.from('email_thread_index').update(rest).eq('id', id)).error
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

  const fetchedAt = new Date().toISOString()
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
        { logWriteErrors: syncedCount < 3, fetchedAt },
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
  opts: { logWriteErrors?: boolean; fetchedAt?: string } = {},
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
    mailboxState: OUTLOOK_MAILBOX_STATE,
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
  const fetchedAt = new Date().toISOString()
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
  await indexOutlookMessages(supabaseAdmin, target, messages, { ...opts, fetchedAt })
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
