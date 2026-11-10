import { getValidToken, getValidTokenForCapability, getAllValidTokens, getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { getServiceClient } from '@/lib/admin'
import { buildRawEmail, encodeHeaderValue, logSentEmailInteractions, parseEmailAddresses } from '@/lib/crm/email-client'
import { isDraftAddress, parseDraftEdits, type DraftEdits } from '@/lib/email/draft-edits'
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'
import { mapGmailLabelsToFolder, outlookDeletedItemsId } from '@/lib/crm/email-sync'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'
import { GMAIL_API, GRAPH_API, gmailDraftIdFor, isProviderId, reindexThreadAfterDraft } from '@/lib/email/provider-drafts'
import type { SupabaseClient } from '@supabase/supabase-js'
import { threadCopyWorkspaceIds, type ReadableEmailAccount } from '@/lib/email/account-scope'
import { draftRowsFor, markHoldsSending, releaseDraftRows, restoreHolds, stampMailReview, type HeldDraftRow } from '@/lib/email/hold'
import { deferDraftRewrite, readDraftForRewrite } from '@/lib/evals/flywheel/draft-rewrite'

export interface EmailMessage {
  id: string
  threadId?: string
  subject: string
  from: string
  to: string[]
  date: string
  snippet: string
  body?: string
  isRead: boolean
  labels?: string[]
}

interface ListEmailsOptions {
  maxResults?: number
  query?: string
  label?: string
}

/** A listed email and the mailbox it came from. */
export interface ListedEmail extends EmailMessage {
  account: string | null
}

/**
 * Recent mail from exactly these mailboxes, newest first, at most
 * `maxResults` in all. The caller picks the accounts (list_emails passes the
 * workspace's, from readableWorkspaceEmailAccounts); nothing here falls back
 * to another of the user's mailboxes. A mailbox that can't be read is named in
 * `unreadable`; when none can be read this throws.
 */
export async function listEmails(
  accounts: readonly ReadableEmailAccount[],
  options: ListEmailsOptions = {},
): Promise<{ emails: ListedEmail[]; unreadable: string[] }> {
  if (accounts.length === 0) throw new Error('No email provider connected')
  const settled = await Promise.allSettled(
    accounts.map(async (account) => {
      const token = await getValidTokenForAccount(account.id)
      if (!token) throw new Error(`${account.account_email ?? 'A mailbox'} needs reconnecting in Settings > Connectors`)
      const list =
        account.provider === 'google'
          ? await listGmailMessages(token.token, options)
          : await listOutlookMessages(token.token, options)
      return list.map((m): ListedEmail => ({ ...m, account: account.account_email ?? token.email }))
    }),
  )

  const emails: ListedEmail[] = []
  const unreadable: string[] = []
  let firstError: unknown = null
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') emails.push(...r.value)
    else {
      unreadable.push(accounts[i].account_email ?? accounts[i].id)
      firstError ??= r.reason
    }
  })
  if (unreadable.length === accounts.length) {
    throw firstError instanceof Error ? firstError : new Error('Failed to fetch emails')
  }

  const time = (m: ListedEmail) => {
    const t = Date.parse(m.date)
    return Number.isNaN(t) ? -Infinity : t
  }
  emails.sort((a, b) => time(b) - time(a))
  return { emails: emails.slice(0, options.maxResults || 20), unreadable }
}

export async function createEmailDraft(
  userId: string,
  draft: {
    to: string[]
    subject: string
    body: string
    cc?: string[]
    bcc?: string[]
    thread_id?: string
    in_reply_to?: string
  },
  workspaceId?: string,
  fromAccountEmail?: string,
): Promise<{ id: string; threadId?: string; message: string }> {
  // If a specific account is requested, find it and use its token
  if (fromAccountEmail) {
    const supabase = getServiceClient()
    const { data: account } = await supabase
      .from('connected_account')
      .select('id, provider')
      .eq('user_id', userId)
      .eq('capability', 'email')
      .eq('account_email', fromAccountEmail)
      .maybeSingle()

    if (account) {
      const tokenResult = await getValidTokenForAccount(account.id)
      if (tokenResult) {
        const createFn = account.provider === 'google' ? createGmailDraft : createOutlookDraft
        const result = await createFn(tokenResult.token, draft)
        if (workspaceId) {
          await indexDraftInDb(userId, workspaceId, account.provider, account.id, result, draft)
        }
        return result
      }
    }
  }

  // Default: use primary account or first available
  const google = await getValidToken(userId, 'google', 'email')
  if (google) {
    const result = await createGmailDraft(google.token, draft)
    if (workspaceId) {
      const accountId = await emailAccountIdFor(userId, 'google', google.email)
      await indexDraftInDb(userId, workspaceId, 'google', accountId, result, draft)
    }
    return result
  }

  const microsoft = await getValidToken(userId, 'microsoft', 'email')
  if (microsoft) {
    const result = await createOutlookDraft(microsoft.token, draft)
    if (workspaceId) {
      const accountId = await emailAccountIdFor(userId, 'microsoft', microsoft.email)
      await indexDraftInDb(userId, workspaceId, 'microsoft', accountId, result, draft)
    }
    return result
  }

  throw new Error('No email provider connected')
}

// The AI tools (`previous_draft_id`) and the chat card's discard route import it from here.
export { deleteProviderDraft, deleteProviderDraftReport } from '@/lib/email/provider-drafts'

export type SendProviderDraftResult =
  | { ok: true; threadId: string; messageId: string | null }
  | { ok: false; reason: 'not_found' | 'no_recipients' }

/** `threadRemains` is false when nothing of the thread was left: it is gone from Mail. */
export type DiscardProviderDraftResult = { ok: true; threadRemains: boolean } | { ok: false; reason: 'not_found' }

/** A draft the provider has sent, and what its bookkeeping needs. */
interface ProviderDraftSent {
  ok: true
  /** The sent message's id (Gmail). Graph files it under a new id we do not look up. */
  messageId: string | null
  /** The thread's folder now, by the sync's rule for its last message. */
  folder: string
  to: string[]
  subject: string
}

type ProviderDraftOutcome = ProviderDraftSent | Extract<SendProviderDraftResult, { ok: false }>

const NOT_FOUND = { ok: false, reason: 'not_found' } as const
const NO_RECIPIENTS = { ok: false, reason: 'no_recipients' } as const

/**
 * Send a draft that sits in the user's mailbox (an agent's reply from
 * `create_email_draft`, a drafting pass's, or one the user saved) as it was
 * reviewed in Mail's thread view, or with the user's `edits` from the draft
 * editor (recipients, subject, body; the rest of the draft is kept).
 *
 * `draftMessageId` is the draft MESSAGE's provider id: what the thread view
 * shows, and what the email tools deliver. Like `deleteProviderDraft`'s, it is
 * untrusted: both ids must look like provider ids, and the mailbox that holds
 * the thread must say the message is a draft on that thread, or nothing is
 * sent. (A Gmail draft edited since it was loaded has a new message id, so it
 * is not found rather than sent unread.) The provider sends it natively
 * (Gmail `drafts.send`, Graph `/send`): the message, headers and all, leaves
 * Drafts there.
 *
 * Once it is sent nothing fails the call, since an error would invite a
 * second send: the thread leaves Drafts in the index, a drafting-pass row for
 * the draft is marked sent, the work items that delivered it stop waiting
 * (ACTIVITY-AND-REVIEW §4.3), and the recipients' timelines log it.
 */
export async function sendProviderDraft(
  userId: string,
  workspaceId: string,
  providerThreadId: string,
  draftMessageId: string,
  edits: DraftEdits | null = null,
): Promise<SendProviderDraftResult> {
  if (!isProviderId(providerThreadId) || !isProviderId(draftMessageId)) return NOT_FOUND
  // The route checked them; checked again because they go into MIME headers.
  if (edits && parseDraftEdits(edits) === 'invalid') throw new Error('Draft edits are not well formed')

  const mailbox = await mailboxForThread(userId, workspaceId, providerThreadId)
  if (!mailbox) throw new Error('No email integration connected')

  // The holding pattern: the hold behind this draft goes 'sending' while the
  // provider sends (expiry and a refresh leave it alone), back to 'held' if
  // the send fails, and is deleted with its drafts once it is sent.
  const supabase = getServiceClient()
  const rows = await draftRowsFor(supabase, userId, { providerDraftId: draftMessageId, providerThreadId })
  const sending = await markHoldsSending(supabase, userId, rows)
  // The evals flywheel (src/lib/evals/flywheel/draft-rewrite.ts): with edits,
  // the draft row's text is read alongside the send (never awaited here, it
  // never rejects), before the send settles the row away.
  const draftBefore = edits ? readDraftForRewrite(supabase, userId, rows, draftMessageId) : null
  let outcome: ProviderDraftOutcome
  try {
    outcome =
      mailbox.provider === 'google'
        ? await sendGmailDraft(mailbox, providerThreadId, draftMessageId, edits)
        : await sendOutlookDraft(mailbox.token, providerThreadId, draftMessageId, edits)
  } catch (err) {
    await restoreHolds(supabase, userId, sending)
    throw err
  }
  if (!outcome.ok) {
    await restoreHolds(supabase, userId, sending)
    return outcome
  }

  await settleSentDraft(userId, workspaceId, providerThreadId, draftMessageId, outcome, rows)
  // Sent: a heavy rewrite of an agent draft becomes an eval candidate (a score
  // and pointers, never the text), after the response and never failing it.
  if (edits && draftBefore) deferDraftRewrite(supabase, { userId, providerThreadId, draft: draftBefore, sentBody: edits.body })
  return { ok: true, threadId: providerThreadId, messageId: outcome.messageId }
}

/**
 * Discard a draft that sits in the user's mailbox, from Mail's thread view.
 *
 * The same checks as sendProviderDraft: both ids must look like provider ids,
 * and the mailbox that holds the thread must say the message is a draft on
 * that thread (at Outlook, outside Deleted Items), or nothing is deleted. A
 * Gmail draft edited since it was loaded has a new message id, so it is not
 * found rather than discarded unread. The provider deletes it: Gmail's
 * drafts.delete by the draft's own id (for good), Graph's DELETE (to Deleted
 * Items, as Outlook's own Discard does). A draft gone by the delete counts as
 * discarded.
 *
 * Once it is gone nothing fails the call: the thread is indexed again from
 * what is left of it (a thread that was nothing but the draft leaves Mail:
 * `threadRemains` false), a drafting pass's row for the draft is dismissed, and
 * the work items that delivered it stop waiting (ACTIVITY-AND-REVIEW §4.3: a
 * discarded draft resolves them, as a sent one does).
 */
export async function discardProviderDraft(
  userId: string,
  workspaceId: string,
  providerThreadId: string,
  draftMessageId: string,
): Promise<DiscardProviderDraftResult> {
  if (!isProviderId(providerThreadId) || !isProviderId(draftMessageId)) return NOT_FOUND

  const mailbox = await mailboxForThread(userId, workspaceId, providerThreadId)
  if (!mailbox) throw new Error('No email integration connected')

  const discarded =
    mailbox.provider === 'google'
      ? await discardGmailDraft(mailbox.token, providerThreadId, draftMessageId)
      : await discardOutlookDraft(mailbox.token, providerThreadId, draftMessageId)
  if (!discarded) return NOT_FOUND

  const threadRemains = await settleDiscardedDraft(userId, workspaceId, mailbox, providerThreadId, draftMessageId)
  return { ok: true, threadRemains }
}

/** What a revision changes: the body always; recipients and subject only when given (else the draft's own). */
export interface DraftRevision {
  body: string
  subject?: string
  to?: string[]
  cc?: string[]
}

export type UpdateProviderDraftResult =
  | { ok: true; threadId: string; messageId: string; edits: DraftEdits }
  | { ok: false; reason: 'not_found' | 'invalid' | 'rich' }

/**
 * Rewrite a draft that sits in the user's mailbox IN PLACE, and never send it
 * (bots v3 Phase 5, `revise_email_draft`: "make it more formal"). The same
 * checks as sendProviderDraft and discardProviderDraft: both ids must look like
 * provider ids, and the mailbox that holds the thread must say the message is
 * a draft on that thread, or nothing is written (a Gmail draft edited since it
 * was read has a new message id, so it is not found rather than overwritten).
 * What the revision leaves out (recipients, subject) is the draft's own, read
 * off the mailbox; the whole is checked as the send path's edits are
 * (parseDraftEdits: `invalid` when it isn't a well-formed draft).
 *
 *   Gmail  `drafts.update` by the draft's own id, with the new message on the
 *          draft's thread, from the draft's sender, keeping its Bcc and the
 *          reply headers that thread it. Gmail gives the draft a NEW message
 *          id: it is returned, and the caller re-points what names the old one.
 *   Graph  PATCH the message (a Graph draft keeps its id), as the send path's
 *          edit step does, without the send.
 *
 * A revision writes the body as plain text, so a draft carrying what that
 * would drop is refused (`rich`, nothing written): a Gmail draft with
 * attachments or inline images (multipart/mixed or multipart/related), or an
 * Outlook draft whose body is HTML (Native Intelligence writes its Outlook drafts as text,
 * so HTML means it was written or edited in Outlook: signature, formatting,
 * the quoted chain).
 *
 * Then the thread is indexed again in each workspace that lists it, so Mail
 * shows the new text (best-effort: the draft is already rewritten).
 */
export async function updateProviderDraft(
  userId: string,
  workspaceId: string,
  providerThreadId: string,
  draftMessageId: string,
  revision: DraftRevision,
): Promise<UpdateProviderDraftResult> {
  if (!isProviderId(providerThreadId) || !isProviderId(draftMessageId)) return NOT_FOUND

  const mailbox = await mailboxForThread(userId, workspaceId, providerThreadId)
  if (!mailbox) throw new Error('No email integration connected')

  const updated =
    mailbox.provider === 'google'
      ? await updateGmailDraft(mailbox, providerThreadId, draftMessageId, revision)
      : await updateOutlookDraft(mailbox.token, providerThreadId, draftMessageId, revision)
  if (!updated.ok) return updated

  try {
    await reindexThreadAfterDraft(userId, mailbox.provider, mailbox, providerThreadId)
  } catch (err) {
    console.warn('[email] draft revised, but its thread re-index failed:', err instanceof Error ? err.message : err)
  }
  return { ok: true, threadId: providerThreadId, messageId: updated.messageId, edits: updated.edits }
}

type DraftUpdateOutcome =
  | { ok: true; messageId: string; edits: DraftEdits }
  | { ok: false; reason: 'not_found' | 'invalid' | 'rich' }

/** The Content-Type of a Gmail draft that holds files (attachments, inline images) a plain rewrite would drop. */
const GMAIL_RICH_CONTENT_TYPE = /^\s*multipart\/(mixed|related)\b/i

/** `revision` over the draft's own fields, checked as a send's edits are; null when not well formed. */
function revisedEdits(
  revision: DraftRevision,
  own: { to: string[]; cc: string[]; subject: string },
): DraftEdits | null {
  const edits = {
    to: revision.to ?? own.to,
    cc: revision.cc ?? own.cc,
    subject: revision.subject ?? own.subject,
    body: revision.body,
  }
  const parsed = parseDraftEdits(edits)
  return parsed && parsed !== 'invalid' ? parsed : null
}

/** The draft's message id after the update (a new one at Gmail), or why not. */
async function updateGmailDraft(
  mailbox: { token: string; email: string | null },
  threadId: string,
  messageId: string,
  revision: DraftRevision,
): Promise<DraftUpdateOutcome> {
  const meta = await gmailDraftOnThread(
    mailbox.token,
    threadId,
    messageId,
    `format=metadata&${GMAIL_DRAFT_HEADERS}&metadataHeaders=Content-Type`,
  )
  if (!meta) return NOT_FOUND
  const payload = meta.payload as { mimeType?: string; headers?: Array<{ name: string; value: string }> } | undefined
  const headers = payload?.headers ?? []
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
  // Attachments or inline images: a plain-text rewrite would drop them.
  if (GMAIL_RICH_CONTENT_TYPE.test(payload?.mimeType ?? '') || GMAIL_RICH_CONTENT_TYPE.test(header('Content-Type'))) {
    return { ok: false, reason: 'rich' }
  }
  const addressesIn = (name: string) => parseEmailAddresses(header(name)).map((a) => a.email)
  const edits = revisedEdits(revision, { to: addressesIn('To'), cc: addressesIn('Cc'), subject: header('Subject') })
  if (!edits) return { ok: false, reason: 'invalid' }
  // The draft endpoints take the draft's own id, which is not its message's.
  const draftId = await gmailDraftIdFor(mailbox.token, messageId)
  if (!draftId) return NOT_FOUND
  const raw = Buffer.from(
    buildRawEmail({
      from: senderHeader(header('From'), mailbox.email),
      to: edits.to,
      cc: edits.cc,
      // The draft's own Bcc: a revision never changes who is blind-copied.
      bcc: addressesIn('Bcc'),
      subject: edits.subject,
      bodyText: edits.body,
      bodyHtml: plainTextToHtml(edits.body),
      inReplyTo: bareMessageIds(header('In-Reply-To'))[0],
      references: bareMessageIds(header('References')),
    }),
  ).toString('base64url')
  const res = await fetch(`${GMAIL_API}/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${mailbox.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: draftId, message: { threadId, raw } }),
  })
  if (res.status === 404) return NOT_FOUND
  if (!res.ok) throw new Error(`Gmail draft update error: ${res.status}`)
  const data = await res.json().catch(() => null)
  const next = data?.message?.id
  return { ok: true, messageId: isProviderId(next) ? next : messageId, edits }
}

/** The draft's message id (unchanged at Graph), or why not. */
async function updateOutlookDraft(
  token: string,
  threadId: string,
  messageId: string,
  revision: DraftRevision,
): Promise<DraftUpdateOutcome> {
  const meta = await outlookDraftOnThread(token, threadId, messageId, ['subject', 'toRecipients', 'ccRecipients', 'body'])
  if (!meta) return NOT_FOUND
  // An HTML body was written or edited in Outlook (Native Intelligence writes text): a
  // plain-text rewrite would drop its signature, formatting and quoted chain.
  const bodyType = (meta.body as { contentType?: unknown } | undefined)?.contentType
  if (typeof bodyType === 'string' && bodyType.toLowerCase() === 'html') return { ok: false, reason: 'rich' }
  const addresses = (list: unknown) =>
    ((Array.isArray(list) ? list : []) as Array<{ emailAddress?: { address?: string } }>)
      .map((r) => r.emailAddress?.address ?? '')
      .filter(Boolean)
  const edits = revisedEdits(revision, {
    to: addresses(meta.toRecipients),
    cc: addresses(meta.ccRecipients),
    subject: typeof meta.subject === 'string' ? meta.subject : '',
  })
  if (!edits) return { ok: false, reason: 'invalid' }
  const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }))
  const res = await fetch(`${GRAPH_API}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // The draft's Bcc is left alone: a revision never changes who is blind-copied.
    body: JSON.stringify({
      subject: edits.subject,
      body: { contentType: 'Text', content: edits.body },
      toRecipients: recipients(edits.to),
      ccRecipients: recipients(edits.cc),
    }),
  })
  if (res.status === 404) return NOT_FOUND
  if (!res.ok) throw new Error(`Outlook draft update error: ${res.status}`)
  return { ok: true, messageId, edits }
}

/** True when the draft is gone: deleted now, or by the time the delete landed. False when it is no draft on the thread. */
async function discardGmailDraft(token: string, threadId: string, messageId: string): Promise<boolean> {
  if (!(await gmailDraftOnThread(token, threadId, messageId, 'format=minimal'))) return false
  // The draft endpoints take the draft's own id, which is not its message's.
  const draftId = await gmailDraftIdFor(token, messageId)
  if (!draftId) return false
  const res = await fetch(`${GMAIL_API}/drafts/${encodeURIComponent(draftId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok || res.status === 404) return true
  throw new Error(`Gmail draft delete error: ${res.status}`)
}

async function discardOutlookDraft(token: string, threadId: string, messageId: string): Promise<boolean> {
  if (!(await outlookDraftOnThread(token, threadId, messageId, []))) return false
  const res = await fetch(`${GRAPH_API}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok || res.status === 404) return true
  throw new Error(`Outlook draft delete error: ${res.status}`)
}

/**
 * What a discarded draft settles, each part best-effort (the draft is already
 * gone). Returns whether the thread is still in Mail for this workspace.
 */
async function settleDiscardedDraft(
  userId: string,
  workspaceId: string,
  mailbox: { provider: 'google' | 'microsoft'; token: string; email: string | null },
  providerThreadId: string,
  draftMessageId: string,
): Promise<boolean> {
  const supabase = getServiceClient()
  const step = async (what: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      console.warn(`[email] draft discarded, but its ${what} failed:`, err instanceof Error ? err.message : err)
    }
  }

  // The thread as it is without the draft, in each workspace that lists it.
  let threadRemains = true
  await step('thread re-index', async () => {
    const outcomes = await reindexThreadAfterDraft(userId, mailbox.provider, mailbox, providerThreadId)
    threadRemains = outcomes.get(workspaceId) !== 'gone'
  })

  // Dismissed: a drafting pass's row for this draft goes, and the hold (the
  // thread's copy) with it (src/lib/email/hold.ts).
  const rowIds: string[] = []
  await step('hold release', async () => {
    // A Gmail-side edit renames the draft's message: fall back to the thread
    // only when one open Native Intelligence draft is on it, so a discard never releases another.
    const rows = await draftRowsFor(supabase, userId, { providerDraftId: draftMessageId, providerThreadId, onlyIfSingle: true })
    rowIds.push(...(await releaseDraftRows(supabase, userId, rows, { reviewed: true })))
    if (!rows.length) await stampMailReview(supabase, userId, [workspaceId])
  })

  // Discarding is the human verb on the draft, as sending is: an agent
  // delivered it by its provider id, a drafting pass by its row.
  for (const id of [draftMessageId, ...rowIds]) {
    await resolveWorkForDeliverable(supabase, { type: 'email_draft', id })
  }
  return threadRemains
}

/**
 * The mailbox that holds a thread: its index row's account (a user with two
 * inboxes sends from the one the draft is in), else the user's token for the
 * row's provider, else their first email token (as the thread view falls back).
 */
async function mailboxForThread(
  userId: string,
  workspaceId: string,
  providerThreadId: string,
): Promise<{ provider: 'google' | 'microsoft'; token: string; email: string | null } | null> {
  const { data: row } = await getServiceClient()
    .from('email_thread_index')
    .select('provider, account_id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('provider_thread_id', providerThreadId)
    .limit(1)
    .maybeSingle()
  const provider = row?.provider === 'google' || row?.provider === 'microsoft' ? (row.provider as 'google' | 'microsoft') : null
  if (provider && row?.account_id) {
    const account = await getValidTokenForAccount(row.account_id as string)
    if (account) return { provider, token: account.token, email: account.email ?? null }
  }
  for (const p of provider ? [provider] : (['google', 'microsoft'] as const)) {
    const fallback = await getValidToken(userId, p, 'email')
    if (fallback) return { provider: p, token: fallback.token, email: fallback.email ?? null }
  }
  return null
}

/**
 * A Gmail message the mailbox says is a draft on `threadId`: its fields (as
 * `query` asks for them), or null when it is not one, or is gone. Send and
 * Discard both act only on what this finds.
 */
async function gmailDraftOnThread(
  token: string,
  threadId: string,
  messageId: string,
  query: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`Gmail message fetch error: ${res.status}`)
  const meta = await res.json()
  return meta.threadId === threadId && ((meta.labelIds as string[] | undefined) ?? []).includes('DRAFT') ? meta : null
}

/**
 * A Graph message that is a draft on `threadId` and not in Deleted Items: its
 * `select`ed fields, or null. A draft in Deleted Items was discarded or
 * superseded (Graph's DELETE moves it there), so it is never acted on.
 */
async function outlookDraftOnThread(
  token: string,
  threadId: string,
  messageId: string,
  select: string[],
): Promise<Record<string, unknown> | null> {
  const fields = ['isDraft', 'conversationId', 'parentFolderId', ...select].join(',')
  const [res, deletedItems] = await Promise.all([
    fetch(`${GRAPH_API}/messages/${encodeURIComponent(messageId)}?$select=${fields}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    outlookDeletedItemsId(token),
  ])
  if (res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`Outlook message fetch error: ${res.status}`)
  if (!deletedItems) throw new Error('Outlook Deleted Items folder unavailable')
  const meta = await res.json()
  return meta.isDraft === true && meta.conversationId === threadId && meta.parentFolderId !== deletedItems ? meta : null
}

/** The headers a Gmail draft is read for: its recipients, and what an edited copy of it keeps. */
const GMAIL_DRAFT_HEADERS = ['To', 'Cc', 'Bcc', 'Subject', 'From', 'In-Reply-To', 'References']
  .map((h) => `metadataHeaders=${h}`)
  .join('&')

async function sendGmailDraft(
  mailbox: { token: string; email: string | null },
  threadId: string,
  messageId: string,
  edits: DraftEdits | null,
): Promise<ProviderDraftOutcome> {
  const auth = { Authorization: `Bearer ${mailbox.token}` }
  const meta = await gmailDraftOnThread(mailbox.token, threadId, messageId, `format=metadata&${GMAIL_DRAFT_HEADERS}`)
  if (!meta) return NOT_FOUND

  const payload = meta.payload as { headers?: Array<{ name: string; value: string }> } | undefined
  const headers = payload?.headers ?? []
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
  const addressesIn = (name: string) => parseEmailAddresses(header(name)).map((a) => a.email)
  const to = edits ? edits.to : addressesIn('To')
  const cc = edits ? edits.cc : addressesIn('Cc')
  // The draft's own Bcc, unless the edits say otherwise (the chat card's field).
  const bcc = edits?.bcc ?? addressesIn('Bcc')
  if (to.length + cc.length + bcc.length === 0) return NO_RECIPIENTS
  const subject = edits ? edits.subject : header('Subject')

  // The draft endpoints take the draft's own id, which is not its message's.
  const draftId = await gmailDraftIdFor(mailbox.token, messageId)
  if (!draftId) return NOT_FOUND

  // Edited, the draft goes out as the user left it: the send carries the new
  // message, on the draft's thread, from the draft's sender, with its Bcc and
  // the reply headers that thread it for the recipients.
  const draft = edits
    ? {
        id: draftId,
        message: {
          threadId,
          raw: Buffer.from(
            buildRawEmail({
              from: senderHeader(header('From'), mailbox.email),
              to,
              cc,
              bcc,
              subject,
              bodyText: edits.body,
              bodyHtml: plainTextToHtml(edits.body),
              inReplyTo: bareMessageIds(header('In-Reply-To'))[0],
              references: bareMessageIds(header('References')),
            }),
          ).toString('base64url'),
        },
      }
    : { id: draftId }
  const sendRes = await fetch(`${GMAIL_API}/drafts/send`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  if (sendRes.status === 404) return NOT_FOUND
  if (!sendRes.ok) {
    const err = await sendRes.text().catch(() => '')
    throw new Error(`Gmail draft send error: ${sendRes.status} - ${err}`)
  }
  const sent = await sendRes.json()
  const labels = Array.isArray(sent.labelIds) && sent.labelIds.length > 0 ? (sent.labelIds as string[]) : ['SENT']
  return {
    ok: true,
    messageId: typeof sent.id === 'string' ? sent.id : null,
    folder: mapGmailLabelsToFolder(labels),
    to,
    subject,
  }
}

/**
 * The From header for an edited copy of a draft: the draft's own sender (its
 * name and any send-as address), else the mailbox's address. A non-ASCII name
 * is an encoded word, an ASCII one is quoted, and control characters never
 * reach the header.
 */
function senderHeader(draftFrom: string, mailboxEmail: string | null): string {
  const parsed = parseEmailAddresses(draftFrom)[0]
  const address = parsed?.email && isDraftAddress(parsed.email) ? parsed.email : (mailboxEmail ?? '')
  const name = (parsed?.name ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
  if (!name) return address
  const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/[\\"]/g, '\\$&')}"` : encodeHeaderValue(name)
  return `${shown} <${address}>`
}

/** The bare Message-IDs in an In-Reply-To or References header, in order. */
function bareMessageIds(value: string): string[] {
  return (value.match(/<[^<>\s]+>/g) ?? []).map((id) => id.slice(1, -1))
}

async function sendOutlookDraft(
  token: string,
  threadId: string,
  messageId: string,
  edits: DraftEdits | null,
): Promise<ProviderDraftOutcome> {
  const auth = { Authorization: `Bearer ${token}` }
  const id = encodeURIComponent(messageId)
  const meta = await outlookDraftOnThread(token, threadId, messageId, ['subject', 'toRecipients', 'ccRecipients', 'bccRecipients'])
  if (!meta) return NOT_FOUND

  const addresses = (list: unknown) =>
    ((Array.isArray(list) ? list : []) as Array<{ emailAddress?: { address?: string } }>)
      .map((r) => r.emailAddress?.address ?? '')
      .filter(Boolean)
  const to = edits ? edits.to : addresses(meta.toRecipients)
  const cc = edits ? edits.cc : addresses(meta.ccRecipients)
  if (to.length + cc.length + (edits?.bcc ?? addresses(meta.bccRecipients)).length === 0) return NO_RECIPIENTS

  // Edited, the draft is updated to what the user left, then sent: a Graph
  // draft keeps its id, and a reply keeps its place in the conversation.
  if (edits) {
    const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }))
    const patchRes = await fetch(`${GRAPH_API}/messages/${id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: edits.subject,
        body: { contentType: 'Text', content: edits.body },
        toRecipients: recipients(edits.to),
        ccRecipients: recipients(edits.cc),
        // Left alone unless the edits carry one, so the draft keeps its Bcc.
        ...(edits.bcc ? { bccRecipients: recipients(edits.bcc) } : {}),
      }),
    })
    if (patchRes.status === 404) return NOT_FOUND
    if (!patchRes.ok) throw new Error(`Outlook draft update error: ${patchRes.status}`)
  }

  const sendRes = await fetch(`${GRAPH_API}/messages/${id}/send`, { method: 'POST', headers: auth })
  if (sendRes.status === 404) return NOT_FOUND
  if (!sendRes.ok) throw new Error(`Outlook draft send error: ${sendRes.status}`)
  const subject = edits ? edits.subject : typeof meta.subject === 'string' ? meta.subject : ''
  return { ok: true, messageId: null, folder: 'sent', to, subject }
}

/** What a sent draft settles. Each part is best-effort on its own: the mail is already gone. */
async function settleSentDraft(
  userId: string,
  workspaceId: string,
  providerThreadId: string,
  draftMessageId: string,
  sent: ProviderDraftSent,
  rows: readonly HeldDraftRow[] = [],
): Promise<void> {
  const supabase = getServiceClient()
  const nowIso = new Date().toISOString()
  const step = async (what: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      console.warn(`[email] draft sent, but its ${what} failed:`, err instanceof Error ? err.message : err)
    }
  }

  // Answered and no longer a draft; out of Drafts until the sync next reads it.
  await step('index update', async () => {
    const answered = await supabase
      .from('email_thread_index')
      .update({ is_draft: false, needs_reply: false, last_message_at: nowIso, synced_at: nowIso })
      .eq('user_id', userId)
      .eq('provider_thread_id', providerThreadId)
    if (answered.error) throw new Error(answered.error.message)
    const moved = await supabase
      .from('email_thread_index')
      .update({ folder: sent.folder })
      .eq('user_id', userId)
      .eq('provider_thread_id', providerThreadId)
      .eq('folder', 'drafts')
    if (moved.error) throw new Error(moved.error.message)
  })

  // Sent: a drafting pass's row for this draft goes, and the hold (the
  // thread's copy) with it (src/lib/email/hold.ts). A hold whose delete fails
  // stays 'sending' and expiry clears it within the hour.
  const rowIds: string[] = []
  await step('hold release', async () => {
    rowIds.push(...(await releaseDraftRows(supabase, userId, rows, { reviewed: true })))
    // A draft with no review row (written in the mailbox) still counts as the person's activity here.
    if (!rows.length) await stampMailReview(supabase, userId, [workspaceId])
  })

  // Sending is the human verb on the draft: an agent delivered it by its
  // provider id, a drafting pass by its row.
  for (const id of [draftMessageId, ...rowIds]) {
    await resolveWorkForDeliverable(supabase, { type: 'email_draft', id })
  }

  await step('interaction log', () =>
    logSentEmailInteractions(workspaceId, sent.to, { referenceId: providerThreadId }),
  )
}

/** The connected email account a token belongs to (the index row's `account_id`). */
async function emailAccountIdFor(userId: string, provider: string, email: string | null): Promise<string | null> {
  if (!email) return null
  try {
    const { data } = await getServiceClient()
      .from('connected_account')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('capability', 'email')
      .eq('account_email', email)
      .limit(1)
      .maybeSingle()
    return (data?.id as string | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * Index a draft the tools just created, so Mail lists it and a work item's
 * "Review draft" (and its ledger touch) can find it before the next sync.
 *
 * Keyed the way the sync keys a thread (workspace, provider thread, user:
 * src/lib/crm/email-sync.ts), so the sync's next pass updates this row rather
 * than adding one. The table's unique key is on an expression
 * (`coalesce(account_id, …)`), which an upsert's conflict target cannot name:
 * the old `onConflict: 'workspace_id,user_id,provider_thread_id'` upsert failed
 * on every call and nothing was indexed. `account_id` is what Mail's list
 * scopes by (the workspace's linked accounts), so a row without it would never
 * be listed.
 *
 * Written into every workspace the account is linked to (each keeps its own
 * copy of a thread, and Mail lists only the current workspace's), so the
 * draft shows wherever its mailbox does. Returns the copy in `workspaceId`
 * when there is one, else the first. Exported for its tests.
 */
export async function indexDraftInDb(
  userId: string,
  workspaceId: string,
  provider: string,
  accountId: string | null,
  result: { id: string; threadId?: string },
  draft: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] },
): Promise<string | null> {
  try {
    const supabase = getServiceClient()
    const workspaceIds = await threadCopyWorkspaceIds(accountId, workspaceId, supabase)
    let indexedId: string | null = null
    for (const ws of workspaceIds) {
      const id = await indexDraftCopy(supabase, ws, userId, provider, accountId, result, draft)
      if (ws === workspaceId || !indexedId) indexedId = id
    }
    return indexedId
  } catch (err) {
    // Non-critical: the draft exists at the provider; the next sync indexes it.
    console.warn('[email] draft index write failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** One workspace's copy of a drafted thread, updated in place or added. Its row id. */
async function indexDraftCopy(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  provider: string,
  accountId: string | null,
  result: { id: string; threadId?: string },
  draft: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[] },
): Promise<string | null> {
  const providerThreadId = result.threadId || result.id
  const row = {
    workspace_id: workspaceId,
    user_id: userId,
    account_id: accountId,
    provider,
    provider_thread_id: providerThreadId,
    provider_message_id: result.id,
    // Ids, flags and addresses only (no stored mail): the draft's text is in
    // the mailbox and its review row (src/lib/email/tool-drafts.ts).
    from_email: null,
    participant_emails: [...new Set([...draft.to, ...(draft.cc || [])].map((a) => a.toLowerCase()))],
    message_count: 1,
    is_unread: false,
    is_starred: false,
    has_attachments: false,
    last_message_at: new Date().toISOString(),
    needs_reply: false,
    folder: 'drafts',
    is_draft: true,
    label_ids: ['DRAFT'],
    synced_at: new Date().toISOString(),
  }
  const { data: existing, error: readErr } = await supabase
    .from('email_thread_index')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('provider_thread_id', providerThreadId)
    .eq('user_id', userId)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)
  if (existing?.id) {
    // A reply draft on a thread already indexed: the thread is now a draft
    // too; its counts stay the sync's.
    const { error } = await supabase
      .from('email_thread_index')
      .update({ provider_message_id: result.id, is_draft: true, account_id: accountId, synced_at: row.synced_at })
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
    return existing.id as string
  }
  const { data: inserted, error } = await supabase.from('email_thread_index').insert(row).select('id').single()
  if (error) throw new Error(error.message)
  return (inserted?.id as string | undefined) ?? null
}

// ---------------------------------------------------------------------------
// Gmail API
// ---------------------------------------------------------------------------

async function listGmailMessages(
  accessToken: string,
  options: ListEmailsOptions,
): Promise<EmailMessage[]> {
  const params = new URLSearchParams({
    maxResults: String(options.maxResults || 20),
  })

  if (options.query) params.set('q', options.query)
  if (options.label) params.set('labelIds', options.label)

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) throw new Error(`Gmail API error: ${res.status}`)
  const data = await res.json()

  if (!data.messages?.length) return []

  // Batch fetch message details (limited to avoid timeout)
  const ids = data.messages.slice(0, options.maxResults || 20)
  const messages = await Promise.all(
    ids.map(async (m: { id: string }) => {
      try {
        return await getGmailMessage(accessToken, m.id)
      } catch {
        return null
      }
    }),
  )

  return messages.filter(Boolean) as EmailMessage[]
}

async function getGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<EmailMessage> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) throw new Error(`Gmail message error: ${res.status}`)
  const msg = await res.json()

  const headers = msg.payload?.headers || []
  const getHeader = (name: string) =>
    headers.find((h: { name: string; value: string }) =>
      h.name.toLowerCase() === name.toLowerCase(),
    )?.value || ''

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: getHeader('Subject') || '(No subject)',
    from: getHeader('From'),
    to: getHeader('To')
      .split(',')
      .map((s: string) => s.trim()),
    date: getHeader('Date'),
    snippet: msg.snippet || '',
    isRead: !msg.labelIds?.includes('UNREAD'),
    labels: msg.labelIds,
  }
}

async function createGmailDraft(
  accessToken: string,
  draft: {
    to: string[]
    subject: string
    body: string
    cc?: string[]
    bcc?: string[]
    thread_id?: string
    in_reply_to?: string
  },
): Promise<{ id: string; threadId?: string; message: string }> {
  // If threading, fetch the RFC 2822 Message-ID from the last message
  // Gmail needs this in the In-Reply-To/References headers for proper threading
  let rfcMessageId: string | null = null
  if (draft.thread_id && draft.in_reply_to) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${draft.in_reply_to}?format=metadata&metadataHeaders=Message-Id`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (msgRes.ok) {
        const msgData = await msgRes.json()
        const msgIdHeader = (msgData.payload?.headers || []).find(
          (h: { name: string; value: string }) => h.name.toLowerCase() === 'message-id',
        )
        if (msgIdHeader?.value) {
          // Strip angle brackets if present — we add them back below
          rfcMessageId = msgIdHeader.value.replace(/^<|>$/g, '')
        }
      }
    } catch {
      // Non-fatal — draft will still be created, just may not thread perfectly
    }
  }

  const headers = [
    `To: ${draft.to.join(', ')}`,
    `Subject: ${encodeHeaderValue(draft.subject)}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ]
  if (draft.cc?.length) headers.push(`Cc: ${draft.cc.join(', ')}`)
  if (draft.bcc?.length) headers.push(`Bcc: ${draft.bcc.join(', ')}`)
  if (rfcMessageId) {
    headers.push(`In-Reply-To: <${rfcMessageId}>`)
    headers.push(`References: <${rfcMessageId}>`)
  }

  const rawMessage = [...headers, '', draft.body].join('\r\n')
  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const messagePayload: Record<string, unknown> = { raw: encoded }
  if (draft.thread_id) {
    messagePayload.threadId = draft.thread_id
  }

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: messagePayload }),
    },
  )

  if (!res.ok) throw new Error(`Gmail draft error: ${res.status}`)
  const data = await res.json()

  return {
    id: data.message?.id || data.id,
    threadId: data.message?.threadId,
    message: draft.thread_id ? 'Reply draft created in Gmail' : 'Draft created in Gmail',
  }
}

// ---------------------------------------------------------------------------
// Microsoft Graph API (Outlook)
// ---------------------------------------------------------------------------

async function listOutlookMessages(
  accessToken: string,
  options: ListEmailsOptions,
): Promise<EmailMessage[]> {
  const params = new URLSearchParams({
    $top: String(options.maxResults || 20),
    // conversationId: Outlook's thread id, for read_email and update_email_thread.
    $select:
      'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead',
  })

  // Graph refuses $search with $orderby (400), and a `"` inside the quoted
  // KQL phrase breaks it.
  if (options.query) {
    params.set('$search', `"${options.query.replace(/"/g, '')}"`)
  } else {
    params.set('$orderby', 'receivedDateTime desc')
  }

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (!res.ok) throw new Error(`Outlook API error: ${res.status}`)
  const data = await res.json()

  return (data.value || []).map(
    (m: Record<string, unknown>): EmailMessage => ({
      id: m.id as string,
      ...(typeof m.conversationId === 'string' && m.conversationId ? { threadId: m.conversationId } : {}),
      subject: (m.subject as string) || '(No subject)',
      from:
        (
          (m.from as Record<string, Record<string, string>>)?.emailAddress
        )?.address || '',
      to: (
        (m.toRecipients as Array<Record<string, Record<string, string>>>) || []
      ).map((r) => r.emailAddress?.address || ''),
      date: m.receivedDateTime as string,
      snippet: (m.bodyPreview as string) || '',
      isRead: m.isRead as boolean,
    }),
  )
}

async function createOutlookDraft(
  accessToken: string,
  draft: {
    to: string[]
    subject: string
    body: string
    cc?: string[]
    bcc?: string[]
    thread_id?: string
    in_reply_to?: string
  },
): Promise<{ id: string; threadId?: string; message: string }> {
  // If replying to a thread and we have the last message ID, use the reply endpoint
  if (draft.in_reply_to) {
    // Create a reply draft on the specific message
    const replyRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${draft.in_reply_to}/createReply`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    )

    if (!replyRes.ok) throw new Error(`Outlook reply draft error: ${replyRes.status}`)
    const replyDraft = await replyRes.json()

    // Update the reply draft with our content and recipients
    const updatePayload: Record<string, unknown> = {
      body: { contentType: 'Text', content: draft.body },
      toRecipients: draft.to.map((email) => ({
        emailAddress: { address: email },
      })),
    }
    if (draft.cc?.length) {
      updatePayload.ccRecipients = draft.cc.map((email) => ({
        emailAddress: { address: email },
      }))
    }
    if (draft.bcc?.length) {
      updatePayload.bccRecipients = draft.bcc.map((email) => ({
        emailAddress: { address: email },
      }))
    }

    const updateRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${replyDraft.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatePayload),
      },
    )

    if (!updateRes.ok) throw new Error(`Outlook draft update error: ${updateRes.status}`)
    const updatedDraft = await updateRes.json()

    return {
      id: updatedDraft.id,
      threadId: updatedDraft.conversationId,
      message: 'Reply draft created in Outlook',
    }
  }

  // Standalone draft (no threading)
  const message: Record<string, unknown> = {
    subject: draft.subject,
    body: { contentType: 'Text', content: draft.body },
    toRecipients: draft.to.map((email) => ({
      emailAddress: { address: email },
    })),
  }

  if (draft.cc?.length) {
    message.ccRecipients = draft.cc.map((email) => ({
      emailAddress: { address: email },
    }))
  }
  if (draft.bcc?.length) {
    message.bccRecipients = draft.bcc.map((email) => ({
      emailAddress: { address: email },
    }))
  }

  // Set conversationId if threading to an existing conversation
  if (draft.thread_id) {
    message.conversationId = draft.thread_id
  }

  const res = await fetch(
    'https://graph.microsoft.com/v1.0/me/messages',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    },
  )

  if (!res.ok) throw new Error(`Outlook draft error: ${res.status}`)
  const data = await res.json()

  return {
    id: data.id,
    threadId: data.conversationId,
    message: draft.thread_id ? 'Reply draft created in Outlook' : 'Draft created in Outlook',
  }
}
