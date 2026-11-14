/**
 * The live mailbox reads a share makes (migration 646), with the OWNER's
 * token, never stored: the thread's message ids when it is shared, and then
 * only those messages (and their attachments) when a reader opens it.
 *
 * Every read of a message checks it is still in the shared thread (Gmail's
 * threadId, Graph's conversationId): an id the share holds can't be turned
 * into a read of another message. Graph ids are asked for as immutable ids
 * (`Prefer: IdType="ImmutableId"`), so a message the owner files keeps the id
 * the share froze.
 *
 * Nothing here logs or throws a subject, a body or an address: a failed read
 * is null (or an Error naming the provider and a status).
 */
import type { EmailShareAddress, EmailShareAttachment, EmailShareMessage } from './types'
import { EMAIL_SHARE_MAX_MESSAGES } from './types'
import { htmlToText, sanitizeSharedEmailHtml } from './sanitize'

export interface ShareMailbox {
  provider: 'google' | 'microsoft'
  token: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'
/** Graph ids that survive a move between folders. */
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' }

/** The largest attachment a share hands on (Gmail's own send limit). */
export const SHARE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

function auth(token: string, extra: Record<string, string> = {}): RequestInit {
  return { headers: { Authorization: `Bearer ${token}`, ...extra }, cache: 'no-store' }
}

// ── The thread's messages now (at share time) ───────────────────────────────

/**
 * The ids of the thread's messages as the mailbox holds it now, oldest first,
 * drafts left out (a draft is never shared), at most EMAIL_SHARE_MAX_MESSAGES
 * (the newest). Null when the thread can't be read.
 */
export async function liveThreadMessageIds(mailbox: ShareMailbox, threadId: string, fetchImpl: FetchLike = fetch): Promise<string[] | null> {
  try {
    if (mailbox.provider === 'google') {
      const res = await fetchImpl(`${GMAIL}/threads/${encodeURIComponent(threadId)}?format=minimal`, auth(mailbox.token))
      if (!res.ok) return null
      const data = (await res.json()) as { messages?: Array<{ id?: string; labelIds?: string[]; internalDate?: string }> }
      const ids = (data.messages ?? [])
        .filter((m) => typeof m.id === 'string' && !(m.labelIds ?? []).includes('DRAFT'))
        .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0))
        .map((m) => m.id as string)
      return ids.slice(-EMAIL_SHARE_MAX_MESSAGES)
    }
    const filter = encodeURIComponent(`conversationId eq '${threadId.replace(/'/g, "''")}'`)
    const res = await fetchImpl(
      `${GRAPH}/messages?$filter=${filter}&$select=id,isDraft,receivedDateTime&$orderby=receivedDateTime asc&$top=${EMAIL_SHARE_MAX_MESSAGES}`,
      auth(mailbox.token, IMMUTABLE),
    )
    if (!res.ok) return null
    const data = (await res.json()) as { value?: Array<{ id?: string; isDraft?: boolean }> }
    return (data.value ?? []).filter((m) => typeof m.id === 'string' && m.isDraft !== true).map((m) => m.id as string)
  } catch {
    return null
  }
}

// ── One shared message (on open) ────────────────────────────────────────────

type GmailHeader = { name?: string; value?: string }
interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}
interface GmailMessage {
  id?: string
  threadId?: string
  snippet?: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailPart
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** "Ana Ruiz <ana@northwind.example>" → { name, email }. */
export function parseAddress(raw: string): EmailShareAddress {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw)
  if (m) return { name: m[1].trim() || null, email: m[2].trim() }
  return { name: null, email: raw.trim() }
}

/** A header list of addresses, split on commas outside quotes and angle brackets. */
export function parseAddressList(raw: string): EmailShareAddress[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let angled = false
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<') angled = true
    else if (ch === '>') angled = false
    if (ch === ',' && !quoted && !angled) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean).map(parseAddress)
}

function gmailBody(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null
  if (part.mimeType === mimeType && part.body?.data && !part.filename) return Buffer.from(part.body.data, 'base64url').toString('utf-8')
  for (const child of part.parts ?? []) {
    const found = gmailBody(child, mimeType)
    if (found) return found
  }
  return null
}

function gmailAttachments(part: GmailPart | undefined, out: EmailShareAttachment[] = []): EmailShareAttachment[] {
  if (!part) return out
  if (part.filename && part.body?.attachmentId && part.partId) {
    out.push({ key: part.partId, name: part.filename, size: part.body.size ?? 0, mimeType: part.mimeType || 'application/octet-stream' })
  }
  for (const child of part.parts ?? []) gmailAttachments(child, out)
  return out
}

function gmailPart(part: GmailPart | undefined, partId: string): GmailPart | null {
  if (!part) return null
  if (part.partId === partId) return part
  for (const child of part.parts ?? []) {
    const found = gmailPart(child, partId)
    if (found) return found
  }
  return null
}

type GraphRecipient = { emailAddress?: { name?: string; address?: string } }
interface GraphAttachment {
  id?: string
  name?: string
  size?: number
  contentType?: string
  isInline?: boolean
  '@odata.type'?: string
}
interface GraphMessage {
  id?: string
  conversationId?: string
  subject?: string
  bodyPreview?: string
  receivedDateTime?: string
  isDraft?: boolean
  from?: GraphRecipient
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  body?: { contentType?: string; content?: string }
  attachments?: GraphAttachment[]
}

const graphAddress = (r: GraphRecipient | undefined): EmailShareAddress => ({ name: r?.emailAddress?.name || null, email: r?.emailAddress?.address || '' })

/** A file attachment Graph lists (an item or reference attachment, or an inline image, is not handed on). */
function graphFiles(list: GraphAttachment[] | undefined): EmailShareAttachment[] {
  return (list ?? [])
    .filter((a) => typeof a.id === 'string' && a.isInline !== true && (a['@odata.type'] ?? '#microsoft.graph.fileAttachment') === '#microsoft.graph.fileAttachment')
    .map((a) => ({ key: a.id as string, name: a.name || 'attachment', size: a.size ?? 0, mimeType: a.contentType || 'application/octet-stream' }))
}

const GRAPH_SELECT = 'id,conversationId,subject,receivedDateTime,isDraft,from,toRecipients,ccRecipients,body'
const GRAPH_ATTACHMENTS = '$expand=attachments($select=id,name,size,contentType,isInline)'

async function gmailMessage(mailbox: ShareMailbox, messageId: string, threadId: string, format: 'full' | 'metadata', fetchImpl: FetchLike): Promise<GmailMessage | null> {
  const query = format === 'full' ? 'format=full' : 'format=metadata&metadataHeaders=Subject&metadataHeaders=From'
  const res = await fetchImpl(`${GMAIL}/messages/${encodeURIComponent(messageId)}?${query}`, auth(mailbox.token))
  if (!res.ok) return null
  const msg = (await res.json()) as GmailMessage
  // Still the shared thread's, and not turned into a draft.
  if (msg.id !== messageId || msg.threadId !== threadId || (msg.labelIds ?? []).includes('DRAFT')) return null
  return msg
}

async function graphMessage(mailbox: ShareMailbox, messageId: string, threadId: string, select: string, fetchImpl: FetchLike): Promise<GraphMessage | null> {
  const res = await fetchImpl(`${GRAPH}/messages/${encodeURIComponent(messageId)}?$select=${select}`, auth(mailbox.token, IMMUTABLE))
  if (!res.ok) return null
  const msg = (await res.json()) as GraphMessage
  if (msg.id !== messageId || msg.conversationId !== threadId || msg.isDraft === true) return null
  return msg
}

/** One shared message, whole and read-only (bodies sanitized). Null when it is gone or no longer the thread's. */
export async function liveSharedMessage(mailbox: ShareMailbox, messageId: string, threadId: string, fetchImpl: FetchLike = fetch): Promise<EmailShareMessage | null> {
  try {
    if (mailbox.provider === 'google') {
      const msg = await gmailMessage(mailbox, messageId, threadId, 'full', fetchImpl)
      if (!msg) return null
      const headers = msg.payload?.headers
      const html = gmailBody(msg.payload, 'text/html')
      const text = gmailBody(msg.payload, 'text/plain')
      return {
        id: messageId,
        from: parseAddress(header(headers, 'From')),
        to: parseAddressList(header(headers, 'To')),
        cc: parseAddressList(header(headers, 'Cc')),
        date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(headers, 'Date'),
        subject: header(headers, 'Subject'),
        bodyHtml: html ? sanitizeSharedEmailHtml(html) : null,
        bodyText: text ?? (html ? htmlToText(html) : null),
        attachments: gmailAttachments(msg.payload),
      }
    }
    const msg = await graphMessage(mailbox, messageId, threadId, `${GRAPH_SELECT}&${GRAPH_ATTACHMENTS}`, fetchImpl)
    if (!msg) return null
    const isHtml = msg.body?.contentType?.toLowerCase() === 'html'
    const content = msg.body?.content ?? ''
    return {
      id: messageId,
      from: graphAddress(msg.from),
      to: (msg.toRecipients ?? []).map(graphAddress),
      cc: (msg.ccRecipients ?? []).map(graphAddress),
      date: msg.receivedDateTime ?? '',
      subject: msg.subject ?? '',
      bodyHtml: isHtml && content ? sanitizeSharedEmailHtml(content) : null,
      bodyText: isHtml ? (content ? htmlToText(content) : null) : content || null,
      attachments: graphFiles(msg.attachments),
    }
  } catch {
    return null
  }
}

/** A shared message's subject, sender and first line, for its card. Null when it is gone. */
export async function liveSharedSummary(
  mailbox: ShareMailbox,
  messageId: string,
  threadId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ subject: string; from: string; firstLine: string } | null> {
  try {
    if (mailbox.provider === 'google') {
      const msg = await gmailMessage(mailbox, messageId, threadId, 'metadata', fetchImpl)
      if (!msg) return null
      return {
        subject: header(msg.payload?.headers, 'Subject'),
        from: parseAddress(header(msg.payload?.headers, 'From')).email,
        firstLine: firstLine(decodeEntities(msg.snippet ?? '')),
      }
    }
    const msg = await graphMessage(mailbox, messageId, threadId, 'id,conversationId,isDraft,subject,from,bodyPreview', fetchImpl)
    if (!msg) return null
    return { subject: msg.subject ?? '', from: graphAddress(msg.from).email, firstLine: firstLine(msg.bodyPreview ?? '') }
  } catch {
    return null
  }
}

/** The first line of a preview, one line, at most 160 characters. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > 160 ? `${flat.slice(0, 159).trimEnd()}…` : flat
}

function decodeEntities(text: string): string {
  return text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

// ── One attachment of a shared message (on download) ────────────────────────

export interface SharedAttachmentFile {
  name: string
  mimeType: string
  size: number | null
  /** The bytes, as the provider hands them: streamed on, never written anywhere. */
  body: ReadableStream<Uint8Array> | Uint8Array
}

/**
 * One attachment of a shared message, by the key the read gave it, checked
 * against the message as the mailbox holds it now: a key the message doesn't
 * list (forged, or another message's) is null, as is a message no longer in
 * the thread, or a file over SHARE_ATTACHMENT_MAX_BYTES.
 */
export async function liveSharedAttachment(
  mailbox: ShareMailbox,
  messageId: string,
  threadId: string,
  key: string,
  fetchImpl: FetchLike = fetch,
): Promise<SharedAttachmentFile | null> {
  try {
    if (mailbox.provider === 'google') {
      const msg = await gmailMessage(mailbox, messageId, threadId, 'full', fetchImpl)
      if (!msg) return null
      const part = gmailPart(msg.payload, key)
      if (!part?.filename || !part.body?.attachmentId) return null
      if ((part.body.size ?? 0) > SHARE_ATTACHMENT_MAX_BYTES) return null
      const res = await fetchImpl(
        `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
        auth(mailbox.token),
      )
      if (!res.ok) return null
      const data = ((await res.json()) as { data?: unknown }).data
      if (typeof data !== 'string') return null
      const bytes = new Uint8Array(Buffer.from(data, 'base64url'))
      if (bytes.byteLength > SHARE_ATTACHMENT_MAX_BYTES) return null
      return { name: part.filename, mimeType: part.mimeType || 'application/octet-stream', size: bytes.byteLength, body: bytes }
    }
    const msg = await graphMessage(mailbox, messageId, threadId, `id,conversationId,isDraft&${GRAPH_ATTACHMENTS}`, fetchImpl)
    if (!msg) return null
    const file = graphFiles(msg.attachments).find((a) => a.key === key)
    if (!file || file.size > SHARE_ATTACHMENT_MAX_BYTES) return null
    const res = await fetchImpl(
      `${GRAPH}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(key)}/$value`,
      auth(mailbox.token, IMMUTABLE),
    )
    if (!res.ok || !res.body) return null
    return { name: file.name, mimeType: file.mimeType, size: file.size || null, body: res.body }
  } catch {
    return null
  }
}
