import { getValidToken, getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { draftRowsFor, markHoldsSending, releaseDraftRows, restoreHolds, touchHold } from '@/lib/email/hold'
import { getServiceClient } from '@/lib/admin'
import { readableWorkspaceEmailAccounts } from '@/lib/email/account-scope'
import { mailboxesForThread, ownedMailbox } from '@/lib/email/thread-mailbox'
import { materializeSearchHit } from '@/lib/email/materialize-thread'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'
import { deleteProviderDraft } from '@/lib/email/provider-drafts'
import { outlookDeletedItemsId } from './email-sync'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailAddress {
  name: string | null
  email: string
}

export interface EmailAttachment {
  name: string
  size: number
  mimeType: string
}

export interface FullEmailMessage {
  id: string
  threadId: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  date: string
  bodyHtml: string | null
  bodyText: string | null
  isUnread: boolean
  isStarred: boolean
  /** An unsent draft in the thread (an agent's reply, or one the user saved). */
  isDraft: boolean
  /** A held reply draft the person edited before a new message arrived (src/lib/email/hold.ts). */
  draftStale?: boolean
  hasAttachments: boolean
  attachments: EmailAttachment[]
}

export interface FullEmailThread {
  threadId: string
  /** The thread's `email_thread_index` row (the id its agent activity is keyed on), when indexed. */
  indexId: string | null
  subject: string
  messages: FullEmailMessage[]
  drafts: Array<Record<string, unknown>>
  contact: Record<string, unknown> | null
  metadata: {
    needs_reply: boolean
    auto_classified: string | null
    linked_capture_id: string | null
  }
}

interface SendEmailParams {
  thread_id?: string
  in_reply_to_message_id?: string
  /**
   * RFC 2822 Message-IDs (bare, no angle brackets) for the References chain,
   * oldest first. Recipient clients thread off these headers, not off provider
   * thread ids. When omitted, falls back to a single-id chain from
   * in_reply_to_message_id.
   */
  references?: string[]
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body_html: string
  body_text?: string
  draft_id?: string
  /** The provider draft this send replaces, by its MESSAGE id (as `create_email_draft` returns it); deleted after the send. */
  provider_draft_id?: string
  /**
   * Pin the send to one connected account. Without this, resolution falls back
   * to google-then-microsoft — callers that send repeatedly to the same thread
   * (sequences) must pin, or a user with two mailboxes can start a thread from
   * one and continue it from the other.
   */
  account_id?: string
  /** Skip the contact_interaction insert — for callers that keep their own ledger. */
  skip_interaction_log?: boolean
  /**
   * Caller-supplied RFC 2822 Message-ID (bare, no angle brackets) to stamp on
   * the outgoing message instead of self-generating one. Callers that persist
   * this id BEFORE calling sendEmail can later recover the fate of a send whose
   * response was lost (crash mid-call) via findSentMessageByRfcId.
   */
  rfc_message_id?: string
}

export interface SendEmailResult {
  message_id: string
  thread_id: string | null
  /**
   * RFC 2822 Message-ID (bare) of the sent message. Gmail: self-generated and
   * stamped on the raw MIME (Gmail preserves it). Outlook: read from the
   * created draft's internetMessageId. This is the durable cross-provider
   * handle for threading follow-ups.
   *
   * Repeat callers building a thread must persist EVERY send's rfc id and pass
   * the full accumulated chain as `references` on the next send — this function
   * does not accumulate the chain for them.
   */
  rfc_message_id: string | null
}

// ---------------------------------------------------------------------------
// Get email token helper
// ---------------------------------------------------------------------------

async function getEmailToken(userId: string) {
  const google = await getValidToken(userId, 'google', 'email')
  if (google) return { provider: 'google' as const, ...google }

  const microsoft = await getValidToken(userId, 'microsoft', 'email')
  if (microsoft) return { provider: 'microsoft' as const, ...microsoft }

  return null
}

// ---------------------------------------------------------------------------
// Fetch full thread — prefers stored messages, falls back to on-demand fetch
// ---------------------------------------------------------------------------

export async function fetchFullEmailThreadForClient(
  userId: string,
  workspaceId: string,
  providerThreadId: string,
  /** The mailbox the thread is in (a search result the index doesn't have opens by it). */
  opts: { accountId?: string | null } = {},
): Promise<FullEmailThread> {
  const supabaseAdmin = getServiceClient()
  const namedAccount = opts.accountId || null

  const readIndex = () => {
    let query = supabaseAdmin
      .from('email_thread_index')
      .select('*, linked_contact:linked_contact_id(id, full_name, email, job_title, company:company_id(id, name))')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('provider_thread_id', providerThreadId)
    if (namedAccount) query = query.eq('account_id', namedAccount)
    return query.maybeSingle()
  }

  // Look up the thread first to find which account/provider it belongs to
  const [draftsResult, threadIndexResult] = await Promise.all([
    supabaseAdmin
      .from('email_draft')
      .select('*')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('provider_thread_id', providerThreadId)
      .in('status', ['pending_review', 'approved', 'edited'])
      .order('created_at', { ascending: false }),
    readIndex(),
  ])

  const existingDrafts = draftsResult.data
  let threadIndex = threadIndexResult.data

  // A search result the index doesn't have (older than its 30 days, or not
  // indexed yet): indexed now from the mailbox Mail names, through the sync's
  // writer (ids, flags, addresses; src/lib/email/materialize-thread.ts), so
  // every thread route works on it from here. Only a mailbox this workspace
  // may read; a named mailbox that isn't is the answer.
  if (!threadIndex && namedAccount) {
    const made = await materializeSearchHit({ userId, workspaceId, accountId: namedAccount, threadId: providerThreadId }, { admin: supabaseAdmin })
    if (!made.ok && made.reason === 'not_readable') throw new Error('Mailbox not found')
    if (!made.ok && made.reason === 'no_mailbox') throw new Error('Mailbox not connected')
    if (made.ok) threadIndex = (await readIndex()).data
  }

  // Get the right token for this thread's account
  let token: { provider: 'google' | 'microsoft'; token: string; email: string | null } | null = null
  if (threadIndex?.account_id) {
    const accountToken = await getValidTokenForAccount(threadIndex.account_id)
    if (accountToken) {
      token = { provider: threadIndex.provider as 'google' | 'microsoft', token: accountToken.token, email: accountToken.email }
    }
  }
  // Not indexed here (older than the index's 30 days, or not indexed yet): the
  // mailbox the caller names, only when it is one this workspace may read; a
  // named mailbox that isn't is the answer (never another mailbox's token).
  if (!token && !threadIndex && namedAccount) {
    const readable = await readableWorkspaceEmailAccounts(userId, workspaceId, supabaseAdmin)
    if (!readable.some((a) => a.id === namedAccount)) throw new Error('Mailbox not found')
    const mailbox = await ownedMailbox(userId, namedAccount)
    if (!mailbox) throw new Error('Mailbox not connected')
    token = { provider: mailbox.provider, token: mailbox.token, email: mailbox.email }
  }
  // Fallback to legacy lookup if no account_id or token not found
  if (!token) {
    token = await getEmailToken(userId)
  }
  if (!token) throw new Error('No email integration connected')

  // Fetch messages from provider API
  const messages = token.provider === 'google'
    ? await fetchGmailThreadFull(token.token, providerThreadId)
    : await fetchOutlookThreadFull(token.token, providerThreadId)

  // The holding pattern (src/lib/email/hold.ts): opening a held thread is
  // touching it (another 14 days), and a reply draft the person edited before
  // a new message arrived says so on the draft itself.
  const heldDrafts = ((existingDrafts ?? []) as Array<{ hold_id?: string | null; stale?: boolean | null; provider_draft_id?: string | null }>)
  const holdIds = [...new Set(heldDrafts.map((d) => d.hold_id).filter((id): id is string => typeof id === 'string' && !!id))]
  for (const holdId of holdIds) await touchHold(supabaseAdmin, userId, holdId)
  const staleDrafts = new Set(heldDrafts.filter((d) => d.stale && d.provider_draft_id).map((d) => d.provider_draft_id as string))
  for (const message of messages) {
    if (message.isDraft && staleDrafts.has(message.id)) message.draftStale = true
  }

  // Mark as read: update provider (source of truth) then local DB
  if (threadIndex?.is_unread) {
    try {
      await markAsReadInProvider(token, providerThreadId, messages)
    } catch (err) {
      // Log but don't block — still update local DB so UI stays consistent
      console.error('[email-client] markAsReadInProvider failed:', err)
    }
    await supabaseAdmin
      .from('email_thread_index')
      .update({ is_unread: false })
      .eq('id', threadIndex.id)
  }

  return {
    threadId: providerThreadId,
    indexId: (threadIndex?.id as string | undefined) ?? null,
    subject: messages[0]?.subject || '',
    messages,
    drafts: existingDrafts || [],
    contact: threadIndex?.linked_contact || null,
    metadata: {
      needs_reply: threadIndex?.needs_reply || false,
      auto_classified: threadIndex?.auto_classified || null,
      linked_capture_id: threadIndex?.linked_capture_id || null,
    },
  }
}

// ---------------------------------------------------------------------------
// Gmail: fetch full thread
// ---------------------------------------------------------------------------

async function fetchGmailThreadFull(
  accessToken: string,
  threadId: string,
): Promise<FullEmailMessage[]> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error(`Gmail thread fetch error: ${res.status}`)

  const data = await res.json()
  return (data.messages || []).map((msg: Record<string, unknown>) => {
    const headers = ((msg.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }>) || []
    const getH = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

    const payload = msg.payload as Record<string, unknown>

    return {
      id: msg.id as string,
      threadId: data.id as string,
      from: parseEmailAddress(getH('From')),
      to: parseEmailAddresses(getH('To')),
      cc: parseEmailAddresses(getH('Cc')),
      bcc: parseEmailAddresses(getH('Bcc')),
      subject: getH('Subject'),
      date: msg.internalDate
        ? new Date(parseInt(msg.internalDate as string)).toISOString()
        : getH('Date'),
      bodyHtml: extractGmailBody(payload, 'text/html'),
      bodyText: extractGmailBody(payload, 'text/plain'),
      isUnread: ((msg.labelIds as string[]) || []).includes('UNREAD'),
      isStarred: ((msg.labelIds as string[]) || []).includes('STARRED'),
      isDraft: ((msg.labelIds as string[]) || []).includes('DRAFT'),
      hasAttachments: hasGmailAttachments(payload),
      attachments: extractGmailAttachmentMetadata(payload),
    }
  })
}

function extractGmailBody(payload: Record<string, unknown>, mimeType: string): string | null {
  // Check direct body
  if ((payload.mimeType as string) === mimeType) {
    const bodyData = (payload.body as Record<string, string>)?.data
    if (bodyData) return Buffer.from(bodyData, 'base64url').toString('utf-8')
  }

  // Check parts recursively
  const parts = (payload.parts as Array<Record<string, unknown>>) || []
  for (const part of parts) {
    if ((part.mimeType as string) === mimeType) {
      const bodyData = (part.body as Record<string, string>)?.data
      if (bodyData) return Buffer.from(bodyData, 'base64url').toString('utf-8')
    }
    // Recurse into nested parts (multipart/alternative, multipart/related)
    if ((part.mimeType as string)?.startsWith('multipart/')) {
      const found = extractGmailBody(part, mimeType)
      if (found) return found
    }
  }

  return null
}

function hasGmailAttachments(payload: Record<string, unknown>): boolean {
  const parts = (payload.parts as Array<Record<string, unknown>>) || []
  return parts.some((p) => !!(p.filename as string))
}

function extractGmailAttachmentMetadata(payload: Record<string, unknown>): EmailAttachment[] {
  const parts = (payload.parts as Array<Record<string, unknown>>) || []
  return parts
    .filter((p) => !!(p.filename as string))
    .map((p) => ({
      name: (p.filename as string) || 'attachment',
      size: (p.body as Record<string, number>)?.size || 0,
      mimeType: (p.mimeType as string) || 'application/octet-stream',
    }))
}

// ---------------------------------------------------------------------------
// Outlook: fetch full thread
// ---------------------------------------------------------------------------

async function fetchOutlookThreadFull(
  accessToken: string,
  conversationId: string,
): Promise<FullEmailMessage[]> {
  const [res, deletedItems] = await Promise.all([
    fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId eq '${conversationId}'&$select=id,conversationId,from,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,body,isRead,isDraft,parentFolderId,flag,hasAttachments,attachments&$orderby=receivedDateTime asc&$top=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    ),
    outlookDeletedItemsId(accessToken),
  ])
  if (!res.ok) throw new Error(`Outlook thread fetch error: ${res.status}`)

  const data = await res.json()
  return (data.value || []).map((msg: Record<string, unknown>) => {
    const from = msg.from as Record<string, Record<string, string>> | undefined
    const toRecipients = (msg.toRecipients as Array<Record<string, Record<string, string>>>) || []
    const ccRecipients = (msg.ccRecipients as Array<Record<string, Record<string, string>>>) || []
    const bccRecipients = (msg.bccRecipients as Array<Record<string, Record<string, string>>>) || []
    const body = msg.body as Record<string, string> | undefined
    const flag = msg.flag as Record<string, string> | undefined
    const attachments = (msg.attachments as Array<Record<string, unknown>>) || []

    return {
      id: msg.id as string,
      threadId: msg.conversationId as string,
      from: {
        name: from?.emailAddress?.name || null,
        email: from?.emailAddress?.address || '',
      },
      to: toRecipients.map((r) => ({
        name: r.emailAddress?.name || null,
        email: r.emailAddress?.address || '',
      })),
      cc: ccRecipients.map((r) => ({
        name: r.emailAddress?.name || null,
        email: r.emailAddress?.address || '',
      })),
      bcc: bccRecipients.map((r) => ({
        name: r.emailAddress?.name || null,
        email: r.emailAddress?.address || '',
      })),
      subject: (msg.subject as string) || '',
      date: (msg.receivedDateTime as string) || '',
      bodyHtml: body?.contentType === 'html' ? body?.content || null : null,
      bodyText: body?.contentType === 'text' ? body?.content || null : null,
      isUnread: !(msg.isRead as boolean),
      isStarred: flag?.flagStatus === 'flagged',
      // A draft in Deleted Items was discarded or superseded (Graph's DELETE
      // moves it there): never offered to send, nor any when that folder is unknown.
      isDraft: msg.isDraft === true && deletedItems !== null && msg.parentFolderId !== deletedItems,
      hasAttachments: msg.hasAttachments as boolean,
      attachments: attachments.map((a) => ({
        name: (a.name as string) || 'attachment',
        size: (a.size as number) || 0,
        mimeType: (a.contentType as string) || 'application/octet-stream',
      })),
    }
  })
}

// ---------------------------------------------------------------------------
// Mark as read in provider
// ---------------------------------------------------------------------------

async function markAsReadInProvider(
  token: { provider: 'google' | 'microsoft'; token: string },
  threadId: string,
  messages: FullEmailMessage[],
) {
  if (token.provider === 'google') {
    await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      },
    )
  } else {
    // Outlook: mark each unread message as read
    for (const msg of messages.filter((m) => m.isUnread)) {
      await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${msg.id}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ isRead: true }),
        },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Send email
// ---------------------------------------------------------------------------

/**
 * Look up a Graph message by its RFC internetMessageId. Graph message ids are
 * FOLDER-scoped — a draft id dies when /send moves the message to Sent Items,
 * and a stored parent id dies when the user files the message — so the RFC id
 * is the only durable handle. `rfcId` is bare (no angle brackets); Graph stores
 * internetMessageId angle-bracket-wrapped. Single attempt, no polling; returns
 * null on empty result or any error.
 */
async function resolveGraphMessageByRfcId(
  accessToken: string,
  rfcId: string,
  scope: 'sentitems' | 'all',
): Promise<{ id: string; conversationId: string | null } | null> {
  const base =
    scope === 'sentitems'
      ? `https://graph.microsoft.com/v1.0/me/mailFolders('sentitems')/messages`
      : 'https://graph.microsoft.com/v1.0/me/messages'
  // OData string literal: single quotes are escaped by doubling.
  const literal = `<${rfcId}>`.replace(/'/g, "''")
  try {
    const res = await fetch(
      `${base}?$filter=${encodeURIComponent(`internetMessageId eq '${literal}'`)}&$select=id,conversationId`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return null
    const data = await res.json()
    const match = (data.value || [])[0] as { id?: string; conversationId?: string } | undefined
    if (!match?.id) return null
    return { id: match.id, conversationId: match.conversationId || null }
  } catch {
    return null
  }
}

/**
 * The token of ONE mailbox the person picked (the From account). Throws when
 * that account is not theirs, is not an email account, or has no valid token.
 */
async function pinnedEmailAccountToken(
  userId: string,
  accountId: string,
): Promise<{ provider: 'google' | 'microsoft'; token: string; email: string | null }> {
  // SECURITY BOUNDARY: this runs on the service-role client, so RLS does not
  // apply — the user_id filter is the only thing preventing a caller from
  // pinning another tenant's account_id and sending as them. The capability
  // check keeps a calendar account id from being pinnable as a sender.
  const [{ data: account }, accountToken] = await Promise.all([
    getServiceClient()
      .from('connected_account')
      .select('provider, capability, user_id')
      .eq('id', accountId)
      .eq('user_id', userId)
      .maybeSingle(),
    getValidTokenForAccount(accountId),
  ])
  if (!account || account.capability !== 'email' || !accountToken) {
    throw new Error('Connected email account unavailable')
  }
  return {
    provider: account.provider as 'google' | 'microsoft',
    token: accountToken.token,
    email: accountToken.email,
  }
}

export async function sendEmail(
  userId: string,
  workspaceId: string,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const supabaseAdmin = getServiceClient()

  // Resolve the sending identity. account_id pins to one mailbox; the legacy
  // fallback tries google then microsoft and takes the first hit.
  let token: { provider: 'google' | 'microsoft'; token: string; email: string | null } | null = null
  if (params.account_id) {
    token = await pinnedEmailAccountToken(userId, params.account_id)
  } else {
    token = await getEmailToken(userId)
  }
  if (!token) throw new Error('No email integration connected')

  let sentMessageId: string
  let sentThreadId: string | null = null
  let sentRfcMessageId: string | null = null

  // The holding pattern (src/lib/email/hold.ts): a held draft's hold goes
  // 'sending' while the provider sends, back to 'held' if the send fails.
  const draftRows = params.draft_id ? await draftRowsFor(supabaseAdmin, userId, { draftId: params.draft_id }) : []
  const sendingHolds = await markHoldsSending(supabaseAdmin, userId, draftRows)
  try {

    if (token.provider === 'google') {
      // Resolve the parent's RFC 2822 Message-ID for threading headers when the
      // caller didn't supply a references chain.
      let parentRfcId: string | undefined =
        params.references && params.references.length > 0
          ? params.references[params.references.length - 1]
          : undefined
      if (!parentRfcId && params.in_reply_to_message_id) {
        try {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${params.in_reply_to_message_id}?format=metadata&metadataHeaders=Message-Id`,
            { headers: { Authorization: `Bearer ${token.token}` } },
          )
          if (msgRes.ok) {
            const msgData = await msgRes.json()
            const msgIdHeader = (msgData.payload?.headers || []).find(
              (h: { name: string; value: string }) => h.name.toLowerCase() === 'message-id',
            )
            if (msgIdHeader?.value) {
              parentRfcId = msgIdHeader.value.replace(/^<|>$/g, '')
            }
          }
        } catch {
          // Non-fatal — send will still work via threadId
        }
      }

      // Self-generate our Message-ID so callers get a durable threading handle
      // without a follow-up metadata fetch (Gmail preserves a caller-set header).
      // A caller-supplied id wins — it lets the caller persist the id before this
      // call and recover the send's fate after a crash.
      sentRfcMessageId = params.rfc_message_id ?? makeRfcMessageId(token.email)

      const rawEmail = buildRawEmail({
        from: token.email || '',
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        bodyHtml: params.body_html,
        bodyText: params.body_text,
        messageId: sentRfcMessageId,
        // Only ever a real RFC id here — in_reply_to_message_id is a Gmail
        // provider id; a malformed In-Reply-To trips spam heuristics, while a
        // missing one still threads via References.
        inReplyTo: parentRfcId,
        references: params.references,
      })

      const encoded = Buffer.from(rawEmail)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      const res = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            raw: encoded,
            threadId: params.thread_id,
          }),
        },
      )
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Gmail send error: ${res.status} - ${err}`)
      }
      const data = await res.json()
      sentMessageId = data.id
      // For new threads this is the only place the thread id ever surfaces —
      // discarding it (the old behavior) left callers unable to track the thread.
      sentThreadId = data.threadId || null
    } else {
      // Microsoft — two-step create-draft-then-send for BOTH paths. /sendMail
      // returns 202 with no body and /reply returns nothing useful, so the old
      // one-shot calls left no handle to the sent message (empty or wrong
      // sentMessageId). Creating the draft first returns the message JSON,
      // including the Graph id and the internetMessageId (Graph assigns the RFC
      // id at draft creation, so reading it here is exact).
      if (params.in_reply_to_message_id) {
        const createReplyAt = (graphId: string) =>
          fetch(`https://graph.microsoft.com/v1.0/me/messages/${graphId}/createReply`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token.token}`,
              'Content-Type': 'application/json',
            },
          })
        let createRes = await createReplyAt(params.in_reply_to_message_id)
        // A 404 usually means the stored Graph id died when the parent changed
        // folders (ids are folder-scoped). The RFC id survives moves — re-resolve
        // the parent by the last References entry and retry once.
        if (createRes.status === 404 && params.references?.length) {
          const parentRfc = params.references[params.references.length - 1]
          const resolved = await resolveGraphMessageByRfcId(token.token, parentRfc, 'all')
          if (resolved) {
            createRes = await createReplyAt(resolved.id)
          }
        }
        if (!createRes.ok) throw new Error(`Outlook createReply error: ${createRes.status}`)
        const draft = await createRes.json()

        // createReply derives recipients from the parent's reply semantics —
        // when replying to our OWN sent message that addresses the sender (us),
        // so recipients MUST be set explicitly.
        // The body replacement deliberately strips the quoted history createReply
        // seeded — outreach follow-ups don't quote (matches the Gmail path's output).
        const patchRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${draft.id}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              body: { contentType: 'html', content: params.body_html },
              // internetMessageId is settable while isDraft — a caller-supplied
              // id replaces the Graph-assigned one for crash-recovery lookups.
              ...(params.rfc_message_id
                ? { internetMessageId: `<${params.rfc_message_id}>` }
                : {}),
              toRecipients: params.to.map((e) => ({ emailAddress: { address: e } })),
              ...(params.cc?.length
                ? { ccRecipients: params.cc.map((e) => ({ emailAddress: { address: e } })) }
                : {}),
              ...(params.bcc?.length
                ? { bccRecipients: params.bcc.map((e) => ({ emailAddress: { address: e } })) }
                : {}),
            }),
          },
        )
        if (!patchRes.ok) throw new Error(`Outlook reply patch error: ${patchRes.status}`)
        const patched = await patchRes.json()

        const sendRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${draft.id}/send`,
          { method: 'POST', headers: { Authorization: `Bearer ${token.token}` } },
        )
        if (!sendRes.ok) throw new Error(`Outlook reply send error: ${sendRes.status}`)

        sentRfcMessageId =
          params.rfc_message_id ??
          ((patched.internetMessageId || draft.internetMessageId || '').replace(/^<|>$/g, '') ||
            null)
        // /send moves the message to Sent Items under a NEW folder-scoped id, so
        // draft.id is already dead. Resolve the real sent message by RFC id; send
        // is async, so an empty result just falls back to the draft values.
        const sent = sentRfcMessageId
          ? await resolveGraphMessageByRfcId(token.token, sentRfcMessageId, 'sentitems')
          : null
        sentMessageId = sent?.id || draft.id
        sentThreadId = sent?.conversationId || draft.conversationId || null
      } else {
        const createRes = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            subject: params.subject,
            body: { contentType: 'html', content: params.body_html },
            // Settable at draft creation — see the reply path's note.
            ...(params.rfc_message_id
              ? { internetMessageId: `<${params.rfc_message_id}>` }
              : {}),
            toRecipients: params.to.map((e) => ({ emailAddress: { address: e } })),
            ...(params.cc?.length
              ? { ccRecipients: params.cc.map((e) => ({ emailAddress: { address: e } })) }
              : {}),
            ...(params.bcc?.length
              ? { bccRecipients: params.bcc.map((e) => ({ emailAddress: { address: e } })) }
              : {}),
          }),
        })
        if (!createRes.ok) throw new Error(`Outlook draft create error: ${createRes.status}`)
        const draft = await createRes.json()

        const sendRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${draft.id}/send`,
          { method: 'POST', headers: { Authorization: `Bearer ${token.token}` } },
        )
        if (!sendRes.ok) throw new Error(`Outlook send error: ${sendRes.status}`)

        sentRfcMessageId =
          params.rfc_message_id ??
          ((draft.internetMessageId || '').replace(/^<|>$/g, '') || null)
        // Same folder-scoped-id problem as the reply path: resolve the real sent
        // message, falling back to the (dead) draft values when it hasn't landed.
        const sent = sentRfcMessageId
          ? await resolveGraphMessageByRfcId(token.token, sentRfcMessageId, 'sentitems')
          : null
        sentMessageId = sent?.id || draft.id
        sentThreadId = sent?.conversationId || draft.conversationId || null
      }
    }
  } catch (err) {
    await restoreHolds(supabaseAdmin, userId, sendingHolds)
    throw err
  }

  // From a Dial8 draft: sent, so the draft row goes, and its hold (the
  // thread's copy) with it. Sending is the human verb on the draft: the work
  // item that produced it stops waiting (ACTIVITY-AND-REVIEW §4.3).
  if (params.draft_id) {
    await releaseDraftRows(supabaseAdmin, userId, draftRows, { reviewed: true })
    await resolveWorkForDeliverable(supabaseAdmin, { type: 'email_draft', id: params.draft_id })
  }

  // The provider draft this send replaces (the chat card's fallback, for a
  // draft it cannot name by its thread; otherwise the card sends the draft
  // itself, through sendProviderDraft): deleted the way a
  // discard is, so only an indexed draft of this user, at its own mailbox, and
  // at Gmail by its draft id; then its thread is indexed again from the
  // mailbox, with the reply just sent as its last message.
  if (params.provider_draft_id) {
    // Its review row (an agent's draft, src/lib/email/tool-drafts.ts) goes too, hold and all.
    const replaced = await draftRowsFor(supabaseAdmin, userId, { providerDraftId: params.provider_draft_id })
    for (const id of await releaseDraftRows(supabaseAdmin, userId, replaced, { reviewed: true })) {
      await resolveWorkForDeliverable(supabaseAdmin, { type: 'email_draft', id })
    }
    try {
      await deleteProviderDraft(userId, params.provider_draft_id)
    } catch (err) {
      // Non-critical: draft cleanup failure shouldn't break the send flow
      console.warn('[email] draft cleanup after send failed:', err instanceof Error ? err.message : err)
    }
  }

  // Create contact interactions for recipients (skipped for callers with
  // their own ledger, e.g. sequences — double-logging inflates the timeline)
  if (!params.skip_interaction_log) {
    await logSentEmailInteractions(workspaceId, params.to, {
      referenceId: params.thread_id || sentMessageId,
    })
  }

  // Update thread index
  if (params.thread_id) {
    await supabaseAdmin
      .from('email_thread_index')
      .update({
        needs_reply: false,
        last_message_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('provider_thread_id', params.thread_id)
  }

  return {
    message_id: sentMessageId,
    thread_id: params.thread_id || sentThreadId,
    rfc_message_id: sentRfcMessageId,
  }
}

/** An email interaction's title: a template naming the contact, never a subject (no stored mail). Pure. */
export function emailInteractionTitle(contactName: string | null | undefined): string {
  const name = (contactName ?? '').trim()
  return name ? `Email to ${name.slice(0, 120)}` : 'Email sent'
}

/**
 * An `email_sent` interaction on the timeline of each recipient who is a
 * contact in the workspace, for mail sent from Dial8 (`sendEmail`, and a
 * draft sent from Mail's thread view). The row is readable by the whole
 * workspace, so it carries a template title ("Email to Dana") and a pointer
 * to the thread, never the subject.
 */
export async function logSentEmailInteractions(
  workspaceId: string,
  recipients: readonly string[],
  ref: { referenceId: string },
): Promise<void> {
  const supabaseAdmin = getServiceClient()
  for (const email of recipients) {
    const { data: contact } = await supabaseAdmin
      .from('contact')
      .select('id, full_name')
      .eq('workspace_id', workspaceId)
      .eq('email', email.toLowerCase())
      .maybeSingle()

    if (contact) {
      await supabaseAdmin.from('contact_interaction').insert({
        workspace_id: workspaceId,
        contact_id: contact.id,
        interaction_type: 'email_sent',
        reference_type: 'email_thread',
        reference_id: ref.referenceId,
        title: emailInteractionTitle((contact as { full_name?: string | null }).full_name),
        occurred_at: new Date().toISOString(),
      })

      await supabaseAdmin.rpc('update_contact_interaction_stats', {
        p_contact_id: contact.id,
        p_occurred_at: new Date().toISOString(),
      })
    }
  }
}

/**
 * Crash-recovery lookup: did a send stamped with `rfcMessageId` actually reach
 * the provider? For callers that persist a caller-supplied rfc_message_id
 * BEFORE calling sendEmail (see SendEmailParams.rfc_message_id), this resolves
 * the fate of a send whose response was lost mid-flight.
 *
 * Gmail: users.messages.list with the rfc822msgid: operator. Outlook: the
 * existing RFC-id resolution against Sent Items. Returns null when the message
 * cannot be found OR anything fails (token, network) — null means "unknown",
 * never "not sent"; callers must keep their at-most-once bias on null.
 */
export async function findSentMessageByRfcId(
  userId: string,
  accountId: string,
  rfcMessageId: string,
): Promise<{ message_id: string; thread_id: string | null } | null> {
  try {
    const supabaseAdmin = getServiceClient()
    // Same security boundary as sendEmail's pinned-account path: service-role
    // client, so the user_id filter is the tenant check.
    const [{ data: account }, accountToken] = await Promise.all([
      supabaseAdmin
        .from('connected_account')
        .select('provider, capability, user_id')
        .eq('id', accountId)
        .eq('user_id', userId)
        .maybeSingle(),
      getValidTokenForAccount(accountId),
    ])
    if (!account || account.capability !== 'email' || !accountToken) return null

    if (account.provider === 'google') {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
          `rfc822msgid:${rfcMessageId}`,
        )}&maxResults=1`,
        { headers: { Authorization: `Bearer ${accountToken.token}` } },
      )
      if (!res.ok) return null
      const data = await res.json()
      const match = (data.messages || [])[0] as
        | { id?: string; threadId?: string }
        | undefined
      if (!match?.id) return null
      return { message_id: match.id, thread_id: match.threadId || null }
    }

    const resolved = await resolveGraphMessageByRfcId(
      accountToken.token,
      rfcMessageId,
      'sentitems',
    )
    if (!resolved) return null
    return { message_id: resolved.id, thread_id: resolved.conversationId }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Save draft to provider
// ---------------------------------------------------------------------------

export async function saveDraftToProvider(
  userId: string,
  params: {
    thread_id?: string
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    body_html: string
    /** The picked From mailbox; pins the draft to it, as sendEmail's account_id does. */
    account_id?: string | null
  },
): Promise<{ draft_id: string }> {
  // The picked From account wins (as on send); otherwise a reply draft belongs
  // in its thread's own mailbox (Gmail files it on the thread there).
  const token = params.account_id
    ? await pinnedEmailAccountToken(userId, params.account_id)
    : params.thread_id ? await threadMailboxToken(userId, params.thread_id) : await getEmailToken(userId)
  if (!token) throw new Error('No email integration connected')

  let draftId: string

  if (token.provider === 'google') {
    const rawEmail = buildRawEmail({
      from: token.email || '',
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      bodyHtml: params.body_html,
    })

    const encoded = Buffer.from(rawEmail)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: { raw: encoded, threadId: params.thread_id },
        }),
      },
    )
    if (!res.ok) throw new Error(`Gmail draft error: ${res.status}`)
    const data = await res.json()
    draftId = data.id
  } else {
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me/messages',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subject: params.subject,
          body: { contentType: 'html', content: params.body_html },
          toRecipients: params.to.map((e) => ({ emailAddress: { address: e } })),
          ccRecipients: params.cc?.map((e) => ({ emailAddress: { address: e } })),
        }),
      },
    )
    if (!res.ok) throw new Error(`Outlook draft error: ${res.status}`)
    const data = await res.json()
    draftId = data.id
  }

  return { draft_id: draftId }
}

// ---------------------------------------------------------------------------
// Thread actions: star, archive, trash, mark-read
// ---------------------------------------------------------------------------

/**
 * The THREAD's own mailbox for an action on it, as the live read resolves it
 * (mailboxesForThread): the account its index row names, never the person's
 * first token, which with two mailboxes acted on the wrong one at the
 * provider. Null when no mailbox holds it.
 */
async function threadMailboxToken(
  userId: string,
  providerThreadId: string,
): Promise<{ provider: 'google' | 'microsoft'; token: string; email: string | null; accountId: string | null } | null> {
  for await (const mailbox of mailboxesForThread(userId, providerThreadId)) {
    return { provider: mailbox.provider, token: mailbox.token, email: mailbox.email, accountId: mailbox.accountId }
  }
  return null
}

/** The person's index rows for the thread, in the mailbox the action ran on when it is known. */
function threadRows(userId: string, providerThreadId: string, accountId: string | null) {
  return (patch: Record<string, unknown>) => {
    let query = getServiceClient().from('email_thread_index').update(patch).eq('user_id', userId).eq('provider_thread_id', providerThreadId)
    if (accountId) query = query.eq('account_id', accountId)
    return query
  }
}

/**
 * A Gmail thread call that THROWS when Gmail refuses it, so the caller never
 * writes the index row (and the route never reports success) for a change the
 * mailbox did not make.
 */
async function gmailThreadCall(token: string, providerThreadId: string, action: 'modify' | 'trash', body?: unknown): Promise<void> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${providerThreadId}/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`Gmail thread ${action} error: ${res.status}`)
}

/**
 * Apply one Graph call to every message of an Outlook conversation (Outlook
 * has no thread-level move or read). Throws on any refusal, so the index row
 * is only written for a change the mailbox made. Every page of ids is read
 * before anything moves: a page link counts its place in the folder, which a
 * move out of it would shift. `moved` (the caller's, so it survives a
 * refusal partway) collects the moved messages' new ids by their old ones: a
 * Graph move gives a message a NEW id (ids are folder-scoped), which the
 * move's response carries.
 */
async function outlookConversationEach(
  token: string,
  conversationId: string,
  call: (messageId: string) => { path: string; method: 'POST' | 'PATCH'; body: unknown },
  /** Only this folder's messages (archive touches the inbox only, as Gmail's does); default: every folder. */
  folder?: 'inbox',
  moved: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
  const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)
  const list = folder ? `me/mailFolders/${folder}/messages` : 'me/messages'
  const ids: string[] = []
  let url: string | null = `https://graph.microsoft.com/v1.0/${list}?$filter=${filter}&$select=id&$top=100`
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Outlook thread fetch error: ${res.status}`)
    const data = (await res.json()) as { value?: Array<{ id?: string }>; '@odata.nextLink'?: string }
    for (const msg of data.value || []) if (msg.id) ids.push(msg.id)
    url = data['@odata.nextLink'] ?? null
  }
  for (const id of ids) {
    const { path, method, body } = call(id)
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Outlook message update error: ${r.status}`)
    if (path === '/move') {
      const after = (await r.json().catch(() => null)) as { id?: unknown } | null
      if (typeof after?.id === 'string' && after.id && after.id !== id) moved.set(id, after.id)
    }
  }
  return moved
}

/**
 * After an Outlook move: the index's newest message id (provider_message_id,
 * the arrival triage's revision, src/lib/email/triage.ts) follows its message
 * to the new id the move gave it. Left on the old id, the next push's
 * re-index reads the new id as a new message and can hand an archived thread
 * to drafting and the agent's news as if mail had arrived. Scoped to the
 * person's rows for the thread in this mailbox (a legacy one: account_id
 * null), and only where the row still names a message that moved. Never
 * throws: the next sync writes the id if this didn't.
 */
async function followMovedNewest(userId: string, providerThreadId: string, accountId: string | null, moved: ReadonlyMap<string, string>): Promise<void> {
  if (!moved.size) return
  try {
    const db = getServiceClient()
    let read = db.from('email_thread_index').select('provider_message_id').eq('user_id', userId).eq('provider_thread_id', providerThreadId)
    read = accountId ? read.eq('account_id', accountId) : read.is('account_id', null)
    const { data, error } = await read
    if (error) throw new Error(error.message)
    const named = new Set(
      ((data ?? []) as Array<{ provider_message_id?: unknown }>)
        .map((r) => r.provider_message_id)
        .filter((id): id is string => typeof id === 'string' && moved.has(id)),
    )
    for (const old of named) {
      let update = db
        .from('email_thread_index')
        .update({ provider_message_id: moved.get(old) })
        .eq('user_id', userId)
        .eq('provider_thread_id', providerThreadId)
        .eq('provider_message_id', old)
      update = accountId ? update.eq('account_id', accountId) : update.is('account_id', null)
      const { error: updateError } = await update
      if (updateError) throw new Error(updateError.message)
    }
  } catch (err) {
    console.warn('[email-client] newest message id not followed:', err instanceof Error ? err.message : String(err))
  }
}

export async function toggleThreadStar(
  userId: string,
  providerThreadId: string,
  starred: boolean,
): Promise<void> {
  const token = await threadMailboxToken(userId, providerThreadId)
  if (!token) throw new Error('No email integration connected')

  if (token.provider === 'google') {
    await gmailThreadCall(
      token.token,
      providerThreadId,
      'modify',
      starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] },
    )
  }
  // Outlook flagging is per-message, skip for now

  await threadRows(userId, providerThreadId, token.accountId)({ is_starred: starred })
}

export async function archiveThread(
  userId: string,
  providerThreadId: string,
): Promise<void> {
  const token = await threadMailboxToken(userId, providerThreadId)
  if (!token) throw new Error('No email integration connected')

  if (token.provider === 'google') {
    await gmailThreadCall(token.token, providerThreadId, 'modify', { removeLabelIds: ['INBOX'] })
  } else {
    // Outlook: move the conversation's INBOX messages (Gmail's archive only
    // drops the INBOX label, so sent replies stay in Sent); the DB row alone
    // left the thread in the real inbox, and the sync never writes `folder` back.
    const moved = new Map<string, string>()
    try {
      await outlookConversationEach(
        token.token,
        providerThreadId,
        () => ({ path: '/move', method: 'POST', body: { destinationId: 'archive' } }),
        'inbox',
        moved,
      )
      await threadRows(userId, providerThreadId, token.accountId)({ folder: 'archive' })
    } finally {
      // Even when a later move was refused: what moved has its new id.
      await followMovedNewest(userId, providerThreadId, token.accountId, moved)
    }
    return
  }

  await threadRows(userId, providerThreadId, token.accountId)({ folder: 'archive' })
}

export async function trashThread(
  userId: string,
  providerThreadId: string,
): Promise<void> {
  const token = await threadMailboxToken(userId, providerThreadId)
  if (!token) throw new Error('No email integration connected')

  if (token.provider === 'google') {
    await gmailThreadCall(token.token, providerThreadId, 'trash')
  } else {
    // Every message goes to Deleted Items, which the indexer leaves out, so
    // the next re-index finds the thread gone (no copy left to call new
    // mail): its moved ids need no following, unlike archive's.
    await outlookConversationEach(token.token, providerThreadId, () => ({
      path: '/move',
      method: 'POST',
      body: { destinationId: 'deleteditems' },
    }))
  }

  await threadRows(userId, providerThreadId, token.accountId)({ folder: 'trash' })
}

export async function toggleThreadRead(
  userId: string,
  providerThreadId: string,
  isRead: boolean,
): Promise<void> {
  const token = await threadMailboxToken(userId, providerThreadId)
  if (!token) throw new Error('No email integration connected')

  if (token.provider === 'google') {
    await gmailThreadCall(
      token.token,
      providerThreadId,
      'modify',
      isRead ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] },
    )
  } else {
    await outlookConversationEach(token.token, providerThreadId, () => ({
      path: '',
      method: 'PATCH',
      body: { isRead },
    }))
  }

  await threadRows(userId, providerThreadId, token.accountId)({ is_unread: !isRead })
}

// ---------------------------------------------------------------------------
// Email building helpers
// ---------------------------------------------------------------------------

export function makeRfcMessageId(fromEmail: string | null): string {
  const domain = fromEmail?.split('@')[1] || 'mail.dial8.ai'
  return `${crypto.randomUUID()}@${domain}`
}

/**
 * RFC 2047 encoded-word for a header value.
 *
 * Header field bodies are ASCII-only (RFC 5322 §2.2); a raw non-ASCII byte
 * there has no declared charset — the body's `charset=UTF-8` covers the body
 * only. Clients that meet undeclared 8-bit bytes in a header fall back to
 * Latin-1, so a UTF-8 em dash arrives as the classic 'Ã¢Â€Â”' mojibake.
 *
 * Pure-ASCII values are returned untouched (the common case, and encoding
 * them would only hurt readability in raw MIME). Anything else is emitted as
 * a single base64 encoded-word. Base64 (not Q) because it is uniform for
 * mixed scripts, and one word because subjects here are short.
 */
export function encodeHeaderValue(value: string): string {
  if (!/[^\x00-\x7f]/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export function buildRawEmail(params: {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  bodyHtml: string
  bodyText?: string
  /** Our own RFC Message-ID (bare) — Gmail preserves a caller-set header */
  messageId?: string
  inReplyTo?: string
  /** Full References chain (bare ids, oldest first); falls back to inReplyTo alone */
  references?: string[]
}): string {
  const boundary = `----=_Part_${Date.now()}`
  // Header-injection defense: a CR/LF (or any control char) in the subject
  // would terminate the Subject header and let the remainder be parsed as
  // additional headers (Bcc exfiltration, spoofed Reply-To). Neutralize here
  // so EVERY send path is covered regardless of upstream validation.
  const oneLine = (value: string) => value.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
  const subject = encodeHeaderValue(oneLine(params.subject))
  // The same for every other header value: recipients and reference ids can
  // come from inbound mail, and a CR/LF in one would add a header (a Bcc).
  const addresses = (list: string[]) => list.map(oneLine).join(', ')
  const referenceIds =
    params.references && params.references.length > 0
      ? params.references
      : params.inReplyTo
        ? [params.inReplyTo]
        : []
  const headers = [
    `From: ${oneLine(params.from)}`,
    `To: ${addresses(params.to)}`,
    params.cc?.length ? `Cc: ${addresses(params.cc)}` : '',
    // Gmail derives envelope recipients from the raw MIME — without this
    // header BCC'd addresses receive nothing (Gmail strips it on delivery).
    params.bcc?.length ? `Bcc: ${addresses(params.bcc)}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    params.messageId ? `Message-ID: <${oneLine(params.messageId)}>` : '',
    params.inReplyTo ? `In-Reply-To: <${oneLine(params.inReplyTo)}>` : '',
    referenceIds.length ? `References: ${referenceIds.map((r) => `<${oneLine(r)}>`).join(' ')}` : '',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n')

  const plainText = params.bodyText || htmlToPlainText(params.bodyHtml)

  return (
    `${headers}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
    `${plainText}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
    `${params.bodyHtml}\r\n` +
    `--${boundary}--`
  )
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Email address parsing
// ---------------------------------------------------------------------------

function parseEmailAddress(header: string): EmailAddress {
  if (!header) return { name: null, email: '' }
  const match = header.match(/^"?([^"<]*?)"?\s*<([^>]+)>/)
  if (match) return { name: match[1].trim() || null, email: match[2].trim() }
  return { name: null, email: header.trim() }
}

export function parseEmailAddresses(header: string): EmailAddress[] {
  if (!header) return []
  const results: EmailAddress[] = []
  const regex = /(?:"?([^"<]*?)"?\s*<([^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/g
  let match
  while ((match = regex.exec(header)) !== null) {
    const name = match[1]?.trim() || null
    const email = (match[2] || match[3] || '').trim()
    if (email && email.includes('@')) {
      results.push({ name, email })
    }
  }
  return results
}
