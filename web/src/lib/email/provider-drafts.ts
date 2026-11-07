/**
 * Drafts in the provider mailbox, named by their MESSAGE id: the id Mail's
 * thread view shows, the email tools return (`create_email_draft`'s
 * `draft_id`) and the index keeps as `email_thread_index.provider_message_id`.
 *
 * Graph drafts are messages, so that id is the draft's id there. Gmail's
 * draft endpoints (`drafts.get`, `drafts.send`, `drafts.delete`) take the
 * DRAFT's own id instead (`r-…`): a Gmail draft is a container whose message
 * id changes every time the draft is saved, and only the drafts list maps one
 * to the other (gmailDraftIdFor).
 *
 * The send and discard paths (src/lib/integrations/email.ts) and sendEmail's
 * cleanup (src/lib/crm/email-client.ts) all use it; it imports none of their
 * modules, so no import makes a cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { getValidToken, getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { indexGmailThread, indexOutlookThread, type ThreadIndexOutcome } from '@/lib/crm/email-sync'
import { draftRowsFor, releaseDraftRows } from './hold'

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const GRAPH_API = 'https://graph.microsoft.com/v1.0/me'

/**
 * The characters a provider id can hold: Gmail ids are hex, Graph ids are
 * base64 with `-`, `_`, `=`, `+` and `/`. There is no `.`, so an id can never
 * be a `.` / `..` path segment, and it is URL-encoded on top of that.
 */
const PROVIDER_ID = /^[A-Za-z0-9_=+/-]{1,512}$/

export function isProviderId(id: unknown): id is string {
  return typeof id === 'string' && PROVIDER_ID.test(id)
}

/** Pages of Gmail drafts read looking for one message's draft (500 a page). */
const GMAIL_DRAFT_PAGES = 10

/**
 * The id of the Gmail draft whose current message is `messageId`, or null
 * when no draft holds it (sent, discarded, or saved again under a new message
 * id). Throws when Gmail cannot list the drafts, or when the list runs past
 * GMAIL_DRAFT_PAGES pages without an answer: neither says the draft is gone.
 */
export async function gmailDraftIdFor(token: string, messageId: string): Promise<string | null> {
  let pageToken: string | null = null
  for (let page = 0; page < GMAIL_DRAFT_PAGES; page++) {
    const params = new URLSearchParams({ maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(`${GMAIL_API}/drafts?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Gmail drafts list error: ${res.status}`)
    const data = await res.json()
    const drafts = (data.drafts as Array<{ id?: string; message?: { id?: string } }> | undefined) ?? []
    const hit = drafts.find((d) => d.message?.id === messageId)
    if (hit?.id) return hit.id
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : null
    if (!pageToken) return null
  }
  throw new Error(`Gmail drafts list runs past ${GMAIL_DRAFT_PAGES} pages`)
}

/** A draft's index rows: one per workspace that lists its mailbox. */
const DRAFT_ROWS = 10

interface DraftIndexRow {
  id: string
  workspace_id: string
  provider: string
  account_id: string | null
  provider_thread_id: string
}

/**
 * Delete a draft by its message id, at the mailbox that holds it, and then
 * settle its index rows from what the provider holds now.
 *
 * The id comes from a caller (a model's `previous_draft_id`, the chat card's
 * discard, or the draft a chat-card send replaces), so it is untrusted. Before
 * any provider call:
 *  - it must look like a provider id (no `.`, so no `../` traversal out of
 *    `/drafts/` or `/me/messages/`, and it is URL-encoded besides);
 *  - it must be an `is_draft` row this user has in `email_thread_index`, and
 *    the DELETE goes to THAT row's provider, with the token of the account
 *    the row names (never another of the user's mailboxes, where the draft
 *    would look "already gone").
 * Otherwise nothing is deleted anywhere. Without this an Outlook token with
 * Mail.ReadWrite would DELETE any `/me/...` item an id could reach.
 *
 * Gone means the provider deleted it (2xx) or it was gone already (a 404; at
 * Gmail also no draft holding the message). Anything else (a refusal, a
 * provider that cannot be reached, no token) leaves the rows alone, since the
 * draft is still in the mailbox, and is logged.
 *
 * A draft's row is its THREAD's row: a reply draft sits on the conversation it
 * answers (the sync indexes a thread by its last message, and the email tools
 * point the thread's row at the draft they add). So once the draft is gone,
 * each row's thread is read again: what is left of it keeps the row, indexed
 * as the sync would index it; only a thread that was nothing but the draft
 * loses its row. A thread the provider will not read back keeps its row as it
 * was, for the next sync.
 */
export async function deleteProviderDraft(userId: string, draftMessageId: string, opts: { reviewed?: boolean } = {}): Promise<string[]> {
  const { released, mailboxError } = await deleteProviderDraftReport(userId, draftMessageId, opts)
  if (mailboxError) throw mailboxError
  return released
}

/**
 * deleteProviderDraft, reporting instead of throwing: the review rows and the
 * hold are released whatever the mailbox said, and mailboxDeleted says whether
 * the mailbox's copy is known gone (false: no token, a refusal, or an error;
 * the draft is still in the mailbox for the person to delete there).
 */
export async function deleteProviderDraftReport(
  userId: string,
  draftMessageId: string,
  opts: { reviewed?: boolean } = {},
): Promise<{ released: string[]; mailboxDeleted: boolean; mailboxError: unknown }> {
  if (!isProviderId(draftMessageId)) return { released: [], mailboxDeleted: false, mailboxError: null }
  const supabase = getServiceClient()
  let mailboxError: unknown = null
  let mailboxDeleted = false
  try {
    mailboxDeleted = await deleteFromMailbox(supabase, userId, draftMessageId)
  } catch (err) {
    mailboxError = err
  }
  // The holding pattern (src/lib/email/hold.ts): a deleted draft's review row
  // goes, and its hold (the thread's copy) with it, whatever the mailbox said.
  const released = await releaseDraftRows(supabase, userId, await draftRowsFor(supabase, userId, { providerDraftId: draftMessageId }), opts)
  return { released, mailboxDeleted, mailboxError }
}

/**
 * The mailbox half of deleteProviderDraft: the draft deleted, its thread
 * re-indexed. False when the draft may still be there (no token, a refusal);
 * true when it is gone, or no indexed mailbox lists it.
 */
async function deleteFromMailbox(supabase: SupabaseClient, userId: string, draftMessageId: string): Promise<boolean> {
  return (await deleteFromMailboxState(supabase, userId, draftMessageId)) !== 'failed'
}

/**
 * What a mailbox delete found:
 *   'deleted'    the provider deleted it now;
 *   'not_found'  nothing holds that id any more (a 404; at Gmail, no draft
 *                holding the message, which is also what a draft saved again
 *                under a new message id looks like); or no indexed mailbox
 *                lists it;
 *   'failed'     it may still be there (no token, a refusal, an error).
 */
export type MailboxDelete = 'deleted' | 'not_found' | 'failed'

async function deleteFromMailboxState(supabase: SupabaseClient, userId: string, draftMessageId: string): Promise<MailboxDelete> {
  const { data } = await supabase
    .from('email_thread_index')
    .select('id, workspace_id, provider, account_id, provider_thread_id')
    .eq('user_id', userId)
    .eq('provider_message_id', draftMessageId)
    .eq('is_draft', true)
    .limit(DRAFT_ROWS)
  const rows = (data ?? []) as DraftIndexRow[]
  const provider = rows[0]?.provider
  if (provider !== 'google' && provider !== 'microsoft') return 'not_found'

  const mailbox = await mailboxFor(userId, provider, rows[0].account_id)
  if (!mailbox) {
    console.warn(`[email] draft not deleted: no token for its ${provider} mailbox`)
    return 'failed'
  }
  const state = await deleteInMailboxState({ provider, token: mailbox.token }, draftMessageId)
  if (state === 'failed') return state

  for (const row of rows) await reindexThread(supabase, mailbox, userId, provider, row)
  return state
}

/**
 * Delete the mailbox copy of one of the person's own Dial8 draft rows (the
 * agent's discard, src/lib/email/discard-drafts.ts). The row is the caller's
 * own (read with `user_id = the caller`) and Dial8 wrote its ids, so the
 * DELETE goes straight to the mailbox the row names (its provider and
 * account), even when the thread's index row names another draft (a second
 * draft on the thread, which the index doesn't list). The thread is then
 * indexed again, best-effort. A row that names no provider (an older chat
 * draft of a new message) goes the index's way, as deleteProviderDraft does.
 * What the delete found (MailboxDelete): at Gmail, 'not_found' also means the
 * person saved the draft again in Gmail (a new message id), so it may still
 * be in their Drafts. Never throws.
 */
export async function deleteDraftOfRow(
  userId: string,
  row: { provider: string | null; account_id: string | null; provider_draft_id: string; provider_thread_id: string | null },
): Promise<MailboxDelete> {
  if (!isProviderId(row.provider_draft_id)) return 'failed'
  try {
    const provider = row.provider
    if (provider !== 'google' && provider !== 'microsoft') return await deleteFromMailboxState(getServiceClient(), userId, row.provider_draft_id)
    const mailbox = await mailboxFor(userId, provider, row.account_id)
    if (!mailbox) {
      console.warn(`[email] draft not deleted: no token for its ${provider} mailbox`)
      return 'failed'
    }
    const state = await deleteInMailboxState({ provider, token: mailbox.token }, row.provider_draft_id)
    if (state !== 'failed' && row.provider_thread_id) {
      await reindexThreadAfterDraft(userId, provider, mailbox, row.provider_thread_id).catch((err: unknown) => {
        console.warn('[email] draft deleted, but its thread was not read again:', err instanceof Error ? err.message : err)
      })
    }
    return state
  } catch (err) {
    console.warn('[email] draft not deleted:', err instanceof Error ? err.message : err)
    return 'failed'
  }
}

/**
 * The mailbox a row names: its account's token and address; a legacy row
 * without an account, the user's token for its provider.
 */
async function mailboxFor(
  userId: string,
  provider: 'google' | 'microsoft',
  accountId: string | null,
): Promise<{ token: string; email: string | null } | null> {
  const found = accountId ? await getValidTokenForAccount(accountId) : await getValidToken(userId, provider, 'email')
  return found ? { token: found.token, email: found.email ?? null } : null
}

/**
 * A thread whose draft is gone, indexed again from what its mailbox holds now,
 * in each workspace that lists it (the thread view's Discard). Each
 * workspace's outcome: re-indexed, dropped (nothing of the thread was left),
 * or left for the next sync (unreadable, or the read failed).
 */
export async function reindexThreadAfterDraft(
  userId: string,
  provider: 'google' | 'microsoft',
  mailbox: { token: string; email: string | null },
  providerThreadId: string,
): Promise<Map<string, ThreadIndexOutcome | 'failed'>> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('email_thread_index')
    .select('id, workspace_id, provider, account_id, provider_thread_id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('provider_thread_id', providerThreadId)
    .limit(DRAFT_ROWS)
  const outcomes = new Map<string, ThreadIndexOutcome | 'failed'>()
  for (const row of (data ?? []) as DraftIndexRow[]) {
    outcomes.set(row.workspace_id, await reindexThread(supabase, mailbox, userId, provider, row))
  }
  return outcomes
}

/** A row's thread, read again after its draft went: re-indexed, dropped (nothing left), or left for the sync. */
async function reindexThread(
  supabase: SupabaseClient,
  mailbox: { token: string; email: string | null },
  userId: string,
  provider: 'google' | 'microsoft',
  row: DraftIndexRow,
): Promise<ThreadIndexOutcome | 'failed'> {
  const target = {
    accessToken: mailbox.token,
    userEmail: mailbox.email,
    userId,
    workspaceId: row.workspace_id,
    // This row's copy only: the caller walks every copy of the thread.
    workspaceIds: [row.workspace_id],
    threadId: row.provider_thread_id,
    accountId: row.account_id,
  }
  let outcome: ThreadIndexOutcome
  try {
    outcome =
      provider === 'google'
        ? await indexGmailThread(supabase, target, { logWriteErrors: true })
        : await indexOutlookThread(supabase, target, { logWriteErrors: true })
  } catch (err) {
    console.warn('[email] draft deleted, but its thread was not read again:', err instanceof Error ? err.message : err)
    return 'failed'
  }
  if (outcome === 'gone') {
    await supabase.from('email_thread_index').delete().eq('id', row.id)
  } else if (outcome === 'unreadable') {
    console.warn(`[email] draft deleted, but ${provider} would not read its thread again; its row waits for the next sync`)
  }
  return outcome
}

/**
 * Gmail deletes a draft by the draft's own id, so it is found first. No draft
 * holding the message is 'not_found' (sent, discarded, or saved again under a
 * new message id).
 */
async function deleteGmailDraftState(token: string, messageId: string): Promise<MailboxDelete> {
  let draftId: string | null
  try {
    draftId = await gmailDraftIdFor(token, messageId)
  } catch (err) {
    console.warn('[email] Gmail draft not deleted:', err instanceof Error ? err.message : err)
    return 'failed'
  }
  if (!draftId) return 'not_found'
  return confirmDeleteState('Gmail', `${GMAIL_API}/drafts/${encodeURIComponent(draftId)}`, token)
}

/** A draft message deleted at the mailbox the caller resolved, saying what it found. */
async function deleteInMailboxState(mailbox: { provider: 'google' | 'microsoft'; token: string }, draftMessageId: string): Promise<MailboxDelete> {
  if (!isProviderId(draftMessageId)) return 'failed'
  return mailbox.provider === 'google'
    ? deleteGmailDraftState(mailbox.token, draftMessageId)
    : confirmDeleteState('Outlook', `${GRAPH_API}/messages/${encodeURIComponent(draftMessageId)}`, mailbox.token)
}

/**
 * Delete a draft message straight from a mailbox the caller already resolved
 * (a held thread's re-draft, src/lib/email/held-refresh.ts, where the thread's
 * index row no longer names the draft). True when it is gone.
 */
export async function deleteDraftInMailbox(
  mailbox: { provider: 'google' | 'microsoft'; token: string },
  draftMessageId: string,
): Promise<boolean> {
  return (await deleteInMailboxState(mailbox, draftMessageId)) !== 'failed'
}

/** DELETE `url`: 'deleted' (2xx), 'not_found' (a 404: gone already) or 'failed'. */
async function confirmDeleteState(provider: string, url: string, token: string): Promise<MailboxDelete> {
  try {
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) return 'deleted'
    if (res.status === 404) return 'not_found'
    console.warn(`[email] ${provider} draft not deleted: ${res.status}`)
  } catch (err) {
    console.warn(`[email] ${provider} draft not deleted:`, err instanceof Error ? err.message : err)
  }
  return 'failed'
}
