import { buildRawEmail } from '@/lib/crm/email-client'
import { ensurePublicMcpUrl } from '@/lib/mcp-client/url-guard-dns'
import { plainTextToHtml } from './plain-text-to-html'
import { GMAIL_API, GRAPH_API } from './provider-drafts'
import { gmailHeaderValue, type GmailMetadata } from './thread-headers'
import { mailboxesForThread, type LiveMailbox } from './thread-mailbox'

/**
 * Unsubscribe from a mailing list by its List-Unsubscribe header (RFC 2369),
 * for the agent's unsubscribe_thread (GEN-1166). The header is read live from
 * the thread's newest message that carries it, in the thread's OWN mailbox
 * (./thread-mailbox.ts). The ways, best first:
 *   one_click  RFC 8058: the sender says List-Unsubscribe-Post:
 *              List-Unsubscribe=One-Click, so a POST of exactly that to its
 *              https link unsubscribes, with no page to read and no cookie,
 *              login or redirect. The link is the sender's, so it goes through
 *              the outbound-URL guard (https only, no private or local
 *              address, ../mcp-client/url-guard-dns.ts) and redirects are not
 *              followed.
 *   mailto     an email to the list's unsubscribe address, sent from the
 *              thread's own mailbox (the subject and body the link names, else
 *              "unsubscribe"). Nothing is logged to the CRM.
 *   link       only an https page: Dial8 never opens a sender's page, so the
 *              person gets the link to open themselves.
 * This leaves Dial8 (an HTTP call to the sender, or a sent email), so the tool
 * that calls it waits for the person's approval card.
 */

export type UnsubscribeMethod =
  | { kind: 'one_click'; url: string }
  | { kind: 'mailto'; to: string; subject: string; body: string }
  | { kind: 'link'; url: string }

/** The links in a List-Unsubscribe header: `<https://…>, <mailto:…>`, in order. */
export function listUnsubscribeLinks(header: string): { https: string[]; mailto: string[] } {
  const https: string[] = []
  const mailto: string[] = []
  for (const [, inner] of header.matchAll(/<\s*([^>]+?)\s*>/g)) {
    const link = inner.replace(/\s+/g, '')
    if (/^https:\/\//i.test(link)) https.push(link)
    else if (/^mailto:/i.test(link)) mailto.push(link)
  }
  return { https, mailto }
}

/** Whether List-Unsubscribe-Post offers RFC 8058 one-click. */
export function offersOneClick(postHeader: string): boolean {
  return /(^|[\s;,])List-Unsubscribe\s*=\s*One-Click($|[\s;,])/i.test(postHeader.trim())
}

/** A mailto link as an address, subject and body, or null when it names no single plain address. */
export function parseMailto(link: string): { to: string; subject: string; body: string } | null {
  const match = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(link.trim())
  if (!match) return null
  let to: string
  try {
    to = decodeURIComponent(match[1]).trim()
  } catch {
    return null
  }
  // One plain address: never a list, a display name or a header line.
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(to)) return null
  const params = new URLSearchParams(match[2] ?? '')
  const oneLine = (value: string | null) => (value ?? '').replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200)
  return {
    to,
    subject: oneLine(params.get('subject')) || 'unsubscribe',
    body: (params.get('body') ?? '').slice(0, 500).trim() || 'unsubscribe',
  }
}

/**
 * A way to unsubscribe as one string, for an approval card to pin (the
 * approval's context) and its replay to compare. Pure.
 */
export function unsubscribeMethodKey(method: UnsubscribeMethod): string {
  return method.kind === 'mailto'
    ? JSON.stringify([method.kind, method.to, method.subject, method.body])
    : JSON.stringify([method.kind, method.url])
}

/** The way to unsubscribe these headers offer, best first, or null for none. Pure. */
export function unsubscribeMethod(listUnsubscribe: string, listUnsubscribePost: string): UnsubscribeMethod | null {
  const { https, mailto } = listUnsubscribeLinks(listUnsubscribe)
  if (https.length && offersOneClick(listUnsubscribePost)) return { kind: 'one_click', url: https[0] }
  for (const link of mailto) {
    const parsed = parseMailto(link)
    if (parsed) return { kind: 'mailto', ...parsed }
  }
  if (https.length) return { kind: 'link', url: https[0] }
  return null
}

// ---------------------------------------------------------------------------
// The header, live from the thread's mailbox
// ---------------------------------------------------------------------------

export interface ListHeaders {
  listUnsubscribe: string
  listUnsubscribePost: string
  /** Who the list mail is from (the From line, as sent). */
  from: string
}

/** The newest received Gmail message's list headers, or null (no thread, or no List-Unsubscribe). */
async function gmailListHeaders(token: string, threadId: string): Promise<ListHeaders | null | 'not_found'> {
  const params = ['format=metadata', 'metadataHeaders=List-Unsubscribe', 'metadataHeaders=List-Unsubscribe-Post', 'metadataHeaders=From'].join('&')
  const res = await fetch(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}?${params}`, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 400 || res.status === 404) return 'not_found'
  if (!res.ok) throw new Error(`Gmail thread read error: ${res.status}`)
  const messages = (((await res.json()) as { messages?: GmailMetadata[] }).messages ?? []).filter((m) => typeof m?.id === 'string')
  if (!messages.length) return 'not_found'
  const time = (m: GmailMetadata) => Number(m.internalDate ?? 0) || 0
  const received = [...messages]
    .sort((a, b) => time(b) - time(a))
    .filter((m) => !(m.labelIds ?? []).some((l) => l === 'SENT' || l === 'DRAFT'))
  const listed = received.find((m) => gmailHeaderValue(m, 'List-Unsubscribe'))
  if (!listed) return null
  return {
    listUnsubscribe: gmailHeaderValue(listed, 'List-Unsubscribe'),
    listUnsubscribePost: gmailHeaderValue(listed, 'List-Unsubscribe-Post'),
    from: gmailHeaderValue(listed, 'From'),
  }
}

/** The newest received Outlook message's list headers (the newest few are read), or null. */
async function outlookListHeaders(token: string, conversationId: string): Promise<ListHeaders | null | 'not_found'> {
  const params = new URLSearchParams({
    $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
    $select: 'id,isDraft,receivedDateTime',
    $top: '100',
  })
  // Every page: Graph orders a conversationId filter as it likes, so the newest may be on any of them.
  const messages: Array<{ id: string; isDraft?: boolean; receivedDateTime?: string }> = []
  let url: string | null = `${GRAPH_API}/messages?${params}`
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 400 || res.status === 404) return 'not_found'
    if (!res.ok) throw new Error(`Outlook thread read error: ${res.status}`)
    const data = (await res.json()) as { value?: Array<{ id?: string; isDraft?: boolean; receivedDateTime?: string }>; '@odata.nextLink'?: string }
    messages.push(...(data.value ?? []).filter((m): m is { id: string; isDraft?: boolean; receivedDateTime?: string } => typeof m?.id === 'string'))
    url = data['@odata.nextLink'] ?? null
  }
  if (!messages.length) return 'not_found'
  const newest = messages.filter((m) => !m.isDraft).sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? '')).slice(0, 3)
  for (const message of newest) {
    const one = await fetch(`${GRAPH_API}/messages/${encodeURIComponent(message.id)}?$select=internetMessageHeaders,from`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!one.ok) continue
    const data = (await one.json()) as {
      internetMessageHeaders?: Array<{ name?: string; value?: string }>
      from?: { emailAddress?: { address?: string; name?: string } }
    }
    const header = (name: string) => data.internetMessageHeaders?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
    if (!header('List-Unsubscribe')) continue
    const sender = data.from?.emailAddress
    return {
      listUnsubscribe: header('List-Unsubscribe'),
      listUnsubscribePost: header('List-Unsubscribe-Post'),
      from: sender?.name && sender.address ? `${sender.name} <${sender.address}>` : sender?.address ?? '',
    }
  }
  return null
}

export interface ThreadListHeaders {
  mailbox: LiveMailbox
  headers: ListHeaders | null
}

/** The thread's mailbox and its list headers (null when it carries none), or null when no mailbox holds the thread. */
export async function readThreadListHeaders(userId: string, workspaceId: string, threadId: string): Promise<ThreadListHeaders | null> {
  for await (const mailbox of mailboxesForThread(userId, threadId, { workspaceId })) {
    const headers = mailbox.provider === 'google'
      ? await gmailListHeaders(mailbox.token, threadId)
      : await outlookListHeaders(mailbox.token, threadId)
    if (headers === 'not_found') continue
    return { mailbox, headers }
  }
  return null
}

// ---------------------------------------------------------------------------
// Unsubscribing
// ---------------------------------------------------------------------------

/** How long a sender's one-click endpoint gets to answer. */
const ONE_CLICK_TIMEOUT_MS = 10_000

export type UnsubscribeOutcome =
  | { ok: true; method: 'one_click' | 'mailto'; target: string }
  | { ok: false; reason: 'link_only'; url: string }
  | { ok: false; reason: 'no_header' | 'not_found' | 'refused' | 'changed'; error: string }

export interface UnsubscribeDeps {
  fetch?: typeof fetch
  /** The outbound-URL guard; throws on a refusal. */
  guardUrl?: (url: string) => Promise<URL>
  /**
   * The way the person's card showed (unsubscribeMethodKey): anything else
   * the list offers now is refused, unsent. Absent when the card couldn't
   * read the list's headers (it said so).
   */
  pinned?: string | null
}

/** RFC 8058: POST `List-Unsubscribe=One-Click` to the link, no redirect followed. */
async function oneClick(url: string, deps: UnsubscribeDeps): Promise<void> {
  const safe = await (deps.guardUrl ?? ensurePublicMcpUrl)(url)
  const res = await (deps.fetch ?? fetch)(safe.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
    signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
  })
  // A 3xx is the sender's confirmation page: the POST itself was taken.
  if (res.status >= 400 || res.status === 0) throw new Error(`The sender's unsubscribe link answered ${res.status || 'nothing'}`)
}

/** The unsubscribe email, from the thread's own mailbox. */
async function sendMailto(mailbox: LiveMailbox, mail: { to: string; subject: string; body: string }, deps: UnsubscribeDeps): Promise<void> {
  const doFetch = deps.fetch ?? fetch
  if (mailbox.provider === 'google') {
    const raw = buildRawEmail({
      from: mailbox.email ?? 'me',
      to: [mail.to],
      subject: mail.subject,
      bodyHtml: plainTextToHtml(mail.body),
      bodyText: mail.body,
    })
    const res = await doFetch(`${GMAIL_API}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mailbox.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
    })
    if (!res.ok) throw new Error(`Gmail send error: ${res.status}`)
    return
  }
  const res = await doFetch(`${GRAPH_API}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mailbox.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: mail.subject,
        body: { contentType: 'Text', content: mail.body },
        toRecipients: [{ emailAddress: { address: mail.to } }],
      },
      saveToSentItems: true,
    }),
  })
  if (!res.ok) throw new Error(`Outlook send error: ${res.status}`)
}

/**
 * Unsubscribe the thread's mailbox from its list, the best way its newest
 * list message offers. Never throws.
 */
export async function unsubscribeFromThread(
  userId: string,
  workspaceId: string,
  threadId: string,
  deps: UnsubscribeDeps & { read?: typeof readThreadListHeaders } = {},
): Promise<UnsubscribeOutcome> {
  try {
    const found = await (deps.read ?? readThreadListHeaders)(userId, workspaceId, threadId)
    if (!found) return { ok: false, reason: 'not_found', error: 'No mailbox connected to this workspace holds this thread.' }
    const method = found.headers ? unsubscribeMethod(found.headers.listUnsubscribe, found.headers.listUnsubscribePost) : null
    if (deps.pinned && (!method || unsubscribeMethodKey(method) !== deps.pinned)) {
      return {
        ok: false,
        reason: 'changed',
        error: "The list's unsubscribe changed since the card was made (a newer message on the thread), so nothing was sent. Tell the person; they can ask again.",
      }
    }
    if (!method) {
      return { ok: false, reason: 'no_header', error: 'This sender offers no unsubscribe link (no List-Unsubscribe header). Mute or archive the thread instead.' }
    }
    if (method.kind === 'link') return { ok: false, reason: 'link_only', url: method.url }
    if (method.kind === 'one_click') {
      await oneClick(method.url, deps)
      return { ok: true, method: 'one_click', target: new URL(method.url).hostname }
    }
    await sendMailto(found.mailbox, method, deps)
    return { ok: true, method: 'mailto', target: method.to }
  } catch (err) {
    return { ok: false, reason: 'refused', error: err instanceof Error ? err.message : 'Unsubscribing failed.' }
  }
}
