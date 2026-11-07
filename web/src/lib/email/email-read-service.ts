import { formatMailbox } from './mailbox-header'
import { mailboxesForThread, type LiveMailbox } from './thread-mailbox'
import { automatedHeaderReason, headerLookup, type AutomatedReason, type HeaderLookup } from './automated-sender'

// =====================================================================
// Types
// =====================================================================

export interface EmailMessageForAI {
  messageId?: string
  /** The provider thread it belongs to (Gmail threadId, Graph conversationId). */
  threadId?: string
  from: string
  /** Provider-declared reply address(es), which may differ from an automated sender. */
  replyTo?: string
  /** False when the message's Reply-To could not be verified. */
  replyToKnown?: boolean
  to: string
  /** Cc'd recipients, listed as `to` is. A reply to all goes to them too. */
  cc: string
  /** An unsent draft on the thread (the user's, or an agent's reply awaiting review), not a message to reply to. */
  isDraft: boolean
  date: string
  /** Unambiguous source timestamp for ordering/policy; date remains the display string. */
  dateISO?: string
  subject: string
  bodyText: string
  /** False when only a snippet, or no readable body, is available. */
  bodyComplete?: boolean
  hasAttachments: boolean
  attachmentNames: string[]
  /**
   * The automated-mail header it carries (Auto-Submitted, Precedence, a list
   * header…: src/lib/email/automated-sender.ts), as a fixed reason, never the
   * header text. Absent when none, or when the read had no headers.
   */
  automatedBy?: AutomatedReason
}

export interface EmailThreadForAI {
  threadId: string
  subject: string
  messages: EmailMessageForAI[]
  participantEmails: string[]
  source: 'provider'
  /** Whether this read returned the full available thread rather than one provider page. */
  complete?: boolean
}

// =====================================================================
// Read full email thread (live, from the thread's own mailbox)
// =====================================================================

/**
 * A thread as its mailbox holds it now. No stored mail (2026-10-15): Dial8
 * keeps no copy of messages, so every read is live, from the thread's OWN
 * mailbox (./thread-mailbox.ts: the account the caller names, else the
 * person's index row's, else each mailbox the workspace may read), never the
 * person's first token. Null when no mailbox holds it, or none can be read.
 */
export async function readEmailThread(
  userId: string,
  threadId: string,
  workspaceId?: string,
  opts: { accountId?: string | null; provider?: 'google' | 'microsoft' | null } = {},
): Promise<EmailThreadForAI | null> {
  try {
    for await (const mailbox of mailboxesForThread(userId, threadId, { workspaceId, ...opts })) {
      const thread = mailbox.provider === 'google'
        ? await readGmailThread(mailbox.token, threadId)
        : await readOutlookThread(mailbox.token, threadId)
      if (thread) return thread
    }
  } catch (err) {
    console.error('[email-read] thread read failed:', err instanceof Error ? err.message : 'unknown error')
  }
  return null
}

// =====================================================================
// Read single message by provider message ID (live)
// =====================================================================

/**
 * One message as its mailbox holds it now, from the mailboxes the workspace
 * may read (a message id names no thread, so each is asked in turn). Null
 * when none holds it.
 */
export async function readEmailMessage(
  userId: string,
  messageId: string,
  workspaceId?: string,
): Promise<EmailMessageForAI | null> {
  try {
    for await (const mailbox of mailboxesForThread(userId, '', { workspaceId })) {
      const message = mailbox.provider === 'google'
        ? await readGmailMessage(mailbox.token, messageId)
        : await readOutlookMessage(mailbox.token, messageId)
      if (message) return message
    }
  } catch (err) {
    console.error('[email-read] message read failed:', err instanceof Error ? err.message : 'unknown error')
  }
  return null
}

// =====================================================================
// One attachment of a message, as bytes (live)
// =====================================================================

/** The largest attachment read (a contacts file the owner emailed, roadmap track G1). */
export const ATTACHMENT_READ_MAX_BYTES = 10 * 1024 * 1024

/**
 * One file attached to a message, by its file name, from the mailboxes the
 * workspace may read (as readEmailMessage). For an owner's emailed
 * spreadsheet or contacts file (src/lib/ai/tools/contact-import.ts). Null
 * when no mailbox holds it, it isn't there, or it is over
 * ATTACHMENT_READ_MAX_BYTES. Never throws.
 */
export async function readEmailAttachment(
  userId: string,
  messageId: string,
  fileName: string,
  workspaceId?: string,
): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  try {
    for await (const mailbox of mailboxesForThread(userId, '', { workspaceId })) {
      const file = mailbox.provider === 'google'
        ? await readGmailAttachment(mailbox.token, messageId, fileName)
        : await readOutlookAttachment(mailbox.token, messageId, fileName)
      if (file) return file
    }
  } catch (err) {
    console.error('[email-read] attachment read failed:', err instanceof Error ? err.message : 'unknown error')
  }
  return null
}

function findGmailPart(payload: Record<string, unknown> | undefined, fileName: string): { attachmentId: string; size: number } | null {
  for (const p of (payload?.parts as Array<Record<string, unknown>>) || []) {
    const body = p.body as { attachmentId?: string; size?: number } | undefined
    if (p.filename === fileName && body?.attachmentId) return { attachmentId: body.attachmentId, size: body.size ?? 0 }
    const nested = findGmailPart(p, fileName)
    if (nested) return nested
  }
  return null
}

async function readGmailAttachment(accessToken: string, messageId: string, fileName: string): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`
  const res = await fetch(`${base}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const msg = await res.json()
  const part = findGmailPart(msg?.payload, fileName)
  if (!part || part.size > ATTACHMENT_READ_MAX_BYTES) return null
  const att = await fetch(`${base}/attachments/${encodeURIComponent(part.attachmentId)}`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!att.ok) return null
  const data = (await att.json())?.data
  if (typeof data !== 'string') return null
  const bytes = new Uint8Array(Buffer.from(data, 'base64url'))
  return bytes.byteLength > ATTACHMENT_READ_MAX_BYTES ? null : { fileName, bytes }
}

async function readOutlookAttachment(accessToken: string, messageId: string, fileName: string): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  const base = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments`
  const list = await fetch(`${base}?$select=id,name,size`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!list.ok) return null
  const items = ((await list.json())?.value ?? []) as Array<{ id?: string; name?: string; size?: number }>
  const hit = items.find((a) => a.name === fileName && a.id)
  if (!hit || (hit.size ?? 0) > ATTACHMENT_READ_MAX_BYTES) return null
  const one = await fetch(`${base}/${encodeURIComponent(hit.id!)}`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!one.ok) return null
  const contentBytes = (await one.json())?.contentBytes
  if (typeof contentBytes !== 'string') return null
  const bytes = new Uint8Array(Buffer.from(contentBytes, 'base64'))
  return bytes.byteLength > ATTACHMENT_READ_MAX_BYTES ? null : { fileName, bytes }
}

// =====================================================================
// Recent sent mail (live, from one mailbox)
// =====================================================================

/** Sent messages one read returns at most. */
export const SENT_READ_MAX = 25

/**
 * The person's recently SENT messages in one mailbox, newest first, read live
 * from Gmail (`in:sent`) or Graph (the Sent Items folder): at most `limit`
 * (SENT_READ_MAX), sent at or after `since`. Drafts are left out.
 *
 * For the nightly mail-tone pass (src/lib/packs/memory-learning.ts, Liam,
 * 2026-10-17: learn how they write, keep no copy of the mail). What comes back
 * lives only in the caller's memory: nothing here stores or logs a subject or
 * body. Never throws: a mailbox that can't be read returns [].
 */
export async function readRecentSentMessages(
  mailbox: Pick<LiveMailbox, 'provider' | 'token'>,
  opts: { since: string; limit: number },
): Promise<EmailMessageForAI[]> {
  const limit = Math.max(0, Math.min(Math.floor(opts.limit), SENT_READ_MAX))
  const sinceMs = Date.parse(opts.since)
  if (limit === 0 || !Number.isFinite(sinceMs)) return []
  try {
    const messages = mailbox.provider === 'google'
      ? await readGmailSent(mailbox.token, sinceMs, limit)
      : await readOutlookSent(mailbox.token, sinceMs, limit)
    return messages
      .filter((m) => !m.isDraft && (!m.dateISO || Date.parse(m.dateISO) >= sinceMs))
      .sort((a, b) => (b.dateISO ?? '').localeCompare(a.dateISO ?? ''))
      .slice(0, limit)
  } catch (err) {
    // The error's message only (a status or network failure), never mail text.
    console.error('[email-read] sent read failed:', err instanceof Error ? err.message : 'unknown error')
    return []
  }
}

async function readGmailSent(accessToken: string, sinceMs: number, limit: number): Promise<EmailMessageForAI[]> {
  // Gmail's `after:` takes seconds since the epoch.
  const q = encodeURIComponent(`in:sent after:${Math.floor(sinceMs / 1000)}`)
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${limit}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return []
  const list = (await res.json()) as { messages?: Array<{ id?: unknown }> }
  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').slice(0, limit)
  const read = await Promise.all(ids.map((id) => readGmailMessage(accessToken, id)))
  return read.filter((m): m is EmailMessageForAI => m !== null)
}

async function readOutlookSent(accessToken: string, sinceMs: number, limit: number): Promise<EmailMessageForAI[]> {
  // Graph wants a property in $orderby to lead the $filter too: sentDateTime in both.
  const filter = encodeURIComponent(`sentDateTime ge ${new Date(sinceMs).toISOString()}`)
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$filter=${filter}&$orderby=sentDateTime desc&$select=${OUTLOOK_READ_SELECT}&$top=${limit}`,
    // Plain text bodies: the tone pass reads words, not markup.
    { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' } },
  )
  if (!res.ok) return []
  const data = (await res.json()) as { value?: Record<string, unknown>[] }
  return (data.value ?? []).map((msg) => outlookMessageForAI(msg, new Set()))
}

// =====================================================================
// Provider reads
// =====================================================================

type GraphRecipient = { emailAddress?: { name?: string; address?: string } }

/** One Gmail message (format=full) as the model reads it; its addresses join `participants`. */
function gmailMessageForAI(msg: Record<string, unknown>, participants: Set<string>): EmailMessageForAI {
  const headers = ((msg.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }>) || []
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

  const fromEmail = extractEmailAddr(getHeader('From'))
  if (fromEmail) participants.add(fromEmail)
  for (const address of addressesIn(`${getHeader('To')}, ${getHeader('Cc')}`)) participants.add(address)

  const bodyText = extractGmailBodyText(msg.payload as Record<string, unknown>)
  const bodyHtml = extractGmailBodyHtml(msg.payload as Record<string, unknown>)
  const fullBody = bodyText || stripHtml(bodyHtml || '') || ''

  return {
    messageId: msg.id as string,
    ...(typeof msg.threadId === 'string' ? { threadId: msg.threadId } : {}),
    from: getHeader('From'),
    replyTo: getHeader('Reply-To') || undefined,
    to: getHeader('To'),
    cc: getHeader('Cc'),
    isDraft: ((msg.labelIds as string[] | undefined) ?? []).includes('DRAFT'),
    date: new Date(parseInt(msg.internalDate as string)).toLocaleString(),
    dateISO: isoTimestamp(Number(msg.internalDate)),
    subject: getHeader('Subject') || '(no subject)',
    bodyText: fullBody || (msg.snippet as string) || '',
    bodyComplete: Boolean(fullBody.trim()),
    hasAttachments: hasGmailAttachments(msg.payload as Record<string, unknown>),
    attachmentNames: extractGmailAttachmentNames(msg.payload as Record<string, unknown>),
    ...automatedField(headerLookup(headers)),
  }
}

/** One Graph message as the model reads it; its addresses join `participants`. */
function outlookMessageForAI(msg: Record<string, unknown>, participants: Set<string>): EmailMessageForAI {
  const from = (msg.from as GraphRecipient | undefined)?.emailAddress
  const fromAddr = from?.address || ''
  if (fromAddr) participants.add(fromAddr.toLowerCase())

  const toRecips = (msg.toRecipients as GraphRecipient[] | undefined) || []
  const ccRecips = (msg.ccRecipients as GraphRecipient[] | undefined) || []
  const replyRecips = (msg.replyTo as GraphRecipient[] | undefined) || []
  for (const r of [...toRecips, ...ccRecips]) {
    if (r.emailAddress?.address) participants.add(r.emailAddress.address.toLowerCase())
  }
  const graphRecipients = (list: GraphRecipient[]) =>
    listRecipients(list.map((r) => ({ name: r.emailAddress?.name, email: r.emailAddress?.address || '' })))

  const body = msg.body as Record<string, string> | undefined
  const bodyText = body?.contentType === 'text' ? body.content : stripHtml(body?.content || '')
  const attachments = (msg.attachments as Array<{ name?: unknown; isInline?: unknown }> | undefined) ?? []

  return {
    messageId: msg.id as string,
    ...(typeof msg.conversationId === 'string' ? { threadId: msg.conversationId } : {}),
    from: formatMailbox(from?.name, fromAddr),
    replyTo: graphRecipients(replyRecips) || undefined,
    to: graphRecipients(toRecips),
    cc: graphRecipients(ccRecips),
    isDraft: msg.isDraft === true,
    date: new Date(msg.receivedDateTime as string).toLocaleString(),
    dateISO: isoTimestamp(msg.receivedDateTime as string),
    subject: (msg.subject as string) || '(no subject)',
    bodyText: bodyText || '',
    bodyComplete: Boolean(bodyText?.trim()),
    hasAttachments: (msg.hasAttachments as boolean) || false,
    attachmentNames: attachments
      .filter((a) => a.isInline !== true && typeof a.name === 'string')
      .map((a) => a.name as string),
    ...(Array.isArray(msg.internetMessageHeaders)
      ? automatedField(headerLookup(msg.internetMessageHeaders as Array<{ name?: unknown; value?: unknown }>))
      : {}),
  }
}

/** The message's automated-mail reason as a field, or nothing. */
function automatedField(header: HeaderLookup): { automatedBy?: AutomatedReason } {
  const reason = automatedHeaderReason(header)
  return reason ? { automatedBy: reason } : {}
}

async function readGmailThread(
  accessToken: string,
  threadId: string,
): Promise<EmailThreadForAI | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return null
  const thread = await res.json()

  if (!thread.messages?.length) return null

  const participantEmails = new Set<string>()
  const messages = oldestFirst(thread.messages as Record<string, unknown>[], msg => Number(msg.internalDate))
    .map((msg) => gmailMessageForAI(msg, participantEmails))

  return {
    threadId,
    subject: messages[0]?.subject || '(no subject)',
    messages,
    participantEmails: Array.from(participantEmails),
    source: 'provider',
    complete: true,
  }
}

async function readGmailMessage(accessToken: string, messageId: string): Promise<EmailMessageForAI | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return null
  const msg = await res.json()
  return msg?.id ? gmailMessageForAI(msg, new Set()) : null
}

/** The fields a live Outlook read asks for (attachment names come from the expansion). */
// internetMessageHeaders: only for the automated-mail check (automatedBy), never passed on.
const OUTLOOK_READ_SELECT = 'id,conversationId,from,replyTo,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments,isDraft,internetMessageHeaders'
const OUTLOOK_ATTACHMENT_EXPAND = '$expand=attachments($select=name,isInline)'

async function readOutlookThread(
  accessToken: string,
  threadId: string,
): Promise<EmailThreadForAI | null> {
  // Conversation ids are base64 (+, /, =): encoded, or a + reads as a space and nothing matches.
  const filter = encodeURIComponent(`conversationId eq '${threadId.replace(/'/g, "''")}'`)
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$filter=${filter}&$orderby=receivedDateTime asc&$select=${OUTLOOK_READ_SELECT}&${OUTLOOK_ATTACHMENT_EXPAND}&$top=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return null
  const data = await res.json()

  if (!data.value?.length) return null

  const participantEmails = new Set<string>()
  const messages = oldestFirst(data.value as Record<string, unknown>[], msg => timestamp(msg.receivedDateTime as string))
    .map((msg) => outlookMessageForAI(msg, participantEmails))

  return {
    threadId,
    subject: messages[0]?.subject || '(no subject)',
    messages,
    participantEmails: Array.from(participantEmails),
    source: 'provider',
    complete: !data['@odata.nextLink'],
  }
}

async function readOutlookMessage(accessToken: string, messageId: string): Promise<EmailMessageForAI | null> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=${OUTLOOK_READ_SELECT}&${OUTLOOK_ATTACHMENT_EXPAND}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return null
  const msg = await res.json()
  return msg?.id ? outlookMessageForAI(msg, new Set()) : null
}

// =====================================================================
// Helpers
// =====================================================================

function timestamp(value: string | number | null | undefined): number {
  return value == null || value === '' ? NaN : new Date(value).getTime()
}

function isoTimestamp(value: string | number | null | undefined): string | undefined {
  const time = timestamp(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/** Sort source timestamps, never locale-formatted display dates. Preserve ties/provider order. */
function oldestFirst<T>(messages: T[], time: (message: T) => number): T[] {
  return [...messages].sort((a, b) => {
    const left = time(a), right = time(b)
    return Number.isFinite(left) && Number.isFinite(right) ? left - right : 0
  })
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Recipients as a header lists them: `Name <address>`, or the bare address. */
function listRecipients(list: Array<{ name?: string | null; email: string }>): string {
  return list
    .filter((r) => r.email)
    .map((r) => formatMailbox(r.name, r.email))
    .join(', ')
}

/** Every address in an address-list header (To, Cc), lowercased. */
function addressesIn(header: string): string[] {
  return (header.match(/[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+\.[^\s<>,;:"()[\]]+/g) ?? []).map((a) => a.toLowerCase())
}

function extractEmailAddr(from: string): string | null {
  const match = from.match(/<([^>]+@[^>]+)>/)
  if (match) return match[1].toLowerCase()
  const emailMatch = from.match(/[\w.+-]+@[\w.-]+\.\w+/)
  return emailMatch ? emailMatch[0].toLowerCase() : null
}

function extractGmailBodyText(payload: Record<string, unknown>): string | null {
  if (!payload) return null

  if ((payload.mimeType as string) === 'text/plain' && (payload.body as Record<string, string>)?.data) {
    return Buffer.from((payload.body as Record<string, string>).data, 'base64url').toString('utf-8')
  }

  const parts = (payload.parts as Array<Record<string, unknown>>) || []
  for (const part of parts) {
    const result = extractGmailBodyText(part)
    if (result) return result
  }

  return null
}

function extractGmailBodyHtml(payload: Record<string, unknown>): string | null {
  if (!payload) return null

  if ((payload.mimeType as string) === 'text/html' && (payload.body as Record<string, string>)?.data) {
    return Buffer.from((payload.body as Record<string, string>).data, 'base64url').toString('utf-8')
  }

  const parts = (payload.parts as Array<Record<string, unknown>>) || []
  for (const part of parts) {
    const result = extractGmailBodyHtml(part)
    if (result) return result
  }

  return null
}

function hasGmailAttachments(payload: Record<string, unknown>): boolean {
  const parts = (payload?.parts as Array<Record<string, unknown>>) || []
  return parts.some(
    (p) => !!(p.filename as string) && (p.body as Record<string, string>)?.attachmentId,
  )
}

function extractGmailAttachmentNames(payload: Record<string, unknown>): string[] {
  const names: string[] = []
  const parts = (payload?.parts as Array<Record<string, unknown>>) || []
  for (const p of parts) {
    if ((p.filename as string) && (p.body as Record<string, string>)?.attachmentId) {
      names.push(p.filename as string)
    }
    // Recurse into nested parts
    if (p.parts) {
      names.push(...extractGmailAttachmentNames(p))
    }
  }
  return names
}
